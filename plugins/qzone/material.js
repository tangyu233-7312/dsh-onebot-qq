/**
 * material.js — 「当日素材」装配（qzone 插件内部模块，不是独立子插件）
 *
 * 为什么单独一层：写说说这件事的**输入**是「今天发生了什么」，而这件事散在三处：
 *   ① 聊天留档 `logs/qq_chat/{group|private}_<号>.jsonl`（当天所有消息，含机器人自己说的）
 *   ② 本群的长期记忆 `long-memory/memories.jsonl`（只读 group:<群号> 作用域，私聊记忆不进）
 *   ③ 空间里已经发过的说说（由 feed.js 另取）
 * 三处都不属于任何一个 DSH 会话 —— 这正是「会话记忆各自独立、它读不到一整天」的根因。
 * 本模块把它们合成**一篇人可读的 Markdown**：既喂给模型，也能被主人直接打开看。
 *
 * 三条纪律：
 *  ① 只读，不写聊天留档、不写记忆库（空间素材永远只是"看"）。
 *  ② 预算先给「最近」，超了从最早的开始丢 —— 越靠后越接近它此刻的心情。
 *  ③ 输出必须**人可读**（带时间、带昵称、带 QQ），排障时不用再猜模型看到了什么。
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

/** 某个本地日期的 [start, end) 毫秒区间 */
export function dayRange(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return { start: 0, end: 0 }
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
  return { start, end: start + 24 * 3600 * 1000 }
}

const hhmm = (ms) => {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

const mmdd = (ms) => {
  const d = new Date(ms)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 压成一行：换行/连续空白折叠，超长截断（正文里出现多行会把清单撑爆） */
const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

const ARCHIVE_RE = /^(group|private)_(\d{4,12})\.jsonl(?:\.(\d+))?$/

/** 列留档文件（含轮转的 .1/.2 分片），按文件名分组：'group:123' → [文件名…] */
function listArchiveFiles(archiveDir) {
  let names = []
  try { names = fs.readdirSync(archiveDir) } catch { return new Map() }
  const byChat = new Map()
  for (const n of names) {
    const m = ARCHIVE_RE.exec(n)
    if (!m) continue
    const key = m[1] + ':' + m[2]
    if (!byChat.has(key)) byChat.set(key, [])
    byChat.get(key).push(n)
  }
  return byChat
}

/** 读一份留档里落在 [start,end) 的消息（宽松解析：坏行跳过，绝不抛） */
function readRows(file, start, end) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let row
    try { row = JSON.parse(s) } catch { continue }
    const ts = Number(row?.ts) || 0
    if (!ts || ts < start || ts >= end) continue
    const msg = oneLine(row?.text, 300)
    if (!msg) continue
    if (/^\[CQ:[^\]]+\]$/.test(msg)) continue // 纯图片/表情占位不占素材预算
    out.push({
      ts,
      out: row?.dir === 'out',
      who: String(row?.sender?.card || row?.sender?.name || '').trim(),
      qq: String(row?.sender?.qq ?? '').trim(),
      text: msg,
    })
  }
  return out
}

/** 一行一条：`[21:03] 昵称(QQ)：…`；机器人自己的用 → 前缀；跨天时带上日期 */
function renderLine(r, withDate) {
  const name = r.who && r.qq ? r.who + '(' + r.qq + ')' : (r.who || r.qq || '未知')
  const stamp = withDate ? mmdd(r.ts) + ' ' + hhmm(r.ts) : hhmm(r.ts)
  return (r.out ? '→' : '') + '[' + stamp + '] ' + (r.out ? '你' : name) + '：' + r.text
}

/** 从末尾按字符预算保留（越新越优先），返回 { lines, dropped } */
function tailByChars(rows, budget, withDate) {
  const lines = []
  let used = 0
  let dropped = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = renderLine(rows[i], withDate)
    const size = line.length + 1
    if (lines.length && used + size > budget) { dropped = i + 1; break }
    used += size
    lines.push(line)
  }
  lines.reverse()
  return { lines, dropped, used }
}

