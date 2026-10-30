/**
 * self-view — 「看看自己 / 翻翻群」（order 88）
 *
 * 用户 2026-10-30 定的口径：
 *   · 回家（私聊）想知道今天群里什么样 → **给摘要，不给原文**
 *     （写空间才需要原文，那里已经有 material.js；私聊里塞原文会把家变成第二个群）
 *   · 想知道自己干过什么 → 读流水账（kernel/self-log.js）
 *
 * 两个工具都是**只读**：不产生出站消息、不新建会话。
 * 摘要完全由代码算（不调模型），所以翻一次群不花 token。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 留档文件名：group_<群号>.jsonl[.N] / private_<QQ>.jsonl[.N] */
const ARCHIVE_RE = /^(group|private)_(\d{4,12})\.jsonl(?:\.(\d+))?$/

const hhmm = (ms) => {
  const d = new Date(Number(ms) || Date.now())
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export default {
  id: 'self-view',
  title: '看自己',
  order: 88,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '看自己', label: '「翻翻群 / 看自己」两个工具',
      hint: '关掉后它就不能主动翻群、也看不到自己的流水账（只剩每轮头顶那一行）。',
    },
    lookbackHours: {
      type: 'int', default: 6, min: 1, max: 72, step: 1, group: '看自己', label: '翻群看最近多少小时', unit: '小时',
      hint: '默认 6 小时。读的是本地聊天留档（不是协议端接口），所以不消耗协议端配额。',
    },
    maxGroups: {
      type: 'int', default: 8, min: 1, max: 30, step: 1, group: '看自己', label: '最多列几个群',
      hint: '按最近活跃排序取前几个，避免群多时一次刷太长。',
    },
    maxLines: {
      type: 'int', default: 3, min: 0, max: 6, step: 1, group: '看自己', label: '每个群给几条浓缩',
      hint: '0 = 只说「几个人在聊」，不给具体句子。默认 3 条、每条截到 40 字 —— 这里是摘要，不是原文。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const on = () => cfg().enabled !== false
    const dataDir = () => String(bot.core?.dataDir || '.')
    const archiveDir = () => {
      const raw = String(bot.core?.archive?.dir || 'logs/qq_chat')
      return path.isAbsolute(raw) ? raw : path.join(dataDir(), raw)
    }

    /** 读一份留档里这段时间的行（宽松解析，坏行跳过） */
    const readRows = (file, since) => {
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
      const out = []
      for (const line of text.split('\n')) {
        const s = line.trim()
        if (!s) continue
        try {
          const row = JSON.parse(s)
          const ts = Number(row && row.ts) || 0
          if (ts < since) continue
          out.push(row)
        } catch { /* 坏行跳过 */ }
      }
      return out
    }

    /** 某个会话的摘要：几条、几个人、我说了没、最近几句（截断） */
    const summarizeChat = (chatKey, since, maxLines) => {
      const prefix = chatKey.replace(':', '_')
      let names = []
      try { names = fs.readdirSync(archiveDir()) } catch { return null }
      const files = names.filter((n) => {
        const m = ARCHIVE_RE.exec(n)
        return m && (m[1] + '_' + m[2]) === prefix
      })
      if (!files.length) return null
      let rows = []
      for (const f of files) rows = rows.concat(readRows(path.join(archiveDir(), f), since))
      if (!rows.length) return null
      rows.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
      const human = rows.filter((r) => r.dir !== 'out')
      const mine = rows.filter((r) => r.dir === 'out')
      const who = new Map()
      for (const r of human) {
        const s = r && r.sender ? r.sender : {}
        const nm = String(s.card || s.name || '').trim()
        if (nm) who.set(nm, (who.get(nm) || 0) + 1)
      }
      const top = [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0])
      const tail = rows.slice(-Math.max(0, maxLines)).map((r) => {
        const s = r && r.sender ? r.sender : {}
        return {
          at: hhmm(r.ts),
          who: r.dir === 'out' ? '我' : String(s.card || s.name || '某人').slice(0, 12),
          text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 40),
        }
      })
      return {
        chatKey: chatKey,
        messages: rows.length,
        humans: human.length,
        mine: mine.length,
        people: top,
        tail: tail,
        lastAt: Number(rows[rows.length - 1] && rows[rows.length - 1].ts) || 0,
      }
    }

    // ── 工具 ①：翻翻群（摘要）────────────────────────────────
    bot.registerTool('browse_groups', {
      description: '看看群里最近在聊什么（**摘要**：几个人、几条、谁在说、最近几句的浓缩）。'
        + '不读原文、不花 token、不会往群里发任何东西。想知道「家里」以外发生了什么时用。',
      parameters: {
        hours: { type: 'number', description: '看最近多少小时（默认用配置里的值）' },
      },
      async execute(args) {
        const a = args || {}
        if (!on()) return { ok: false, reason: '「看自己」功能没开启' }
        const hours = Math.max(1, Math.min(72, Number(a.hours) || Number(cfg().lookbackHours) || 6))
        const since = Date.now() - hours * 3600 * 1000
        let groups = []
        // 群名优先用协议端的（可选能力，取不到就只显示号码）
        try {
          const list = await bot.onebot.groupList()
          groups = (Array.isArray(list) ? list : []).map((g) => ({ id: String(g.id), name: String(g.name || '') }))
        } catch { /* 取不到就往下走 */ }
        if (!groups.length) {
          // 协议端不可用：退化成「留档里出现过的群」
          try {
            for (const n of fs.readdirSync(archiveDir())) {
              const m = ARCHIVE_RE.exec(n)
              if (m && m[1] === 'group') groups.push({ id: m[2], name: '' })
            }
          } catch { /* ignore */ }
        }
        const seen = new Set()
        const out = []
        for (const g of groups) {
          if (seen.has(g.id)) continue
          seen.add(g.id)
          const s = summarizeChat('group:' + g.id, since, Number(cfg().maxLines) || 3)
          if (!s) continue
          out.push({ group: g.id, name: g.name, ...s })
        }
        out.sort((x, y) => y.lastAt - x.lastAt)
        const maxGroups = Math.max(1, Number(cfg().maxGroups) || 8)
        return {
          ok: true,
          hours: hours,
          groups: out.slice(0, maxGroups),
          more: Math.max(0, out.length - maxGroups),
          note: out.length ? '' : '这段时间群里没人说话（或者留档没开）',
        }
      },
    })

    // ── 工具 ②：看我自己的流水账 ─────────────────────────────
    bot.registerTool('self_log', {
      description: '看看自己今天做过什么（看视频、发说说、翻群、改人设…）以及还剩多少额度。',
      parameters: {
        limit: { type: 'number', description: '看最近几条（默认 20）' },
      },
      async execute(args) {
        const a = args || {}
        if (!on()) return { ok: false, reason: '「看自己」功能没开启' }
        const log = bot.selfLog
        if (!log || typeof log.recent !== 'function') return { ok: false, reason: '内核没暴露流水账（版本太老）' }
        const lim = Math.max(1, Math.min(50, Number(a.limit) || 20))
        return {
          ok: true,
          today: log.todayLine(),
          rows: log.recent(lim),
        }
      },
    })

    bot.log.info('[看自己] 已装配：翻群看最近 ' + (Number(cfg().lookbackHours) || 6) + ' 小时（摘要）')
  },
}
