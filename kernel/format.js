/**
 * kernel/format.js — 纯文本 / 入站事件归一。无 I/O、无 this、无模块状态。
 *
 * 为什么全做成纯函数：历史实现最贵的债就是"同一条规则收发两处各写一遍"——
 * 脱敏 / [AT:] / 引用 / 长度在两条发送路径上各有一份，改一处忘一处。
 * 内核把这类逻辑收进这里，谁要就 import，不许再复制第二份。
 *
 * 平台边界：`escapeCq` 的唯一实现在 `platform/cq-file.js`（要一起转义 `,`，否则路径里的
 * 逗号会把 CQ 参数拆坏）；本文件只再导出，**不要**在这里写第二份。
 */

import { createEvent } from '../contracts.js'
import { escapeCq, escapeCqText, escapeCqParam } from '../platform/cq-file.js'

export { escapeCq, escapeCqText, escapeCqParam }

// ============================================================
// 六项出口脱敏（设计定稿：只拦 QQ 号 / 服务器 IP / 端口 / root 凭据 / 密码 / API key）
// 命中不再拒发，而是把该字段就地换成 [已隐去] 后照发 —— 脱敏是兜底不是审查。
// ============================================================
const SENSITIVE_RULES = [
  // 裸号码只认 9~11 位（真实 QQ 长度）：5~8 位普通数字（等级/人数/商品号）不再误伤；带 QQ/群 标签的 5~12 位全拦
  ['qq', /(?:QQ|qq|扣扣|群)\s*(?:号码?)?\s*(?:是|为)?\s*[:：=]?\s*\d{5,12}|\b[1-9]\d{8,10}\b/],
  // IP 连同后面的 :端口 一起吃，免得留下 ":3080" 这种尾巴
  ['ip', /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/],
  // 端口四种形态；不误伤 10:30 这类时间（时间的前缀是 1~2 位数字，这里要求 host:4~5 位）
  ['port', /(?:端口|port)\s*[:：]?\s*\d{2,5}\b|(?<![\d.])\d{2,5}\s*(?:端口|port)|\b[\w.-]+:\d{4,5}\b/i],
  // root 凭据：连值一起清除
  ['rootCred', /(?:\broot\b[^\n]{0,8}(?:密码|口令|password|passwd)\s*(?:是|为)?\s*[:=：]?\s*\S+)|\broot@\S+/i],
  // 密码/口令：连值一起清除
  ['password', /(?:密码|口令|password|passwd)\s*(?:是|为)?\s*[:=：]?\s*\S+/],
  ['apiKey', /api[_-]?key\s*[:=]?\s*\S*|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+/i],
]

/**
 * @param {string} text
 * @param {{exempt?: boolean}} [opts] exempt = 主人私聊（唯一豁免通道，别的地方传 true 就是漏洞）
 * @returns {{text: string, hits: string[]}} hits 是命中的规则名（契约 SENSITIVE_KINDS），供日志/回报
 */
export function sanitizeSensitive(text, { exempt = false } = {}) {
  if (exempt) return { text: String(text ?? ''), hits: [] }
  let out = String(text ?? '')
  const hits = []
  for (const [kind, re] of SENSITIVE_RULES) {
    // 规则只写一遍 source：在字符串上做 g 替换，命中名回传，别为"先测后换"再写第二条正则
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    if (!g.test(out)) continue
    hits.push(kind)
    out = out.replace(g, '[已隐去]')
  }
  return { text: out, hits }
}

/** 兼容旧调用：只要清理后的文本 */
export function redactSensitive(text) {
  return sanitizeSensitive(text).text
}

// ============================================================
// CQ 码 / @ 标记 / 文本长度
// ============================================================

/**
 * CQ 码参数反转义（入站用）：协议端在 `file=` 等参数里会把 `& [ ] ,` 转义成实体，
 * 解析成本地路径前必须先还原 —— 否则含逗号/方括号的 Windows 路径会被拆坏或带实体入库。
 */
