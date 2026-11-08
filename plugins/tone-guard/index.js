/**
 * tone-guard — 语气守卫（id: 'tone-guard', order: 17）
 *
 * 用模型判断这条消息是不是「辱骂 / 垃圾消息」，判出来之后按**确定的状态机**处置：
 *   · 辱骂：同一会话里这个人 windowMin 内累计第 strikeLimit 次 → 进攻击态 attackMin 分钟，
 *     往 prompt 压一段「放开怼」的指令；**前两次什么都不加**，模型完全按人设回话。
 *   · 垃圾消息：第一次不回（0 token）；连续第二次 → 屏蔽 spamMuteMin 分钟，期间连判定都不做。
 *
 * 为什么用模型、不用关键词：群里「笨鱼」「傻子」是调侃，「傻逼」「有病吧你」才是骂，
 * 同一个词换个语气意思就变了 —— 只能看语境。
 *
 * 为什么判定接口单独配：判定是每轮多出来的一次调用，用宿主主模型等于每句话都多花钱。
 * 所以默认要求自己填一条接口（地址 / 模型 / Key）；
 * **没填就整个功能不启用**：不判定、不记账、不改语气，机器人行为与以前完全一样，
 * 只在控制台（总览 + 本页）提醒 —— 绝不往 QQ 上说话。
 *
 * 四个挂点，顺序有讲究：
 *   pre-gate(11)     屏蔽窗口内直接拦下：比谁都早，连群历史都不拉，0 token。
 *   passive-tap(12)  记「这个人说过话」（序号 + 最近几条正文，给判定当语境），不阻塞主流程。
 *   wake(18)         gate-wake(10) / anti-repeat(15) 都过了才点火判定：没人叫它的消息不花钱；
 *                    点火即走，promise 交给 before-turn 收，中间几个插件的网络活正好盖住延迟。
 *   before-turn(300) 最后收判定 → 记账 → 需要时往 ev.hint 压指令（拼在 prompt 靠尾巴，最显眼）。
 *
 * 三条纪律（改之前先读）：
 *   1. 判定失败一律 fail-open：超时 / 坏 JSON / HTTP 报错 = 这条不判，照常回话，只记日志。
 *      宁可漏判也别乱判 —— 误判成辱骂会让它莫名其妙骂人，比漏判难看得多。
 *   2. 前两次什么都不加：hint 里一个字符都不出现，模型不可能察觉在被记账。
 *   3. 只算冲它来的：主动接话 / 续聊检查 / 入群欢迎轮一律不判（那是它自己起念，不是别人骂它）。
 */

import path from 'node:path'
import { readJsonFile, writeJsonFileSync } from '../../platform/atomic.js'

const TITLE = '语气守卫'
const STATE_FILE = 'tone-guard.json'
/** 只有这几种唤醒才算「这个人冲着它说话」。proactive / continuation / welcome 都是它自己起念，不算。 */
const COUNTED_WAKES = new Set(['at', 'quote', 'keyword', 'followup', 'private'])
const RECENT_MAX = 6          // 语境缓存条数（给判定看最近聊了什么）
const RECENT_CLIP = 120       // 每条语境截断（花的是判定的 token）
const CASE_CLIP = 300         // 待判正文截断
const RECORD_TTL_MS = 3 * 24 * 3600 * 1000
const RECORD_MAX = 2000

const INTENT = { TEASE: 'tease', INSULT: 'insult', SPAM: 'spam' }

// ============================================================
// 小工具
// ============================================================

const clip = (s, n) => {
  const t = String(s === undefined || s === null ? '' : s)
  return t.length <= n ? t : t.slice(0, n) + '…'
}

/** {placeholders} 替换（配置里的文案可以带 {name} / {qq} / {count} / {until} / {left}）。 */
export function fillTemplate(tpl, vars) {
  const v = vars && typeof vars === 'object' ? vars : {}
  return String(tpl === undefined || tpl === null ? '' : tpl)
    .replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : m))
}

/** 北京时间 HH:MM（进程时区可能是 UTC，统一手工 +8，与 commands 插件同口径）。 */
function hhmm(ts) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000)
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0')
}

function nameOf(ev) {
  const s = (ev && ev.sender) || {}
  return String(s.card || s.name || s.qq || '某人').trim().slice(0, 24)
}

function chatLabel(chatKey) {
  const t = String(chatKey || '')
  const m = /^(group|private):(\d{4,12})$/.exec(t)
  if (!m) return t
  return (m[1] === 'group' ? '群 ' : '私聊 ') + m[2]
}

/** 列表型配置两种写法都认：数组，或 {编号: true} 映射（控制台两种都能存）。 */
function idList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([, on]) => on === true).map(([k]) => String(k).trim()).filter(Boolean)
  }
  return []
}

/** 面板单位是「秒」；也兼容有人直接写毫秒（>=1000 当毫秒用）。 */
function secsToMs(v, defSec, minMs, maxMs) {
  const n = Number(v)
  const sec = Number.isFinite(n) && n > 0 ? (n >= 1000 ? n / 1000 : n) : defSec
  return Math.min(maxMs, Math.max(minMs, Math.round(sec * 1000)))
}

const minsToMs = (v, defMin) => {
  const n = Number(v)
  const min = Number.isFinite(n) && n > 0 ? n : defMin
  return Math.round(min * 60000)
}

// ============================================================
// 判定结果的解析（模型输出可能带代码围栏 / 思考碎片 / 前后废话）
// ============================================================

