/**
 * plugins/long-memory/index.js — 长期记忆（id: 'long-memory'，order: 46）
 *
 * 一句话：**它记得住人**，不靠压缩、不靠 dcp、不靠任何外部插件。
 *
 * 和「短期记忆」的分界（命名就来自这条）：
 *   · 短期 = DSH 自带的会话窗口（同一个 QQ 会话里最近几十条）。会话一换 / 被压缩，它就没了；
 *   · 长期 = 这个插件。**存盘**的事件库 + 按相关/新鲜/重要打分后每轮现查现注入，
 *     换会话、重启、隔一个月回来，该想起的还能想起来。
 *
 * 四条纪律（改之前先读）：
 *   ① **每轮现算**：`before-turn` 里重新检索，不缓存“本会话上次注入过什么”。
 *      旧实现把“提示过没”记在会话状态里，换个会话就全丢 —— 那是它在别人机器上“等于没有”的主因。
 *   ② **注入必须带保护前缀**：记忆正文进 `ev.hint`，模型只会当成“系统信息、非用户发言”。
 *      不加前缀，模型会把记忆当成群友说的话（旧插件 2026-10-30 踩过）。
 *   ③ **隐私按作用域硬隔离**：群聊只查本群、私聊只查本人。跨作用域检索**不可能**发生（先过滤再打分）。
 *   ④ **任何失败都不许影响聊天**：检索/整理/记账全部 try/catch，失败只写一行日志。
 *
 * 它不依赖：dcp、向量库、宿主 llm 服务、group-memory 的任何共享槽或工具名。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataPath } from '../../platform/paths.js'
import { createStore } from './store.js'
import { createOrganizer, DEFAULT_ORGANIZE_PROMPT, readArchiveLines, archiveFileOf } from './organize.js'
import { rankMemories, formatInjection, effectiveImportance, isForgettable, scoreMemory, agoText } from './decay.js'
import { chatComplete, normalizeLlmConfig } from './relay.js'

/** 记忆库默认目录（相对数据目录，与其它状态文件同处一地）。 */
const DEFAULT_DIR = 'long-memory'
/** 占位模板（控制台「恢复默认」用；真值在 configSchema.default）。 */
export { DEFAULT_ORGANIZE_PROMPT }

const num = (v, d, min, max) => {
  const n = Number(v)
  const base = Number.isFinite(n) ? n : d
  return Math.max(min, Math.min(max, base))
}

