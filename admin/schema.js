/**
 * admin/schema.js — 控制面的**描述表**（核心开关 + 各子插件 configSchema 汇总）。
 *
 * 设计（沿用现网 admin-api 最值钱的那部分：描述表驱动）：
 *   · 加一个核心开关 = 下面 CORE_CONTROLS 加一行；
 *   · 加一个子插件开关 = 只改插件自己的 configSchema —— 这里、控制台 UI 都不用动；
 *   · 控制台只能改**白名单里的键**：`readValue/writeValue` 按 key 找到注册项，找不到就抛错。
 *
 * 控制台页面归属规则（2026-10-20 起）：
 *   · 目标：**一个子插件 = 一个页面**（生图凭据也归 imagegen，虽然仍存 `credentials.gptImage.*`）；
 *   · `OTHER_GROUPS`：权限/门禁/文件/发图/头像 五组统一并到「其他」页（低频配置集中放）；
 *   · `PERSONA_GROUPS`：跟随「人设」显示在「总览」页的分组（当前为空：句池/唤醒 已各自成页）。
 *
 * 键与配置路径的映射（v2 配置结构见 kernel/config-store.js）：
 *   · 核心项：`key` 就是 raw 配置里的点路径（`pacing.reply.hourlyMax`、`onebot.wsUrl`…）；
 *   · 子插件项：`key = <pluginId>.<field>`，落到 `raw.pluginConfig[<pluginId>][<field>]`。
 *
 * 单位口径（**两套，别混**）：
 *   · 核心项：raw 存“底层单位”（毫秒 / 0~1 分数），面板显示“人话单位”（分钟 / 秒 / %）；
 *     `scale` = 面板值 × scale = 存储值，换算只在 readValue/writeValue 的边界做一次。
 *   · 子插件项：raw 里**本来就存面板单位**（秒 / % —— 各插件 configSchema 的 default 就是面板值），
 *     所以这里**不做 scale 换算**；`scale` 只是“× scale = 插件内部基准单位”的说明字段，前端不读。
 *
 * 秘密字段（onebot token）读出来给占位符，写回占位符 = 不改。
 */