/**
 * 群记忆摘录（2026-11-09 起从「每群一篇 md」换成「long-memory 事件库」）。
 *
 * 为什么不读 md 了：旧的 group-memory 已移出 plugins/，`qq-memory/<群号>.md` 不再更新；
 * 再读它只会把「记不清的旧摘要」当成今天的事写进空间。
 *
 * 新口径：从长记忆库（`<数据目录>/long-memory/memories.jsonl`）里取**这个群**作用域、
 * 未遗忘、且最近 memoryMaxAgeDays 天内记录或被想起过的记忆，最多几条。
 * 读不到文件 = 没有，不算错。
 *
 * 隐私：只读 `group:<群号>` 作用域 —— 私聊记忆一个字都不进空间素材。
 * @returns {{text:string, skipped:string, ageDays:number, count:number}}
 */
function memoryExcerpt(memoryFile, chatKey, maxChars, maxAgeDays) {
  const m = /^(group|private):(\d{4,12})$/.exec(chatKey)
  if (!m || m[1] !== 'group') return { text: '', skipped: '', ageDays: 0, count: 0 }
  const scope = 'group:' + m[2]
  let raw = ''
  try {
    raw = fs.readFileSync(memoryFile, 'utf8').replace(/^\uFEFF/, '')
  } catch { return { text: '', skipped: '', ageDays: 0, count: 0 } }
  // 回放事件流（与 long-memory 的 store 同一口径，但这里只读、不写、不缓存）
  const rows = new Map()
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev
    try { ev = JSON.parse(s) } catch { continue } // 坏行（半行写入）跳过
    if (!ev || typeof ev !== 'object') continue
    if (ev.op === 'add' && ev.memory && String(ev.memory.scope || '') === scope) {
      rows.set(String(ev.memory.id), { ...ev.memory })
    } else if (ev.op === 'forget' && rows.has(String(ev.id))) {
      rows.get(String(ev.id)).forgottenAt = Number(ev.at) || 1
    } else if (ev.op === 'restore' && rows.has(String(ev.id))) {
      rows.get(String(ev.id)).forgottenAt = 0
    } else if (ev.op === 'recall' && rows.has(String(ev.id))) {
      const r = rows.get(String(ev.id))
      r.lastRecalledAt = Math.max(Number(r.lastRecalledAt) || 0, Number(ev.at) || 0)
    }
  }
  if (!rows.size) return { text: '', skipped: '', ageDays: 0, count: 0 }
  const span = Math.max(1, Number(maxAgeDays) || 1) * 24 * 3600 * 1000
  const since = Date.now() - span
  const fresh = [...rows.values()]
    .filter((r) => !Number(r.forgottenAt) && String(r.text || '').trim())
    .filter((r) => Math.max(Number(r.createdAt) || 0, Number(r.lastRecalledAt) || 0) >= since)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
  if (!fresh.length) return { text: '', skipped: '这几天群里没有值得记的事', ageDays: 0, count: 0 }
  let out = ''
  for (const r of fresh.slice(0, 6)) {
    const line = '- ' + String(r.text).replace(/\s+/g, ' ').trim()
    if (out.length + line.length > maxChars) break
    out += (out ? '\n' : '') + line
  }
  return { text: out, skipped: '', ageDays: 0, count: fresh.length }
}

/**
 * 装配当天素材。
 * @returns {{date:string, text:string, stats:object, file:string}}
 */
