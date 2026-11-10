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


/**
 * 读「当前生效」的那份人设文件 —— 供 read_persona 工具用（导出给测试）。
 *
 * 为什么必须解析而不是让模型给路径：人设库里有好几套（蓝色大肥鱼 / 祀 / 带日期的版本），
 * 模型随手写一个路径就可能读到**别人的人设**，白白浪费 token 还串戏。
 * 这里只认三份：正主人设（.md）、固定句池（.lines.txt）、唤醒词（.wake.txt），都跟着指针走。
 *
 * @param {{personaDir:string, workspaceDir:string, activeName?:string, which?:string}} o
 * @returns {{ok:boolean, name:string, which:'md'|'lines'|'wake', file:string, reason?:string}}
 */
export function personaFilesForRead({ personaDir = '', workspaceDir = '', activeName = '', which = 'md' } = {}) {
  const want = which === 'lines' || which === 'wake' ? which : 'md'   // 其它一律当 md（不认路径）
  const suffix = want === 'lines' ? '.lines.txt' : want === 'wake' ? '.wake.txt' : '.md'
  let name = String(activeName || '').trim()
  if (!name) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(String(workspaceDir || ''), '.persona.json'), 'utf8'))
      name = String((p && p.name) || '').trim()
    } catch { /* 没有指针就返回下面的失败 */ }
  }
  if (!name) return { ok: false, name: '', which: want, file: '', reason: '读不到当前生效的人设（.persona.json 与 activePersona 都是空）' }
  const dir = String(personaDir || '')
  const file = path.join(dir, name + suffix)
  // 防穿越：解析后必须仍在人设库目录里（名字来自配置/指针，正常不会有 ..，但别假设）
  const resolved = path.resolve(file)
  if (!path.resolve(dir) || !resolved.startsWith(path.resolve(dir) + path.sep)) {
    return { ok: false, name, which: want, file: '', reason: '人设名不合法（解析出了人设库目录）' }
  }
  return { ok: true, name, which: want, file: resolved }
}

/**
 * 读一份人设文件的内容（只读；超预算截断并说明）。失败不抛，返回 { ok:false, reason }。
 */