/** 秘密值的占位符：读 schema 时回显它而不是真值；把它原样写回来 = 不修改。 */
export const SECRET_MASK = '••••••••'

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 点路径读取（`a.b.c` 或数组）。 */
export function getPath(obj, dotted) {
  const parts = Array.isArray(dotted) ? dotted : String(dotted).split('.')
  return parts.reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/** 点路径写入（中间层不存在就建对象）。 */
export function setPath(obj, dotted, value) {
  const parts = Array.isArray(dotted) ? dotted.slice() : String(dotted).split('.')
  const last = parts.pop()
  const target = parts.reduce((o, k) => (o[k] == null ? (o[k] = {}) : o[k]), obj)
  target[last] = value
  return obj
}

/** 数字保留 3 位小数（面板值显示用；避免 0.1*3 这类浮点尾巴）。 */
const round3 = (n) => Math.round(n * 1000) / 1000
const round6 = (n) => Math.round(n * 1e6) / 1e6

/**
 * 子插件里**由内核权威配置接管**的字段：不在控制台聚合里渲染（插件字段保留作 fallback）。
 * 拆条 / 表情概率的权威存储是顶层 `pacing.reply.style`（内核 reload 时同步进插件 cfg），
 * 两边都给控件会互相覆盖，所以子插件侧只保留配置、不暴露控件。
 */
const HIDDEN_PLUGIN_FIELDS = {
  'persona-voice': new Set(['splitReplyEnabled', 'splitReplyProbability', 'splitReplyMinLen', 'splitReplyDelayMs', 'splitReplyMaxParts']),
  stickers: new Set(['offerPercent']),
}

// ============================================================
// 注册表 ①：核心开关（映射 raw 配置顶层键）
// ============================================================

/**
 * @typedef {object} ControlDef
 * @property {string} key       面板/白名单键 = raw 配置点路径
 * @property {string} group     控制台页签（首次出现顺序 = 标签页顺序）
 * @property {'bool'|'int'|'float'|'str'|'text'|'enum'|'group'|'info'} type
 * @property {string} label
 * @property {string} [unit]    面板单位（分钟/秒/%/字/毫秒/次）
 * @property {number} [scale]   面板值 × scale = 存储值（只在读写边界换算）
 * @property {number} [min]     面板值下限
 * @property {number} [max]     面板值上限
 * @property {number} [step]
 * @property {Array|object[]} [options]
 * @property {string} [hint]
 * @property {unknown} [default] 配置缺键时的默认值（存储单位）
 * @property {boolean} [secret] 秘密字段：面板只回显占位符
 * @property {string} [text]  `type:'info'` 的说明正文（原样给前端，不参与读写）
 * @property {string[]} [suggestions] str 控件的输入建议（前端渲染成 datalist）
 */
export const CORE_CONTROLS = [
  // ── 群聊页顶部：主人 QQ（全局唯一身份）──────────────────────
  {
    key: 'adminQq', group: '群聊', type: 'int', label: '主人 QQ',
    min: 1, max: 99999999999, step: 1, default: 0,
    hint: '必填：只有这个 QQ 的私聊豁免出口脱敏，群里的“主人指令”也按它判。改完热生效（下一条消息起）。',
  },

  // ── OneBot 连接（对接任意 OneBot v11 协议端）──────
  {
    key: 'info.onebot', group: 'OneBot 连接', type: 'info',
    text: '分三步接上 OneBot 协议端（任意 OneBot v11 实现；配置键是 onebot.*，与具体实现无关）：\n'
      + '① 先在本机装好并启动协议端并登录 QQ（各实现方式不同：有的自己拉起 QQ，有的注入已在运行的 QQ 进程，详见 docs/安装与卸载.md §二）；\n'
      + '② 在协议端配置里打开「WebSocket 服务端」（常见默认 ws://127.0.0.1:3001）和「HTTP 服务端」（常见默认 http://127.0.0.1:3000）；有 token 就一并填到下面（部分实现强制要 token，两个都要填）；\n'
      + '③ 填好地址/token 后先让输入框失焦（离开输入框就会保存），再点「运维」页的「🔌 测试 OneBot 连接」：出现 ✅ 就说明通了（测的是已保存的配置）。\n'
      + '⚠️ 两个地址都在同一台机器时用 127.0.0.1 即可；跨机器要把 127.0.0.1 换成协议端那台机器的 IP，并确认防火墙放行端口。',
  },
  {
    key: 'onebot.wsUrl', group: 'OneBot 连接', type: 'str', label: 'OneBot v11 正向 WS 地址',
    default: 'ws://127.0.0.1:3001',
    hint: '协议端的 WebSocket 服务地址（入站消息从这里来）。改了会重新连接。',
  },
  {
    key: 'onebot.wsToken', group: 'OneBot 连接', type: 'str', label: 'WS Token', secret: true, default: '',
    hint: '可留空。填了就是 OneBot 的 access_token（走 Authorization: Bearer）。',
  },
  {
    key: 'onebot.httpUrl', group: 'OneBot 连接', type: 'str', label: 'OneBot HTTP API 地址',
    default: 'http://127.0.0.1:3000',
    hint: '发消息 / 查群列表 / 取头像走这个 HTTP API。',
  },
  {
    key: 'onebot.httpToken', group: 'OneBot 连接', type: 'str', label: 'HTTP Token', secret: true, default: '',
    hint: '多数实现可留空；强制鉴权的实现（如 SnowLuma）必填，与协议端的 HTTP token 一致。',
  },

  // ── 出站（回复长度 / 长文卡片 / 引用）───────────────────────
  {
    key: 'outbound.replyMaxLength', group: '消息设置', type: 'int', label: '单条字数上限',
    min: 100, max: 100000, step: 100, default: 3000,
    hint: '网关硬上限：超过直接报错，让模型精简重发；兜底路径会在换行处切段逐条发。',
  },
  {
    key: 'outbound.longForwardThreshold', group: '消息设置', type: 'int', label: '长文卡片阈值', unit: '字',
    min: 0, max: 100000, step: 100, default: 400,
    hint: '正文超过这个字数就打成一张合并转发卡片（不刷屏）；0 = 用单条字数上限（等于关掉卡片）。',
  },
  {
    key: 'outbound.longForwardChunkSize', group: '消息设置', type: 'int', label: '长文卡片分片大小', unit: '字',
    min: 100, max: 5000, step: 100, default: 800,
    hint: '合并转发卡片里每个节点最多这么多字。',
  },
  {
    key: 'outbound.quoteAfterMsgs', group: '消息设置', type: 'int', label: '引用门槛（唤醒后插了几条才挂引用）',
    min: 0, max: 50, step: 1, default: 3,
    hint: '本群在“唤醒那条”之后又插了 N 条才允许挂引用；0 = 一律不自动挂。',
  },
  {
    key: 'outbound.groupContextCount', group: '群聊', type: 'int', label: '入站条数上限',
    min: 0, max: 50, step: 1, default: 10,
    hint: '**每轮最多带几条“还没给它看过的”群消息**（不是固定带这么多）。\n'
      + '怎么算：只取上一次回复之后群里新来的消息，最多 N 条（按时间旧→新，只取 30 分钟内的，本条消息本身不算）；'
      + '新消息超过 N 条时**只给最后 N 条，更早的直接丢弃、之后也不会补** —— 所以这是个封顶值。\n'
      + '调大 = 它更能接上前文（尤其是它沉默一阵、群里刷了几十条之后），代价是每轮多几十个 token（每条约 20 token，走的是未缓存输入）。\n'
      + '0 = 完全不带上文；一般 10~20 够用；要一次性看很多条用 `/history N`，别靠这里顶。',
  },

  // ── 静默合批（连发的几条并成一轮）──────────────────────────
  {
    key: 'pacing.merge.enabled', group: '消息设置', type: 'bool', label: '静默合批（连发的几条并成一轮）', default: true,
    hint: '同一群里几百毫秒内连着叫它的几条消息并成一轮 —— 省钱、也更像“等别人说完再开口”。',
  },
  {
    key: 'pacing.merge.windowMs', group: '消息设置', type: 'int', label: '合批等待（冷清时）', unit: '毫秒',
    min: 0, max: 10000, step: 100, default: 2000,
    hint: '上一条离得比较久（不是连发）时，单条只等这么久就发车。',
  },
  {
    key: 'pacing.merge.windowActiveMs', group: '消息设置', type: 'int', label: '合批等待（对话进行中）', unit: '毫秒',
    min: 0, max: 10000, step: 100, default: 4000,
    hint: '上一条消息来得近（正在聊）时多等一会儿，把 3~5 秒内的几条收成一轮再答。',
  },
  {
    key: 'pacing.merge.activeGapMs', group: '消息设置', type: 'int', label: '对话判定（距上一条多久算在聊）', unit: '毫秒',
    min: 1000, max: 120000, step: 500, default: 15000,
    hint: '上一条离这条 ≤ 本值 → 用「对话进行中」的等待窗口；否则用「冷清时」。',
  },
  {
    key: 'pacing.merge.maxWaitMs', group: '消息设置', type: 'int', label: '合批最长等待', unit: '毫秒',
    min: 0, max: 15000, step: 100, default: 6000,
    hint: '刷屏时窗口会被不断重置，这是硬上限，到点必须发车。',
  },
  {
    key: 'pacing.merge.skipIfSlowMs', group: '消息设置', type: 'int', label: '慢群不等阈值', unit: '毫秒',
    min: 0, max: 600000, step: 1000, default: 30000,
    hint: '距上一条群消息超过这个间隔 = 不是连发，直接回答、不进合批。',
  },

  // ── 主动接话：没人叫也偶尔接一句（高级项默认折叠）─────────────
  // 频率口径只有一种：实际间隔 = max(最小间隔, 60 分钟 ÷ 每小时次数)。
  {
    key: 'pacing.reply.enabled', group: '主动接话', type: 'bool', label: '允许主动接话（没人叫也偶尔接一句）', default: false,
    hint: '关掉后只在被叫时回话。开 = 到点看群里聊得怎么样，合适就接一句；每个群还要在「群聊」页勾「允许主动接话」，两处都开才生效。',
  },
  {
    key: 'pacing.reply.hourlyMax', group: '主动接话', type: 'int', label: '每小时最多主动接话', unit: '次',
    min: 0, max: 10, step: 1, default: 6,
    hint: '硬上限（不是每条消息的概率）。调大后两次间隔会自动按 60÷次数 收紧；0 = 关。',
  },
  {
    key: 'pacing.reply.minGapMs', group: '主动接话', type: 'int', label: '两次机会至少间隔', unit: '分钟',
    scale: 60000, min: 1, max: 120, step: 1, default: 480000,
    hint: '两次“可以考虑开口”之间至少隔这么久；实际间隔 = max(本值, 60÷每小时次数)。',
  },
  {
    key: 'pacing.reply.silenceEnabled', group: '主动接话', type: 'bool', label: '群冷场时也主动找话', default: true,
    hint: '开 = 群里长时间没人说话也会主动起个话头（按「安静多久算冷场」判定）；'
      + '关 = 不再定时找话，只有群里出现新消息、且语境合适时才可能接一句。',
  },
  {
    key: 'pacing.reply.coldSilenceMs', group: '主动接话', type: 'int', label: '群里安静多久算冷场', unit: '分钟',
    scale: 60000, min: 1, max: 120, step: 1, default: 180000,
    hint: '群里没人说话超过这么久、又到了机会点 → 可能主动起个话头。',
  },
  {
    key: 'pacing.reply.sensitivity', group: '主动接话', type: 'int', label: '语境敏感度（越高越挑时机）', unit: '%',
    scale: 0.01, min: 0, max: 100, step: 5, default: 0.45,
    hint: '先给群消息按语境打分（问句、正在热聊、它很久没说话…分高；@别人、纯表情分低），分够高才接。',
  },
  // ── 连续对话（2026-10-27）：被真人叫过并回过话之后，隔一会儿把这期间的新消息塞回模型再判一次 ──
  // 控制台：8 项全部暴露，但不平铺在页面上——`section:'连续对话'` 让前端收进「主动接话」页里
  // 一个独立的折叠块（和「高级」按钮同一种交互），默认收起，免得把常用项挤下去。
  {
    key: 'pacing.reply.continuation.enabled', group: '主动接话', section: '连续对话', type: 'bool', label: '连续对话（回完话后再看要不要补一句）', default: false,
    hint: '开 = 被真人叫过、它回过话之后，等「回完话后等多久检查」这么久，把这期间群里新说的话再看一遍：'
      + '想补就补一句，不想补就什么都不发。\n'
      + '防自转：只有真人唤醒才会开这条链，一次唤醒只检查一次，且必须有人类新消息才会检查。'
      + '总开关（允许主动接话）关掉时它也不工作。',
  },
  {
    key: 'pacing.reply.continuation.delayMs', group: '主动接话', section: '连续对话', type: 'int', label: '回完话后等多久检查', unit: '秒',
    scale: 1000, min: 30, max: 300, step: 10, default: 120000,
    hint: '从它**发出回复**那一刻开始计时。到点时如果没人再叫它 → 看这期间有没有新的人类消息，再决定要不要补一句。',
  },
  {
    key: 'pacing.reply.continuation.bonus', group: '主动接话', section: '连续对话', type: 'float', label: '情境加分', min: 0, max: 3, step: 0.1, default: 1.5,
    hint: '和「主动接话」共用同一套语境权重与门槛，这里只是给"刚聊过"这个情境加的分（直接加到分数上）。\n'
      + '0 = 完全按原权重（续聊几乎永远过不了门槛）；调高 = 更容易补这一句。默认 1.5。',
  },
  {
    key: 'pacing.reply.continuation.hourlyMax', group: '主动接话', section: '连续对话', type: 'int', label: '每群每小时最多补几次', unit: '次',
    min: 1, max: 20, step: 1, default: 5,
    hint: '防话痨：每个群每小时最多起几次续聊检查。和下面的「两次续聊最小间隔」一起，两个都满足才会触发。',
  },
  {
    key: 'pacing.reply.continuation.minGapMs', group: '主动接话', section: '连续对话', type: 'int', label: '两次续聊最小间隔', unit: '分钟',
    scale: 60000, min: 1, max: 60, step: 1, default: 300000,
    hint: '两次续聊检查之间至少隔这么久，防止"刚补完又补"。默认 5 分钟。',
  },
  {
    key: 'pacing.reply.continuation.maxPerChain', group: '主动接话', section: '连续对话', type: 'int', label: '一次唤醒最多检查几次', unit: '次',
    min: 1, max: 3, step: 1, default: 1,
    hint: '**防自转的核心**：一次真人唤醒最多只走 1 次续聊检查（默认 1）。'
      + '调成 2~3 会让它在一段对话里多回看几次，也更容易显得"黏人"，建议先保持 1。',
  },
  {
    key: 'pacing.reply.continuation.requireNewMessage', group: '主动接话', section: '连续对话', type: 'bool', label: '必须有人类新消息才检查', default: true,
    hint: '开（推荐）：它回完之后，群里必须有人再说话，才会做续聊检查；没人说话就彻底不触发。\n'
      + '关：即使没人接话也会隔一会儿自己回看一次——容易变成"自问自答"，不建议关。',
  },
  {
    key: 'pacing.reply.continuation.quoteLastHuman', group: '主动接话', section: '连续对话', type: 'bool', label: '续聊时引用最后一条人类消息', default: false,
    hint: '开 = 补的那一句会挂在"最后一条人类消息"下面（引用），视觉上更像在接话；关 = 普通发言。\n'
      + '注意：主动接话/续聊默认不 @ 任何人，这里只控制引用（挂哪条消息）。',
  },
  {
    key: 'pacing.reply.maxChars', group: '主动接话', type: 'int', label: '主动接话最多多少字', unit: '字',
    min: 20, max: 500, step: 10, default: 140,
    hint: '提示里要求它主动接话别太长；超了照发但会记日志。',
  },
  {
    key: 'pacing.reply.groups', group: '主动接话', type: 'group', label: '允许主动接话的群',
    default: [],
    hint: '群号列表（空 = 没有群允许主动接话）。推荐在「群聊」页每张群卡片勾「允许主动接话」；这里和群卡片改的是同一份配置。',
  },
  // ── 私聊主动接话：与群聊分开开关，默认关 ────────────────────────
  {
    key: 'pacing.reply.privateEnabled', group: '主动接话', section: '私聊主动接话', type: 'bool', label: '私聊也能主动接话', default: false,
    hint: '开 = 一对一私聊里，对方有一阵没说话时可以自己起个话头（不必等你先开口）。\n'
      + '私聊里「没人叫却开口」更容易显得打扰，所以默认间隔比群聊保守：2 小时没说话才考虑、每小时最多 1 次、每天最多 3 次；'
      + '数值都在下面几项里改。总开关（允许主动接话）关掉时它也不工作；静默时段内同样不开口。',
  },
  {
    key: 'pacing.reply.privateFriendsOnly', group: '主动接话', section: '私聊主动接话', type: 'bool', label: '私聊只对好友开口', default: true,
    hint: '开（推荐）：只对「好友名单」里的人主动发消息；名单取不到（协议端超时）时本轮一个都不开口，宁可不发也不群发。\n'
      + '关：白名单里的人都算——陌生人的临时会话也可能收到主动消息，一般不要关。',
  },
  {
    key: 'pacing.reply.privateColdSilenceMs', group: '主动接话', section: '私聊主动接话', type: 'int', label: '私聊安静多久才考虑开口', unit: '分钟',
    scale: 60000, min: 10, max: 1440, step: 10, default: 7200000,
    hint: '上一次说话（含它自己的回复）之后，超过这么久没动静才会考虑主动发一条。默认 120 分钟。',
  },
  {
    key: 'pacing.reply.privateHourlyMax', group: '主动接话', section: '私聊主动接话', type: 'int', label: '每个私聊每小时最多', unit: '次',
    min: 0, max: 5, step: 1, default: 1,
    hint: '单个私聊每小时最多主动几次；0 = 不主动。和「每天最多」「两次至少间隔」一起，三个闸门都满足才开口。',
  },
  {
    key: 'pacing.reply.privateMaxPerDay', group: '主动接话', section: '私聊主动接话', type: 'int', label: '每个私聊每天最多', unit: '次',
    min: 0, max: 20, step: 1, default: 3,
    hint: '单个私聊一天（滚动 24 小时）最多主动几次。',
  },
  {
    key: 'pacing.reply.privateMinGapMs', group: '主动接话', section: '私聊主动接话', type: 'int', label: '两次主动至少间隔', unit: '分钟',
    scale: 60000, min: 30, max: 1440, step: 30, default: 10800000,
    hint: '同一个私聊两次主动消息之间至少隔这么久（默认 180 分钟）。',
  },
  {
    key: 'pacing.reply.privateQqs', group: '主动接话', section: '私聊主动接话', advanced: true, type: 'group', label: '只对这些人主动（QQ 号，留空 = 全部好友）',
    default: [],
    hint: '留空 = 好友名单里的所有人都可能在冷场时收到主动消息；写了 QQ 号就只对这几个（逗号分隔）。',
  },
  // ── 静默时段：这段时间内不主动开口（被叫照常回）──────────────────
  {
    key: 'pacing.reply.quietEnabled', group: '主动接话', section: '静默时段', type: 'bool', label: '静默时段内不主动开口', default: true,
    hint: '开（默认）：在下面这段小时数里，它不会主动起话头（群聊、私聊都停）；被 @ / 被叫时的正常回话不受影响。\n'
      + '关：24 小时都可能主动开口。',
  },
  {
    key: 'pacing.reply.quietStart', group: '主动接话', section: '静默时段', type: 'int', label: '静默开始', unit: '点',
    min: 0, max: 23, step: 1, default: 0,
    hint: '几点开始不主动说话（0~23）。默认 0 点；开始小于结束 = 跨零点区间。',
  },
  {
    key: 'pacing.reply.quietEnd', group: '主动接话', section: '静默时段', type: 'int', label: '静默结束', unit: '点',
    min: 0, max: 24, step: 1, default: 7,
    hint: '几点恢复主动说话（0~24）。默认 7 点。起止相同 = 不启用静默。',
  },
  // 主动开口 / 续聊的提示词（2026-10-29）：从代码里搬出来，方便改口味而不动代码。
  // {n} = 这期间新消息条数，拼接时替换。
  {
    key: 'pacing.reply.prompts.private', group: '主动接话', section: '提示词（可改）', type: 'text',
    label: '私聊主动开口时给它的提示',
    hint: '对方安静够久、它准备主动开口时，把这段话塞给模型。想加/去要求直接改这里 —— 比如不喜欢某句叮嘱就删掉。\n'
      + '这段末尾提到 watch_video（「自己找视频看」的工具），不想让它用就删掉那半句。',
  },
  {
    key: 'pacing.reply.prompts.privateContinuation', group: '主动接话', section: '提示词（可改）', type: 'text',
    label: '私聊续聊时给它的提示',
    hint: '它刚在私聊回过话、对方又说了几句时用这段。{n} 会替换成新消息条数。',
  },
  {
    key: 'pacing.reply.prompts.group', group: '主动接话', section: '提示词（可改）', type: 'text',
    label: '群聊主动开口时给它的提示',
    hint: '群里没人叫它、它自己准备接一句时用这段。群聊默认要求「不发也在正文写一行 [不发] 原因」—— 因为群里没人点它名，只写正文等于石沉大海。私聊没有这个要求。',
  },
  {
    key: 'pacing.reply.prompts.groupContinuation', group: '主动接话', section: '提示词（可改）', type: 'text',
    label: '群聊续聊时给它的提示',
    hint: '{n} 会替换成这期间的新消息条数。',
  },
  {
    key: 'pacing.reply.prompts.tailPrivate', group: '主动接话', section: '提示词（可改）', type: 'text',
    label: '私聊提示的收尾一句',
    hint: '贴在 prompt 最后一行 —— 模型读到最后看的正是这句，比中间写十遍都管用。',
  },
  {
    key: 'pacing.reply.prompts.tailGroup', group: '主动接话', section: '提示词（可改）', type: 'text',
    label: '群聊提示的收尾一句',
    hint: '群聊的收尾：默认强制它「不发也要写 [不发] 原因」。觉得太啰嗦可以自己放宽。',
  },
  {
    key: 'pacing.reply.style.splitEnabled', group: '主动接话', type: 'bool', label: '拆条（先短反应再补正话）', default: true,
    hint: '小概率把一条回复拆成两条发（先丢个短反应、隔一会儿补正话），治“每条一个路子”的机器感。',
  },
  {
    key: 'pacing.reply.style.splitProbability', group: '主动接话', type: 'int', label: '拆条概率', unit: '%',
    scale: 0.01, min: 0, max: 100, step: 5, default: 0.5,
    hint: '每次回话拆条的概率；太短的话不拆（见「高级」里的最小长度）。',
  },
  {
    key: 'pacing.reply.style.stickerProbability', group: '主动接话', type: 'int', label: '表情包概率', unit: '%',
    scale: 0.01, min: 0, max: 100, step: 5, default: 0.8,
    hint: '每轮回话有多大机会被提醒“可以配一张表情”；它也可以不发。',
  },

  // ── 主动接话·高级（控制台折叠在「高级」按钮里，一般不用动）─────
  {
    key: 'pacing.reply.topicWindowMs', group: '主动接话', advanced: true, type: 'int', label: '机会窗口（到点后再等多久时机）', unit: '分钟',
    scale: 60000, min: 1, max: 30, step: 1, default: 600000,
    hint: '到了机会点后在窗口里等一条“值得接”的消息；一直等不到就放弃这次机会（不硬凑）。',
  },
  {
    key: 'pacing.reply.topicMinMsgs', group: '主动接话', advanced: true, type: 'int', label: '窗口内至少几条消息才按话题接',
    min: 1, max: 20, step: 1, default: 3,
    hint: '窗口里消息太少就不按“话题”挑时机（防硬接）；冷场找话不受这条限制。',
  },
  {
    key: 'pacing.reply.style.splitMinLen', group: '主动接话', advanced: true, type: 'int', label: '拆条最小长度', unit: '字',
    min: 0, max: 200, step: 1, default: 12,
    hint: '短于这个字数的回复不拆条（太短了拆成两条很怪）。',
  },
  {
    key: 'pacing.reply.style.splitDelayMs', group: '主动接话', advanced: true, type: 'int', label: '拆条两条之间的间隔', unit: '秒',
    scale: 1000, min: 0, max: 10, step: 1, default: 1000,
    hint: '拆出来的第一条之后，每条隔多久发（拆成 3 条时是 1×间隔、2×间隔）；调大更像“打完一句再想一句”。',
  },
  {
    key: 'pacing.reply.style.splitMaxParts', group: '主动接话', advanced: true, type: 'int', label: '最多拆几条',
    min: 2, max: 4, step: 1, default: 3,
    hint: '一段回复最多拆成几条发（2~4）。只在句末标点/换行处拆，绝不把一句话拦腰砍；\n句数不够就按实际句数发。'
      + '配「拆条概率」用：概率决定拆不拆、这里决定最多拆几条。',
  },
  {
    key: 'pacing.reply.style.stickerEnabled', group: '主动接话', advanced: true, type: 'bool', label: '回话时允许提醒发表情', default: true,
    hint: '关掉后主动回话不掷骰提醒发图（表情包子插件自己的总开关在「表情包」页）。',
  },
  // 9 项语境权重：只影响主动接话的“挑时机”，一般只调语境敏感度就够
  { key: 'pacing.reply.weights.intercept', group: '主动接话', advanced: true, type: 'float', label: '语境分：基础分（截距）', min: -5, max: 5, step: 0.05, default: -1.2005, hint: '所有加分项都从这一分开始；数越负整体越安静。' },
  { key: 'pacing.reply.weights.mentionBot', group: '主动接话', advanced: true, type: 'float', label: '语境分：提到它名字', min: -5, max: 5, step: 0.05, default: 1.5852, hint: '消息里出现它的名字/别名时加分（真 @ 或叫到走唤醒那条路，不看这些分）。' },
  { key: 'pacing.reply.weights.atOther', group: '主动接话', advanced: true, type: 'float', label: '语境分：@ 了别人', min: -5, max: 5, step: 0.05, default: -1.1157, hint: '群友在点名别人 = 不是冲它来的，减分。' },
  { key: 'pacing.reply.weights.hasQuestion', group: '主动接话', advanced: true, type: 'float', label: '语境分：在提问（问号）', min: -5, max: 5, step: 0.05, default: 0.4807, hint: '消息带问号 = 这话在等人回应，加分。' },
  { key: 'pacing.reply.weights.placeholderOnly', group: '主动接话', advanced: true, type: 'float', label: '语境分：只有表情/图', min: -5, max: 5, step: 0.05, default: -1.0281, hint: '只有表情包/图片、没有文字可接，减分。' },
  { key: 'pacing.reply.weights.selfRatio', group: '主动接话', advanced: true, type: 'float', label: '语境分：它自己的话占比', min: -5, max: 5, step: 0.05, default: 2.6525, hint: '近 5 分钟群里的话有多少是它说的；权重最大的一项。' },
  { key: 'pacing.reply.weights.recentCount', group: '主动接话', advanced: true, type: 'float', label: '语境分：群里刷屏程度', min: -5, max: 5, step: 0.05, default: -0.0367, hint: '近 5 分钟的消息条数；越刷屏越观望。' },
  { key: 'pacing.reply.weights.logSecondsSinceBot', group: '主动接话', advanced: true, type: 'float', label: '语境分：它多久没说话', min: -5, max: 5, step: 0.05, default: 0.0571, hint: '距它上次发言的秒数取对数；越久没说话越有信心。' },
  { key: 'pacing.reply.weights.pendingCount', group: '主动接话', advanced: true, type: 'float', label: '语境分：一次来几条', min: -5, max: 5, step: 0.05, default: 0.1012, hint: '它正在回一轮时又来消息 = 群里正热，小幅加分。' },

  // ── 其他（2026-10-20）：原来隐藏的 权限/门禁/文件/发图/头像 五组统一并到这一页 ──
  {
    key: 'info.other', group: '其他', type: 'info',
    text: '这里是低频 / 高级配置，按来源分组说明（每一项都有详细悬停解释）：\n'
      + '· 权限：主人 QQ —— 一般由内核按实例配置自动填，不用改。\n'
      + '· 门禁：屏蔽群 / 群内黑名单 / 群内白名单 / 全局允许用户 —— 「群聊」页每张群卡片也有同样的开关，改哪边都一样。\n'
      + '· 文件 / 发图：入站文件落盘目录、可发图片目录白名单。\n'
      + '· 头像：QQ 头像缓存目录与过期时长。\n'
      + '平时不用动；改错了热生效，且有配置备份可回滚。',
  },
]

// ============================================================
// 注册表 ②：动作按钮（需要 ops 的动作未配置时返回“本机未配置”，不是 500）
// ============================================================

/** @typedef {{id:string,group:string,label:string,hint?:string,confirm?:{title?:string,okLabel?:string},hidden?:boolean}} ActionDef */
export const ACTIONS = [
  {
    id: 'selfcheck', group: '运维', label: '跑离线自检',
    hint: '调用本机 ops 提供的离线自检（不碰 QQ）；未配置运维能力时点了会提示“本机未配置”。',
  },
  {
    id: 'clear-qq-sessions', group: '危险操作', label: '🧹 一键清空 QQ 对话',
    hint: '清空全部 QQ 线映射并归档这些会话（含游离会话）。点击后弹窗二次确认才执行；归档只影响侧栏显示、不删文件。',
    confirm: { title: '⚠️ 确认清空全部 QQ 对话？', okLabel: '确认清空' },
  },
  {
    id: 'cleanup-tmp', group: '运维', label: '🧽 清理临时文件',
    hint: '调用本机 ops 的清理能力（默认先预演，确认后才真删）。',
    confirm: { title: '⚠️ 确认清理临时文件？', okLabel: '确认清理' },
  },
  {
    id: 'dedup-baks', group: '运维', label: '🧹 备份代际去重',
    hint: '调用本机 ops 的备份去重能力（默认先预演，确认后才真删）。',
    confirm: { title: '⚠️ 确认删掉旧备份代？', okLabel: '确认去重' },
  },

  // 新手向导 / 连接自检（契约 §3.1）
  {
    id: 'onebot-check', group: '运维', label: '🔌 测试 OneBot 连接',
    hint: '向协议端发一次 get_login_info：通了一次就能收到消息；失败会给出原因（未启动 / 地址错 / token 错）。',
  },
  {
    id: 'onebot-reconnect', group: '运维', label: '↻ 重新连接 OneBot',
    hint: '重连协议端的 WebSocket（改完地址/token 但没自动重连时用）。',
  },
  {
    id: 'ensure-workspace', group: '运维', label: '📁 检查 / 创建 QQ 工作区',
    hint: '按「QQ 线工作区」路径在 DSH 侧栏注册工作区（已存在则复用，不重复创建）；「QQ 线工作区名称」是显示名。',
  },
  {
    id: 'check-host-deps', group: '运维', label: '🧪 检查运行环境',
    hint: '逐项检查「安装即用」需要的依赖：DSH 会话 / 工具 / 工作区 / preset 服务、内置 qq-chat、工作区自举、数据目录可写；'
      + '缺什么给出修复建议（可直接把结果交给 DSH，让它安装依赖）。',
  },
  {
    id: 'imagegen-check', group: '运维', label: '🖼 检查生图配置',
    hint: '校验协议 / 地址 / 模型 / API Key；必填都过了会再试一次 GET {base}/models（不通不算失败，只给提示）。',
  },
  {
    id: 'diagnose', group: '运维', label: '🩺 一键诊断 / 导出运维报告',
    hint: '检查配置、DSH preset、工具注册、OneBot 连接、人设、目录可写、生图配置，生成脱敏报告并告诉你保存位置；可直接交给 DSH 本体修复。',
  },

  // 空间日记：按钮长在「空间日记」配置页底部（onGroup = 不在「运维」页重复出现）
  {
    id: 'qzone-run-now', group: '空间日记', onGroup: true, label: '📔 立刻让它回顾一次',
    hint: '马上装配今天的素材，在「空间工作区」会话里让它决定写不写。异步执行，点完去看那个会话。',
  },
  {
    id: 'qzone-reset-today', group: '空间日记', onGroup: true, label: '♻️ 重置今日空间额度',
    hint: '把今天「已发 / 已跳过」清掉，它还能再写一条。只动本地状态，空间里已有的说说不会被删。',
    confirm: { title: '⚠️ 确认重置今天的空间额度？', okLabel: '确认重置' },
  },

  // 隐藏动作（由控制台特定页面调用，不出现在按钮列表里）
  { id: 'reply-preset', hidden: true, group: '隐藏', label: '主动接话档位', hint: '内部动作：{id:"reply-preset", preset:"quiet|semi|active"}' },
  { id: 'reset-session', hidden: true, group: '隐藏', label: '重置单条会话', hint: '内部动作：{id:"reset-session", chat:"group:<群号>"}' },
  { id: 'welcome-images', hidden: true, group: '隐藏', label: '入群欢迎图片池', hint: '内部动作：列图片池目录' },
  { id: 'welcome-test', hidden: true, group: '隐藏', label: '模拟入群欢迎', hint: '内部动作：{id:"welcome-test", group_id, confirm?}' },

  // 自己找视频看：按钮长在它自己的配置页底部（onGroup = 不在「运维」页重复出现）
  {
    id: 'wander-run-now', group: '自己找视频看', onGroup: true, label: '🎬 立刻看一个',
    hint: '马上挑一个 B 站视频看一遍，把感想私聊发给你。异步执行（下载 + 抽帧 + 写感想要一两分钟），'
      + '点完去看「看视频的地方」会话。',
  },
]

/** 控制台「运维」页要渲染的动作按钮（过滤隐藏项；confirm 透传给前端二次确认）。 */
export function visibleActions() {
  return ACTIONS.filter((a) => !a.hidden).map((a) => ({
    id: a.id, group: a.group, label: a.label, hint: a.hint || '', confirm: a.confirm || null,
  }))
}

// ============================================================
// 配置路径 → 白名单键（endpoints 的 group / memory 端点共用）
// ============================================================

/** 群管控写哪几段配置（v2 结构）。唤醒词落点 = `pluginConfig['gate-wake'].keywords`（文本行）。 */
export const GROUP_PATHS = {
  ignore: ['pluginConfig', 'gate-wake', 'ignoreGroups'],
  allowlist: ['pluginConfig', 'gate-wake', 'groupUserAllowlist'],
  blocklist: ['pluginConfig', 'gate-wake', 'groupUserBlocklist'],
  keywords: ['pluginConfig', 'gate-wake', 'keywords'],
  spont: ['pacing', 'reply', 'groups'],
  welcome: ['pluginConfig', 'group-welcome', 'groups'],
}

// ============================================================
// 子插件展开
// ============================================================

const defOf = (item) => (item && item.plugin) || item

/**
 * 全部**已发现**的子插件定义（含被配置停用的）。
 * 内核优先给 `kernel.pluginDefs`；退回 `kernel.pluginsAll`；最后退回 `kernel.plugins`（只有已加载的）。
 * @returns {{id:string, def:object, cfg:object|null, loaded:boolean}[]}
 */
export function pluginDefs(kernel = {}) {
  const out = []
  const seen = new Set()
  const add = (item, loaded) => {
    const def = defOf(item)
    const id = String((item && item.id) || (def && def.id) || '')
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ id, def: def && typeof def === 'object' ? def : {}, cfg: (item && item.cfg) || null, loaded })
  }
  if (Array.isArray(kernel?.pluginDefs)) for (const p of kernel.pluginDefs) add(p, false)
  if (Array.isArray(kernel?.pluginsAll)) for (const p of kernel.pluginsAll) add(p, false)
  if (Array.isArray(kernel?.plugins)) for (const p of kernel.plugins) add(p, true)
  // 插件定义（kernel.pluginDefs）里没有 cfg；把内核已加载条目的**已解析 cfg**（含默认值/绝对路径）补上，
  // 这样控制台某字段在 raw 没写时能回落到真正的运行时值，而不是 schema 里的相对默认值。
  const loadedCfg = new Map(
    (Array.isArray(kernel?.plugins) ? kernel.plugins : []).map((p) => [String(p?.id || p?.plugin?.id || ''), p?.cfg || null]),
  )
  for (const rec of out) if (!rec.cfg) rec.cfg = loadedCfg.get(rec.id) || null
  const order = (p) => Number(p.def?.order) || 100
  return out.sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))
}

