/**
 * persona-voice — 网感子插件①：人设句池（bot.linesPool）+ 唤醒词（bot.readWakeWords）+ 出站拆条
 * + 引用门槛（quoteEnforce）+ 控制台状态源（bot.linesSource / bot.wakeSource）。
 *
 * 为什么这些放一个插件：都"跟着人设走"——`personas/<名字>.lines.txt` / `.wake.txt` 由切人设机制
 * （软链或 copy 模式）投递到 qq-lines 工作区，本插件只按**解析结果**热读（mtime 变即重读），
 * 换人设后句池/唤醒词立刻跟着变、不用重启进程。
 *
 * 平台边界（Windows 兼容的关键）：
 *  · 人设名解析只用 `platform/persona-ref.js`：显式 `activePersona` → `.persona.json` 指针 →
 *    软链 realpath 反推；**不自己调 realpath 猜**，也不依赖 bash/ln/chmod。
 *  · 人设文件路径只用 `personaSources()`（同时认 `_default.lines.txt` 与 `_默认.lines.txt`）。
 *  · 读句池/唤醒词先剥 UTF-8 BOM（Windows 编辑器常见），换行已兼容 CRLF。
 *
 * ⚠️ 配置**一律每轮现读 bot.cfg**（热改立即生效）：控制台写配置后内核原地同步这个对象，
 *    setup 顶部算成局部常量的话热改就得重启才生效。
 *
 * 群唤醒词：权威存储在实例配置 `pluginConfig['gate-wake'].keywords`（文本行格式），
 * 内核解析成 `bot.core.keywordTable` 注入；本插件只负责"人设词表优先、群号词叠加"的取值链。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { splitBubbles } from '../../kernel/format.js'
import { stripBom } from '../../platform/atomic.js'
import { activePersona as resolveActivePersona, personaSources } from '../../platform/persona-ref.js'

/** 人设库目录缺省值（相对 dataDir，由内核解析成绝对路径） */
const DEFAULT_PERSONA_DIR = 'personas'

/**
 * 句池节名归一：旧句池支持中文节名；imagegen 子插件的需求里写的是 imagegenAck/imagegenFail。
 * alias 成规范节名 → 人设文件只写规范名时，两种叫法都取得到。
 */
const SECTION_ALIAS = {
  戳一戳: 'poke', 戳: 'poke',
  答应: 'callAck', 应答: 'callAck', 接话: 'callAck',
  在画了: 'imageAck', imagegenAck: 'imageAck',
  画不过来: 'imageBusy', imagegenBusy: 'imageBusy',
  画失败: 'imageFail', imagegenFail: 'imageFail',
}

/**
 * 第三级兜底（人设没有、共享底池也没有时用）。句池**永远不能为空**：
 * 「叫了它但没正文 → 答应一声」「被戳回一句」都从池里取话；池空 = 没声。
 * ⚠️ 事故：**纯呼名不参与关键词冷却**（它不回话、只开接续窗口）。若 callAck 池是空的，
 *    就会出现"呼名既不答应、又没被冷却记住" → 之后补正文也没人应，两头空。
 * 句末不带句号：聊天里挂句号显得生硬。
 */
const LINES_FALLBACK = {
  poke: ['嗯？', '在', '怎么了？', '别戳', '有事说事'],
  callAck: ['在', '嗯？', '怎么了？', '听着呢'],
  imageAck: ['在画了，稍等'],
  imageBusy: ['画不过来，等会儿再叫'],
  imageFail: ['画失败了…等会儿再试'],
}
/** 内置兜底覆盖的五节；linesSource.effective 也按它们 + 文件里出现的节来报 */
const LINES_SECTIONS = Object.keys(LINES_FALLBACK)

/**
 * 拆条只针对**聊天短回复**：超过这个字数就交给内核按长文处理（套合并转发卡片 / 单条长消息）。
 * 不加这道闸的话，几百字的长回复会被拆成两三条平铺，逃掉"长文卡片"这条既有行为（测试踩到）。
 */
const SPLIT_MAX_CHARS = 120

