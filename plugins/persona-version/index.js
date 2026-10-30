/**
 * persona-version — 人设版本化（order 42）
 *
 * 用户 2026-10-30 定的规矩：
 *   · 人设**独立放一个文件夹**，每版一个文件，文件名带日期：<角色><YYYYMMDD>.md
 *   · 同一天改多次就在后面加编号：<角色><YYYYMMDD>-2.md、-3…
 *   · **绝对不能原地改**，只另存新版本，然后把指针指过去
 *
 * 为什么「不能原地改」不是洁癖（这是踩过的坑）：
 *   DSH 的 @deepseek-ai/dsh-agent-instructions 是**按路径 + 内容 digest 缓存**的，
 *   "路径没变 + 内容没变就不重复注入"。它自己改文件时走的是工具调用，
 *   不一定触发 DSH 记录的 read/write/edit touch —— 于是会出现「改了没生效」。
 *   另存新版本 → 改指针 → 路径变了 → 一定重新注入。
 *
 * 工具面：
 *   persona_revise(change)          → 开一个新版本文件（当前版 + 顶部改动说明）
 *   persona_write(version, content) → 把完整正文写进那一版
 *   persona_switch(name)            → 切生效版本（留空 = 最新）
 *   persona_history()               → 版本历史
 *
 * 红线：只能写人设库目录里 <角色><YYYYMMDD>[-N].md 这种文件，不许传路径；
 *       版本文件一旦存在绝不被隐式覆盖（同日改多次自动 +1）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 本地日期 YYYYMMDD */
const stampOf = (ms = Date.now()) => {
  const d = new Date(ms)
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
}

/** 从版本名里拆出 { role, date, seq }；不是版本名就返回 null */
export function parseVersionName(name) {
  const m = /^(.*?)(\d{8})(?:[-_](\d+))?$/.exec(String(name || ''))
  if (!m) return null
  return { role: m[1], date: m[2], seq: Number(m[3] || 1) }
}

