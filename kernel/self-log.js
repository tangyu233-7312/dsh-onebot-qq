/**
 * kernel/self-log.js — 「我自己的流水账」（跨会话的自我记录）
 *
 * 为什么需要它（2026-10-30）：
 *   DSH 的会话是**每条 QQ 线一个**。它在群里干的事、在「看视频的地方」干的事、在「空间工作区」干的事，
 *   私聊里的它一概不知道 —— 于是会出现「唉？已经看了吗？」这种"像有不同人在做"的撕裂感。
 *
 * 这份流水账是**跨会话的唯一真相**：
 *   · 谁干活谁 append 一行（看视频 / 写说说 / 翻群 / 人设变更 …）；
 *   · 每轮开头顶一行「我今天的经历 + 额度」，任何会话都能知道自己干过什么；
 *   · 控制台可以查最近 N 条。
 *
 * 三条纪律：
 *  ① **只记事实，不记正文**：记 title/字数/原因，绝不记聊天原文（日志变垃圾场还会泄密）。
 *  ② **写失败不许影响干活**：任何一次 append 失败只 warn 一行，功能照常。
 *  ③ **按天分文件 + 只留 N 天**：`state/self-log/YYYY-MM-DD.jsonl`，读的时候只读今天，
 *     清理在 append 时顺手做（不需要额外定时器）。
 *
 * 存储位置跟其他状态文件一排（`<dataDir>/state/`），不写进工作区 ——
 * 工作区是给 GUI 看的，这里是给模型看的运行时状态，两者别混。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，会把晚上 8 点算成第二天） */
export function localDateOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

const hhmm = (ms) => {
  const d = new Date(Number(ms) || Date.now())
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/** 单行压成一行文本（换行会把 jsonl 撑坏） */
const oneLine = (s, max = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir  数据目录（`<dataDir>/state/self-log/<日期>.jsonl`）
 * @param {object} [opts.log]
 * @param {number} [opts.keepDays] 保留多少天（默认 14）
 * @param {() => number} [opts.now] 自检可钉住时间
 */
export function createSelfLog({ dataDir, log = console, keepDays = 14, now = () => Date.now() } = {}) {
  const rootOf = () => path.join(String(dataDir || '.'), 'state', 'self-log')
  const fileOf = (ms) => path.join(rootOf(), localDateOf(ms) + '.jsonl')

  /** 顺手清理过期文件（append 时做，不另开定时器） */
  let lastPrune = 0
  function pruneIfNeeded(ms) {
    const t = Number(ms) || Date.now()
    if (t - lastPrune < 3600 * 1000) return // 一小时最多扫一次
    lastPrune = t
    try {
      const dir = rootOf()
      const cutoff = t - Math.max(1, Number(keepDays) || 14) * 24 * 3600 * 1000
      for (const n of fs.readdirSync(dir)) {
        const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(n)
        if (!m) continue
        const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
        if (day < cutoff) {
          try { fs.unlinkSync(path.join(dir, n)) } catch { /* 删不掉就下次 */ }
        }
      }
    } catch { /* 目录还不存在 / 权限问题：都不影响记录 */ }
  }

  /**
   * 记一行。**永远不抛**。
   * @param {object} entry  { kind, what, why, where, session, ...任意附加字段 }
   *   kind   机器可读的类型：watch / qzone / browse / persona / timer / …
   *   what   人话：干了什么（会原样出现在提示词里，别写太长）
   *   why    人话：为什么（可选）
   *   where  在哪（群号 / 私聊 / desk:xxx）
   */
  function append(entry = {}) {
    try {
      const ms = now()
      const row = {
        ts: ms,
        at: hhmm(ms),
        kind: String(entry.kind || 'misc').slice(0, 24),
        what: oneLine(entry.what, 200),
        why: oneLine(entry.why, 160),
        where: oneLine(entry.where, 60),
        session: oneLine(entry.session, 60),
      }
      // 附加字段：只允许标量，避免把大对象写进日志
      for (const [k, v] of Object.entries(entry)) {
        if (k in row) continue
        if (v == null) continue
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          row[k] = typeof v === 'string' ? oneLine(v, 120) : v
        }
      }
      fs.mkdirSync(rootOf(), { recursive: true })
      fs.appendFileSync(fileOf(ms), JSON.stringify(row) + '\n', 'utf8')
      pruneIfNeeded(ms)
      return true
    } catch (e) {
      // 记流水账失败不能影响主流程，但一定要留一行日志（静默失败是本项目的头号坑）
      try { log.warn?.( `[流水账] 写失败（不影响功能）: ${e?.message || e}` ) } catch { /* ignore */ }
      return false
    }
  }

  /** 读某一天的行（默认今天）。坏行跳过，绝不抛 */
  function readDay(ms = now()) {
    const out = []
    let text = ''
    try { text = fs.readFileSync(fileOf(ms), 'utf8') } catch { return out }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const row = JSON.parse(s)
        if (row && typeof row === 'object' && Number.isFinite(Number(row.ts))) out.push(row)
      } catch { /* 坏行跳过 */ }
    }
    return out
  }

  /** 今天（本地日）按类型计数 */
  function countToday(kind) {
    return readDay().filter((r) => String(r.kind) === String(kind)).length
  }

  /** 最近 n 条（跨天：昨天 + 今天，够用就行） */
  function recent(n = 20) {
    const lim = Math.max(1, Math.min(200, Number(n) || 20))
    const today = readDay()
    if (today.length >= lim) return today.slice(-lim)
    const y = readDay(now() - 24 * 3600 * 1000)
    return [...y, ...today].slice(-lim)
  }

  /**
   * 「我今天的经历」一行（给每轮提示词用）。
   * 只挑**有信息量**的几种，避免把主会话自己的一问一答也塞进去。
   */
  const INTERESTING = new Set(['watch', 'qzone', 'browse', 'persona'])
  function todayLine() {
    const rows = readDay().filter((r) => INTERESTING.has(String(r.kind)))
    if (!rows.length) return ''
    const parts = rows.slice(-6).map((r) => {
      const w = String(r.where || '')
      return r.at + (w && w !== '私聊' && w !== '家' ? ' ' + w : '') + ' ' + String(r.what || '')
    })
    return parts.join('；')
  }

  return { append, readDay, countToday, recent, todayLine, fileOf, rootOf }
}