/** 解析句池文本 → { 节名: [句子] }（纯函数）。
 *  · `## <节名>` 分节、`#` 注释、未知分节/节外内容忽略（别把说明当句子吃进去）
 *  · 没有分节的老文件（`<名字>.poke.txt`）→ 整份当 poke（兼容）
 */
function parseLinesText(text) {
  const pools = {}
  let cur = null
  let sawSection = false
  for (const raw of stripBom(String(text || '')).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^#{2,}\s*([^\s#]+)\s*$/.exec(line)
    if (m) {
      cur = SECTION_ALIAS[m[1]] || m[1]
      sawSection = true
      pools[cur] = pools[cur] || []
      continue
    }
    if (line.startsWith('#')) continue
    if (!cur) {
      if (sawSection) continue // 分节之外的内容：忽略
      pools.poke = pools.poke || []
      pools.poke.push(line)
      continue
    }
    pools[cur].push(line)
  }
  return pools
}

/**
 * 单位双口径归一（控制台面板值 ↔ 按 scale 换算的存储值）：
 *  · 概率：面板 40（%）或存储 0.4 → 0~1
 *  · 时间：面板 1（秒）或存储 1000（ms）→ ms
 * 迁移期旧配置里的"分数 / 毫秒"原生值也走同一套。
 */
const toRate = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.min(1, n / 100) : (Number.isFinite(n) && n > 0 ? n : 0)
}
const toMs = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? (n >= 1000 ? Math.round(n) : Math.round(n * 1000)) : 0
}
const countPools = (pools) => (pools
  ? Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]))
  : null)