export default {
  id: 'long-memory',
  title: '长期记忆',
  order: 46,
  description: '存盘的长期记忆：自动提炼要点、按相关/新鲜/重要打分、每轮注入；不依赖压缩插件。',

  configSchema: {
    // ── ① 状态（纯说明块：现算，不落盘）───────────────────────────────
    statusInfo: {
      type: 'info', group: '记忆', label: '现状', text: (kernel) => {
        const fn = kernel?.shared?.longMemory?.status
        if (typeof fn !== 'function') return '长期记忆插件没加载（看「子插件」页有没有加载失败）。'
        try {
          const s = fn()
          const n = s.llm || {}
          const parts = [
            `已记 ${s.entries} 条（已遗忘 ${s.forgotten} 条，可找回）｜范围：${s.scopeSummary || '—'}`,
            n.configured
              ? `整理接口：${n.model || '（未填模型）'} 已配置`
              : `整理接口：❌ 未配置（缺 ${(n.missing || []).join(' / ')}）—— 现在只支持手动记 / 自己调 remember，自动整理不跑`,
            `上次整理：${s.organize?.at ? new Date(s.organize.at).toLocaleString() : '还没跑过'}`
              + (s.organize?.error ? `｜上次失败：${String(s.organize.error).slice(0, 80)}` : ''),
            `目录：${s.dir}`,
          ]
          return parts.join('\n')
        } catch (e) {
          return `读取状态失败：${e?.message || e}`
        }
      },
    },

    // ── ② 存储范围 ────────────────────────────────────────────────────
    privateAll: {
      type: 'bool', default: true, group: '记忆', section: '存储范围',
      label: '记所有私聊',
      hint: '开：谁私聊它都记（记忆按 QQ 分开存，互相看不到）。关：只记下面「只记这些 QQ」里列出的人。',
    },
    privateInclude: {
      type: 'group', default: [], group: '记忆', section: '存储范围',
      label: '只记这些 QQ',
      hint: '「记所有私聊」关掉后生效。一行一个 QQ 号；留空 = 一条私聊都不记。',
    },
    groupsMode: {
      type: 'enum', default: 'none', group: '记忆', section: '存储范围',
      label: '群聊记忆',
      options: [
        { value: 'none', label: '不记任何群（默认）' },
        { value: 'list', label: '只记下面列出的群' },
        { value: 'all', label: '记所有群' },
      ],
      hint: '群聊里人多消息杂，默认不记。要记就选「只记下面列出的群」填群号——填群号后在它的群记忆里能查到。',
    },
    groupsInclude: {
      type: 'group', default: [], group: '记忆', section: '存储范围',
      label: '要记的群号',
      hint: '「群聊记忆 = 只记下面列出的群」时生效。一行一个群号。',
    },

    // ── ③ 整理模型（照生图那套：接口 + 模型 + Key，可测）──────────────
    llmProtocol: {
      type: 'enum', default: 'openai-chat', group: '记忆', section: '整理模型',
      label: '接口协议',
      options: [
        { value: 'openai-chat', label: 'OpenAI 兼容（chat/completions）' },
        { value: 'openai-completions', label: 'OpenAI 兼容（completions 别名）' },
      ],
      hint: '绝大多数中转站/官方都选第一个。',
    },
    llmBaseUrl: {
      type: 'str', default: '', group: '记忆', section: '整理模型',
      label: 'API 地址（填到 /v1）',
      hint: '例：https://api.example.com/v1 。和生图用的是同一套填写口径。',
    },
    llmModel: {
      type: 'str', default: '', group: '记忆', section: '整理模型',
      label: '模型',
      hint: '建议用便宜的小模型（如 glm-5.3-flash / deepseek-flash），整理是后台高频任务，不值得用主模型。',
    },
    llmApiKey: {
      type: 'str', default: '', secret: true, group: '记忆', section: '整理模型',
      label: 'API Key',
      hint: '只存在实例配置里，控制台只回显掩码。留空 = 不自动整理（照样能手动记、能查、能注入）。',
    },
    llmReasoningEffort: {
      type: 'enum', default: '', group: '记忆', section: '整理模型',
      label: '思考强度',
      options: [
        { value: '', label: '不指定（跟随接口默认）' },
        { value: 'low', label: 'low（省）' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high（贵）' },
      ],
      hint: '多数整理模型不需要开思考；不填最省。',
    },
    organizePrompt: {
      type: 'text', default: DEFAULT_ORGANIZE_PROMPT, group: '记忆', section: '整理模型',
      label: '整理提示词',
      hint: '决定「记什么、怎么写、怎么打分」。占位符：{transcript}（聊天正文）、{maxMemories}、{scopeLabel}。改完下一轮生效。',
    },

    // ── ④ 高级参数（默认折叠）─────────────────────────────────────────
    enabled: {
      type: 'bool', default: true, group: '记忆（高级）', section: '开关',
      label: '长期记忆',
      hint: '总开关。关：不注入、不自动整理（已有记忆原样保留，可以随时再打开）。',
    },
    injectEnabled: {
      type: 'bool', default: true, group: '记忆（高级）', section: '开关',
      label: '每轮注入相关记忆',
      hint: '关：不再往对话里塞记忆（省 token、也不想它主动提旧事时关）。',
    },
    autoOrganize: {
      type: 'bool', default: true, group: '记忆（高级）', section: '开关',
      label: '定时自动整理',
      hint: '开：每隔一段时间自动把新聊天提炼成记忆。关：只在你点「立刻整理」或它自己调 remember 时写入。',
    },
    dir: {
      type: 'str', default: DEFAULT_DIR, group: '记忆（高级）', section: '存储',
      label: '记忆目录',
      hint: '相对路径按数据目录解析。改目录不会自动搬家（旧库留在原处）。',
    },
    organizeIntervalMin: {
      type: 'int', default: 30, min: 5, max: 1440, step: 5, unit: '分钟', group: '记忆（高级）', section: '节奏',
      label: '整理间隔',
      hint: '多久检查一次「有没有值得记的新消息」。检查本身不花 token，只有真有新消息才调模型。',
    },
    minNewMessages: {
      type: 'int', default: 8, min: 1, max: 200, step: 1, unit: '条', group: '记忆（高级）', section: '节奏',
      label: '至少攒够几条才整理',
      hint: '某个会话自上次整理后，对方说的话少于这个数就跳过（省 token）。',
    },
    maxMessagesPerRound: {
      type: 'int', default: 120, min: 10, max: 2000, step: 10, unit: '条', group: '记忆（高级）', section: '节奏',
      label: '单次最多喂几条',
      hint: '一次整理最多把多少条聊天交给模型；多了拆到下一轮。',
    },
    maxCharsPerRound: {
      type: 'int', default: 6000, min: 500, max: 60000, step: 500, unit: '字', group: '记忆（高级）', section: '节奏',
      label: '单次正文上限',
      hint: '喂给模型的聊天正文最多多少字（超出从最早的开始丢）。',
    },
    maxMemoriesPerRound: {
      type: 'int', default: 5, min: 1, max: 20, step: 1, unit: '条', group: '记忆（高级）', section: '整理',
      label: '单次最多产出几条记忆',
      hint: '群聊一天几十条有价值的信息，别只记一条；但也别让模型记成流水账。',
    },
    maxCharsPerMemory: {
      type: 'int', default: 240, min: 40, max: 800, step: 20, unit: '字', group: '记忆（高级）', section: '整理',
      label: '单条记忆长度上限',
      hint: '超过就截断（多半说明模型把整段聊天抄回来了）。',
    },
    topK: {
      type: 'int', default: 5, min: 1, max: 20, step: 1, unit: '条', group: '记忆（高级）', section: '检索',
      label: '每轮最多注入几条',
      hint: '打分后取前 N 条拼进提示词（照公示的 5 条）。',
    },
    injectMaxChars: {
      type: 'int', default: 600, min: 80, max: 4000, step: 50, unit: '字', group: '记忆（高级）', section: '检索',
      label: '注入总字数上限',
      hint: '整个记忆块的硬上限，超了从低分的开始丢。',
    },
    recallContextLines: {
      type: 'int', default: 3, min: 0, max: 20, step: 1, unit: '行', group: '记忆（高级）', section: '检索',
      label: '检索时额外参考几行上文',
      hint: '除了本轮这句话，再从群聊上文里取几行一起当查询词（0 = 只看本轮这句）。',
    },
    graceDays: {
      type: 'int', default: 7, min: 0, max: 90, step: 1, unit: '天', group: '记忆（高级）', section: '遗忘',
      label: '宽限天数',
      hint: '刚记下的头几天不掉清晰度；被想起一次会重新计时。',
    },
    halfLifeDays: {
      type: 'int', default: 18, min: 2, max: 365, step: 1, unit: '天', group: '记忆（高级）', section: '遗忘',
      label: '半衰期',
      hint: '宽限期过后，清晰度每过这么多天减半（重要的事自动慢一些）。',
    },
    forgetThreshold: {
      type: 'float', default: 0.2, min: 0, max: 0.9, step: 0.05, group: '记忆（高级）', section: '遗忘',
      label: '遗忘阈值',
      hint: '清晰度低于这个值就「忘掉」（软删除，可在记忆库找回）。0 = 永不遗忘。',
    },
    weightRelevance: {
      type: 'float', default: 0.65, min: 0, max: 1, step: 0.05, group: '记忆（高级）', section: '打分',
      label: '相关性权重',
      hint: '综合分 = 相关 × 它 + 新鲜 × 下一条 + 重要 × 再下一条。默认照 0.65 / 0.20 / 0.15。',
    },
    weightFresh: {
      type: 'float', default: 0.2, min: 0, max: 1, step: 0.05, group: '记忆（高级）', section: '打分',
      label: '新鲜度权重',
      hint: '越新记的/越近被想起的分越高。它和下面「重要性权重」一起调：调大 = 更爱提最近的事。',
    },
    weightImportance: {
      type: 'float', default: 0.15, min: 0, max: 1, step: 0.05, group: '记忆（高级）', section: '打分',
      label: '重要性权重',
      hint: '模型打分高的（承诺、关键转折）分越高。调大 = 更爱提它觉得重要的事，哪怕和当下话题关系不大。',
    },
    toolRemember: {
      type: 'bool', default: true, group: '记忆（高级）', section: '工具',
      label: '允许它自己记（remember 工具）',
      hint: '开：对方说「记住这件事」时它能直接写一条。关：只靠定时整理。',
    },
    toolRecall: {
      type: 'bool', default: true, group: '记忆（高级）', section: '工具',
      label: '允许它自己翻记忆（recall_memory 工具）',
      hint: '开：它想不起来细节时可以主动查。关：只吃每轮自动注入的那几条。',
    },
  },

  setup(bot) {
    const log = bot.log || console
    const cfgOf = () => (bot.cfg && typeof bot.cfg === 'object' ? bot.cfg : {})
    const dataDirOf = () => String(bot.core?.dataDir || '.')
    const on = () => cfgOf().enabled !== false

    const store = createStore({ dir: resolveDataPath(String(cfgOf().dir || DEFAULT_DIR), dataDirOf()), log })
    const archiveDirOf = () => String(bot.core?.archive?.dir || '').trim() || path.join(dataDirOf(), 'logs', 'qq_chat')
    const adminQq = () => String(bot.core?.adminQq || '')

    // ── 作用域 / 隔离 ───────────────────────────────────────────────────
    /** 某个 chatKey 是否允许记忆（存储范围）。 */
    function scopeAllowed(chatKey) {
      const key = String(chatKey || '')
      if (!/^(group|private):\d{4,12}$/.test(key)) return false
      const cfg = cfgOf()
      if (key.startsWith('private:')) {
        const listed = (Array.isArray(cfg.privateInclude) ? cfg.privateInclude : []).map(String).filter(Boolean)
        if (listed.length) return listed.includes(key.slice('private:'.length))
        return cfg.privateAll !== false
      }
      const mode = String(cfg.groupsMode || 'none')
      if (mode === 'all') return true
      if (mode === 'list') return (Array.isArray(cfg.groupsInclude) ? cfg.groupsInclude : []).map(String).includes(key.slice('group:'.length))
      return false
    }

    const decayOpts = (now = Date.now()) => {
      const cfg = cfgOf()
      return {
        now,
        graceDays: num(cfg.graceDays, 7, 0, 90),
        halfLifeDays: num(cfg.halfLifeDays, 18, 2, 365),
        forgetThreshold: num(cfg.forgetThreshold, 0.2, 0, 0.9),
        weightRelevance: num(cfg.weightRelevance, 0.65, 0, 1),
        weightFresh: num(cfg.weightFresh, 0.2, 0, 1),
        weightImportance: num(cfg.weightImportance, 0.15, 0, 1),
      }
    }

    /** 把到了遗忘阈值的条目标成“已遗忘”（软删，可恢复）。返回本次忘掉的 id。 */
    function sweepForgotten(now = Date.now()) {
      const o = decayOpts(now)
      if (o.forgetThreshold <= 0) return []
      const gone = []
      for (const m of store.all()) {
        if (Number(m.forgottenAt) > 0) continue
        if (isForgettable(m, o)) {
          try { if (store.forget(m.id, '清晰度低于遗忘阈值')) gone.push(m.id) } catch { /* ignore */ }
        }
      }
      return gone
    }

    /**
     * 检索：只在本作用域里找（先过滤再打分 —— 隔离靠结构，不靠提示词）。
     * @returns {{hits:Array, block:string}}
     */
    function recall(chatKey, { text = '', qqList = [], topK = null, mark = true } = {}) {
      const cfg = cfgOf()
      if (!scopeAllowed(chatKey)) return { hits: [], block: '' }
      const now = Date.now()
      sweepForgotten(now)
      const o = { ...decayOpts(now), scope: chatKey, text, qqList, topK: topK || num(cfg.topK, 5, 1, 20) }
      const hits = rankMemories(store.all(), o)
      const picked = hits.map((h) => h.memory)
      const block = formatInjection(picked, { now, maxChars: num(cfg.injectMaxChars, 600, 80, 4000) })
      // 只有真进了提示词的那几条才算“被想起”（重置宽限、+1 次数）
      if (mark && block) {
        const included = picked.filter((m) => block.includes(String(m.text).slice(0, 30)))
        try { store.markRecalled(included.map((m) => m.id), now) } catch (e) { log.warn?.(`[long-memory] 记账失败: ${e.message}`) }
      }
      return { hits, block }
    }

    // ── 整理器 ──────────────────────────────────────────────────────────
    const organizer = createOrganizer({
      store,
      cfgOf,
      archiveDirOf,
      log: (m) => log.info?.(m),
      inScope: (scope) => scopeAllowed(scope),
    })

    let timer = null
    const armTimer = () => {
      if (timer) { clearInterval(timer); timer = null }
      const cfg = cfgOf()
      if (cfg.autoOrganize === false || !on()) return
      const every = num(cfg.organizeIntervalMin, 30, 5, 1440) * 60000
      timer = setInterval(() => {
        if (!on() || cfgOf().autoOrganize === false) return
        if (organizer.isRunning()) return
        organizer.run({ force: false, reason: 'timer' }).catch((e) => log.warn?.(`[long-memory] 定时整理异常: ${e.message}`))
      }, every)
      timer.unref?.()
      log.info?.(`[long-memory] 定时整理已启动：每 ${Math.round(every / 60000)} 分钟检查一次`)
    }
    // 首启别立刻抢模型：先等一个间隔（重启频繁时尤其重要）
    armTimer()

    // ── 每轮注入（核心）─────────────────────────────────────────────────
    bot.on('before-turn', (ev) => {
      try {
        if (!on() || cfgOf().injectEnabled === false) return
        if (!ev || !ev.wake) return
        if (ev.wake.kind === 'welcome') return
        const chatKey = String(ev.chatKey || '')
        if (!scopeAllowed(chatKey)) return
        if (ev._scratch && ev._scratch['long-memory:injected']) return
        const cfg = cfgOf()
        const lines = num(cfg.recallContextLines, 3, 0, 20)
        const hist = String(ev.historyBlock || '')
        const tail = lines > 0 ? hist.split('\n').slice(-lines - 1).join('\n') : ''
        const qqList = [String(ev.sender?.qq || ''), adminQq()].filter(Boolean)
        const { hits, block } = recall(chatKey, { text: `${ev.text || ''}\n${tail}`, qqList })
        if (!block) return
        ev.hint.push(block)
        if (ev._scratch) ev._scratch['long-memory:injected'] = true
        log.debug?.(`[long-memory] 注入 ${chatKey}：${hits.length} 条候选，${block.length} 字`)
      } catch (e) {
        log.warn?.(`[long-memory] 注入失败（不影响本轮）: ${e.message}`)
      }
    }, { order: 300 })

    // ── 工具 ────────────────────────────────────────────────────────────
    // 工具名不带前缀：内核会统一加 `mcp__qq__`（见 contracts.js toolPrefix）。
    if (cfgOf().toolRemember !== false) {
      bot.registerTool('remember', {
        description: '把一件值得长期记住的事记下来（对方说「记住…」、或刚说了一件重要的事时用）。'
          + '只有你和当前这个人的对话里能记；群里记的是这个群的事。不要记寒暄和一次性的闲聊。',
        parameters: {
          text: { type: 'string', required: true, description: '一句话记忆，以「我」的口吻写（≤200 字）' },
          importance: { type: 'number', description: '重要性 0~1：承诺/关键转折 0.85+，喜好/计划/强烈情绪 0.6+，日常 0.5' },
          type: { type: 'string', description: 'commitment | plan | preference | event | emotion | fact（可省）' },
          tags: { type: 'string', description: '2~4 个短标签，用逗号或空格分开（可省）' },
        },
        async execute(args) {
          const a = args || {}
          if (!on()) return { ok: false, reason: '长期记忆总开关是关的' }
          const turn = bot.currentTurn?.()
          const scope = String(turn?.chatKey || '')
          if (!scope) return { ok: false, reason: '拿不到当前会话（请重试一次）' }
          if (!scopeAllowed(scope)) return { ok: false, reason: '这个会话不在「存储范围」里，没记' }
          const text = String(a.text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
          if (!text) return { ok: false, reason: 'text 不能为空' }
          const tags = String(a.tags || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
          const types = ['commitment', 'plan', 'preference', 'event', 'emotion', 'fact']
          const type = types.includes(String(a.type || '')) ? String(a.type) : 'fact'
          const r = store.add({
            key: scope, scope, text,
            importance: Number.isFinite(Number(a.importance)) ? Number(a.importance) : 0.6,
            memoryType: type, tags, origin: 'manual', createdAt: Date.now(),
          })
          return { ok: true, id: r.id, merged: Boolean(r.merged), hint: r.merged ? '这条之前记过，已合并' : '记住了' }
        },
      })
    }
    const currentScope = () => String(bot.currentTurn?.()?.chatKey || '')
    // 默认开：只有显式关掉（false）才不注册。热改开关要重启插件才生效 —— 控制台提示里写明。
    if (cfgOf().toolRecall !== false) {
      bot.registerTool('recall_memory', {
        description: '主动翻一下自己的长期记忆（想不起对方以前说过什么时用）。只返回当前这段关系/这个群里的记忆；'
          + '每轮最重要的是已经自动注入给你的那几条，这里用于补充细节。',
        parameters: {
          query: { type: 'string', description: '想找什么（可省，省了就按最近被想起的排）' },
          limit: { type: 'number', description: '最多几条（默认 5）' },
        },
        async execute(args) {
          const a = args || {}
          if (!on()) return { ok: false, reason: '长期记忆总开关是关的' }
          const turn = bot.currentTurn?.()
          const scope = String(turn?.chatKey || '')
          if (!scope) return { ok: false, reason: '拿不到当前会话（请重试一次）' }
          if (!scopeAllowed(scope)) return { ok: false, count: 0, items: [], reason: '这个会话不在「存储范围」里' }
          const limit = num(a.limit, 5, 1, 20)
          const { hits } = recall(scope, { text: String(a.query || ''), qqList: [String(a.qq || adminQq())], topK: limit, mark: false })
          return {
            ok: true,
            count: hits.length,
            items: hits.map((h) => ({
              text: h.memory.text,
              when: agoText(h.memory.createdAt),
              importance: Math.round(Number(h.memory.importance) * 100) / 100,
              score: Math.round(h.score * 100) / 100,
            })),
            note: hits.length ? '' : '这里还没有相关记忆',
          }
        },
      })
    }
    bot.registerTool('memory_status', {
      description: '看一眼自己的长期记忆概况（记了多少条、最早最晚是什么时候）。不需要参数。',
      parameters: {},
      async execute() {
        const all = store.all().filter((m) => Number(m.forgottenAt) === 0)
        const scoped = all.filter((m) => scopeAllowed(m.scope))
        const times = scoped.map((m) => Number(m.createdAt) || 0).filter(Boolean)
        const st = store.statsOrganize()
        return {
          ok: true,
          total: all.length,
          here: scoped.length,
          oldest: times.length ? agoText(Math.min(...times)) : '',
          newest: times.length ? agoText(Math.max(...times)) : '',
          lastOrganize: st.lastOrganizeAt ? agoText(st.lastOrganizeAt) : '还没整理过',
          lastError: st.lastError || '',
        }
      },
    })

    // ── 主人命令 ────────────────────────────────────────────────────────
    bot.registerCommand('memory', {
      permission: 'master',
      description: '长期记忆：/memory status | list [N] | forget <id> | restore <id> | organize',
      async handler(ev, argv = []) {
        const sub = String(argv[0] || 'status').toLowerCase()
        const send = (t) => bot.deliver(ev.chatKey, t)
        try {
          if (sub === 'status') {
            const all = store.all()
            const alive = all.filter((m) => !Number(m.forgottenAt)).length
            const st = store.statsOrganize()
            const n = normalizeLlmConfig(cfgOf())
            const llm = n.missing.length ? `未配（缺 ${n.missing.join('/')}）` : `${n.cfg.model}`
            await send(`长期记忆：${alive} 条（已忘 ${all.length - alive} 条）｜整理接口 ${llm}｜上次整理 ${
              st.lastOrganizeAt ? agoText(st.lastOrganizeAt) : '还没跑过'}${st.lastError ? `｜上次失败：${st.lastError.slice(0, 60)}` : ''}`)
            return
          }
          if (sub === 'list') {
            const n = num(argv[1], 10, 1, 50)
            const rows = store.all().filter((m) => !Number(m.forgottenAt)).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)).slice(0, n)
            if (!rows.length) { await send('还没有记忆。'); return }
            await send(rows.map((m) => `${m.id} [${agoText(m.createdAt)}｜${Number(m.importance || 0).toFixed(2)}] ${m.text}`).join('\n'))
            return
          }
          if (sub === 'forget' || sub === 'restore') {
            const id = String(argv[1] || '').trim()
            if (!id) { await send(`用法：/memory ${sub} <id>（id 用 /memory list 看）`); return }
            const ok = sub === 'forget' ? store.forget(id, '主人手动') : store.restore(id)
            await send(ok ? `已${sub === 'forget' ? '忘掉' : '恢复'} ${id}` : `没找到 ${id}`)
            return
          }
          if (sub === 'organize') {
            await send('开始整理…（跑完我再说一句）')
            const r = await organizer.run({ force: true, reason: 'manual' })
            await send(`整理完成：${r.scopes} 个会话，新增 ${r.added} 条${r.failed.length ? `，失败 ${r.failed.length}` : ''}`)
            return
          }
          await send('用法：/memory status | list [N] | forget <id> | restore <id> | organize')
        } catch (e) {
          await send(`记忆命令出错：${e.message}`)
        }
      },
    })

    // ── 给控制台用的能力（`bot.shared.longMemory`；与旧插件的 shared 槽完全无关）──
    bot.shared.longMemory = {
      store,
      organizer,
      recall,
      scopeAllowed,
      decayOpts,
      sweep: sweepForgotten,
      status() {
        const cfg = cfgOf()
        const all = store.all()
        const alive = all.filter((m) => !Number(m.forgottenAt))
        const byScope = new Map()
        for (const m of alive) byScope.set(m.scope, (byScope.get(m.scope) || 0) + 1)
        const times = alive.map((m) => Number(m.createdAt) || 0).filter(Boolean)
        const st = store.statsOrganize()
        const n = normalizeLlmConfig(cfg.llm || {})
        const now = Date.now()
        return {
          dir: store.dir,
          entries: alive.length,
          forgotten: all.length - alive.length,
          scopes: [...byScope].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count),
          oldest: times.length ? Math.min(...times) : 0,
          newest: times.length ? Math.max(...times) : 0,
          llm: { configured: !n.missing.length, missing: n.missing, model: n.cfg.model, baseUrl: n.cfg.baseUrl, protocol: n.cfg.protocol },
          organize: { at: st.lastOrganizeAt, result: st.lastResult, error: st.lastError },
          running: organizer.isRunning(),
          autoOrganize: cfg.autoOrganize !== false,
          injectEnabled: cfg.injectEnabled !== false,
          archiveDir: archiveDirOf(),
          scopeSummary: describeScopes(cfg),
        }
      },
      /** 控制台「预览」：不落库地抽一次，看模型会记成什么。 */
      async preview({ scope = '', limit = 60 } = {}) {
        const target = String(scope || '').trim()
        if (!target) throw new Error('预览需要指定会话（scope，如 private:123456）')
        // 预览不看旧水位：那批消息可能早就整理过了，但用户就是想看“现在会记成什么”
        const r = await organizer.organizeOne({ scope: target, dryRun: true, ignoreWatermark: true })
        return r
      },
      /** 控制台「立刻整理」：可指定单个会话。 */
      async organize({ scope = '', force = true } = {}) {
        const target = String(scope || '').trim()
        if (target) return organizer.organizeOne({ scope: target })
        const r = await organizer.run({ force })
        store.save()
        return r
      },
      /** 接口连通性测试：一条最小请求。 */
      async testLlm() {
        const cfg = cfgOf()
        const r = await chatComplete({
          protocol: cfg.llmProtocol || 'openai-chat',
          baseUrl: cfg.llmBaseUrl || '',
          apiKey: cfg.llmApiKey || '',
          model: cfg.llmModel || '',
          reasoningEffort: cfg.llmReasoningEffort || '',
        }, { prompt: '只回答两个字：能通' })
        // 明确把「缺哪几项」带回控制台：报“接口不通”而不说缺什么，用户只能干瞪眼
        return {
          ok: r.ok, code: r.code || '', reason: r.reason || '', ms: r.ms || 0,
          model: String(cfg.llmModel || ''), text: r.ok ? String(r.text || '').slice(0, 40) : '',
        }
      },
      stats(m) {
        const o = decayOpts()
        return { ...scoreMemory(m, { text: '', qqList: [] }, o), effective: effectiveImportance(m, o) }
      },
    }

    function describeScopes(cfg) {
      const parts = []
      const qqs = (Array.isArray(cfg.privateInclude) ? cfg.privateInclude : []).map(String).filter(Boolean)
      if (qqs.length) parts.push(`私聊只记 ${qqs.length} 个`)
      else if (cfg.privateAll !== false) parts.push('私聊全记')
      else parts.push('私聊不记')
      const mode = String(cfg.groupsMode || 'none')
      if (mode === 'all') parts.push('群聊全记')
      else if (mode === 'list') parts.push(`群聊记 ${(Array.isArray(cfg.groupsInclude) ? cfg.groupsInclude : []).length} 个群`)
      else parts.push('群聊不记')
      return parts.join('｜')
    }

    try { bot.onDispose?.(() => { if (timer) clearInterval(timer) }) } catch { /* 老内核没有 onDispose */ }
    log.info?.(`[long-memory] 已就绪：${store.dir}（${store.size()} 条记忆）`)
  },
}