/** 核心项 → 注册项（内部形态；`configPath` 为 raw 配置点路径数组）。 */
function coreEntries() {
  return CORE_CONTROLS.map((c) => ({
    kind: 'core',
    key: c.key,
    // info 是纯说明块：不映射任何配置路径，读写都被挡（见 readValue/writeValue）
    configPath: c.type === 'info' ? null : String(c.key).split('.'),
    plugin: 'core',
    field: '',
    group: c.group,
    type: c.type,
    label: c.label,
    unit: c.unit || '',
    scale: Number(c.scale) > 0 ? Number(c.scale) : 1,
    min: c.min,
    max: c.max,
    step: c.step,
    options: Array.isArray(c.options) ? c.options : null,
    hint: c.hint || '',
    text: c.text,
    suggestions: Array.isArray(c.suggestions) ? c.suggestions : null,
    default: c.default,
    secret: c.secret === true,
    // 进阶项：控制台折叠显示（如「主动接话」页的「高级」按钮）
    advanced: c.advanced === true,
    // 具名折叠块：同一标签页里再分小组（如「连续对话」），前端按 section 渲染成独立折叠块
    section: c.section || '',
  }))
}

/** 子插件 configSchema → 注册项：key = `<插件id>.<字段>`，落到 `pluginConfig.<id>.<field>`。 */
function pluginEntries(kernel) {
  const out = []
  for (const { id, def, cfg } of pluginDefs(kernel)) {
    const schema = def?.configSchema
    if (!isPlainObject(schema)) continue
    const title = String(def.title || id)
    const hidden = HIDDEN_PLUGIN_FIELDS[id] || null
    for (const [field, fdef] of Object.entries(schema)) {
      if (!isPlainObject(fdef)) continue
      if (hidden && hidden.has(field)) continue // 权威配置在核心项里，见文件头
      // 插件字段可以映射到别的配置路径（例：生图凭据仍存 credentials.gptImage.*，
      // 但面板归属算 imagegen —— 这样「生图」页 = 一个子插件，旧配置零迁移）
      const configPath = fdef.type === 'info'
        ? null
        : (Array.isArray(fdef.configPath) ? fdef.configPath : ['pluginConfig', id, field])
      out.push({
        kind: 'plugin',
        key: String(fdef.key || `${id}.${field}`),
        configPath,
        plugin: id,
        field,
        title,
        cfg,
        group: fdef.group || title, // 不写 group 的字段按插件标题归组
        type: String(fdef.type || 'str'),
        label: fdef.label || field,
        unit: fdef.unit || '',
        scale: Number(fdef.scale) > 0 ? Number(fdef.scale) : 1,
        min: fdef.min,
        max: fdef.max,
        step: fdef.step,
        options: Array.isArray(fdef.options) ? fdef.options : null,
        hint: fdef.hint || '',
        text: fdef.text,
        suggestions: Array.isArray(fdef.suggestions) ? fdef.suggestions : null,
        default: fdef.default,
        secret: fdef.secret === true,
      })
    }
  }
  return out
}

