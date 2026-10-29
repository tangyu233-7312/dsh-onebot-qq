/**
 * kernel/pacing.js — 回复节奏：**静默合批** + **主动接话**。
 *
 * 一块是时间维度、一块是"要不要自己开口"，都只有内核知道：
 *   · 合批：同群几百毫秒内的多条**被叫**消息并成一​轮（省 token，也更像"等别人说完"）
 *   · 主动接话：没人叫也偶尔接一句（群聊 / 私聊都适用）。一次"机会"= 最多一轮模型调用；
 *     到点后等一个**合适的时机**（按语境打分），拿不到就放弃这一次，绝不硬凑。
 *     命中后发一条**候选入站**给模型，由模型自己判断接不接（不调发送工具 = 不接）。
 *
 * 纪律：
 *   · 本模块**不发消息**（出站只有 deliver，由内核那一侧负责），也不碰 prompt。
 *   · 参数全部来自实例配置的 `pacing.reply` / `pacing.merge`（控制台可改，热生效）。
 *   · 主动接话轮 `wake.kind='proactive'`，出站强制不 @ 不引用（内核 decorate 钩子硬挡）。
 *   · **默认不启用主动接话**（配置里 `pacing.reply.enabled` 默认 false）：不启用时不装调度定时器、
 *     也不起念；只有显式开启后才 start/apply 起来。
 *
 * 频率口径（控制台/文档只认这一种，别再搞第二套算法）：
 *   相邻两次机会至少间隔 `minGapMs`；同时 3600s ÷ `hourlyMax` 也是间隔下限 →
 *   实际间隔 = max(minGapMs, 3600s/hourlyMax)，所以"每小时最多 N 次"是**硬上限**。
 */

const HOUR = 3600000
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const log1p = (v) => Math.log1p(Math.max(0, Number(v) || 0))

/** 主动接话默认参数：配置缺键时用它（与 config-store v2 的默认配置对齐，改默认值只改这里） */
export const REPLY_DEFAULTS = {
  enabled: false,            // 默认关：不装调度、不起念
  hourlyMax: 6,              // 每小时最多几次"机会"（0 = 关）
  minGapMs: 480000,          // 两次机会最小间隔（8 分钟）
  coldSilenceMs: 180000,     // 群安静多久算冷场（3 分钟）
  silenceEnabled: true,      // 冷场找话：关 = 只在群里有新消息时才可能接话（不定时找话）
  topicWindowMs: 600000,     // 机会窗口：到点后再等多久的合适时机（10 分钟）
  topicMinMsgs: 3,           // 窗口内至少几条消息才按"话题"挑时机（防单条消息就接）
  sensitivity: 0.45,         // 语境敏感度 0~1（越高越挑"值得接"的时机）
  maxChars: 140,             // 主动接话单条字数上限（提示用；超了照发但记日志）
  groups: [],                // 允许主动接话的群号（数组或 {"群号": true} 对象都认）
  // 静默时段（2026-10-27 线下加的，此前**只在 NAS 生产副本里**，2026-10-29 回流进仓库以生产为准）：
  // 这段时间内不起念、不主动开口；被 @ / 被叫时的正常回话不受影响。
  quietEnabled: true,        // 静默时段内不主动接话（被叫照常回）
  quietStart: 0,             // 静默开始（小时 0~23）
  quietEnd: 7,               // 静默结束（小时 0~24；小于开始 = 跨零点）
  // 私聊主动接话（2026-10-29）：对方一段时间没说话，可以自己起个话头。
  // 社交默认值比群聊保守得多 —— 私聊里"没人叫却开口"更容易显得打扰，所以间隔更长、冷场更久。
  privateEnabled: false,     // 总开关（默认关；只在「允许主动接话」也开时生效）
  privateQqs: [],            // 允许主动接话的 QQ 号（数组或 {"QQ号": true} 都认；空 = 全部好友）
  privateFriendsOnly: true,  // 只对好友开口（协议端 get_friend_list；取不到名单 = 一个都不开口）
  privateColdSilenceMs: 7200000, // 私聊冷场阈值：对方多久没说话才算"该主动找一句"（2 小时）
  privateHourlyMax: 1,       // 每个私聊每小时最多几次（内部闸门，比群聊更严）
  privateMaxPerDay: 3,       // 每个私聊每天最多几次（内部闸门）
  privateMinGapMs: 10800000, // 两次之间至少隔多久（3 小时）
  // 连续对话（2026-10-27）：被真人叫过、且它回过话之后，等一会儿把这期间的新消息塞回模型再判一次。
  // 只暴露 enabled / delayMs / bonus 三个到控制台；其余是防"自己转"的内部闸门（改这里就够了）。
  continuation: {
    enabled: false,          // 总开关（默认关；跟主动接话一起受 pacing.reply.enabled 总闸管）
    delayMs: 120000,         // 回完话后等多久再检查（默认 2 分钟）
    bonus: 1.5,              // 复用主动接话 9 个权重的"情境加分"（直接加到 logit 上）
    hourlyMax: 5,            // 每群每小时最多续几次（内部闸门）
    minGapMs: 300000,        // 两次续聊最小间隔（5 分钟，内部闸门）
    maxPerChain: 1,          // 一次唤醒最多检查几次（1 = 补一次就收手，防自转）
    requireNewMessage: true, // 它回完之后必须有人类新消息才检查（关掉容易变成自问自答）
    quoteLastHuman: false,   // 续聊是否引用最后一条人类消息（默认不引用）
  },
  style: {
    splitEnabled: true,
    splitProbability: 0.5,   // 拆条概率（0~1）
    splitMinLen: 12,
    splitDelayMs: 1000,
    splitMaxParts: 3,        // 一段回复最多拆几条（2~4）
    stickerEnabled: true,
    stickerProbability: 0.8, // 表情包概率（0~1）
  },
  weights: {                 // 语境权重（MaiBot 日志拟合值；一般不用动，改「语境敏感度」就够了）
    intercept: -1.2005,
    mentionBot: 1.5852,
    atOther: -1.1157,
    hasQuestion: 0.4807,
    placeholderOnly: -1.0281,
    selfRatio: 2.6525,
    recentCount: -0.0367,
    logSecondsSinceBot: 0.0571,
    pendingCount: 0.1012,
  },
}