export function readPersonaFile({ personaDir = '', workspaceDir = '', activeName = '', which = 'md', maxBytes = 24000 } = {}) {
  const f = personaFilesForRead({ personaDir, workspaceDir, activeName, which })
  if (!f.ok) return { ...f, text: '', bytes: 0, clipped: false }
  try {
    const buf = fs.readFileSync(f.file)
    const budget = Math.max(1000, Number(maxBytes) || 24000)
    const clipped = buf.length > budget
    const text = buf.slice(0, budget).toString('utf8')
    return { ok: true, name: f.name, which: f.which, file: f.file, text, bytes: buf.length, clipped }
  } catch (e) {
    return { ok: false, name: f.name, which: f.which, file: f.file, text: '', bytes: 0, clipped: false, reason: '读不到文件：' + (e && e.message ? e.message : String(e)) }
  }
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
    // ── 系统提示词里的人设（2026-11-10）──
    // 默认只放一小段「人格骨架」，全文靠 read_persona 按需读；打开下面的开关才把全文常驻。
    promptFull: {
      type: 'bool', default: false, group: '人设版本',
      label: '人设全文常驻系统提示词',
      hint: '开：把当前生效的整篇人设写进系统提示词 —— 每轮都带上，最稳，但每轮多约 2500 token（走缓存也贵）。\n'
        + '关（默认）：系统提示词里只放一小段人格骨架（自称 / 语尾 / 句末不挂句号 / 禁忌），'
        + '全文由它自己按需调 read_persona 来读 —— 省 token，但依赖它愿意读。\n'
        + '改完**重启 DSH** 才生效（系统提示词是会话建立时定的）；已有会话不会重新读。',
    },
    promptFullMaxBytes: {
      type: 'int', default: 12000, min: 1000, max: 40000, step: 1000, group: '人设版本',
      label: '全文常驻时的字数上限',
      hint: '超过这个字节数的部分会被截断（防一篇巨长人设把系统提示词吃光）。只在上面那个开关打开时有效。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = (m) => bot.log?.info?.(m)
    const on = () => cfg().enabled !== false
    const dataDir = () => String(bot.core?.dataDir || '.')

    /** 人设库目录（和控制台 persona-voice.personaDir 同一个） */
    const personaDir = () => {
      const raw = String(bot.core?.paths?.personaDir || cfg().personaDir || '').trim()
      return raw ? path.resolve(raw) : path.join(dataDir(), 'personas')
    }
    /** 当前生效的名字（内核 personaLabel 已经做了「取最新版」解析） */
    const currentName = () => String(bot.personaLabel || '').trim()
    /** QQ 工作区目录（.persona.json 在那儿）；内核没给就退回 <dataDir>/workspace。 */
    const workspaceDirNow = () => {
      const core = bot.core || {}
      const raw = String(core.qqWorkspacePath || '').trim()
      if (raw) return path.isAbsolute(raw) ? raw : path.join(String(core.dataDir || '.'), raw)
      return path.join(String(core.dataDir || '.'), 'workspace')
    }
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
        // 老人设（没有日期的名字，例如「蓝色大肥鱼」）：先把它**升级成版本化**再改。
        // 不这么做的话，第一次想改自己就卡在"名字不合规"上，体验很差；
        // 升级动作本身也是"另存一份"，老文件原样留着不动。
        const parsed = parseVersionName(cur) || { role: cur, date: '', seq: 1 }
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
        const upgraded = parseVersionName(cur) == null
        return {
          ok: true,
          from: cur,
          newVersion: name,
          nowActive: cur,
          upgraded,
          note: upgraded ? '原来的人设没有日期版本号，已按规则把它升级成「' + name + '」（老文件没动）。' : '',
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

    // ── 工具 ⑤：read_persona（只读，按需读当前生效的人设）──────
    // 为什么要有它：系统提示词里只放一小段人格骨架（省钱），全文让人设自己按需来读。
    // 为什么只认名字不认路径：人设库里有好几套，模型随手写路径会读到别人的；
    // 这里用「当前生效人设」解析，拿到的一定是正在用的那份。
    bot.registerTool('read_persona', {
      description: '读你自己**当前生效**的人设全文（默认读主文件 .md；也可以读固定句池 / 唤醒词）。'
        + '不用每轮都读 —— 换话题的头一句、被夸/被凶/被叫外号之后、或觉得自己刚才回得太敷衍时读一次就够了。'
        + '只会读到正在用的那一套人设（不会读到别的角色，也没有路径参数）。',
      parameters: {
        which: { type: 'string', description: 'md（默认，人设正文）/ lines（固定句池）/ wake（唤醒词）' },
      },
      async execute(args) {
        const a = args || {}
        const turn = bot.currentTurn ? bot.currentTurn() : null
        // 同会话读一次就够：第二轮起直接告诉它「这轮已经读过了」，省 token
        if (turn && turn.personaReadAt) {
          return { ok: true, alreadyRead: true, note: '这一轮已经读过人设了，直接用就行，别重复读' }
        }
        const r = readPersonaFile({
          personaDir: personaDir(),
          workspaceDir: workspaceDirNow(),
          activeName: currentName(),
          which: String(a.which || 'md'),
          maxBytes: Math.max(2000, Number(cfg().maxReadBytes) || 24000),
        })
        if (!r.ok) return { ok: false, reason: r.reason || '读不到人设' }
        if (turn) turn.personaReadAt = Date.now()
        const label = r.which === 'lines' ? '固定句池' : r.which === 'wake' ? '唤醒词' : '人设正文'
        return {
          ok: true,
          persona: r.name,
          which: r.which,
          label: label + '（' + r.name + '）',
          bytes: r.bytes,
          ...(r.clipped ? { clipped: true, hint: '文件超过读取上限，已截断；够用了，不用再读' } : {}),
          text: r.text,
        }
      },
    })

    /** 人设以什么方式进系统提示词：full = 全文常驻（promptFull），skeleton = 骨架 + 按需读。 */
    const promptModeNow = () => (cfg().promptFull === true ? 'full' : 'skeleton')

    /**
     * 把「当前生效人设」按模式渲染进 cordis.patch.yml 的 persona.prefix（B 方案真正落地的地方）。
     *
     * 为什么必须改这个文件：系统提示词由 preset 的 persona.prefix 决定，config.json 里动不了它。
     * 为什么由插件在启动时做：控制台开关在 config.json，重启时插件先跑，正好同步进 patch。
     * 安全：**只往已存在的 generated 标记之间写**；标记不在就整段跳过，绝不凭空造 YAML 结构。
     */
    function syncPersonaPrompt() {
      const mode = promptModeNow()
      const candidates = [
        path.join(dataDir(), '..', 'profiles', 'web', 'cordis.patch.yml'),
        path.join(import.meta.dirname, '..', '..', 'cordis.patch.yml'),
      ]
      const target = candidates.find((f) => { try { return fs.existsSync(f) } catch { return false } })
      if (!target) { log('[人设提示词] 找不到 cordis.patch.yml，跳过（不影响聊天）'); return }
      const text = fs.readFileSync(target, 'utf8')
      // 标记**在块标量内部**（16 空格内容行）：YAML 会把它当正文，不会当新键。
      const re = /([ ]+)# >>> persona-body:begin >>>\n([\s\S]*?)\n([ ]+)# <<< persona-body:end <<</
      const m = re.exec(text)
      if (!m) { log('[人设提示词] patch 里没有 generated 标记，跳过（保持原样）'); return }
      const endIndent = m[1]
      const body = mode === 'full'
        ? String(readPersonaFile({ personaDir: personaDir(), workspaceDir: workspaceDirNow(), activeName: currentName(), which: 'md', maxBytes: Number(cfg().promptFullMaxBytes) || 12000 }).text || '')
        : ''
      const rendered = body.trim()
        ? body.split('\n').map((l) => (l.trim() ? endIndent + l : '')).join('\n')
        : endIndent + '# （骨架模式：人设全文不常驻，由 read_persona 按需读）'
      const next = text.replace(m[0], m[1] + '# >>> persona-body:begin >>>\n' + rendered + '\n' + m[1] + '# <<< persona-body:end <<<')
      if (next === text) { log('[人设提示词] ' + mode + ' 模式，patch 无变化'); return }
      try {
        const backup = target + '.bak-' + stampOf()
        fs.copyFileSync(target, backup)
        fs.writeFileSync(target, next, 'utf8')
        log('[人设提示词] 已按 ' + mode + ' 模式写入 ' + target + '（备份 ' + path.basename(backup) + '）→ 重启 DSH 后生效')
      } catch (e) {
        log('[人设提示词] 写入失败（保持原样）：' + (e && e.message ? e.message : String(e)))
      }
    }

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
        promptMode: promptModeNow(),
      }
    }

    bot.log.info('[人设版本] 已装配：人设库 ' + personaDir() + '，当前 ' + (currentName() || '(未解析)') + '｜提示词模式 ' + promptModeNow())
    // 2026-11-10：把「全文常驻 / 骨架」的选择同步进 cordis.patch.yml（控制台开关 → 系统提示词）
    try { syncPersonaPrompt() } catch (e) { bot.log.warn('[人设提示词] 同步失败（不影响聊天）：' + (e && e.message ? e.message : String(e))) }
  },
}