/** 注册表全量（核心 + 子插件）。 */
export function allControls(kernel) {
  return [...coreEntries(), ...pluginEntries(kernel)]
}

/** 按 key 找注册项；找不到返回 null（写值时调用方负责抛“不在白名单”）。 */
export function findControl(kernel, key) {
  const k = String(key || '')
  return allControls(kernel).find((e) => e.key === k) || null
}

/** raw 配置里该注册项的**存储值**（子插件项缺键时退回内核已加载的插件 cfg，再退回 schema 默认值）。 */
function storedValue(entry, rawConfig = {}, kernel = {}) {
  if (entry.type === 'info') return undefined
  const raw = rawConfig || {}
  if (entry.kind === 'core') return getPath(raw, entry.configPath)
  const inFile = getPath(raw, entry.configPath)
  if (inFile !== undefined) return inFile
  const fromCfg = entry.cfg && entry.field ? entry.cfg[entry.field] : undefined
  if (fromCfg !== undefined) return fromCfg
  return kernel?.runtime ? getPath(kernel.runtime, entry.configPath) : undefined
}

/** 存储值 → 面板值（核心项按 scale 除；子插件项原样；秘密字段回显占位符）。 */
function panelValue(entry, rawConfig, kernel) {
  if (entry.type === 'info') return undefined
  const stored = storedValue(entry, rawConfig, kernel)
  let value = stored === undefined ? entry.default : stored
  if (entry.secret && value) return SECRET_MASK
  // 列表型（group）：配置里既可能是数组，也可能是 {"编号": true} 这种对象写法（如 pacing.reply.privateQqs），
  // 面板一律显示成数组，否则前端 join 会得到 "[object Object]"
  if (entry.type === 'group' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).filter(([, on]) => on === true).map(([k]) => k)
  }
  if (entry.kind === 'core' && entry.scale !== 1 && typeof value === 'number' && Number.isFinite(value)) {
    return round3(value / entry.scale)
  }
  return value
}