/** 生成同一天的下一个可用版本名：<角色><YYYYMMDD> / -2 / -3…（**绝不覆盖**） */
export function nextVersionName(personaDir, role, date) {
  const base = role + date
  const exists = (n) => {
    try { return fs.statSync(path.join(personaDir, n + '.md')).isFile() } catch { return false }
  }
  if (!exists(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const n = base + '-' + i
    if (!exists(n)) return n
  }
  throw new Error('同一天的版本号用完了（不该发生），请手工看一眼人设目录')
}


export default {
  id: 'persona-version',
  title: '人设版本',
  order: 42,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '人设版本',
      label: '允许它自己改人设（另存新版本）',
      hint: '开：它可以用 persona_revise 把自己的人设改出新的一版（**永远另存，不覆盖旧版**）。关：只能你手工改。',
    },
    allowInGroup: {
      type: 'bool', default: false, group: '人设版本',
      label: '群里也允许改人设',
      hint: '默认关：只有私聊（家）里才许改自己。群里人多嘴杂，别让人随口一句就改掉它的性格。',
    },
    changelog: {
      type: 'bool', default: true, group: '人设版本',
      label: '每版写一行改动说明',
      hint: '在正文末尾追加「## 版本记录」小节，写明哪天改的 —— 半年后翻一眼就知道每一版怎么来的。',
    },
    maxChars: {
      type: 'int', default: 20000, min: 1000, max: 200000, step: 1000, group: '人设版本',
      label: '单版人设最多多少字',
      hint: '防它一次写太长把上下文吃光。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const on = () => cfg().enabled !== false
    const dataDir = () => String(bot.core?.dataDir || '.')

    /** 人设库目录（和控制台 persona-voice.personaDir 同一个） */
    const personaDir = () => {
      const raw = String(bot.core?.paths?.personaDir || cfg().personaDir || '').trim()
      return raw ? path.resolve(raw) : path.join(dataDir(), 'personas')
    }
    /** 当前生效的名字（内核 personaLabel 已经做了「取最新版」解析） */
    const currentName = () => String(bot.personaLabel || '').trim()
    const readVersion = (name) => fs.readFileSync(path.join(personaDir(), String(name) + '.md'), 'utf8')

    /** 该角色的所有版本（名字排序 = 时间排序） */
    const versionsOf = (role) => {
      let names = []
      try {
        names = fs.readdirSync(personaDir())
          .filter((n) => n.toLowerCase().endsWith('.md'))
          .map((n) => n.slice(0, -3))
      } catch { return [] }
      if (!role) return names.sort()
      return names.filter((n) => n === role || (parseVersionName(n) || {}).role === role).sort()
    }

    const switchTo = (name) => {
      const fn = bot.core && bot.core.switchPersona
      if (typeof fn === 'function') return fn(name)
      throw new Error('内核没暴露 switchPersona（版本太老），请用控制台「人设」页切换')
    }

    // ── 工具 ①：开一个新版本 ────────────────────────────────
    bot.registerTool('persona_revise', {
      description: '给自己的人设开一版新的（**永远另存，不覆盖旧版**）。把想要的改动写成 change。'
        + '工具会以当前这版为基础建一个新文件（文件名带今天日期）。'
        + '之后调 persona_write 写完整正文，再调 persona_switch 让它生效。',
      parameters: {
        change: { type: 'string', required: true, description: '说清楚要怎么改（例：「把自嘲从必选项改成偶尔，别的都不要动」）' },
      },
      async execute(args) {
        const a = args || {}
        if (!on()) return { ok: false, reason: '人设版本功能没开启' }
        const change = String(a.change || '').trim()
        if (!change) return { ok: false, reason: 'change 不能为空：说清楚想怎么改' }
        const turn = bot.currentTurn ? bot.currentTurn() : null
        if (turn && turn.isGroup && cfg().allowInGroup !== true) {
          return { ok: false, reason: '群里不允许改人设（想改就私聊说）' }
        }
        const cur = currentName()
        if (!cur) return { ok: false, reason: '读不到当前人设版本（.persona.json / activePersona 都为空）' }
        const parsed = parseVersionName(cur)
        if (!parsed) return { ok: false, reason: '当前人设名不是版本化格式（' + cur + '）：让主人先把文件改成 <角色><YYYYMMDD>.md' }
        const text0 = readVersion(cur)
        const max = Math.max(1000, Number(cfg().maxChars) || 20000)
        if (text0.length > max) return { ok: false, reason: '当前人设太长（' + text0.length + ' 字 > ' + max + '），先精简再改' }
        const name = nextVersionName(personaDir(), parsed.role, stampOf())
        const file = path.join(personaDir(), name + '.md')
        if (fs.existsSync(file)) return { ok: false, reason: '目标文件已存在（并发？）：' + name }
        const header = '<!-- 待改写：' + change + '（基于 ' + cur + ' 生成于 ' + new Date().toISOString() + '） -->\n'
        fs.writeFileSync(file, header + text0, 'utf8')
        if (bot.selfLog && bot.selfLog.append) {
          bot.selfLog.append({ kind: 'persona', what: '给自己开了一版新人设 ' + name, why: change.slice(0, 100), where: turn && turn.isGroup ? '群' : '私聊' })
        }
        bot.log.info('[人设版本] 新版本 ' + name + '（基于 ' + cur + '）：' + change.slice(0, 60))
        return {
          ok: true,
          from: cur,
          newVersion: name,
          nowActive: cur,
          next: '新版本文件已建好（当前版 + 顶部一条改动说明）。下一步 persona_write 写完整正文，再 persona_switch 生效。',
        }
      },
    })

    // ── 工具 ②：写完整正文 ─────────────────────────────────
    bot.registerTool('persona_write', {
      description: '把**完整正文**写进某一版人设文件（不是 diff）。只允许写人设库里的 <角色><YYYYMMDD>[-N].md。',
      parameters: {
        version: { type: 'string', required: true, description: '版本名，例如 蓝色大肥鱼20261030-2' },
        content: { type: 'string', required: true, description: '完整正文' },
      },
      async execute(args) {
        const a = args || {}
        if (!on()) return { ok: false, reason: '人设版本功能没开启' }
        const version = String(a.version || '').trim()
        const content = String(a.content || '')
        if (!parseVersionName(version)) return { ok: false, reason: '版本名必须是 <角色><YYYYMMDD>[-N] 格式' }
        const file = path.join(personaDir(), version + '.md')
        if (!fs.existsSync(file)) return { ok: false, reason: '没有这一版，先用 persona_revise 开新版本：' + version }
        const max = Math.max(1000, Number(cfg().maxChars) || 20000)
        if (content.length > max) return { ok: false, reason: '正文太长（' + content.length + ' > ' + max + '）' }
        if (!content.trim()) return { ok: false, reason: '正文不能为空' }
        let out = content
        if (cfg().changelog !== false && !/##\s*版本记录/.test(out)) {
          out += '\n\n---\n\n## 版本记录\n\n- ' + stampOf() + ' ' + version + '：由它自己改\n'
        }
        fs.writeFileSync(file, out, 'utf8')
        bot.log.info('[人设版本] 写入 ' + version + '（' + out.length + ' 字）')
        return { ok: true, version: version, chars: out.length, next: '正文写好了，调 persona_switch 让它生效' }
      },
    })

    // ── 工具 ③：切换生效版本 ────────────────────────────────
    bot.registerTool('persona_switch', {
      description: '让某一版人设**生效**（不传 name = 最新那版）。返回里带「现在生效的是哪一版」，务必对一下。',
      parameters: {
        name: { type: 'string', description: '版本名；留空 = 最新一版' },
      },
      async execute(args) {
        const a = args || {}
        if (!on()) return { ok: false, reason: '人设版本功能没开启' }
        const turn = bot.currentTurn ? bot.currentTurn() : null
        if (turn && turn.isGroup && cfg().allowInGroup !== true) {
          return { ok: false, reason: '群里不允许改人设（想改就私聊说）' }
        }
        const cur = currentName()
        const p = parseVersionName(cur)
        const role = (p && p.role) || cur
        const versions = versionsOf(role)
        if (!versions.length) return { ok: false, reason: '人设库里没有 ' + (role || '(未知角色)') + ' 的任何版本' }
        const wanted = String(a.name || '').trim()
        const target = wanted || versions[versions.length - 1]
        if (versions.indexOf(target) < 0) return { ok: false, reason: '没有这一版：' + target }
        switchTo(target)
        const now = currentName()
        bot.log.info('[人设版本] 生效 ' + target + '（原 ' + cur + '）')
        return {
          ok: true,
          switchedTo: target,
          nowActive: now,
          warn: now && now !== target ? '切换后读回来不是目标版本（' + now + '）：可能配置里钉死了 activePersona，去控制台看一眼' : '',
        }
      },
    })

    // ── 工具 ④：版本历史 ────────────────────────────────────
    bot.registerTool('persona_history', {
      description: '列自己人设的所有版本（旧 → 新），并标出哪一版现在生效。',
      parameters: {},
      async execute() {
        const cur = currentName()
        const p = parseVersionName(cur)
        const role = (p && p.role) || cur
        const versions = versionsOf(role)
        const rows = versions.map((v) => {
          let size = 0
          try { size = fs.statSync(path.join(personaDir(), v + '.md')).size } catch { /* ignore */ }
          return { version: v, bytes: size, active: v === cur }
        })
        return { ok: true, role: role, active: cur, versions: rows }
      },
    })

    // ── 控制台状态 ──────────────────────────────────────────
    bot.shared.personaVersionStatus = () => {
      const cur = currentName()
      const p = parseVersionName(cur)
      const role = (p && p.role) || cur
      const versions = versionsOf(role)
      return {
        ok: true,
        enabled: on(),
        dir: personaDir(),
        active: cur,
        role: role,
        count: versions.length,
        latest: versions[versions.length - 1] || '',
        stale: versions.length > 1 && cur !== versions[versions.length - 1],
      }
    }

    bot.log.info('[人设版本] 已装配：人设库 ' + personaDir() + '，当前 ' + (currentName() || '(未解析)'))
  },
}