export function unescapeCq(input) {
  return String(input ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

/**
 * 从出站正文抽 @ 标记：`[AT:qq=123]` → 号码，`[AT:奶茶]` → 名字（群聊再查成员表）。
 * ⚠️ 只认方括号里以 AT: 开头的内容，其它方括号交给 escapeCq 转义。
 */
export function extractAtMarkers(s) {
  const qq = []
  const names = []
  let text = String(s ?? '').replace(/\[AT:qq=(\d+)\]\s*/gi, (m, n) => { qq.push(Number(n)); return '' })
  text = text.replace(/\[AT:([^[\]]{1,40})\]\s*/g, (m, nm) => { const t = nm.trim(); if (t) names.push(t); return '' })
  return { text, qq, names }
}

/**
 * 按**码点**截断，绝不切开代理对。
 * `slice(0, n)` 数的是 UTF-16 单元：一串 🌕 被切在中间会留下孤立代理，拼进 prompt 后请求体
 * JSON 非法 → 上游一律 400 INVALID_REQUEST，而且已进会话历史 → **之后每一轮都失败**
 * （线上踩过：孤立代理会让之后每一轮请求都 400）。
 */
export function clipChars(text, max) {
  const str = String(text ?? '')
  return str.length <= max ? str : [...str].slice(0, max).join('')
}

/** 兜底合法化：把孤立代理换成 U+FFFD（Node 20+ 的 toWellFormed），保证发给 API/QQ 的文本永远合法 */
export function toWellFormedText(s) {
  const str = String(s ?? '')
  return typeof str.toWellFormed === 'function' ? str.toWellFormed() : str
}

/**
 * 长文本分段。切点优先级：段落 → 换行 → 句末标点 → 空格 → 硬切。
 * 硬切按"码点"切（emoji 占 2 个单元，按 UTF-16 下标切会劈成 �）；
 * 只在 [40%, maxLen] 区间找切点，免得为凑一个标点把段落切得七零八落。
 * @param {string} text
 * @param {number|{max?: number}} opts 目标长度（兼容直接传数字）
 * @returns {string[]}
 */
export function splitLongText(text, opts = {}) {
  const t = String(text ?? '')
  const maxLen = Math.max(1, Number(typeof opts === 'object' ? opts.max : opts) || 3000)
  const cps = Array.from(t) // 按码点切
  if (cps.length <= maxLen) return [t]
  const minCut = Math.max(1, Math.floor(maxLen * 0.4))
  // 分隔符在码点数组上找切点，不经过字符串 —— lastIndexOf 给的是 UTF-16 下标，遇 emoji 会算错
  const SEPS = ['\n\n', '\n', '。', '！', '？', '；', '…', '~', '!', '?', ' '].map((s) => Array.from(s))
  const startsWith = (arr, i, pat) => pat.every((c, k) => arr[i + k] === c)
  const parts = []
  let start = 0
  while (cps.length - start > maxLen) {
    const limit = start + maxLen
    let cut = -1
    for (const pat of SEPS) {
      for (let i = limit - pat.length; i >= start + minCut; i--) {
        if (startsWith(cps, i, pat)) { cut = i + pat.length; break }
      }
      if (cut > 0) break
    }
    if (cut <= start) cut = limit
    parts.push(cps.slice(start, cut).join(''))
    start = cut
  }
  if (start < cps.length) parts.push(cps.slice(start).join(''))
  return parts
}

/**
 * 拆条用：找"短开头 + 正话"的自然断点，找不到返回 null。
 * 只在首句够短（2~13 字、不含换行）且余下 ≥8 字时才拆 —— 绝不把一句话拦腰砍断。
 */
/**
 * 把一段回复按**自然句末**切成 2~maxParts 条（拆条 = 连发几条短消息，像真人打字）。
 *
 * 纪律：只在句末标点（。！？!?…～~）或换行处切，**绝不把一句话从中间砍开**；
 * 单句 / 带 CQ 码 / 切完只剩一条 → 返回 null（调用方降级成单条发，话不能吞）。
 *
 * `maxParts` 之外的句子按"最短相邻两条合并"收拢，保证不出现一长串碎句。
 * @returns {string[]|null} 2..maxParts 段；无法安全拆 → null
 */
export function splitBubbles(text, { maxParts = 3, minPartChars = 2 } = {}) {
  const t = toWellFormedText(String(text ?? '')).trim()
  if (!t || t.includes('[CQ:')) return null
  const cap = Math.max(2, Math.min(6, Math.floor(Number(maxParts) || 3)))
  // 句末标点留在前一句；换行也当硬断点
  const raw = t.split(/(?<=[。！？!?…～~])|\n+/).map((x) => x.trim()).filter(Boolean)
  if (raw.length < 2) return null
  const parts = []
  for (const seg of raw) {
    // 过短碎片（"嗯"、孤零零的标点）并进前一条，别单独发一条
    if (parts.length && seg.length < Math.max(1, Number(minPartChars) || 2)) parts[parts.length - 1] += seg
    else parts.push(seg)
  }
  if (parts.length < 2) return null
  while (parts.length > cap) {
    let at = 0
    let best = Infinity
    for (let i = 0; i < parts.length - 1; i += 1) {
      const len = parts[i].length + parts[i + 1].length
      if (len < best) { best = len; at = i }
    }
    parts.splice(at, 2, parts[at] + parts[at + 1])
  }
  return parts.length >= 2 ? parts : null
}

/** 旧接口（只拆两条）：等价于 splitBubbles(text, { maxParts: 2 })。 */
export function pickSplitPoint(text) {
  const parts = splitBubbles(text, { maxParts: 2 })
  if (!parts) return null
  // 老语义还有两条长度约束：首条是短反应（≤13 字），第二条得说满 8 字
  const [head, tail] = parts
  if (!head || !tail || head.includes('\n')) return null
  if (head.length > 13 || tail.length < 8) return null
  return [head, tail]
}

/**
 * 群唤醒词表（文本行格式）→ `{ '*': [...], '<群号>': [...] }`。
 *
 * 行格式（控制台「群聊」页与实例配置共用这一种，别再搞第二套）：
 *   `*: 词1,词2`       全局唤醒词（人设 `.wake.txt` 非空时被它覆盖）
 *   `<群号>: 词1,词2`  该群专属唤醒词（永远叠加，只加不改）
 *   `# ...`            注释行
 * 没有冒号的行按「全局词」处理；也接受已解析好的 `{ '*': [...] }` 对象（原样归一）。
 */
export function parseKeywordLines(input) {
  const table = Object.create(null)
  const push = (key, words) => {
    if (!key || !words.length) return
    const list = table[key] || (table[key] = [])
    for (const w of words) if (!list.includes(w)) list.push(w)
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, words] of Object.entries(input)) {
      const list = (Array.isArray(words) ? words : String(words ?? '').split(/[,，\s]+/))
        .map((w) => String(w ?? '').trim()).filter(Boolean)
      push(String(key).trim(), list)
    }
    return table
  }
  for (const raw of String(input ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([^:：]+)\s*[:：]\s*(.*)$/.exec(line)
    const key = m ? m[1].trim() : '*'
    const body = m ? m[2] : line
    push(key || '*', body.split(/[,，\s]+/).map((w) => w.trim()).filter(Boolean))
  }
  return table
}

// ============================================================
// 出站 wire（CQ 码串）解析 —— 给留档/回报用，不参与发送
// ============================================================

/** wire 串 → 可读文本（剥 CQ 码） */
export function wireToText(wire) {
  return String(wire ?? '')
    .replace(/\[CQ:reply,id=-?\d+\]\s*/g, '')
    .replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, '@$1')
    .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
    .trim()
}