/** 按注册项的类型/范围归一**面板值**（不做 scale 换算 —— 换算在 writeValue 里一次性做）。 */
export function coercePanel(entry, raw) {
  const key = entry.key
  if (entry.type === 'info') throw new Error(`${key} 是说明块，不能写值`)
  if (entry.type === 'bool') {
    if (typeof raw !== 'boolean') throw new Error(`${key} 需要布尔值（true/false）`)
    return raw
  }
  if (entry.type === 'int') {
    const n = Number(raw)
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${key} 需要整数`)
    if (entry.min != null && n < entry.min) throw new Error(`${key} 不能小于 ${entry.min}${entry.unit || ''}`)
    if (entry.max != null && n > entry.max) throw new Error(`${key} 不能大于 ${entry.max}${entry.unit || ''}`)
    return n
  }
  if (entry.type === 'float') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${key} 需要数字`)
    if (entry.min != null && n < entry.min) throw new Error(`${key} 不能小于 ${entry.min}`)
    if (entry.max != null && n > entry.max) throw new Error(`${key} 不能大于 ${entry.max}`)
    return n
  }
  if (entry.type === 'str' || entry.type === 'text') {
    const s = raw == null ? '' : String(raw)
    if (/[\u0000]/.test(s)) throw new Error(`${key} 不能包含空字符`)
    return s
  }
  if (entry.type === 'enum') {
    const v = raw == null ? '' : String(raw)
    const hit = (entry.options || []).some((o) => String(o && o.value !== undefined ? o.value : o) === v)
    if (!hit) throw new Error(`${key} 不在可选项里：${v}`)
    return v
  }
  if (entry.type === 'group') {
    // 群号列表这类：接受数组或逗号/空白分隔字符串 → 统一成字符串数组（去空、去重）
    const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/)
    const out = []
    for (const x of arr) {
      const s = String(x).trim()
      if (s && !out.includes(s)) out.push(s)
    }
    return out
  }
  throw new Error(`${key} 的控件类型未知：${entry.type}`)
}