export function buildDailyMaterial({
  archiveDir, memoryFile, workspaceDir, date,
  msgPerChat = 400, perChatChars = 8000, totalChars = 60000, memoryChars = 1200, includePrivate = true,
  onlyChatKey = '', days = 1, memoryMaxAgeDays = 0,
} = {}) {
  const day = String(date || localDateOf(Date.now()))
  const today = dayRange(day)
  const span = Math.max(1, Math.min(14, Math.round(Number(days) || 1)))
  // 往回看 span 天（默认只今天）：宁可少喂，也别把上周的旧事当今天的经历
  const start = today.start - (span - 1) * 24 * 3600 * 1000
  const end = today.end
  const memMaxAge = Math.max(0, Number(memoryMaxAgeDays) || 0)
  const byChat = listArchiveFiles(String(archiveDir || ''))
  const chats = []
  const only = String(onlyChatKey || '').trim()
  for (const [chatKey, files] of byChat) {
    if (only && chatKey !== only) continue // 只写某一个群："/空间 群聊" 用
    if (!includePrivate && chatKey.startsWith('private:')) continue
    let rows = []
    for (const f of files) rows = rows.concat(readRows(path.join(String(archiveDir), f), start, end))
    if (!rows.length) continue
    rows.sort((a, b) => a.ts - b.ts)
    chats.push({ chatKey, rows: rows.slice(-msgPerChat), total: rows.length })
  }
  chats.sort((a, b) => b.total - a.total)

  // 预算：先按每会话上限，再按当天总上限收口（每会话额度 = 总预算 / 会话数）
  const perChat = Math.max(500, Math.min(perChatChars, Math.floor(totalChars / Math.max(1, chats.length))))
  const sections = []
  let messages = 0
  let droppedTotal = 0
  for (const c of chats) {
    const { lines, dropped } = tailByChars(c.rows, perChat, span > 1)
    messages += lines.length
    droppedTotal += dropped + Math.max(0, c.total - c.rows.length)
    const m = /^(group|private):(\d{4,12})$/.exec(c.chatKey)
    const kind = m && m[1] === 'private' ? '私聊 ' : '群 '
    const num = m ? m[2] : c.chatKey
    const first = c.rows.length ? c.rows[0].ts : 0
    const last = c.rows.length ? c.rows[c.rows.length - 1].ts : 0
    const timeSpan = c.rows.length
      ? ((span > 1 ? mmdd(first) + ' ' : '') + hhmm(first) + '–' + (span > 1 ? mmdd(last) + ' ' : '') + hhmm(last))
      : '-'
    const head = '## ' + kind + num + '（' + (span > 1 ? '最近 ' + span + ' 天 ' : '今天 ') + c.total + ' 条，' + timeSpan + '）'
    const mem = memoryExcerpt(String(memoryFile || ''), c.chatKey, memoryChars, Math.max(1, Math.round((memMaxAge || span) / (24 * 3600 * 1000))))
    const body = [head]
    if (mem.text) body.push('', '**这个群最近的记忆**（共 ' + mem.count + ' 条）', mem.text)
    else if (mem.skipped) body.push('', '（' + mem.skipped + '）')
    if (dropped) body.push('', '（更早的 ' + dropped + ' 条已省略）')
    body.push('', lines.join('\n'))
    sections.push(body.join('\n'))
  }

  const scopeText = only ? '（只看 ' + only + ' 这一段）' : ''
  const rangeText = span > 1 ? '最近 ' + span + ' 天' : '今天'
  const header = [
    '# ' + day + ' · ' + rangeText + '的经历' + scopeText,
    '',
    '共 ' + chats.length + ' 个会话、' + messages + ' 条消息' + (droppedTotal ? '（已省略 ' + droppedTotal + ' 条较早的）' : '') + '。',
    '格式：`[' + (span > 1 ? '日期 时间' : '时间') + '] 昵称(QQ)：内容`；行首 `→` 是**你自己**说的话。',
  ].join('\n')
  const emptyText = only ? '（这一段' + rangeText + '没有任何人说话。）' : '（' + rangeText + '没有任何人说话。）'
  const text = chats.length ? header + '\n\n' + sections.join('\n\n') : header + '\n\n' + emptyText

  // 落地一份供人查看（也是排障时「模型到底看到了什么」的唯一答案）
  let file = ''
  try {
    const dir = path.join(String(workspaceDir || '.'), 'qzone-desk')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, day + '.md')
    fs.writeFileSync(file, text + '\n')
  } catch { file = '' }

  return {
    date: day,
    text,
    file,
    stats: { chats: chats.length, messages, chars: text.length, dropped: droppedTotal, days: span },
  }
}