/** wire 串 → { at, replyTo, images } */
export function parseWire(wire) {
  const s = String(wire ?? '')
  const at = [...s.matchAll(/\[CQ:at,qq=(\d+)/g)].map((m) => Number(m[1]))
  const reply = /\[CQ:reply,id=(-?\d+)\]/.exec(s)
  const images = [...s.matchAll(/\[CQ:image,[^\]]*file=([^,\]]+)/g)].map((m) => m[1])
  return { at, replyTo: reply ? Number(reply[1]) : null, images }
}

// ============================================================
// 图片：格式识别 / 像素尺寸 / 出图档位
// ============================================================

/** 按文件头识别图片 MIME（DSH 图像块只接受 png/jpeg/webp/gif） */
export function detectImageMediaType(buf) {
  if (!buf || buf.length < 12) return 'image/png'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  return 'image/png'
}

/** 读图片真实像素尺寸（PNG/JPEG；读不出返回 null）—— 回报"这为什么是竖图"用数说话，不用猜 */
export function imagePixelSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } // PNG IHDR
    if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: 扫 SOFn
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
        }
        i += 2 + len
      }
    }
  } catch { /* 读不出就算了 */ }
  return null
}

/**
 * 按参考图比例挑"1K 档"出图尺寸（gpt-image 原生档位）。
 * 为什么不能留空 size：实测 —— 不传或传 `auto` 都给 2048x2048，且不跟原图竖/横比例，
 * 所以默认由内核按主参考图（第一张）的比例选最近档。
 */