/** 面板值 → 存储值（核心项按 scale 乘，子插件项原样 —— 见文件头单位口径）。 */
function storedOf(entry, panel) {
  if (entry.kind !== 'core' || entry.scale === 1 || typeof panel !== 'number') return panel
  const stored = round6(panel * entry.scale)
  return entry.type === 'int' && entry.scale >= 1 ? Math.round(stored) : stored
}

/**
 * 读一个白名单键的**面板值**（供 schema/status 与测试用）。
 * @param {object} kernel
 * @param {string} key
 * @param {object} [rawConfig]
 */
export function readValue(kernel, key, rawConfig = {}) {
  const entry = findControl(kernel, key)
  if (!entry) throw new Error(`不在控制台白名单里：${key}`)
  if (entry.type === 'info') return undefined // 说明块：Read 不产出
  return panelValue(entry, rawConfig, kernel)
}

/**
 * 写一个白名单键：校验/归一 → 返回该落在 raw 配置的哪个路径、存什么值。
 * **不落盘**（落盘由 admin/store.js 负责，方便先校验后备份）。
 * @returns {{key:string, value:unknown, stored:unknown, configPath:string[], unchanged?:boolean}}
 */
export function writeValue(kernel, key, value, rawConfig = {}) {
  const entry = findControl(kernel, key)
  if (!entry) throw new Error(`不在控制台白名单里：${key}`)
  if (entry.type === 'info') throw new Error(`${key} 是说明块，不能写值`)
  if (entry.secret) {
    const s = value == null ? '' : String(value)
    if (s === SECRET_MASK) {
      return { key, value: SECRET_MASK, stored: SECRET_MASK, configPath: entry.configPath, unchanged: true }
    }
    // 秘密字段允许直接写成空串（清空）或新值
  }
  const panel = coercePanel(entry, value)
  const stored = storedOf(entry, panel)
  if (isPlainObject(rawConfig)) setPath(rawConfig, entry.configPath, stored)
  return { key, value: panel, stored, configPath: entry.configPath }
}