export default {
  id: 'persona-voice',
  title: '人设句池 / 拆条',
  order: 40,
  configSchema: {
    enabled: { type: 'bool', default: true, group: '句池', label: '人设句池 / 唤醒词 / 拆条', hint: '开：启用人设文件的句池（随机句）、唤醒词、拆条回话；关：只用 AGENTS 指令，不加载这些花样。' },
    personaDir: {
      type: 'str', default: DEFAULT_PERSONA_DIR, group: '句池', label: '人设目录',
      hint: '相对路径由内核按数据目录解析；人设文件命名 `<名字>.md` / `.lines.txt` / `.wake.txt`',
    },
    activePersona: {
      type: 'str', default: '', group: '句池', label: '当前人设',
      hint: '留空 = 按 qq-lines 工作区的指针/软链自动解析（换人设不用改这里）',
    },
    splitReplyEnabled: { type: 'bool', default: true, group: '回话', label: '拆条' },
    splitReplyProbability: { type: 'int', unit: '%', scale: 0.01, default: 50, min: 1, max: 100, group: '回话', label: '拆条概率' },
    splitReplyMinLen: { type: 'int', default: 12, min: 0, max: 200, group: '回话', label: '拆条最小长度' },
    splitReplyDelayMs: { type: 'int', unit: '秒', scale: 1000, default: 1, min: 0, max: 10, group: '回话', label: '拆条间隔' },
    splitReplyMaxParts: {
      type: 'int', default: 3, min: 2, max: 4, group: '回话', label: '最多拆几条',
      hint: '一段回复最多拆成几条发（2~4）。只在句末标点/换行处拆，绝不拦腰砍句；\n'
        + '句子不够就按实际句数发（2 条就够时不会硬凑）。拆出来的每条之间隔「拆条间隔」秒。',
    },
    quoteEnforce: {
      type: 'bool', default: true, group: '句池', label: '不引用刚触发回复的那条消息',
      hint: '人话：它回你时不会「引用」你刚说的那句（真人聊天不会这样）。\n开：模型引用刚触发回复的那条消息时自动去掉引用；例外：唤醒后群里又插了 ≥「引用门槛」条消息时，引用才有意义、会保留。\n关：模型想引用就引用，不拦。',
    },
  },

  setup(bot) {
    const log = bot.log
    /** 配置每轮现读（控制台热改 = 内核原地同步这个对象）；setup 里只留"路径推导"这类纯函数，不缓存值 */
    const cfgNow = () => bot.cfg || {}
    const enabledNow = () => cfgNow().enabled !== false
    const dirNow = () => String(cfgNow().personaDir || '').trim() || DEFAULT_PERSONA_DIR
    const workspaceDirNow = () => String(bot.core?.dsh?.qqWorkspacePath || '').trim()

    // 文件 mtime+size 当版本号（与旧 readLinesFile 同一套）：改句池立刻生效、不用重启
    const linesCache = new Map()
    const wakeCache = new Map()

    /** 当前人设名：配置写死优先；否则平台层按指针/软链解析。换人设只改投递文件，所以每次现算。 */
    function activePersona() {
      const configured = String(cfgNow().activePersona || '').trim()
      const workspaceDir = workspaceDirNow()
      // 没配 qq-lines 工作区又没显式配置人设时，没有可靠的解析来源（别拿进程 cwd 猜）
      if (!configured && !workspaceDir) return ''
      return resolveActivePersona({ configured, workspaceDir, personaDir: dirNow() })
    }
    /** 当前人设的源文件集（缺的给 ''）。 */
    const sourcesNow = () => personaSources(dirNow(), activePersona())
    const personaLinesFile = () => sourcesNow().lines
    const personaWakeFile = () => sourcesNow().wake
    const baseLinesFile = () => sourcesNow().baseLines || join(dirNow(), '_默认.lines.txt')

    /** 读一份句池文件 → {节: [句子]}；文件不在/读不了 → null。mtime 没变直接吃缓存。 */
    function readPools(file) {
      if (!file) return null
      let st
      try { st = statSync(file) } catch { return null } // 没人设文件 = 只走底池
      const stamp = `${st.mtimeMs}:${st.size}`
      const hit = linesCache.get(file)
      if (hit && hit.stamp === stamp) return hit.pools
      try {
        const pools = parseLinesText(readFileSync(file, 'utf8'))
        linesCache.set(file, { stamp, pools })
        return pools
      } catch (e) {
        log.warn(`[句池] 读 ${file} 失败: ${e.message}`)
        return null
      }
    }

    /**
     * 取某节的一句。回落链：人设 .lines.txt 的节 → `_默认.lines.txt` 同名节 → 内置兜底。
     * 绝不返回空（除节名拼错且没有内置兜底）—— 空池会让"答应声/回戳"直接哑掉。
     */
    function pick(section) {
      if (!enabledNow()) return '' // 插件热关 → 调用方（gate-wake/imagegen）回落各自内置兜底句
      const key = SECTION_ALIAS[section] || String(section || '')
      const own = readPools(personaLinesFile())?.[key]
      const base = readPools(baseLinesFile())?.[key]
      const list = (Array.isArray(own) && own.length ? own : null)
        || (Array.isArray(base) && base.length ? base : null)
        || LINES_FALLBACK[key]
      if (!list || !list.length) {
        log.warn(`[句池] 节「${section}」在人设 / 底池 / 内置兜底里都没有`)
        return ''
      }
      return list[Math.floor(Math.random() * list.length)]
    }

    /** 控制台「总览」用：哪份人设文件 / 底池、各节各几条、最终生效几条 */
    function linesSource() {
      const pf = personaLinesFile()
      const bf = baseLinesFile()
      const personaPools = readPools(pf)
      const basePools = readPools(bf)
      const effective = {}
      const sections = new Set([...LINES_SECTIONS, ...Object.keys(personaPools || {}), ...Object.keys(basePools || {})])
      for (const s of sections) {
        const own = personaPools?.[s]
        const base = basePools?.[s]
        const list = (Array.isArray(own) && own.length ? own : null)
          || (Array.isArray(base) && base.length ? base : null)
          || LINES_FALLBACK[s] || []
        effective[s] = list.length
      }
      return {
        personaFile: pf,
        baseFile: bf,
        persona: countPools(personaPools),
        base: countPools(basePools),
        effective,
      }
    }

    /** 人设唤醒词文件（一行一个、`#` 注释）；缺失/空 → null（回落到配置的群唤醒词表） */
    function personaWakeWords() {
      const file = personaWakeFile()
      if (!file) return null
      let st
      try { st = statSync(file) } catch { return null }
      const stamp = `${st.mtimeMs}:${st.size}`
      const hit = wakeCache.get(file)
      if (hit && hit.stamp === stamp) return hit.words
      try {
        const words = stripBom(readFileSync(file, 'utf8')).split(/\r?\n/).map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
        wakeCache.set(file, { stamp, words })
        return words
      } catch (e) {
        log.warn(`[唤醒词] 读 ${file} 失败: ${e.message}`)
        return null
      }
    }

    /** 群关键词表：内核解析自 `pluginConfig['gate-wake'].keywords`（文本行格式）后共享过来 */
    function groupKeywordTable() {
      const table = bot.core?.keywordTable
      return table && typeof table === 'object' ? table : {}
    }

    /**
     * 该群生效的唤醒词：人设 `.wake.txt` 与配置全局 `*` **合并都生效**（去重）；群号专属键永远叠加。
     * "包含"、大小写不敏感由 gate-wake 做，这里只给表。
     */
    function readWakeWords(gid) {
      if (!enabledNow()) return [] // 插件热关 → 关键词唤醒也停（gate-wake 自己会回落）
      const table = groupKeywordTable()
      const persona = personaWakeWords() || []
      const global = Array.isArray(table['*']) ? table['*'] : []
      const extra = gid != null && gid !== '' ? (table[String(gid)] || []) : []
      // 人设词 + 配置全局词 + 群专属词：合并去重（人设词排前面，方便排障）
      return [...new Set([...persona, ...global, ...extra]
        .map((w) => String(w).trim().toLowerCase()).filter(Boolean))]
    }

    /** 控制台「群聊」用：唤醒词实际用哪份、人设词表、配置全局词表 */
    function wakeSource() {
      const words = personaWakeWords() || []
      const table = groupKeywordTable()
      const cfgGlobal = Array.isArray(table['*']) ? table['*'].map(String) : []
      const from = words.length && cfgGlobal.length ? 'persona+config' : (words.length ? 'persona' : 'config')
      return {
        from,
        wakeFile: words.length ? personaWakeFile() : '',
        persona: words,                                            // 人设文件里写的
        cfgGlobal,                                                 // 配置的全局表（控制台加/删写这里）
        effectiveGlobal: [...new Set([...words, ...cfgGlobal].map(String))], // 实际生效（合并去重）
      }
    }

    // ⚠️ 必须挂在 bot 上（不是任何插件私有）：gate-wake 的「答应声 / 回戳」和 imagegen 的
    //    「在画了 / 画失败」都要取同一份罐头话。各插件自己读文件 = 回落链与缓存各写一遍，迟早分叉。
    // 内核共享槽只有 `linesPool` / `readWakeWords` 两个访问器（kernel.shared）→ 状态源挂在它们身上，
    // 内核/控制台一处即可取到：`kernel.shared.linesPool.source()` / `kernel.shared.readWakeWords.source()`。
    bot.linesPool = { pick, source: linesSource }
    bot.linesSource = linesSource
    bot.wakeSource = wakeSource
    bot.readWakeWords = readWakeWords
    bot.readWakeWords.source = wakeSource
    bot.keywordsFor = readWakeWords // 旧名别名：gate-wake 照旧名字取也拿得到同一份表

    log.info(`[网感] 句池: 人设 ${activePersona() || '(未解析, 只用底池)'} → ${personaLinesFile() || '—'}`
      + `｜底池 ${baseLinesFile()}｜唤醒词来源 ${wakeSource().from}`)

    // 正在等第二条的"正话"：deliver 会再跑一遍本钩子，靠它认出"这是我自己拆出去的"，别二次拆
    const pendingTails = new Map()

    bot.onOutbound((out) => {
      if (!enabledNow()) return
      const cfg = cfgNow()
      const tc = out.turnCtx || null

      // ── ① 引用门槛：模型显式引用"刚触发本轮的那条"零信息量 ——
      //      实测（线上群）指令拦不住：55 次里仍引用 47 次，且每次都是刚来的那条。
      //      只有"唤醒之后、回复之前同群又插了 ≥ quoteAfterMsgs 条"才值得挂；没到门槛就抹掉。
      //      引用**更早的其它消息**（用户点名要引用）保留不动；主动接话轮由内核出站钩子强制清（这里不碰）。
      if (cfg.quoteEnforce !== false && tc && !tc._steered && tc.wakeKind !== 'proactive' && out.replyTo != null
        && Number(out.replyTo) === Number(tc.triggerMsgId)) {
        const need = Number(tc.quoteAfterMsgs ?? 3) // 内核没往 turnCtx 带就按默认 3
        const arrived = Number(tc.arrivedDuringTurn) || 0
        if (arrived < need) {
          log.info(`[引用门槛] 丢掉引用 ${out.replyTo}（${out.target}）：唤醒后群里插了 ${arrived} 条 < ${need}，引用零信息量`)
          out.replyTo = null
        }
      }

      // ── ② 拆条：小概率把一段回复按自然句拆成 2~N 条发（像真人连打几条） ──
      // 只在 mode==='plain'（无 @ / 无引用 / 非卡片）时做：@ 与引用是挂在**单条**上的语义，拆开就散架。
      const prob = toRate(cfg.splitReplyProbability)
      if (cfg.splitReplyEnabled === false || prob <= 0) return
      const minLen = Number(cfg.splitReplyMinLen) > 0 ? Number(cfg.splitReplyMinLen) : 12
      const delayMs = toMs(cfg.splitReplyDelayMs)
      const maxParts = Math.max(2, Math.min(4, Math.floor(Number(cfg.splitReplyMaxParts) || 3)))
      const text = String(out.text || '')
      // 先认自己拆出去的后几条（放在 mode 判断前：内核可能已按 turnCtx 给它们补了引用）
      if (pendingTails.get(out.target) === text) { pendingTails.delete(out.target); return }
      if (out.mode !== 'plain') return
      // 只拆模型经 send_message 写的话（fromTool）：命令回执 / 答应声 / 系统提示 / 生图说明
      // 这些"非对话正文"不该被拆 —— 拆了命令输出会变成两条，用户看不出哪条是结果（测试踩过）。
      if (!out.fromTool) return
      if ((out.ats && out.ats.length) || out.replyTo != null) return
      // CQ 码（图 / 表情 / 合并转发）挂在**单条**上，拆成几条就是坏消息（sendMedia 也走 deliver）
      if (text.includes('[CQ:')) return
      if (text.length < minLen) return
      if (text.length > SPLIT_MAX_CHARS) return // 长文不拆：留给内核走卡片/长消息
      if (Math.random() >= prob) return
      // ⚠️ 拆条失败必须降级成单条发（**话不能吞**）：拆条只是"像真人"的锦上添花，
      //    找不到自然断点（绝不把一句话拦腰砍）或算断点抛错 → 原样单条发，不许把正话弄丢。
      let parts = null
      try { parts = splitBubbles(text, { maxParts }) } catch (e) { log.warn(`[拆条] 找断点失败(降级单条): ${e.message}`) }
      if (!parts || parts.length < 2) return
      // 第一条交给内核照常发：deliver 跑完 decorate 就发 out.text，改它 = "第一条立刻发"
      out.text = parts[0]
      // 后面每一条依次隔 delayMs 发**同一个 target**；走 bot.deliver = 唯一出站口
      // （脱敏 / 留档 / 长文卡片都由内核兜，这里绝不自己发裸消息）
      parts.slice(1).forEach((part, i) => {
        const nth = i + 2
        setTimeout(async () => {
          pendingTails.set(out.target, part)
          try { await bot.deliver(out.target, part, { turnCtx: out.turnCtx || null, conversationReply: true }) }
          catch (e) { log.warn(`[拆条] 第 ${nth} 条发送失败 (${out.target}): ${e.message}`) }
          finally { pendingTails.delete(out.target) }
        }, delayMs * nth)
      })
      log.info(`[拆条] ${out.target} → ${parts.map((x) => `「${x.slice(0, 20)}」`).join(' + ')}`)
    })
  },
}