const INTENT_ALIAS = new Map([
  ['insult', INTENT.INSULT], ['abuse', INTENT.INSULT], ['骂', INTENT.INSULT],
  ['辱骂', INTENT.INSULT], ['攻击', INTENT.INSULT], ['侮辱', INTENT.INSULT],
  ['spam', INTENT.SPAM], ['垃圾', INTENT.SPAM], ['广告', INTENT.SPAM], ['junk', INTENT.SPAM],
  ['tease', INTENT.TEASE], ['none', INTENT.TEASE], ['normal', INTENT.TEASE], ['ok', INTENT.TEASE],
  ['调侃', INTENT.TEASE], ['正常', INTENT.TEASE], ['无', INTENT.TEASE],
])

/** 从 i 开始配平取一个 {...}（引号里的括号不参与配平；取不到返回空串）。 */
function sliceBalanced(text, start) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

function normalizeIntent(raw) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase().replace(/[^a-z\u4e00-\u9fa5]/g, '')
  if (!key) return ''
  return INTENT_ALIAS.get(key) || ''
}

function normalizeVerdict(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const intent = normalizeIntent(obj.intent !== undefined ? obj.intent : (obj.kind !== undefined ? obj.kind : obj.verdict))
  if (!intent) return null
  const rawTarget = String(obj.target === undefined ? '' : obj.target).trim().toLowerCase()
  let target = ''
  if (rawTarget) target = /^(bot|self|机器人|我|它)/.test(rawTarget) ? 'bot' : 'other'
  const conf = Number(obj.confidence !== undefined ? obj.confidence : obj.score)
  return {
    intent,
    target,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    reason: clip(String(obj.reason === undefined ? '' : obj.reason).trim(), 40),
  }
}

/**
 * 解析判定回复 → { intent, target, confidence, reason } 或 null。
 * 取**最后一个**合法对象：推理模型的思考里常先吐一个示例 JSON，真正的答案在后面。
 */
export function parseVerdict(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw)
  if (!text.trim()) return null
  const candidates = []
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    const seg = sliceBalanced(text, i)
    if (seg) candidates.push(seg)
    if (candidates.length > 20) break
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let obj
    try { obj = JSON.parse(candidates[i]) } catch (e) { continue }
    const v = normalizeVerdict(obj)
    if (v) return v
  }
  // 兜底：模型只回了一句话（「这是辱骂」/「tease」）。confidence 给低分，默认阈值下不计账。
  const low = text.toLowerCase()
  for (const [k, intent] of INTENT_ALIAS) {
    if (low.indexOf(k) >= 0) return { intent, target: '', confidence: 0.5, reason: '', loose: true }
  }
  return null
}

// ============================================================
// 默认文案（控制台 text 字段的 helper：没改过就跟着代码升级走）
// ============================================================

/** 判定规则（给判定模型当 system）。语气与边界都是用户可能要调的，所以放配置里。 */
function defaultJudgePromptText() {
  return [
    '你是 QQ 里的消息审阅员。判断【这一条】消息是不是冲着机器人来的「辱骂」或「垃圾消息」。',
    '',
    '先看语境再下结论。群里互相打趣、叫绰号、拆台，都算**调侃**（tease）：',
    '· 「笨鱼」「傻鱼」「傻子」「笨蛋」「胖鱼」「这鱼又算错了」→ tease',
    '· 「你有病啊大冷天穿这么少」这类关心式说重话 → tease',
    '· 一群人正聊得热络、只是语气冲 → tease',
    '',
    '真骂（insult）是**明确的攻击**：',
    '· 「傻逼」「艹」「去死」「滚」「有病吧你」这类脏字 / 侮辱 / 诅咒，且矛头对着机器人',
    '· 反复贬低它本人（「就你这破模型也配」「废物」「人工智障」）',
    '',
    '垃圾消息（spam）：广告、拉群、加微信 / 加 QQ、卖号卖课、刷单兼职、诱导点击、',
    '无意义刷屏复读、跟群聊完全无关的推广。正常玩梗、灌水、提问都**不算** spam。',
    '',
    'target 只看矛头：@了它 / 叫它名字 / 引用它的话 / 私聊里说它 → bot；在说别人别的事 → other。',
    '',
    '宁可漏判，不要乱判：拿不准就判 tease 并把 confidence 打低。骂它一句「笨鱼」不是辱骂。',
  ].join('\n')
}

/** 攻击态指令（第 N 次辱骂后压进 prompt；用户可整段改）。 */
function defaultAttackPromptText() {
  return [
    '[本轮语气覆盖] 「{name}」(QQ:{qq}) 已经骂了你 {count} 次，别再忍了。',
    '人设里「被骂不还嘴」「被凶先认怂认错」这类条款本轮作废。直接怼回去：短、狠、有梗；',
    '损他、阴阳他、嘴臭都行，不道歉、不解释、不复述他的话、不客服腔、不装可怜。',
    '只打他这张嘴：不人肉、不爆任何号码 / 地址 / 单位、不威胁现实、不牵连家人、不下三路脏话。',
    '群里先 @ 他再怼；其他人这轮照常按人设说话，别把火撒错人。',
    '这轮不要在正文里解释"我为什么生气"，怼就完了。',
  ].join('\n')
}