// ============================================================
// 汇总：controls / groups / modules / actions
// ============================================================

/**
 * 原来的「隐藏组」：权限/门禁/文件/发图/头像 五组不再各占一页，而是统一并到「其他」页
 * （配置路径与插件读取逻辑完全不变，只是换了个面板入口 + 补详细悬停解释）。
 */
const OTHER_GROUPS = new Set(['权限', '门禁', '文件', '发图', '头像'])
const OTHER_LABEL = '其他'

/** 跟随「人设」显示在同一页（「总览」的人设区块下方）的分组。当前为空：句池 / 唤醒 已各自成页（子插件 1:1）。 */
const PERSONA_GROUPS = []

/** 控制面板值（含默认值回填；schema 端点直接返回它）。 */
function controlView(entry, rawConfig, kernel) {
  if (entry.type === 'info') {
    // 说明块：只带 text（前端渲染整行说明），没有 value/min/max/options
    return {
      key: entry.key,
      group: entry.group,
      type: 'info',
      label: entry.label || '',
      text: String(entry.text || ''),
      hint: entry.hint || '',
    }
  }
  const view = {
    key: entry.key,
    group: entry.group,
    type: entry.type,
    label: entry.label,
    unit: entry.unit,
    scale: entry.scale,
    min: entry.min,
    max: entry.max,
    step: entry.step,
    options: entry.options,
    value: panelValue(entry, rawConfig, kernel),
    hint: entry.hint,
    default: entry.default,
  }
  if (entry.kind === 'plugin') {
    view.plugin = entry.plugin
    view.field = entry.field
    // 字段映射到别的配置路径（key 不以 <插件id>. 开头）→ 标 mapped，前端/测试都别按老约定猜
    if (!String(entry.key).startsWith(`${entry.plugin}.`)) view.mapped = true
  }
  if (entry.secret) view.secret = true
  // 进阶项：控制台默认折叠在「高级」按钮里（比如主动接话的语境权重）
  if (entry.advanced) view.advanced = true
  // 具名折叠块：前端据此在同一个标签页里额外渲染一个独立折叠区（如「连续对话」）
  if (entry.section) view.section = entry.section
  // str 控件的输入建议（前端渲染 <datalist>）
  if (Array.isArray(entry.suggestions) && entry.suggestions.length) view.suggestions = entry.suggestions
  return view
}