/** 合批默认参数（与 config-store v2 的默认配置对齐） */
export const MERGE_DEFAULTS = {
  enabled: true,
  windowMs: 2000,         // 冷清时（上一条隔了很久）窗口 —— 单条提问要快
  windowActiveMs: 4000,   // 对话进行中（上一条 ≤ activeGapMs）等更久，收得住连发
  activeGapMs: 15000,     // 距上一条 ≤ 这么多毫秒 = 还在同一个对话里
  maxWaitMs: 6000,        // 硬上限：一群人刷屏时也必须发车
  skipIfSlowMs: 30000,    // 距上一条 > 这么多 = 不是连发，直接回答
}

/** 兴趣分：把一条群消息按权重算成 0~1 的"值得接吗"（纯函数，自检直接用） */
export function scoreFeatures(f = {}, weights = REPLY_DEFAULTS.weights) {
  const w = { ...REPLY_DEFAULTS.weights, ...(weights || {}) }
  const logit = num(w.intercept, -1.2)
    + num(w.mentionBot, 0) * (f.mentionBot ? 1 : 0)
    + num(w.atOther, 0) * (f.atOther ? 1 : 0)
    + num(w.hasQuestion, 0) * (f.hasQuestion ? 1 : 0)
    + num(w.placeholderOnly, 0) * (f.placeholderOnly ? 1 : 0)
    + num(w.selfRatio, 0) * clamp01(f.selfRatio)
    + num(w.recentCount, 0) * Math.max(0, num(f.recentCount, 0))
    + num(w.logSecondsSinceBot, 0) * log1p(f.secondsSinceBot)
    + num(w.pendingCount, 0) * Math.max(0, num(f.pendingCount, 0))
  const p = 1 / (1 + Math.exp(-logit))
  return { score: p, logit }
}

/** 语境敏感度 → 触发门槛：0% = 0.15（几乎来什么接什么）；50% = 0.50；100% = 0.85（很挑） */
export function thresholdForSensitivity(sensitivity) {
  return Math.max(0, Math.min(0.95, 0.15 + 0.7 * clamp01(sensitivity)))
}

/** 把实例配置的 `pacing` 段归一成"每块都齐全"的配置（数组/对象两种群号写法都认） */
function normalize(rawPacing) {
  const p = rawPacing && typeof rawPacing === 'object' ? rawPacing : {}
  const r = p.reply && typeof p.reply === 'object' ? p.reply : {}
  const style = r.style && typeof r.style === 'object' ? r.style : {}
  const weights = r.weights && typeof r.weights === 'object' ? r.weights : {}
  const groups = {}
  if (Array.isArray(r.groups)) {
    for (const g of r.groups) if (String(g || '').trim()) groups[String(g).trim()] = true
  } else if (r.groups && typeof r.groups === 'object') {
    for (const [g, on] of Object.entries(r.groups)) if (on === true) groups[String(g)] = true
  }
  // 私聊白名单：与 groups 同一种写法（数组或 {qq: true}）
  const privateQqs = {}
  if (Array.isArray(r.privateQqs)) {
    for (const q of r.privateQqs) if (String(q || '').trim()) privateQqs[String(q).trim()] = true
  } else if (r.privateQqs && typeof r.privateQqs === 'object') {
    for (const [q, on] of Object.entries(r.privateQqs)) if (on === true) privateQqs[String(q)] = true
  }
  const m = p.merge && typeof p.merge === 'object' ? p.merge : {}
  return {
    reply: {
      ...REPLY_DEFAULTS,
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !['style', 'weights', 'groups'].includes(k))),
      style: { ...REPLY_DEFAULTS.style, ...style },
      weights: { ...REPLY_DEFAULTS.weights, ...weights },
      continuation: { ...REPLY_DEFAULTS.continuation, ...(r.continuation && typeof r.continuation === 'object' ? r.continuation : {}) },
      groups,
      privateQqs,
    },
    merge: { ...MERGE_DEFAULTS, ...m },
  }
}

/**
 * @param {{log?: object, state: object}} deps
 *   state — ChatState（用它的 map / get()，不新开一套会话状态）
 */