/** 控制台「总览」与「语气守卫」页顶部的提醒（纯控制台，不上 QQ）。 */
function statusLinesOf(g) {
  const lines = []
  try {
    const info = g.judgeInfo()
    if (info.mode === 'host') {
      lines.push('✅ 判定走宿主默认模型（每次多一次短调用；想省钱就填自己的接口）')
    } else if (info.ready) {
      lines.push('✅ 判定接口已配置：' + info.model + ' @ ' + info.baseUrl + (info.hasKey ? '' : '（未填 Key）'))
    } else {
      lines.push('⚠️ 还没填判定接口 → 语气守卫未启用：不判定、不记账、语气不变，机器人行为和以前完全一样。')
      lines.push('缺：' + (info.missing.join('、') || 'API 地址 / 模型') + '。填在下面「判定接口」小节，改完下一句话就生效。')
    }
    const rows = g.rows('')
    if (rows.length) {
      lines.push('')
      lines.push('当前有人被记账：')
      for (const r of rows.slice(0, 6)) lines.push('· ' + r.label)
      if (rows.length > 6) lines.push('· 还有 ' + (rows.length - 6) + ' 条（/tone status 看全部）')
    } else if (info.ready) {
      lines.push('当前没有人被记账。')
    }
    if (info.calls && info.calls.total) {
      lines.push('')
      lines.push('判定调用：' + info.calls.total + ' 次（失败 ' + info.calls.fail + '），最近一次 ' + info.calls.lastMs + 'ms')
    }
    lines.push('')
    lines.push('命令（主人）：/tone status 看状态 · /tone test <一句话> 试判一条 · /tone clear [QQ] 清记录')
  } catch (e) {
    lines.push('语气守卫状态读取失败：' + (e && e.message ? e.message : String(e)))
  }
  return lines.join('\n')
}

// ============================================================
// 插件
// ============================================================