/**
 * 子插件清单（控制台「子插件」页与「总览 → 可选模块」）。
 * `on` = 配置层面的启用态；`loaded` = 内核当前是否真的加载成功。
 */
export function collectModules(kernel, rawConfig = {}) {
  const raw = isPlainObject(rawConfig) ? rawConfig : {}
  const errs = kernel?.pluginErrors instanceof Map ? kernel.pluginErrors : null
  const loadedIds = new Set(
    (Array.isArray(kernel?.plugins) ? kernel.plugins : []).map((p) => String(p?.id || p?.plugin?.id || '')).filter(Boolean),
  )
  const list = []
  const seen = new Set()
  for (const { id, def } of pluginDefs(kernel)) {
    seen.add(id)
    const cfg = raw.pluginConfig && isPlainObject(raw.pluginConfig[id]) ? raw.pluginConfig[id] : {}
    const hardOff = Boolean(raw.plugins && raw.plugins[id] === false)
    const hasEnabled = isPlainObject(def.configSchema) && Boolean(def.configSchema.enabled)
    // on：raw 里没写过这个插件的配置时，用内核 pluginDefs 的 enabled（已考虑停用/插件级关闭）
    const cfgOn = cfg.enabled !== false && !hardOff
    const on = isPlainObject(raw.pluginConfig) && isPlainObject(raw.pluginConfig[id]) ? cfgOn : (def.enabled !== false && !hardOff)
    const order = Number(def.order) || 100
    const err = errs?.get?.(id)
    const defError = typeof def.error === 'string' && def.error ? def.error : null
    const loaded = loadedIds.has(id)
    list.push({
      id,
      title: def.title || id,
      label: `${def.title || id}（${id}）`,
      order,
      key: hasEnabled ? `${id}.enabled` : null,
      on,
      alwaysOn: !hasEnabled,
      loaded,
      lastError: err ? String(err?.message || err) : defError,
      desc: String(def.description || def.desc || ''),
      hint: `管线顺序 order=${order}｜${loaded ? '已加载' : '未加载'}`
        + (hardOff ? '｜插件级关闭（plugins.<id> = false）' : ''),
    })
  }
  if (errs) {
    for (const [id, e] of errs) {
      if (seen.has(id)) continue
      seen.add(id)
      list.push({
        id, title: id, label: id, order: 100, key: null, on: false, alwaysOn: false,
        loaded: false, lastError: String(e?.message || e), desc: '',
        hint: '插件加载失败（详见内核日志）',
      })
    }
  }
  for (const [id, v] of Object.entries(raw.plugins || {})) {
    if (v !== false || seen.has(id)) continue
    list.push({
      id, title: id, label: id, order: 100, key: null, on: false, alwaysOn: false,
      loaded: false, lastError: null, desc: '', hint: '在配置里被插件级关闭（plugins.<id> = false）',
    })
  }
  return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * 汇总成控制台能直接渲染的 schema（形状对齐现网 /admin/schema 响应）。
 * @param {object} kernel
 * @param {object} [rawConfig] 实例配置 raw（v2；缺省用 kernel.raw）
 * @returns {{controls:object[], groups:{name:string,plugins:string[]}[], modules:object[], actions:object[]}}
 */
export function collectSchema(kernel, rawConfig) {
  const raw = isPlainObject(rawConfig) ? rawConfig : (isPlainObject(kernel?.raw) ? kernel.raw : {})
  // 权限/门禁/文件/发图/头像 → 统一并到「其他」页（配置路径不变，只是换分组）
  const entries = allControls(kernel).map((e) => (OTHER_GROUPS.has(e.group) ? { ...e, group: OTHER_LABEL } : e))
  // 「表情包」页顶部一行实时概况（数量/标签数随时变 → 插件现算后给，不塞进静态 schema 文字）。
  // 插件没加载 / 没提供统计时静默跳过，控制台照常可用。
  const stickerStats = (() => {
    const fn = kernel?.shared?.stickerStats
    if (typeof fn !== 'function') return null
    try { return fn() } catch { return null }
  })()
  if (stickerStats?.ok) {
    const at = entries.findIndex((e) => e.group === '表情包')
    if (at >= 0) {
      entries.splice(at, 0, {
        key: 'info.stickers', group: '表情包', type: 'info', kind: 'plugin', plugin: 'stickers',
        text: `当前表情库：${stickerStats.count} 张（其中 ${stickerStats.tagged} 张打过标签，共 ${stickerStats.tags} 个标签）｜上限 ${stickerStats.max} 张`
          + (stickerStats.dead > 0 ? `\n⚠️ 另有 ${stickerStats.dead} 条索引指向已被删除的图片（挑到会跳过；打开「收表情」后会自动清理）` : '')
          + `\n收表情（会写索引）：${stickerStats.collect ? '开 —— 会收新图并写 index.json' : '关 —— 库只读，只能挑现有图发'}`,
      })
    }
  }
  const controls = entries.map((e) => controlView(e, raw, kernel))
  const groups = new Map() // group 名 -> Set<来源>（core / 插件 id），保持首次出现顺序
  for (const e of entries) {
    // PERSONA_GROUPS 当前为空（句池/唤醒 已各自成页）；机制保留：以后要折叠进总览的小组写这里
    if (PERSONA_GROUPS.includes(e.group)) continue
    if (!groups.has(e.group)) groups.set(e.group, new Set())
    groups.get(e.group).add(e.kind === 'core' ? 'core' : e.plugin)
  }
  return {
    controls,
    groups: [...groups].map(([name, plugins]) => ({ name, plugins: [...plugins] })),
    modules: collectModules(kernel, raw),
    actions: visibleActions(),
    // 跟随「人设」一起显示在「总览」页的组（不再单独成页）
    personaGroups: [...PERSONA_GROUPS],
  }
}