export function createPacing({ log = console, state, clock = null }) {
  // clock：自检用（可传函数/对象把"现在"钉住）；运行时一律真实时间
  const nowMs = () => {
    const v = typeof clock === 'function' ? Number(clock()) : (clock && typeof clock.now === 'function' ? Number(clock.now()) : NaN)
    return Number.isFinite(v) ? v : Date.now()
  }
  let cfg = normalize(null)
  let lastLogged = ''
  let timer = null
  let onProactiveTurn = null
  let isBusy = () => false
  let wasQuiet = false      // 静默时段状态（进/出各打一行日志，别每 30s 刷）
  // 宿主注入给 pacing 的只读能力（好友名单等）。缺了就是"没有"，不抛错。
  const hostHooks = { friendList: null }

  // ── 合批 ────────────────────────────────────────────────────
  const pending = new Map()  // chatKey → { evs, firstAt, timer, run }
  const inbound = new Map()  // chatKey → [ts…]（最近 20 条入站，合批判"慢群"用）
  const outbound = new Map() // chatKey → [ts…]（最近 20 条出站，算"自己发言占比"）

  // ── 主动接话 ────────────────────────────────────────────────
  const rings = new Map()    // chatKey → [{ ts, text, mentionBot, atOther, hasQuestion, placeholderOnly, short }]
  const opp = new Map()      // chatKey → { dueAt, windowUntil, fired, missed }
  const fired = []           // 最近主动接话事件 [{ at, chatKey, gid, reason, score, sent }]
  const MAX_RING = 60
  const RING_TTL = 30 * 60000

  function pushRing(map, key, ts, max = 20) {
    const list = map.get(key) || []
    list.push(ts)
    while (list.length > max) list.shift()
    map.set(key, list)
  }

  /** 当前生效的群集合（Set<群号字符串>） */
  function allowedGroups() {
    return new Set(Object.keys(cfg.reply.groups || {}))
  }

  /** 私聊主动接话的 QQ 集合（空 = 不按人筛，靠 friendsOnly 把关） */
  function allowedPrivate() {
    return new Set(Object.keys(cfg.reply.privateQqs || {}))
  }

  // 好友名单缓存（只为"私聊只对好友开口"这件事服务；懒加载 + 5 分钟 TTL）
  let friendsCache = { at: 0, ids: new Set(), ok: false }
  async function friendIds() {
    if (friendsCache.at && nowMs() - friendsCache.at < 5 * 60000) return friendsCache
    const fn = hostHooks.friendList
    if (typeof fn !== 'function') return friendsCache
    try {
      const list = await fn()
      const ids = new Set((Array.isArray(list) ? list : [])
        .map((f) => Number(f?.user_id ?? f?.qq ?? f))
        .filter((q) => Number.isInteger(q) && q > 0))
      friendsCache = { at: nowMs(), ids, ok: true }
    } catch (e) {
      // 取不到名单 ≠ 全是好友：保持空集合，宁可这次不开口
      log.debug(`[主动接话] 好友名单取不到，私聊暂不开口: ${e.message}`)
    }
    return friendsCache
  }

  /** 这个 QQ 号能不能被主动私聊（白名单 +`好友闸门`） */
  async function privateAllowed(qq) {
    const id = String(qq || '')
    if (!/^\d{4,12}$/.test(id)) return false
    const allow = allowedPrivate()
    if (allow.size && !allow.has(id)) return false
    if (cfg.reply.privateFriendsOnly === false) return true
    const f = await friendIds()
    return f.ok && f.ids.has(Number(id))
  }

  /** 写一条进"最近群消息环"（只收允许主动接话的群；自检也用它造样本） */
  function remember(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key || !ev?.isGroup) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    const now = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const text = String(ev.text || '')
    const list = rings.get(key) || []
    list.push({
      ts: now,
      // 记下消息 id：「续聊时引用最后一条人类消息」（quoteLastHuman）要用它挂引用
      id: ev.messageId ?? null,
      text: text.slice(0, 200),
      mentionBot: !!ev.mentionedSelf,
      atOther: /@\d{4,}/.test(text),
      hasQuestion: /[?？]/.test(text),
      placeholderOnly: /^\s*\[(表情包|图片|语音|文件|卡片)/.test(text),
      short: text.replace(/[\s\p{P}\p{S}]/gu, '').length < 4,
    })
    while (list.length > MAX_RING) list.shift()
    while (list.length && now - list[0].ts > RING_TTL) list.shift()
    rings.set(key, list)
  }

  /** 记录一条入站（内核在最前面调；必须在管线之前） */
  function noteInbound(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key) return
    const ts = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const st = state.get(key)
    st.lastInboundAt = ts
    pushRing(inbound, key, ts)
    remember(ev)
  }

  /** 记录一条出站（内核的 afterSend 调；用于"自己发言占比"） */
  function noteOutbound(target) {
    const key = String(target ?? '')
    if (!key) return
    pushRing(outbound, key, nowMs())
  }

  /** 主动接话轮里真的发出了一条 → 记在最近事件上（控制台"最近"里显示已接） */
  function markSent(chatKey) {
    for (let i = fired.length - 1; i >= 0; i -= 1) {
      if (fired[i].chatKey === chatKey && !fired[i].sent && nowMs() - fired[i].at < 10 * 60000) {
        fired[i].sent = true
        return
      }
    }
  }

  function hourIntervalMs() {
    const n = Math.max(0, num(cfg.reply.hourlyMax, 0))
    return n > 0 ? HOUR / n : Infinity
  }

  function opportunityGapMs() {
    return Math.max(num(cfg.reply.minGapMs, 900000), hourIntervalMs())
  }

  /** 某群的"下一次机会"状态（懒创建；开机后第一次随机错开，避免重启瞬间一起开口） */
  function oppOf(chatKey) {
    let o = opp.get(chatKey)
    if (!o) {
      const gap = opportunityGapMs()
      const wait = Number.isFinite(gap) ? gap * (0.4 + Math.random() * 0.6) : Infinity
      o = { dueAt: Number.isFinite(wait) ? nowMs() + wait : Infinity, windowUntil: 0, fired: 0, missed: 0 }
      opp.set(chatKey, o)
    }
    return o
  }

  /** 从宿主事件/环算兴趣分（给自检与日志看；也供外部插件调用） */
  function interestFor(ev = {}) {
    const key = String(ev.chatKey ?? '')
    const st = key ? state.get(key) : { lastSendAt: 0 }
    const now = nowMs()
    const list = (rings.get(key) || []).filter((m) => now - m.ts < 5 * 60000)
    const recentOut = (outbound.get(key) || []).filter((t) => now - t < 5 * 60000)
    const total = list.length + recentOut.length
    const features = {
      mentionBot: !!ev.mentionedSelf,
      atOther: /@\d{4,}/.test(String(ev.text ?? '')),
      hasQuestion: /[?？]/.test(String(ev.text ?? '')),
      placeholderOnly: /^\s*\[(表情包|图片|语音|文件|卡片)/.test(String(ev.text ?? '')),
      selfRatio: total > 0 ? recentOut.length / total : 0,
      recentCount: list.length,
      secondsSinceBot: (now - Number(st.lastSendAt || 0)) / 1000,
      pendingCount: isBusy(key) ? 1 : 0,
    }
    return { ...scoreFeatures(features, cfg.reply.weights), features }
  }

  /** 到点后进入"窗口"；窗口过期 = 这次机会作废（宁可少说，不硬凑） */
  function ensureWindow(chatKey, now) {
    const o = oppOf(chatKey)
    if (now < o.dueAt) return null
    if (!o.windowUntil) o.windowUntil = now + Math.max(60000, num(cfg.reply.topicWindowMs, 600000))
    if (now > o.windowUntil) {
      o.windowUntil = 0
      o.dueAt = now + opportunityGapMs()
      o.missed += 1
      log.info(`[主动接话] ${chatKey} 本次没有合适时机，放弃（下次约 ${Math.round(opportunityGapMs() / 60000)} 分钟后）`)
      return null
    }
    return o
  }

  /**
   * 是否处于「静默时段」（回流自 NAS 生产副本，2026-10-27）。
   *
   * 为什么放内核而不是写死人设：主动接话是**内核调度**决定的，跟模型无关；
   * 人设只能劝模型，拦不住定时器起念。这里拦在 fire() 之前才真的不开口。
   *
   * 支持跨零点：quietStart > quietEnd 时（如 23 → 7）判断为 `h >= s || h < e`。
   * 起止相同 = 不启用静默。
   * @param {number} [now] 毫秒时间戳（自检可钉住时间）
   */
  function inQuietHours(now) {
    if (cfg.reply.quietEnabled === false) return false
    const s = Math.max(0, Math.min(23, Math.round(num(cfg.reply.quietStart, 0))))
    const e = Math.max(0, Math.min(24, Math.round(num(cfg.reply.quietEnd, 7))))
    if (s === e) return false
    const h = new Date(Number.isFinite(now) ? now : nowMs()).getHours()
    return s < e ? (h >= s && h < e) : (h >= s || h < e)
  }

  /** 真正起一轮主动接话：先记账（防止模型/失败反复触发），再交给内核起回合 */
  function fire(chatKey, gid, reason, score) {
    // 静默时段：不主动开口（被叫时的回话不走这里，不受影响）
    if (inQuietHours()) {
      log.debug(`[主动接话] ${chatKey} 处于静默时段，跳过（${reason}）`)
      return
    }
    const o = oppOf(chatKey)
    const now = nowMs()
    o.windowUntil = 0
    o.dueAt = now + opportunityGapMs()
    o.fired += 1
    // kind：这条机会是群（group）还是私聊（private）——控制台"最近"与统计都按它分开展示
    const isPrivate = String(chatKey).startsWith('private:')
    fired.push({ at: now, chatKey, gid, kind: isPrivate ? 'private' : 'group', reason, score: Number(score) || 0, sent: false })
    while (fired.length > 30) fired.shift()
    log.info(`[主动接话] ${chatKey} 起念（${isPrivate ? '私聊·' : ''}${reason === 'silence' ? '冷场找话' : '话题合适'}，兴趣分 ${(Number(score) * 100).toFixed(0)}%）`)
    if (typeof onProactiveTurn !== 'function') return
    Promise.resolve()
      .then(() => onProactiveTurn({ chatKey, groupId: gid, isGroup: !isPrivate, reason, score }))
      .catch((e) => log.error(`[主动接话] 起回合失败 ${chatKey}: ${e.stack || e.message}`))
  }

  /**
   * 一条**没唤醒机器人**的群消息进来后：看看要不要把它捡成"接话时机"。
   * 内核在管线跑完后调（有 wake 的消息不进来，避免被叫时同时主动插话）。
   */
  function consider(ev) {
    if (!cfg.reply.enabled || num(cfg.reply.hourlyMax, 0) <= 0) return
    if (inQuietHours()) return // 静默时段：连评分都不做，省算力（私聊也一起停）
    if (!ev?.isGroup) return
    const key = String(ev.chatKey ?? '')
    if (!key) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    if (isBusy(key)) return // 这个群正在被叫的一轮里，不抢
    if (contPending(key)) return // 已经有续聊排队，别抢同一时刻
    const now = nowMs()
    const o = ensureWindow(key, now)
    if (!o) return
    const text = String(ev.text || '').trim()
    // 窗口里至少得有几条消息才按"话题"挑时机：单条孤零零的消息不接（冷场路径另算）。
    // 私聊例外：一对一对话本来就话少，n 句话就是一整段对话 —— 只要有一条就够判。
    const need = Math.max(1, ev.isGroup ? num(cfg.reply.topicMinMsgs, 3) : 1)
    const recent = (rings.get(key) || []).filter((m) => now - m.ts < Math.max(60000, num(cfg.reply.topicWindowMs, 600000) / 2))
    if (recent.length < need) return
    const last = recent[recent.length - 1]
    // 纯表情/图/太短的：不按话题接（分值也会很低，这里先挡一道省计算）
    if (!text || last?.placeholderOnly || last?.short) return
    const { score, logit } = interestFor(ev)
    const threshold = thresholdForSensitivity(cfg.reply.sensitivity)
    log.debug(`[主动接话] ${key} 兴趣分 ${(score * 100).toFixed(0)}% / 门槛 ${(threshold * 100).toFixed(0)}%（logit ${logit.toFixed(2)}）`)
    if (score >= threshold) fire(key, gid, 'topic', score)
  }

  /** 冷场找话是否开启（关 = 只由入站消息驱动「话题合适时接话」，不再定时找话）。 */
  const silenceOn = () => cfg.reply.silenceEnabled !== false

  // ── 连续对话（2026-10-27）────────────────────────────────────
  // 只做一件事：真人叫过它、它也回过话之后，隔一会儿把**这期间的新消息**塞回模型再判一次
  // "要不要补一句"。判据不另起一套：续聊分 = sigmoid(主动接话那 9 个权重算出的 logit + bonus)。
  // 防"自己转"：只由真人唤醒登记；合成轮（proactive/continuation/welcome）不登记；
  //            一次链路默认只检查 1 次；且必须有人类新消息（requireNewMessage）。
  const cont = new Map()      // chatKey → { gid, armedAt, lastReplyAt, dueAt, chain, lastFireAt }
  const contFires = new Map() // chatKey → [ts…]（每群每小时续聊次数）

  /** 它上次回复之后，群里又有几条人类消息 */
  function humanMsgsSince(chatKey, since) {
    return (rings.get(chatKey) || []).filter((m) => m.ts > Number(since || 0))
  }

  /** 真人唤醒时登记一条"续聊链"（同一群再来一次就重置，不叠加） */
  function noteWake(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key || !ev?.isGroup) return
    if (!cfg.reply.enabled || !cfg.reply.continuation.enabled) return
    const kind = String(ev?.wake?.kind ?? '')
    if (!['at', 'quote', 'keyword', 'followup'].includes(kind)) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    cont.set(key, { gid, armedAt: nowMs(), lastReplyAt: 0, dueAt: 0, chain: 0, lastFireAt: 0 })
  }

  /** 它真的发出了一条回复 → 从这一刻开始计时（主动/续聊/欢迎轮不参与） */
  function noteReplySent(chatKey, turnCtx) {
    const key = String(chatKey ?? '')
    const c = cont.get(key)
    if (!c) return
    if (['proactive', 'continuation', 'welcome'].includes(String(turnCtx?.wakeKind ?? ''))) return
    c.lastReplyAt = nowMs()
    if (c.chain < num(cfg.reply.continuation.maxPerChain, 1)) {
      c.dueAt = c.lastReplyAt + num(cfg.reply.continuation.delayMs, 120000)
    }
  }

  /** 该群是否有待执行的续聊（主动接话两条路径要避让，别同一时刻说两句） */
  function contPending(chatKey) {
    const c = cont.get(String(chatKey))
    return Boolean(c && c.dueAt > 0)
  }

  /** 到点检查：有人类新消息 + 续聊分够 → 起一轮；否则记日志、链结束 */
  function tickContinuation(now) {
    const cf = cfg.reply.continuation
    if (!cfg.reply.continuation.enabled) return
    for (const [key, c] of [...cont]) {
      if (now - c.armedAt > 10 * 60000) { cont.delete(key); continue } // 链活太久（唤醒 10 分钟后语境已变）
      if (!c.dueAt || now < c.dueAt) continue
      if (!allowedGroups().has(String(c.gid)) || isBusy(key)) continue
      if (c.chain >= num(cf.maxPerChain, 1)) { cont.delete(key); continue }
      const fires = (contFires.get(key) || []).filter((t) => now - t < HOUR)
      contFires.set(key, fires)
      if (fires.length >= num(cf.hourlyMax, 5)) { cont.delete(key); continue }
      if (now - c.lastFireAt < num(cf.minGapMs, 300000)) continue
      const humans = humanMsgsSince(key, c.lastReplyAt)
      if (cf.requireNewMessage && humans.length === 0) {
        log.info(`[连续对话] ${key} 没人接话 → 不检查（链结束）`)
        cont.delete(key)
        continue
      }
      const last = humans[humans.length - 1]
      if (!last || last.placeholderOnly || last.short) {
        log.info(`[连续对话] ${key} 最后一条是媒体/太短 → 跳过`)
        cont.delete(key)
        continue
      }
      // 复用主动接话的权重：结构不变的 logit + 情境加分
      const { logit } = interestFor({ chatKey: key, isGroup: true, groupId: c.gid, text: last.text, mentionedSelf: last.mentionBot })
      const p = 1 / (1 + Math.exp(-(logit + num(cf.bonus, 1.5))))
      const threshold = thresholdForSensitivity(cfg.reply.sensitivity)
      if (p < threshold) {
        log.info(`[连续对话] ${key} 续聊分 ${(p * 100).toFixed(0)}% < 门槛 ${(threshold * 100).toFixed(0)}% → 跳过`)
        cont.delete(key)
        continue
      }
      c.chain += 1
      c.lastFireAt = now
      fires.push(now)
      // 「引用最后一条人类消息」：只有开关打开、且这条消息有 id 时才带
      const quoteTo = cf.quoteLastHuman ? (last.id ?? null) : null
      log.info(`[连续对话] ${key} 起念（续聊分 ${(p * 100).toFixed(0)}%，新消息 ${humans.length} 条，第 ${c.chain}/${num(cf.maxPerChain, 1)} 次${quoteTo ? '，引用 ' + quoteTo : ''}）`)
      if (typeof onProactiveTurn === 'function') {
        Promise.resolve()
          .then(() => onProactiveTurn({ chatKey: key, groupId: c.gid, reason: 'continuation', score: p, humanMsgs: humans.length, quoteTo }))
          .catch((e) => log.error(`[连续对话] 起回合失败 ${key}: ${e.stack || e.message}`))
      }
      // 默认只检查一次：起过就结束；要再续必须等新的真人唤醒
      if (c.chain >= num(cf.maxPerChain, 1)) cont.delete(key)
      else c.dueAt = now + num(cf.delayMs, 120000)
    }
  }

  /** 冷场：到点了、群又安静够久 → 直接起一轮"找话"（不等消息） */
  function tickSilence(now) {
    if (!cfg.reply.enabled || num(cfg.reply.hourlyMax, 0) <= 0 || !onProactiveTurn) return
    // 静默时段：不起念，并把「到点时间」一路推后，
    // 免得静默一结束就补发一条（用户要的是"这段时间别说话"，不是"攒着说"）。
    if (inQuietHours(now)) {
      if (!wasQuiet) {
        wasQuiet = true
        log.info(`[主动接话] 进入静默时段（${num(cfg.reply.quietStart, 0)}:00~${num(cfg.reply.quietEnd, 7)}:00），暂停主动接话`)
      }
      for (const gid of allowedGroups()) {
        const o = oppOf(`group:${gid}`)
        o.windowUntil = 0
        o.dueAt = now + opportunityGapMs()
      }
      for (const qq of allowedPrivate()) {
        const o = oppOf(`private:${qq}`)
        o.windowUntil = 0
        o.dueAt = now + opportunityGapMs()
      }
      return
    }
    if (wasQuiet) {
      wasQuiet = false
      log.info('[主动接话] 离开静默时段，重新计时')
    }
    for (const gid of allowedGroups()) {
      const key = `group:${gid}`
      const st = state.get(key)
      const silence = now - Number(st.lastInboundAt || 0)
      if (silence < num(cfg.reply.coldSilenceMs, 300000)) continue
      if (isBusy(key) || contPending(key)) continue // 有续聊待执行时先让路
      const o = ensureWindow(key, now)
      if (!o) continue
      o.windowUntil = now // 立即用掉窗口，避免下个 tick 重复
      fire(key, gid, 'silence', 1)
    }
    if (privateEnabled()) tickPrivateSilence(now)
  }

  // ── 私聊主动接话（2026-10-29）────────────────────────────────
  // 与群聊的区别：私聊没有"上下文在流动"可判断，只剩"对方多久没说话"这一个信号。
  // 所以只看冷场 + 自己的三条闸门（每小时 / 每天 / 最小间隔），不参与话题打分。
  const privateRings = new Map() // qq → [ts…]（最近几个 tick 的判定记录，只用于控制台/日志）

  /** 私聊主动接话总开关：外层总闸 + 私聊开关 */
  function privateEnabled() {
    return cfg.reply.enabled !== false && cfg.reply.privateEnabled === true
  }

  /** 单个私聊的配额是否还有（每小时 / 每天 / 最小间隔） */
  function privateQuotaOk(qq, now) {
    const fires = (privateRings.get(qq) || []).filter((t) => now - t < 24 * HOUR)
    privateRings.set(qq, fires)
    const lastHour = fires.filter((t) => now - t < HOUR).length
    if (lastHour >= Math.max(0, num(cfg.reply.privateHourlyMax, 1))) return false
    if (fires.length >= Math.max(0, num(cfg.reply.privateMaxPerDay, 3))) return false
    const last = fires[fires.length - 1] || 0
    if (last && now - last < Math.max(60000, num(cfg.reply.privateMinGapMs, 3 * HOUR))) return false
    return true
  }

  /** 私聊冷场轮询：对每个"说过话的私聊"看是不是静太久了 */
  function tickPrivateSilence(now) {
    const coldMs = Math.max(60000, num(cfg.reply.privateColdSilenceMs, 2 * HOUR))
    // state.keys() 是 ChatState 的 map 键（group:xxx / private:xxx）；没有 keys() 的桩一律不扫
    const allKeys = typeof state.keys === 'function' ? [...state.keys()] : []
    for (const key of allKeys) {
      if (!String(key).startsWith('private:')) continue
      const qq = String(key).slice(8)
      const st = state.get(key)
      const lastAt = Number(st.lastInboundAt || 0)
      // 从没说过话 / 刚被回复过 都从"它时间线"算：取最近一次入站与出站里较晚的那个
      const lastTouch = Math.max(lastAt, Number(st.lastSendAt || 0))
      if (!lastTouch || now - lastTouch < coldMs) continue
      if (isBusy(key) || contPending(key)) continue
      if (!privateQuotaOk(qq, now)) continue // 配额便宜的检查放前面，好友名单要联网所以放后面
      if (typeof onProactiveTurn !== 'function') continue
      // 当天最晚一条由核心循环统一判（这里只筛选"静太久了"）
      privateBeforeFire(qq, key, now)
    }
  }

  /**
   * 私聊起念前的最后一道闸：好友名单是异步的 → 先在这里 await，通过了再 fire。
   * 用"占位时间戳"防止同一 tick 里重复排（每次 tick 30 秒，重复排队会连发）。
   */
  let privatePending = new Set()
  function privateBeforeFire(qq, key, now) {
    if (privatePending.has(qq)) return
    privatePending.add(qq)
    Promise.resolve()
      .then(() => privateAllowed(qq))
      .then((ok) => {
        if (!ok) {
          log.debug(`[主动接话] 私聊 ${key} 不在白名单/已不是好友 → 不开口`)
          return
        }
        // 先记一条"已开口"的时间戳（配额就是靠它算的），再起回合
        const stamps = privateRings.get(qq) || []
        stamps.push(nowMs())
        privateRings.set(qq, stamps)
        fire(key, qq, 'private-silence', 1)
      })
      .catch((e) => log.error(`[主动接话] 私聊起念失败 ${key}: ${e.stack || e.message}`))
      .finally(() => { privatePending.delete(qq) })
  }

  /** 定时器入口：冷场找话（群 + 私聊，可选）+ 连续对话（可选） */
  function tick() {
    const now = nowMs()
    // 群冷场开关关掉时，私聊冷场仍要单独跑（两者是不同场景，不该互相拖累）
    if (silenceOn()) tickSilence(now)
    else if (privateEnabled()) tickPrivateSilence(now)
    tickContinuation(now)
  }

  /**
   * 装好回调并按需启动调度：**主动接话默认关**（`enabled:false`）时只记回调、不装定时器，
   * 免得"关着却每 30s 空跑一次"。配置热改成开启后 apply() 会重新 start。
   */
  function start(opts = {}) {
    if (typeof opts.onProactiveTurn === 'function') onProactiveTurn = opts.onProactiveTurn
    if (typeof opts.isBusy === 'function') isBusy = opts.isBusy
    if (typeof opts.friendList === 'function') hostHooks.friendList = opts.friendList
    if (timer) clearInterval(timer)
    timer = null
    if (!proactiveEnabled()) return null
    // 冷场找话、连续对话、私聊冷场三者都关掉时不需要定时器：接话机会只由入站消息触发（topic 路径）
    // 私聊冷场挂在 tickSilence 里，但它独立于「群冷场找话」开关 —— 两个都要算进"要不要装定时器"
    const needPrivate = privateEnabled() && cfg.reply.privateFriendsOnly === false // 好友闸门要联网，放 tick 里做
    if (!silenceOn() && !cfg.reply.continuation.enabled && !needPrivate) return null
    timer = setInterval(() => {
      try { tick() } catch (e) { log.error(`[主动接话] tick 异常: ${e.message}`) }
    }, 30000)
    timer.unref?.()
    return timer
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    for (const key of [...pending.keys()]) flush(key)
  }

  // ── 静默合批（与旧版同一套语义，别动） ──────────────────────
  /**
   * 把一轮"已唤醒"的提交推迟 windowMs，窗口内的后续唤醒消息并进来。
   * @param {object} ev 已唤醒事件（ev.wake 有值）
   * @param {(ev:object)=>Promise} run 真正执行的入口
   */
  function submit(ev, run) {
    const c = cfg.merge
    // 主动接话轮与入群欢迎轮都是"系统自己发起的轮"，不和群友消息合批（会被延迟/串进普通对话）
    if (!c.enabled || !ev?.isGroup || ev.wake?.kind === 'proactive' || ev.wake?.kind === 'welcome') return run(ev)
    const key = String(ev.chatKey)
    const ring = inbound.get(key) || []
    const prev = ring.length >= 2 ? ring[ring.length - 2] : 0
    const now = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const gap = prev > 0 ? now - prev : 0
    if (gap > num(c.skipIfSlowMs, 30000)) return run(ev)

    const slot = pending.get(key) || { evs: [], firstAt: nowMs(), timer: null, run }
    slot.evs.push(ev)
    slot.run = run
    if (slot.timer) clearTimeout(slot.timer)
    const baseWait = gap > 0 && gap <= num(c.activeGapMs, 15000)
      ? num(c.windowActiveMs, 4000)
      : num(c.windowMs, 800)
    const waited = nowMs() - slot.firstAt
    const wait = Math.max(0, Math.min(baseWait, num(c.maxWaitMs, 6000) - waited))
    slot.timer = setTimeout(() => flush(key), wait)
    slot.timer.unref?.()
    pending.set(key, slot)
    return undefined
  }

  /** 把缓冲里的一批并成一条事件，交给最近一次提交的 run */
  function flush(key) {
    const slot = pending.get(key)
    if (!slot) return
    pending.delete(key)
    if (slot.timer) clearTimeout(slot.timer)
    const evs = slot.evs
    const last = evs[evs.length - 1]
    if (!last) return
    if (evs.length > 1) {
      const head = evs.slice(0, -1)
        .map((e) => `[${e.sender?.card || e.sender?.name || e.sender?.qq || '?'}]: ${e.text || ''}`)
        .join('\n')
      last.text = `${head}\n${last.text || ''}`.trim()
      const hints = []
      for (const e of evs) for (const h of (e.hint || [])) if (!hints.includes(h)) hints.push(h)
      last.hint = hints
      const parts = evs.flatMap((e) => (Array.isArray(e.imageParts) ? e.imageParts : []))
      const paths = evs.flatMap((e) => (Array.isArray(e.imagePaths) ? e.imagePaths : []))
      if (parts.length) last.imageParts = parts
      if (paths.length) last.imagePaths = [...new Set(paths)]
      const quoted = evs.map((e) => e._scratch?.quoteText).find(Boolean)
      if (quoted && !last._scratch?.quoteText) last._scratch.quoteText = quoted
      last._scratch.mergedCount = evs.length
      log.info(`[合批] ${key} ${evs.length} 条 → 1 轮（等 ${nowMs() - slot.firstAt}ms）`)
    }
    Promise.resolve(slot.run(last)).catch((e) => log.error(`[合批] 执行失败 ${key}: ${e.stack || e.message}`))
  }

  // ── 配置 / 状态 ─────────────────────────────────────────────
  function apply(pacingCfg) {
    cfg = normalize(pacingCfg)
    // 群集合变了：清掉不再允许的群的调度状态（防止旧群继续按旧间隔起念）
    const allow = allowedGroups()
    // 私聊 key（private:xxx）不归群白名单管，只清 group:*，否则私聊机会每改一次配置就被抹掉
    const staleGroup = (key) => String(key).startsWith('group:') && !allow.has(String(key).replace(/^group:/, ''))
    for (const key of [...opp.keys()]) {
      if (staleGroup(key)) opp.delete(key)
    }
    for (const key of [...rings.keys()]) {
      if (staleGroup(key)) rings.delete(key)
    }
    // 开关热更新：开了就装调度，关了就连定时器一起停（不空跑）
    if (proactiveEnabled() && !timer && onProactiveTurn) start()
    else if (!proactiveEnabled() && timer) { clearInterval(timer); timer = null }
    const r = cfg.reply
    // 同一份配置只打一行（启动时 apply + 控制台热改可能重复触发）
    const stamp = JSON.stringify([r, cfg.merge])
    if (stamp === lastLogged) return cfg
    lastLogged = stamp
    try {
      log.info(`节奏：主动接话=${r.enabled && r.hourlyMax > 0 ? '开' : '关'}`
        + `（每小时≤${r.hourlyMax}次，间隔≥${Math.round(opportunityGapMs() / 60000)}分钟，`
        + (silenceOn() ? `冷场≥${Math.round(num(r.coldSilenceMs, 300000) / 60000)}分钟` : '只在群里有新消息时接')
        + `，敏感度${Math.round(clamp01(r.sensitivity) * 100)}%，群${Object.keys(r.groups).join('/') || '（无）'}`
        + (privateEnabled()
          ? `，私聊=开（冷场≥${Math.round(num(r.privateColdSilenceMs, 2 * HOUR) / 60000)}分钟，每私聊≤${r.privateHourlyMax}次/时、${r.privateMaxPerDay}次/天，${Object.keys(r.privateQqs || {}).join('/') || '全部好友'}）`
          : '，私聊=关')
        + '）'
        + ` 合批=${cfg.merge.enabled ? '开' : '关'}(${num(cfg.merge.windowMs, 800)}/${num(cfg.merge.windowActiveMs, 4000)}ms 冷清/在聊)`)
    } catch { /* 日志失败不影响配置生效 */ }
    return cfg
  }

  /** 主动接话总开关（控制台/内核用；关掉 = 连"要不要插一句"的念头都不起） */
  function proactiveEnabled() {
    return cfg.reply.enabled !== false && num(cfg.reply.hourlyMax, 0) > 0
  }

  /** 允许主动接话的群号列表（给内核开机播种"最后一条消息时间"用） */
  function allowedGroupIds() {
    return [...allowedGroups()]
  }

  /** 控制台状态：本小时用了几次 / 最近几次的去向（"已接 / 没发"） */
  function stats() {
    const now = nowMs()
    const hourAgo = now - HOUR
    const groups = [...allowedGroups()].map((gid) => {
      const key = `group:${gid}`
      const list = fired.filter((e) => e.chatKey === key && e.at > hourAgo)
      const last = [...fired].reverse().find((e) => e.chatKey === key)
      const o = opp.get(key)
      return {
        groupId: gid,
        used: list.length,
        max: Math.max(0, num(cfg.reply.hourlyMax, 0)),
        lastAt: last ? last.at : null,
        lastSent: last ? !!last.sent : null,
        lastReason: last ? last.reason : null,
        lastScore: last ? last.score : null,
        nextAt: o && Number.isFinite(o.dueAt) ? o.dueAt : null,
      }
    })
    return {
      ok: true,
      enabled: proactiveEnabled(),
      quiet: {
        enabled: cfg.reply.quietEnabled !== false,
        start: num(cfg.reply.quietStart, 0),
        end: num(cfg.reply.quietEnd, 7),
        active: inQuietHours(),
      },
      hourlyMax: Math.max(0, num(cfg.reply.hourlyMax, 0)),
      minGapMs: opportunityGapMs(),
      sensitivity: clamp01(cfg.reply.sensitivity),
      threshold: thresholdForSensitivity(cfg.reply.sensitivity),
      // 连续对话：只在控制台"最近状态"里显示待执行/本小时次数（UI 只暴露 3 个可调项）
      continuation: {
        enabled: cfg.reply.continuation.enabled === true,
        threshold: thresholdForSensitivity(cfg.reply.sensitivity),
        pending: [...cont.keys()].length,
        firedThisHour: [...contFires.values()].reduce((n, list) => n + list.filter((t) => now - t < HOUR).length, 0),
      },
      // 私聊主动接话：开关 + 最近开口过的私聊（控制台「主动接话」页展示）
      private: {
        enabled: privateEnabled(),
        friendsOnly: cfg.reply.privateFriendsOnly !== false,
        qqs: [...allowedPrivate()],
        coldSilenceMs: Math.max(60000, num(cfg.reply.privateColdSilenceMs, 2 * HOUR)),
        hourlyMax: Math.max(0, num(cfg.reply.privateHourlyMax, 1)),
        maxPerDay: Math.max(0, num(cfg.reply.privateMaxPerDay, 3)),
        minGapMs: Math.max(60000, num(cfg.reply.privateMinGapMs, 3 * HOUR)),
        recent: fired.filter((e) => e.kind === 'private').slice(-6).reverse().map((e) => ({
          at: e.at, qq: e.gid, reason: e.reason, sent: !!e.sent,
        })),
      },
      groups,
      recent: fired.slice(-8).reverse().map((e) => ({
        at: e.at, kind: e.kind || 'group', groupId: e.gid, reason: e.reason, sent: !!e.sent, score: e.score,
      })),
    }
  }

  return {
    apply, start, stop,
    noteInbound, noteOutbound,
    noteWake, noteReplySent, // 连续对话的两个钩子（内核在唤醒/出站时调）
    markProactiveSent: markSent,
    submit, flush,
    consider,
    interestFor,
    proactiveEnabled, allowedGroupIds, stats,
    privateEnabled, allowedPrivateQqs: () => [...allowedPrivate()], privateAllowed,
    nextOpportunityAt: (chatKey) => {
      const o = opp.get(String(chatKey))
      return o && Number.isFinite(o.dueAt) ? o.dueAt : null
    },
    tickNow: tick,
    get config() { return cfg },
  }
}