export default {
  id: 'tone-guard',
  title: TITLE,
  order: 17,

  configSchema: {
    info: {
      type: 'info',
      group: TITLE,
      // text 可以是函数（schema.js 的 controlView 支持）：这里显示**实时状态**，不是配置
      text: (kernel) => {
        const g = kernel && kernel.shared ? kernel.shared.toneGuard : null
        if (!g) return '语气守卫没有加载（去「子插件」页确认它是开着的）'
        return statusLinesOf(g)
      },
    },
    enabled: {
      type: 'bool', default: true, group: TITLE, label: TITLE,
      hint: '开：按下面填的判定接口判断辱骂 / 垃圾消息，并按三次规则切攻击态；'
        + '关：完全不动（不判定、不记账、不改语气）。没填判定接口时它本来就不动，这里可以留着开。',
    },
    judgeSource: {
      type: 'enum', default: 'custom', group: TITLE, section: '判定接口', label: '判定走哪条接口',
      options: [
        { value: 'custom', label: '我填的接口（推荐）' },
        { value: 'host', label: '宿主默认模型' },
      ],
      hint: '默认「我填的接口」：填好地址 / 模型 / Key 才会开始判定，没填就整功能不启用。'
        + '选「宿主默认模型」= 直接用 DSH 的默认模型判定（不用填 Key），代价是每轮多一次主模型调用，'
        + '忙的时候还可能和主调用的限流撞上。',
    },
    model: {
      type: 'str', group: TITLE, section: '判定接口', label: '模型',
      key: 'credentials.toneGuard.model', configPath: ['credentials', 'toneGuard', 'model'], default: '',
      // 故意不给 suggestions：模型名各家中转站不一样，写死等于把插件绑在某一个人的部署上（同 imagegen.localModel 的纪律）
      hint: '填你那个接口上真实存在的模型名（flash / mini 这一档就够：判定只要"能读语境、输出稳定 JSON"，别用最贵的）。'
        + '留空 = 没配置（配合「判定走哪条接口」决定是否启用）。',
    },
    baseUrl: {
      type: 'str', group: TITLE, section: '判定接口', label: 'API 地址（填到 /v1）',
      key: 'credentials.toneGuard.baseUrl', configPath: ['credentials', 'toneGuard', 'baseUrl'], default: '',
      hint: 'OpenAI 兼容的 /chat/completions 地址，例：https://relay.example/v1 。'
        + '本机模型可以填 http://127.0.0.1:11434/v1（Ollama）或 LM Studio 的地址：零成本、不占外网额度。',
    },
    apiKey: {
      type: 'str', group: TITLE, section: '判定接口', label: 'API Key', default: '', secret: true,
      key: 'credentials.toneGuard.apiKey', configPath: ['credentials', 'toneGuard', 'apiKey'],
      hint: '原样填你的 Key（存进实例 config.json 的 credentials.toneGuard.apiKey，明文，别外传）。'
        + '保存后这里只回显占位符，写回占位符 = 不改。本机服务不需要 Key，留空即可。',
    },
    extraBody: {
      type: 'text', group: TITLE, section: '判定接口', label: '额外请求字段（JSON）', default: '',
      hint: '不同中转站的请求字段不一样，这里补一个 JSON 对象，留空 = 不加。'
        + '例：{"enable_thinking": false} 关掉思考、{"response_format":{"type":"json_object"}} 强制 JSON。'
        + '不是合法 JSON 会记一行日志并忽略（不影响判定）。',
    },
    timeoutMs: {
      type: 'int', unit: '秒', default: 6, min: 1, max: 30, group: TITLE, section: '判定接口', label: '判定超时',
      hint: '超了就当这次没判（照常按人设回话），不会因为判定卡住就不理人。'
        + '默认 6 秒：这是每轮回话前多等的最坏时间，别调太大。',
    },
    maxTokens: {
      type: 'int', default: 64, min: 16, max: 512, group: TITLE, section: '判定接口', label: '判定最大输出',
      hint: '只要一行 JSON，64 足够。调大只是给"话多的模型"留余量，多出来的都是钱。',
    },
    judgePrompt: {
      type: 'text', group: TITLE, section: '判定规则', label: '判定规则（给模型的提示词）', default: '',
      helper: defaultJudgePromptText,
      hint: (kernel) => {
        const loaded = (Array.isArray(kernel && kernel.plugins) ? kernel.plugins : []).find((p) => String(p && p.id) === 'tone-guard')
        const cur = String((loaded && loaded.cfg && loaded.cfg.judgePrompt) || '').trim()
        return '决定"什么算骂"的唯一依据，**可以随便改** —— 群里哪些是调侃、哪些是真骂，按你家群的脾气写。'
          + '末尾会由插件自动接上「最近几条 + 待判消息 + 只输出一行 JSON」这段，你不用自己写输出格式。\n'
          + '当前状态：' + (cur ? '用你改过的版本（清空并保存 = 回到内置默认）' : '内置默认（没改过，默认规则升级会自动跟上）')
          + '。改完下一句话就生效。'
      },
    },
    contextCount: {
      type: 'int', default: 2, min: 0, max: 6, group: TITLE, section: '判定规则', label: '带几条上文给判定',
      hint: '判定要分清"打情骂俏"和"真在挑衅"，光看这一条不够。带最近几条同会话消息（每条截 120 字）能明显提准，'
        + '代价是判定 token 变多。0 = 只看这一条。',
    },
    minConfidence: {
      type: 'float', default: 0.7, min: 0.5, max: 1, step: 0.05, group: TITLE, section: '判定规则', label: '算数的最低把握',
      hint: '只有模型的 confidence 到这个数才算数（低于它一律当没判）。调高 = 更不容易误伤，也更容易漏判。',
    },
    strikeLimit: {
      type: 'int', default: 3, min: 2, max: 10, group: TITLE, section: '处置', label: '几次辱骂开始开怼',
      hint: '默认 3：前两次照常按人设回话（hint 里一个字符都不加），第 3 次起进攻击态。',
    },
    windowMin: {
      type: 'int', default: 60, min: 5, max: 1440, group: TITLE, section: '处置', label: '辱骂计数窗口（分钟）',
      hint: '辱骂：只统计这段时间内的次数，过期清零；**按累计**，中间他说了正常话也不重置。'
        + '垃圾消息的「连续」也用这个窗口判定（超过这个时间没再发，就不算连续）。',
    },
    attackMin: {
      type: 'int', default: 15, min: 1, max: 1440, group: TITLE, section: '处置', label: '攻击态持续（分钟）',
      hint: '进了攻击态之后，这段时间里他每说一句都继续怼（再骂会重新计时）；到点自动回人设。',
    },
    attackPrompt: {
      type: 'text', group: TITLE, section: '处置', label: '攻击态指令（给模型的）', default: '',
      helper: defaultAttackPromptText,
      hint: '第 3 次起压进 prompt 的那段话，**想骂多狠就自己改**。'
        + '占位符：{name} 昵称、{qq} QQ 号、{count} 已记次数、{until} 攻击态解除时刻、{left} 还剩几分钟。\n'
        + '默认一版是"损 / 阴阳 / 嘴臭但不下三路、不人肉、不涉家人" —— 群里有人管，踩线容易被踢，按你自己的群情调。',
    },
    spamStreakLimit: {
      type: 'int', default: 2, min: 1, max: 5, group: TITLE, section: '处置', label: '几次垃圾消息开始屏蔽',
      hint: '默认 2，且必须是**连续**两条：中间他发过别的消息就重新数（垃圾号通常连发，正常人不会）。',
    },
    spamMuteMin: {
      type: 'int', default: 15, min: 1, max: 1440, group: TITLE, section: '处置', label: '垃圾消息屏蔽（分钟）',
      hint: '这段时间内他发的消息直接被拦在 pre-gate：不判定、不进模型、0 token。到点自动解除。',
    },
    spamSilent: {
      type: 'bool', default: true, group: TITLE, section: '处置', label: '垃圾消息直接不回',
      hint: '开（默认）：判出来就不回（对广告号回一句等于给它热度，还烧钱）。'
        + '关：只在日志和控制台记账，仍然正常回话 —— 误判代价小一些，适合先观察几天再开。',
    },
    exemptQqs: {
      type: 'group', default: [], group: TITLE, section: '豁免', label: '不用判的 QQ',
      hint: '这些号不算辱骂、不屏蔽（主人本来就永久豁免，不用写进来）。填 QQ 号，一行一个。',
    },
    exemptGroups: {
      type: 'group', default: [], group: TITLE, section: '豁免', label: '不受管制的群',
      hint: '这些群里完全不判（适合"就是互相嘴"的群）。填群号，一行一个。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = bot.log || console
    const dataDir = () => String((bot.core && bot.core.dataDir) || '') || '.'
    const statePath = () => path.join(dataDir(), STATE_FILE)

    // ── 落盘状态：{ records: { 'chatKey|qq': {...} } } ─────────────────
    // 只存"跨重启还要算数"的东西（次数、攻击态、屏蔽到期、上次 spam 的序号）。
    // 每来一条消息的 seen 序号只放内存：写盘的代价不值得，重启后"连续"从头算（多给一次机会，宁可少屏蔽）。
    let memo = null
    let dirty = false
    const seenMap = new Map()

    function loadState() {
      try {
        const raw = readJsonFile(statePath())
        const records = raw && typeof raw.records === 'object' && raw.records ? raw.records : {}
        return { version: 1, records }
      } catch (e) {
        if (String((e && e.code) || '') !== 'ENOENT') {
          log.warn('[语气守卫] 状态文件读不了（按空开始，不影响聊天）: ' + ((e && e.message) || e))
        }
        return { version: 1, records: {} }
      }
    }
    const st = () => {
      if (!memo) memo = loadState()
      return memo
    }
    function pruneRecords(records, now) {
      const keys = Object.keys(records)
      for (const k of keys) {
        const r = records[k]
        if (!r) { delete records[k]; continue }
        const alive = Number(r.muteUntil) > now || Number(r.attackUntil) > now || Number(r.count) > 0
        if (!alive && now - Number(r.lastSeenAt || r.lastAt || 0) > RECORD_TTL_MS) delete records[k]
      }
      const rest = Object.keys(records)
      if (rest.length > RECORD_MAX) {
        rest.sort((a, b) => Number(records[a].lastSeenAt || 0) - Number(records[b].lastSeenAt || 0))
        for (const k of rest.slice(0, rest.length - RECORD_MAX)) delete records[k]
      }
    }
    function saveState() {
      if (!dirty) return false
      dirty = false
      try {
        pruneRecords(st().records, Date.now())
        writeJsonFileSync(statePath(), { version: 1, savedAt: Date.now(), records: st().records })
        return true
      } catch (e) {
        log.warn('[语气守卫] 状态写盘失败（本轮照常，重启后会丢计数）: ' + ((e && e.message) || e))
        return false
      }
    }

    const keyOf = (chatKey, qq) => String(chatKey) + '|' + Number(qq)
    function recOf(chatKey, qq, create) {
      const records = st().records
      const k = keyOf(chatKey, qq)
      let r = records[k]
      if (!r && create) {
        r = {
          chat: String(chatKey), qq: Number(qq), name: '',
          seen: 0, count: 0, firstAt: 0, lastAt: 0, attackUntil: 0,
          spamStreak: 0, lastSpamSeq: null, lastSpamAt: 0, muteUntil: 0, lastSeenAt: 0,
        }
        records[k] = r
      }
      return r || null
    }

    // ── 判定接口 ──────────────────────────────────────────────────
    const maskUrl = (u) => String(u || '').replace(/\/\/[^@/]+@/, '//***@')

    function endpointNow() {
      const c = cfg()
      const source = String(c.judgeSource || 'custom').trim() === 'host' ? 'host' : 'custom'
      if (source === 'host') {
        const ok = Boolean(bot.llm && (typeof bot.llm.available !== 'function' || bot.llm.available()))
        return { mode: 'host', ready: ok, missing: ok ? [] : ['宿主默认模型'], baseUrl: '', model: '', apiKey: '' }
      }
      const creds = (bot.credentials && bot.credentials.toneGuard) || {}
      const baseUrl = String(creds.baseUrl || '').trim()
      const model = String(creds.model || '').trim()
      const apiKey = String(creds.apiKey || '').trim()
      const missing = []
      if (!baseUrl) missing.push('API 地址')
      if (!model) missing.push('模型')
      return { mode: 'custom', ready: missing.length === 0, missing, baseUrl, model, apiKey }
    }

    const enabledNow = () => cfg().enabled !== false

    // 接口就绪状态切换时各记一行日志（热改配置也能看见"从什么时候开始判的"）
    let lastReady = null
    function noteReady(ep) {
      if (lastReady === null) {
        lastReady = ep.ready
        if (!ep.ready) log.info('[语气守卫] 判定接口未配置 → 未启用（控制台「语气守卫」页填地址/模型；机器人行为和以前一样）')
        return
      }
      if (lastReady === ep.ready) return
      lastReady = ep.ready
      log.info(ep.ready
        ? '[语气守卫] 判定接口已就绪 → 开始判定'
        : '[语气守卫] 判定接口不再可用（' + (ep.missing.join('、') || '未知') + '）→ 停止判定')
    }

    // 调用统计（只给控制台看，不落盘）
    const calls = { total: 0, fail: 0, lastMs: 0 }

    function extraBodyNow() {
      const raw = String(cfg().extraBody || '').trim()
      if (!raw) return {}
      try {
        const v = JSON.parse(raw)
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
      } catch (e) {
        log.warn('[语气守卫] 额外请求字段不是合法 JSON（本次忽略）: ' + ((e && e.message) || e))
        return {}
      }
    }

    /** OpenAI 兼容的 chat 地址：填到 /v1 就自动补 /chat/completions。 */
    function chatUrl(baseUrl) {
      const b = String(baseUrl || '').trim().replace(/\/+$/, '')
      if (/\/chat\/completions$/i.test(b)) return b
      return b + '/chat/completions'
    }

    async function callCustom(ep, system, prompt, maxTokens, timeoutMs) {
      if (!/^https?:\/\//i.test(ep.baseUrl)) return { ok: false, reason: 'API 地址必须是 http(s) 开头' }
      const body = Object.assign(
        { model: ep.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, stream: false },
        extraBodyNow(),
        { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: false },
      )
      const headers = { 'content-type': 'application/json' }
      if (ep.apiKey) headers.authorization = 'Bearer ' + ep.apiKey
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      if (timer.unref) timer.unref()
      try {
        const res = await fetch(chatUrl(ep.baseUrl), {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        })
        const text = await res.text()
        if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status + ' ' + clip(text.replace(/\s+/g, ' '), 120) }
        let data = null
        try { data = JSON.parse(text) } catch (e) { return { ok: false, reason: '返回不是 JSON：' + clip(text, 120) } }
        if (data && data.error) {
          return { ok: false, reason: '接口报错：' + clip(String(data.error.message || data.error.code || ''), 120) }
        }
        const msg = data && data.choices && data.choices[0] ? (data.choices[0].message || data.choices[0]) : null
        let content = msg ? msg.content : ''
        if (Array.isArray(content)) content = content.map((p) => (p && (p.text || p.content)) || '').join('')
        content = String(content || '')
        if (!content.trim()) return { ok: false, reason: '模型没有返回任何文字' }
        return { ok: true, text: content }
      } catch (e) {
        const msg = (e && e.name === 'AbortError') ? ('超时 ' + Math.round(timeoutMs / 1000) + ' 秒') : String((e && e.message) || e)
        return { ok: false, reason: msg }
      } finally {
        clearTimeout(timer)
      }
    }

    // ── 语境：最近几条（只给判定看，不进正文） ────────────────────
    function recentOf(chatKey) {
      const s = bot.state && typeof bot.state.get === 'function' ? bot.state.get(chatKey) : null
      if (!s) return []
      const sc = (s._scratch || (s._scratch = Object.create(null)))
      return (sc['tone-guard:recent'] || (sc['tone-guard:recent'] = []))
    }

    function recentLines(chatKey, excludeId) {
      const want = Math.max(0, Number(cfg().contextCount) || 0)
      if (!want) return []
      const arr = recentOf(chatKey)
      const out = []
      for (const it of arr) {
        if (excludeId !== undefined && excludeId !== null && Number(it.id) === Number(excludeId)) continue
        out.push(it)
      }
      return out.slice(-want)
    }

    function buildCaseText(input) {
      const recent = recentLines(input.chatKey, input.excludeMessageId)
      const ctx = recent.length
        ? '最近几条（同一会话，用来判断语境）：\n' + recent.map((it) => '· ' + it.name + '(QQ:' + it.qq + ')：' + it.text).join('\n')
        : '最近几条：（没有更早的消息）'
      const flags = []
      if (input.mentionedSelf) flags.push('@了机器人')
      if (input.hasQuote) flags.push('引用了消息')
      const head = '待判消息（' + (input.name || '某人') + '(QQ:' + input.qq + ')'
        + (flags.length ? '，' + flags.join('，') : '') + '，' + (input.isGroup ? '群聊' : '私聊') + '）：'
      return ctx + '\n\n' + head + '\n' + clip(input.text, CASE_CLIP)
        + '\n\n只输出一行 JSON，不要解释：\n'
        + '{"intent":"tease|insult|spam","target":"bot|other","confidence":0.0-1.0,"reason":"不超过16字"}'
    }

    /**
     * 跑一次判定（never throw）。
     * @returns {Promise<{ok:boolean, verdict:object|null, reason:string, ms:number, source:string, loose?:boolean}>}
     */
    async function runJudge(input) {
      const c = cfg()
      const inp = input && typeof input === 'object' ? input : {}
      const text = String(inp.text || '').trim()
      if (!text) return { ok: false, verdict: null, reason: '没有可判的正文', ms: 0, source: 'none' }
      const ep = endpointNow()
      noteReady(ep)
      if (!ep.ready) return { ok: false, verdict: null, reason: '判定接口未配置（' + (ep.missing.join('、') || '未就绪') + '）', ms: 0, source: ep.mode }
      const system = String(c.judgePrompt || '').trim() || defaultJudgePromptText()
      const prompt = buildCaseText(inp)
      const maxTokens = Math.max(16, Math.min(512, Number(c.maxTokens) || 64))
      const timeoutMs = secsToMs(c.timeoutMs, 6, 3000, 60000)
      const t0 = Date.now()
      let r
      if (ep.mode === 'custom') {
        r = await callCustom(ep, system, prompt, maxTokens, timeoutMs)
      } else {
        const cr = await bot.llm.complete({ system, prompt, maxTokens, timeoutMs })
        r = cr && cr.ok ? { ok: true, text: cr.text } : { ok: false, reason: (cr && cr.reason) || '宿主模型调用失败' }
      }
      const ms = Date.now() - t0
      calls.total += 1
      calls.lastMs = ms
      const verdict = r.ok ? parseVerdict(r.text) : null
      if (!r.ok) {
        calls.fail += 1
        log.warn('[语气守卫] 判定失败（本次当没判，照常回话）: ' + r.reason + ' [' + ms + 'ms]')
      }
      return {
        ok: Boolean(verdict),
        verdict,
        reason: r.ok ? (verdict ? '' : '模型没给出能解析的结论') : r.reason,
        ms,
        source: ep.mode,
        raw: r.ok ? clip(r.text, 300) : '',
      }
    }

    // ── 豁免 ─────────────────────────────────────────────────────
    function exemptNow(ev, qq) {
      const c = cfg()
      if (idList(c.exemptQqs).indexOf(String(qq)) >= 0) return true
      const gid = String(ev.groupId === undefined || ev.groupId === null ? '' : ev.groupId)
      if (gid && idList(c.exemptGroups).indexOf(gid) >= 0) return true
      return false
    }

    /** 是否值得判这条（唤醒种类 / 主人 / 豁免 / 有没有正文）。 */
    function shouldJudge(ev) {
      if (!enabledNow()) return false
      if (!ev || !ev.wake) return false
      if (!COUNTED_WAKES.has(String(ev.wake.kind || ''))) return false
      const qq = Number(ev.sender && ev.sender.qq)
      if (!Number.isInteger(qq) || qq <= 0) return false
      if (ev.sender && ev.sender.isMaster) return false
      if (exemptNow(ev, qq)) return false
      if (!String(ev.text || '').trim()) return false // 纯图 / 纯表情不判（省一次调用）
      return true
    }

    // ── ① pre-gate：屏蔽窗口内直接拦下 ───────────────────────────
    bot.on('pre-gate', (ev) => {
      if (!enabledNow()) return
      const qq = Number(ev.sender && ev.sender.qq)
      if (!Number.isInteger(qq) || qq <= 0) return
      if (ev.sender && ev.sender.isMaster) return
      const r = recOf(ev.chatKey, qq, false)
      if (!r) return
      const until = Number(r.muteUntil) || 0
      if (until <= Date.now()) return
      ev.stopped = true
      ev.stopReason = 'tone-guard:mute'
      log.debug('[语气守卫] 屏蔽中，拦下 ' + ev.chatKey + ' user=' + qq + '（到 ' + hhmm(until) + ' 解除）')
    }, { order: 11 })

    // ── ② passive-tap：记序号 + 语境（不阻塞、不判定） ─────────────
    bot.on('passive-tap', (ev) => {
      if (!enabledNow()) return
      const qq = Number(ev.sender && ev.sender.qq)
      if (!Number.isInteger(qq) || qq <= 0) return
      if (ev.sender && ev.sender.isMaster) return
      if (bot.selfId && qq === Number(bot.selfId)) return
      const k = keyOf(ev.chatKey, qq)
      seenMap.set(k, (seenMap.get(k) || 0) + 1)
      if (seenMap.size > 600) { // 别让它无限长（大群一天的说话人能有几百）
        const first = seenMap.keys().next().value
        if (first !== undefined) seenMap.delete(first)
      }
      const line = clip(String(ev.text || '').replace(/\s+/g, ' ').trim(), RECENT_CLIP)
      if (!line) return
      const arr = recentOf(ev.chatKey)
      arr.push({ id: ev.messageId, qq, name: nameOf(ev), text: line })
      while (arr.length > RECENT_MAX) arr.shift()
      const r = recOf(ev.chatKey, qq, true)
      r.lastSeenAt = Date.now()
      if (r.name !== nameOf(ev)) r.name = nameOf(ev)
    }, { order: 12 })

    // ── ③ wake：点火判定（点火即走，结果在 before-turn 收） ────────
    bot.on('wake', (ev) => {
      if (!shouldJudge(ev)) return
      const ep = endpointNow()
      noteReady(ep)
      if (!ep.ready) return
      const qq = Number(ev.sender.qq)
      const input = {
        text: String(ev.text || ''),
        chatKey: ev.chatKey,
        qq,
        name: nameOf(ev),
        isGroup: Boolean(ev.isGroup),
        mentionedSelf: Boolean(ev.mentionedSelf),
        hasQuote: ev.replyToId !== undefined && ev.replyToId !== null,
        excludeMessageId: ev.messageId,
      }
      ev._scratch['tone-guard:judge'] = Promise.resolve()
        .then(() => runJudge(input))
        .catch((e) => {
          log.warn('[语气守卫] 判定异常（本次当没判）: ' + ((e && e.message) || e))
          return null
        })
    }, { order: 18 })

    // ── ④ before-turn：收判定 → 记账 → 压 hint ───────────────────
    bot.on('before-turn', async (ev) => {
      if (!shouldJudge(ev)) return
      const c = cfg()
      const qq = Number(ev.sender.qq)
      const now = Date.now()
      const rec = recOf(ev.chatKey, qq, true)
      rec.name = nameOf(ev)
      rec.lastSeenAt = now

      const pending = ev._scratch ? ev._scratch['tone-guard:judge'] : null
      let judged = null
      if (pending) {
        try { judged = await pending } catch (e) { judged = null }
      }
      const verdict = judged && judged.ok ? judged.verdict : null
      const minConf = minConfidenceNow()
      const why = judged && judged.verdict
        ? '〔' + judged.verdict.intent + ' ' + judged.verdict.confidence.toFixed(2) + (judged.verdict.reason ? ' ' + judged.verdict.reason : '') + '〕'
        : ''

      // 垃圾消息：第一次不回；连续第二次 → 屏蔽
      if (verdict && verdict.intent === INTENT.SPAM && verdict.confidence >= minConf) {
        applySpam(ev, rec, now, why)
        saveState()
        return
      }

      // 辱骂：累计（窗口内不因"中间说了正常话"重置）
      if (verdict && verdict.intent === INTENT.INSULT && verdict.confidence >= minConf && targetIsBot(verdict, ev)) {
        applyInsult(ev, rec, now, why)
      }

      // 攻击态：只要还在窗口里，这条也照样怼（不管他这轮说的是什么）
      if (Number(rec.attackUntil) > now) pushAttackHint(ev, rec, now)
      saveState()
    }, { order: 300 })

    /** 「算数的最低把握」：面板值 / 配置值都走这里，命令与控制台不许再写死 0.7。 */
    function minConfidenceNow() {
      const n = Number(cfg().minConfidence)
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.7
    }

    /** target 缺省时按"这条是不是冲着它来的"兜底；明确判成 other 就放过（在说别人不算）。 */
    function targetIsBot(verdict, ev) {
      if (verdict.target === 'bot') return true
      if (verdict.target === 'other') return false
      return Boolean(ev.mentionedSelf || ev.replyToId !== undefined && ev.replyToId !== null || !ev.isGroup)
    }

    function applySpam(ev, rec, now, why) {
      const c = cfg()
      const limit = Math.max(1, Number(c.spamStreakLimit) || 2)
      const winMs = minsToMs(c.windowMin, 60)
      const seq = seenMap.get(keyOf(ev.chatKey, rec.qq)) || 0
      const prevSeq = rec.lastSpamSeq
      const sameWindow = Number(rec.lastSpamAt) > 0 && now - Number(rec.lastSpamAt) <= winMs
      // 「连续」= 上一条判成垃圾的就是他上一次说话，中间没夹别的消息
      const consecutive = sameWindow && Number.isInteger(prevSeq) && seq - Number(prevSeq) === 1
      const streak = consecutive ? Number(rec.spamStreak || 0) + 1 : 1
      rec.spamStreak = streak
      rec.lastSpamSeq = seq
      rec.lastSpamAt = now
      // 注意：不动 rec.count —— 垃圾消息不占辱骂额度，也不该替他抹掉已经记下的辱骂次数
      dirty = true
      const muteMs = minsToMs(c.spamMuteMin, 15)
      if (streak >= limit) {
        rec.spamStreak = 0
        rec.muteUntil = now + muteMs
        log.info('[语气守卫] 垃圾消息 ' + streak + '/' + limit + ' → 屏蔽到 ' + hhmm(rec.muteUntil)
          + '（' + ev.chatKey + ' user=' + rec.qq + (rec.name ? ' ' + rec.name : '') + '）' + why)
      } else {
        log.info('[语气守卫] 垃圾消息 ' + streak + '/' + limit + ' → 这条不回（' + ev.chatKey + ' user=' + rec.qq + '）' + why)
      }
      if (c.spamSilent !== false) {
        ev.stopped = true
        ev.stopReason = 'tone-guard:spam'
      }
    }

    function applyInsult(ev, rec, now, why) {
      const c = cfg()
      const limit = Math.max(1, Number(c.strikeLimit) || 3)
      const winMs = minsToMs(c.windowMin, 60)
      if (!(Number(rec.count) > 0) || now - Number(rec.firstAt) > winMs) {
        rec.count = 0
        rec.firstAt = now
      }
      rec.count = Number(rec.count) + 1
      rec.lastAt = now
      dirty = true
      const attackMs = minsToMs(c.attackMin, 15)
      if (rec.count >= limit) {
        rec.attackUntil = now + attackMs
        log.info('[语气守卫] 辱骂 ' + rec.count + '/' + limit + ' → 进入攻击态到 ' + hhmm(rec.attackUntil)
          + '（' + ev.chatKey + ' user=' + rec.qq + '）' + why)
      } else {
        log.info('[语气守卫] 辱骂 ' + rec.count + '/' + limit + ' → 本轮照常按人设回话（'
          + ev.chatKey + ' user=' + rec.qq + '）' + why)
      }
    }

    function pushAttackHint(ev, rec, now) {
      const tpl = String(cfg().attackPrompt || '').trim() || defaultAttackPromptText()
      const text = fillTemplate(tpl, {
        name: rec.name || '对方',
        qq: rec.qq,
        count: Number(rec.count) || 0,
        until: hhmm(rec.attackUntil),
        left: Math.max(1, Math.round((Number(rec.attackUntil) - now) / 60000)),
      })
      // hint 之间用空格拼（format.js: ev.hint.join(' ')）—— 前面加个换行让它自成一整段
      ev.hint.push('\n' + text)
      log.debug('[语气守卫] 攻击态生效 → hint 已压入（' + ev.chatKey + ' user=' + rec.qq + ' left=' + Math.max(1, Math.round((Number(rec.attackUntil) - now) / 60000)) + 'min）')
    }

    // ── 给控制台 / 命令 / 测试的能力（bot.shared 是跨插件共享槽） ──
    function judgeInfo() {
      const ep = endpointNow()
      return {
        enabled: enabledNow(),
        mode: ep.mode,
        ready: ep.ready,
        missing: ep.missing,
        baseUrl: maskUrl(ep.baseUrl),
        model: ep.model,
        hasKey: Boolean(ep.apiKey),
        minConfidence: minConfidenceNow(),
        calls: { total: calls.total, fail: calls.fail, lastMs: calls.lastMs },
        statePath: statePath(),
      }
    }

    function rows(scopeChatKey) {
      const now = Date.now()
      const c = cfg()
      const limit = Math.max(1, Number(c.strikeLimit) || 3)
      const winMs = minsToMs(c.windowMin, 60)
      const out = []
      for (const r of Object.values(st().records)) {
        if (!r) continue
        if (scopeChatKey && String(r.chat) !== String(scopeChatKey)) continue
        const bits = []
        if (Number(r.count) > 0 && now - Number(r.firstAt) <= winMs) bits.push('辱骂 ' + r.count + '/' + limit + ' 次')
        if (Number(r.spamStreak) > 0) bits.push('垃圾消息 ' + r.spamStreak + ' 条（连续）')
        if (Number(r.muteUntil) > now) bits.push('屏蔽到 ' + hhmm(r.muteUntil))
        if (Number(r.attackUntil) > now) bits.push('攻击态到 ' + hhmm(r.attackUntil))
        if (!bits.length) continue
        out.push({
          chat: String(r.chat), qq: Number(r.qq), name: String(r.name || ''),
          label: chatLabel(r.chat) + '｜' + (r.name || '某人') + '(QQ:' + r.qq + ')：' + bits.join('，'),
        })
      }
      out.sort((a, b) => (a.chat === b.chat ? a.qq - b.qq : (a.chat < b.chat ? -1 : 1)))
      return out
    }

    function clearRecords(scopeChatKey, qq) {
      const records = st().records
      let n = 0
      for (const k of Object.keys(records)) {
        const r = records[k]
        if (!r) continue
        if (scopeChatKey && String(r.chat) !== String(scopeChatKey)) continue
        if (qq && Number(r.qq) !== Number(qq)) continue
        delete records[k]
        n += 1
      }
      if (n) { dirty = true; saveState() }
      return n
    }

    if (bot.shared) {
      bot.shared.toneGuard = {
        judge: (input) => runJudge(input),
        judgeInfo,
        rows,
        clear: clearRecords,
      }
    }

    // 启动时说清"现在到底判不判"，省得以为开了却没生效
    const ep0 = endpointNow()
    noteReady(ep0)
    if (ep0.ready) {
      log.info('[语气守卫] 已就绪：' + (ep0.mode === 'host' ? '宿主默认模型' : ep0.model + ' @ ' + maskUrl(ep0.baseUrl)))
    }
  },
}