export function pickImageSizeByRatio(buf) {
  const px = imagePixelSize(buf)
  if (!px || !px.w || !px.h) return '1024x1024'
  const r = px.w / px.h
  if (r > 1.15) return '1536x1024' // 横图
  if (r < 0.87) return '1024x1536' // 竖图
  return '1024x1024'
}

// ============================================================
// 会话标识 / 时间
// ============================================================

/** 发送人显示名（群名片 > 昵称 > QQ 号）—— 提示里的说话人、表情来源都用它，只有这一处实现 */
export function senderNameOf(event, userId) {
  const s = event?.sender ?? event ?? {}
  return s.card || s.name || s.nickname || String(userId ?? s.qq ?? '')
}

/** 北京时间字符串（进程时区是 UTC，手工 +8） */
export function beijingTime(ms) {
  const d = new Date(Number(ms || Date.now()) + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

// ============================================================
// 入站：CQ 串拆段 / 段数组 → 正文 + 附件（旧 extractText）
// ============================================================

/** 纯字符串按 CQ 码拆成段数组（最小实现，兼容 raw_message / message 为字符串的协议端） */
function parseCqString(str) {
  const segments = []
  const re = /\[CQ:([a-z]+)(?:,([^\]]*))?\]/g
  let last = 0
  let m
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) segments.push({ type: 'text', data: { text: str.slice(last, m.index) } })
    const data = {}
    if (m[2]) {
      for (const kv of m[2].split(',')) {
        const eq = kv.indexOf('=')
        // 参数值反转义：`&#44;` / `&#91;` 等还原（入站路径可能带转义逗号/方括号）
        if (eq > 0) data[kv.slice(0, eq)] = unescapeCq(kv.slice(eq + 1))
      }
    }
    segments.push({ type: m[1], data })
    last = m.index + m[0].length
  }
  if (last < str.length) segments.push({ type: 'text', data: { text: unescapeCq(str.slice(last)) } })
  return segments
}

// 卡片(小程序/分享卡)真链接藏的字段；正文里一个字都没有，链接只在 meta 里
const CARD_PATHS = [
  ['miniapp', 'legacyUrl'], ['miniapp', 'pcJumpUrl'], ['miniapp', 'jumpUrl'], ['miniapp', 'sourceUrl'], ['miniapp', 'url'],
  ['detail_1', 'qqdocurl'], ['detail_1', 'jumpUrl'], ['detail_1', 'url'], ['detail_1', 'sourceUrl'], ['detail_1', 'shareUrl'], ['detail_1', 'targetUrl'],
  ['news', 'jumpUrl'], ['news', 'url'], ['news', 'sourceUrl'], ['news', 'shareUrl'],
  ['music', 'musicUrl'], ['music', 'jumpUrl'], ['music', 'url'],
]
const CARD_SKIP_KEYS = /^(icon|preview|image|imageUrl|cover|coverUrl|thumb|thumbnail|avatar|poster)$/i
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)(\?|#|$)/i

/** 从卡片 JSON 里挖第一个可解析链接（`\/` 是 JSON 转义过的斜杠） */
function cardFirstUrl(value) {
  const s = String(value ?? '').replace(/\\\//g, '/')
  const m = s.match(/https?:\/\/[^\s"'<>\\\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/)
  return m ? m[0].replace(/[),.;!?，。；！？、）》」』】]+$/, '') : null
}

function extractCardUrl(seg) {
  let obj = seg?.data ?? seg
  if (typeof obj === 'string') { try { obj = JSON.parse(obj) } catch { return null } }
  if (!obj || typeof obj !== 'object') return null
  if (obj.data && typeof obj.data === 'object') obj = obj.data
  else if (typeof obj.data === 'string') { try { obj = JSON.parse(obj.data) } catch { /* 不是 JSON 就按原对象找 */ } }
  const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : null
  if (meta) {
    for (const [k1, k2] of CARD_PATHS) {
      const node = meta[k1]
      if (node && typeof node === 'object') { const url = cardFirstUrl(node[k2]); if (url) return url }
    }
    for (const node of Object.values(meta)) {
      if (!node || typeof node !== 'object') continue
      for (const [k, v] of Object.entries(node)) {
        if (typeof v !== 'string' || CARD_SKIP_KEYS.test(k)) continue
        const url = cardFirstUrl(v)
        if (url && !IMG_EXT_RE.test(url)) return url
      }
    }
  }
  return cardFirstUrl(obj.url)
}

/**
 * 入站消息 → { text, mentioned, files, quotes, images, cards, rawSegments }。
 * @param {string|Array|{message?: any}} message OneBot 的 message / raw_message / 事件对象
 * @param {number|string} selfId 本机 QQ：@本机 只算"叫了本机器人"，不写进正文
 *
 * 行为坑（搬旧代码时留的账）：
 *  · `@别人` 必须写进正文：以前直接丢空串，模型完全不知道 @ 了谁。
 *  · 真图 vs 表情必须分清：判据只看协议字段 emoji_id / sub_type，**不看 summary 字符串**
 *    —— 旧实现两处判据不一致，采集侧把 sub_type 7/11 的表情静默滤掉过。
 *  · 卡片链接抽出来单独放 cards，**不塞进 text**：保持"卡片不算文字"的旧行为，只有链接解析用它。
 */
/**
 * 把一条合并转发（get_forward_msg 的返回）渲染成可读文本。
 *
 * 为什么单独一个函数：转发是**嵌套结构**（一条转发里还有发送者、时间、以及任意段），
 * 内联在 extractText 里会和主流程互相纠缠；而且它是**纯函数**，测试不用起协议端。
 *
 * 取舍：
 *   · 每条前缀 `[昵称(QQ:号)]: `（跟群上文格式一致，模型认这个形状）
 *   · 单条正文 clip 到 `perItemChars`，整体 clip 到 `totalChars` —— 一条 200 条的转发
 *     全塞进去会把上下文撑爆，而模型只需要"大概聊了啥"
 *   · 超量时明确告诉模型"后面还有 N 条省略"，别让它以为就这些
 *
 * @param {{messages:Array}|null} forward  get_forward_msg 的返回
 * @param {object} [opts]
 * @param {number} [opts.maxItems]      最多渲染几条（默认 30）
 * @param {number} [opts.perItemChars]  单条最多多少字（默认 80）
 * @param {number} [opts.totalChars]    总字数上限（默认 2000）
 * @returns {string} 渲染结果；forward 为空时返回 ''（调用方据此降级）
 */
export function renderForward(forward, opts = {}) {
  // 两种来源都吃：
  //   · get_forward_msg 的返回 → { messages: [...] }
  //   · get_msg 内联的 forward 段 → { content: [...] }（真机走这条，别漏）
  const list = Array.isArray(forward?.messages) ? forward.messages
    : Array.isArray(forward?.content) ? forward.content
      : Array.isArray(forward) ? forward
        : []
  if (!list.length) return ''
  const maxItems = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : 30
  const perItem = Number(opts.perItemChars) > 0 ? Number(opts.perItemChars) : 80
  const total = Number(opts.totalChars) > 0 ? Number(opts.totalChars) : 2000

  const shown = list.slice(0, maxItems)
  const lines = []
  for (const it of shown) {
    const uid = it?.sender?.user_id ?? it?.user_id ?? ''
    const name = String(it?.sender?.card || it?.sender?.nickname || uid || '?')
    // 每条内容按段解析（不递归 parse 转发 —— 嵌套转发极罕见，且会被 QQ 折叠）
    // ⚠️ 真机：内层条目的 message 有时是空字符串/空数组，正文只在 raw_message 里
    const body = clipChars(extractText(it?.message ?? it?.content ?? '', null).text
      || String(it?.raw_message ?? '').trim()
      || '[非文字]', perItem)
      .replace(/\s+/g, ' ')
      .trim()
    lines.push(`[${name}${uid ? `(QQ:${uid})` : ''}]: ${body}`)
  }
  let text = lines.join('\n')
  if (text.length > total) text = `${clipChars(text, total)}…`
  const rest = list.length - shown.length
  if (rest > 0) text += `\n…（还有 ${rest} 条未列出）`
  return text
}

export function extractText(message, selfId) {
  let segments = []
  if (typeof message === 'string') segments = parseCqString(message)
  else if (Array.isArray(message)) segments = message
  else if (message && Array.isArray(message.message)) segments = message.message
  else if (message && typeof message.message === 'string') segments = parseCqString(message.message)

  const parts = []
  const files = []
  const quotes = []
  const images = []
  const cards = []
  const forwards = []   // 合并转发的 id（可能多条）
  let mentioned = false
  for (const seg of segments) {
    const type = seg?.type || ''
    const d = seg?.data ?? seg ?? {}
    if (type === 'text') {
      parts.push(d.text ?? seg.text ?? '')
    } else if (type === 'at') {
      const qq = String(d.qq ?? seg.qq ?? '')
      if (selfId != null && qq === String(selfId)) { mentioned = true; parts.push('') }
      else if (qq === 'all') parts.push('@全体成员 ')
      else if (qq) parts.push(`@${qq} `) // 拿不到"@别人→名字"解析器时退回号码（纯函数不许打网络）
      else parts.push('')
    } else if (type === 'image') {
      const summary = String(d.summary ?? '').trim()
      const emojiId = d.emoji_id ? String(d.emoji_id) : ''
      const subType = Number(d.sub_type ?? 0)
      const isSticker = !!(emojiId || subType !== 0)
      const url = String(d.url ?? '')
      const file = String(d.file ?? '')
      if (url || file) images.push({ url, file, isSticker, summary, emojiId, subType })
      if (isSticker) {
        const name = summary.replace(/^\[|\]$/g, '').trim()
        parts.push(name && name !== '动画表情' ? `[表情:${name}]` : '[表情]')
      } else parts.push('[图片]')
    } else if (type === 'record') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'file') {
      // fileId 是回协议端溯源本地文件的唯一把手（url 会过期）；name/url/size 按契约给插件用
      const fileId = String(d.file_id ?? d.file ?? '')
      if (fileId) files.push({ name: String(d.name ?? ''), url: String(d.url ?? ''), size: Number(d.file_size ?? 0) || 0, fileId })
      parts.push('')
    } else if (type === 'reply') {
      const rid = String(d.id ?? d.message_id ?? '')
      if (rid) quotes.push(rid)
      parts.push('')
    } else if (type === 'json') {
      const url = extractCardUrl(seg)
      if (url) cards.push(url)
      parts.push('')
    } else if (type === 'forward') {
      // 合并转发。⚠️ 真机实测：协议端的 get_msg 已经把转发内容**内联**在
      //   data.content 里了，而 get_forward_msg(id) 对这类消息常直接失败
      //   （"消息已过期或者为内层消息"）。所以先把 inline 内容带出去，别白跑一趟。
      // 纯函数不碰网络：这里只做结构整理，取不到才由 index.js 回退请求。
      const fid = String(d.id ?? d.resid ?? '')
      const inline = Array.isArray(d.content) ? d.content : null
      if (fid || inline) forwards.push({ id: fid, content: inline })
      parts.push('[合并转发]')
    } else parts.push('') // face / 未知段：忽略
  }
  return { text: parts.join('').trim(), mentioned, files, quotes, images, cards, forwards, rawSegments: segments }
}

// ============================================================
// OneBot 原始事件 → 契约事件（contracts.createEvent）
// ============================================================

/**
 * 把 OneBot v11 原始事件归一成 `contracts.createEvent` 的入参并返回事件对象。
 * 返回 **null** = 这条事件根本不该进管线（心跳/生命周期/自己发的）——内核在入管线前先滤掉，
 * 别让自发轮或命令自己触发自己。
 *
 * 通知事件（戳一戳）在契约事件里没有位置，原样塞进 `ev._scratch.notice`：gate-wake 在 intercept
 * 阶段靠它回戳。**不许**用 text 伪造（模型会把"戳一戳"当成一句话来回）。
 *
 * @param {object} rawEvent OneBot 原始事件
 * @param {number|string} selfId 本机 QQ
 * @param {number|string|null} adminQq 主人 QQ（填 sender.isMaster；契约要求这个字段）
 */
export function normalizeEvent(rawEvent, selfId, adminQq = null) {
  if (!rawEvent) return null
  const isNotice = rawEvent.post_type === 'notice'
  if (rawEvent.post_type !== 'message' && !isNotice) return null // meta_event / lifecycle / message_sent
  // 既没有群号也没有 user_id 的 notice = 无法归线的系统事件（点赞通知 profile_like / bot_offline…）：
  // 直接丢。否则 chatKey 会变成 `private:undefined`，被"私聊永远算被叫"放行 → 空对话进模型、
  // 还建出 private:undefined 的 DSH 会话（2026-10-25 13:57 事故：两条点赞通知 = 两个空对话）。
  if (isNotice && rawEvent.user_id == null && rawEvent.group_id == null) return null
  const uid = rawEvent.user_id
  if (uid != null && selfId != null && String(uid) === String(selfId)) return null // 自己发的
  const isGroup = isNotice ? rawEvent.group_id != null : rawEvent.message_type === 'group'
  const x = isNotice
    ? { text: '', mentioned: false, files: [], quotes: [], images: [], cards: [], forwards: [], rawSegments: [] }
    : extractText(rawEvent.message ?? rawEvent.raw_message ?? '', selfId)
  const ev = createEvent({
    chatKey: isGroup ? `group:${rawEvent.group_id}` : `private:${uid}`,
    isGroup,
    groupId: rawEvent.group_id ?? null,
    messageId: rawEvent.message_id ?? null,
    sender: {
      qq: Number(uid) || null,
      name: String(rawEvent.sender?.card || rawEvent.sender?.nickname || uid || ''),
      card: rawEvent.sender?.card ?? null,
      isMaster: adminQq != null && String(uid) === String(adminQq),
    },
    time: rawEvent.time ? Number(rawEvent.time) * 1000 : Date.now(),
    text: x.text,
    rawSegments: x.rawSegments,
    mentionedSelf: x.mentioned,
    replyToId: x.quotes[0] ?? null,
    images: x.images,
    files: x.files,
    cards: x.cards,
  })
  // 合并转发的 id（可能多条）：before-turn 里再取内容（get_forward_msg 要打接口，不在纯函数里做）
  if (Array.isArray(x.forwards) && x.forwards.length) ev._scratch.forwards = x.forwards
  if (isNotice) {
    ev._scratch.notice = {
      type: rawEvent.notice_type,
      subType: rawEvent.sub_type ?? '',
      userId: Number(uid) || null,
      targetId: rawEvent.target_id != null ? Number(rawEvent.target_id) : null,
    }
    ev.mentionedSelf = rawEvent.target_id != null && String(rawEvent.target_id) === String(selfId)
  }
  return ev
}

// ============================================================
// 拼 prompt —— 槽位顺序是硬约定，别随手挪：
//   头契约+会话ID/消息ID → 唤醒标记 → 说话人+正文 → 附件/引用/卡片 → 图片路径
//   → 群上文 → hint 数组 → 尾契约
// 为什么尾巴要再提一次契约：模型最容易忘"只写正文 = 群里收不到"，而它读到最后看的正是尾巴。
// ============================================================

/**
 * @param {object} ev 契约事件（wake/hint/imagePaths/historyBlock 已由前面阶段写好）
 * @param {{quoteText?: string, fileHint?: string}} [opts] quoteText = 反查到的被引正文；fileHint = 文件落盘提示
 */
export function buildPromptText(ev, opts = {}) {
  const greeted = opts.greeted === true
  const chatTag = greeted
    ? `[本条消息ID ${ev.messageId ?? '-'}]`
    : `[QQ会话 ${ev.chatKey}｜本条消息ID ${ev.messageId ?? '-'}]`
  const head = `[QQ线:回话须调工具] ${chatTag} `
  // 唤醒标记：只给**极简**标签。具体该怎么说由 index.js 的 hint 按「群聊 / 私聊」分别写，
  // 这里再写一遍只会变成两套互相打架的话（踩过：私聊里冒出「群里正聊着」）。
  const wakeMark = ev.wake?.kind === 'keyword' ? `[关键词:${ev.wake.keyword}] `
    : ev.wake?.kind === 'followup' ? '[接上条] '
      : ev.wake?.kind === 'proactive' ? '[主动开口轮] '
        : ev.wake?.kind === 'continuation' ? '[续聊检查] '
          : ev.wake?.kind === 'welcome' ? '[入群欢迎轮] ' : ''
  // 群里必须带说话人+QQ：同名/近名的人靠号码才能分开（否则会把 A 说的话安到 B 头上）
  // 主动接话轮/入群欢迎轮的"触发"不是某个人发的消息 → 不挂说话人前缀，避免凭空出现一个空名字
  const speakerName = senderNameOf(ev.sender, ev.sender?.qq)
  const speakerQq = Number(ev.sender?.qq)
  const speakerTag = speakerQq > 0 ? `${speakerName}(QQ:${speakerQq})` : speakerName
  const speaker = ev.isGroup && ev.wake?.kind !== 'proactive' && ev.wake?.kind !== 'continuation' && ev.wake?.kind !== 'welcome'
    ? `[${speakerTag}]: ` : ''
  const quote = opts.quoteText ? `\n\n[引用]\n${opts.quoteText}` : ''
  const fileHint = opts.fileHint ? `\n${opts.fileHint}` : ''
  const cardHint = ev.cards?.length ? `\n[卡片] ${ev.cards.join(' ')}` : ''
  const imgHint = ev.imagePaths?.length ? `\n[图: ${ev.imagePaths.join(', ')}]` : ''
  const ctx = ev.historyBlock ? `\n${ev.historyBlock}` : ''
  const hints = ev.hint?.length ? `\n${ev.hint.join(' ')}` : ''
  // 尾巴：模型读到最后看的正是这一句。
  //   · 合成轮（主动开口 / 续聊）里，**群聊**要求"不发也要写一行 [不发] 原因"——
  //     群里没人点它名，只写正文就等于石沉大海，必须逼它明确表态；
  //   · **私聊**不这么逼：一对一里"这次不想说话"是正常行为，硬要它写 [不发] 反而像客服。
  // 合成轮的收尾句由调用方给（index.js 从控制台的「提示词（可改）」里取，ev._tail）；
  // 没给就退回默认 —— 这样文案可配置，format.js 不用管文案长什么样。
  const isSynthTurn = ev.wake?.kind === 'proactive' || ev.wake?.kind === 'continuation'
  const customTail = String(ev._tail || '').trim()
  const tail = isSynthTurn
    // 它自己带了「[提醒: …]」就整句用它，否则补上前缀
    ? (customTail
      ? (customTail.startsWith('[') ? '\n' + customTail : '\n[提醒: ' + customTail + ']')
      : (ev.isGroup
        ? '\n[提醒: 发到群里必须调 send_message；这轮不打算说话也要在正文写一行 [不发] 原因]'
        : '\n[提醒: 想说话就调 send_message；不想说就不发，不用解释]'))
    : '\n[提醒:只写正文收不到]'
  // 双保险：拼好的 prompt 再兜一道合法化 —— 历史里只要带一个孤立代理，上游就整轮 400
  return toWellFormedText(head + wakeMark + speaker + (ev.text || '') + fileHint + quote + cardHint + imgHint + ctx + hints + tail)
}
