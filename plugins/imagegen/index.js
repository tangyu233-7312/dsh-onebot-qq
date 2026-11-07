/**
 * imagegen.js — 生图 / 图生图 / 头像子插件（id: imagegen，order: 60）
 *
 * 生图协议（`credentials.gptImage.protocol`；环境变量 `QQ_IMAGEGEN_PROTOCOL` 优先）：
 *   · `openai-images`（默认）：`POST {base}/images/generations`（JSON 文生图）+
 *     `POST {base}/images/edits`（multipart 图生图；重复 `image` 字段 = 多张参考，顺序即传入顺序）。
 *   · `openai-chat`：`POST {base}/chat/completions`（JSON，messages 里放文本 + 参考图 data URL）。
 *     适合只提供 chat 出图能力的中转站；响应尽量宽容地解析 URL / base64 / markdown 图 / data URI。
 *
 * 凭据纪律：**代码里不写死任何 apiKey / baseUrl** —— 实例配置 `credentials.gptImage`
 * （`bot.credentials` / `setup(bot, opts)` 的 `opts.credentials`）注入，或环境变量：
 *   QQ_IMAGEGEN_API_KEY / QQ_IMAGEGEN_BASE_URL / QQ_IMAGEGEN_MODEL。
 * 没配置时工具报"未配置生图凭据"的友好错误，不抛底层 401。
 *
 * 平台边界：生图快照写 `resolveTmpDir('imagegen')`（系统临时目录下专用子目录，Windows 可用）；
 * 参考图白名单用 `isInsidePath()`（Windows 反斜杠/大小写正确）；发送媒体用 `cqImage()`。
 *
 * 四条实测纪律（都对应踩过的坑，改代码前先读）：
 *   ① **冷却被挡 = 不生成、不排队**：冷却内再调直接返回 `{blocked:true,retryAfterMs,suggestedText}`，
 *      本插件**不代答**，由模型自己回一句后结束本轮。
 *   ② **失败 = 到此为止**：工具侧**不重试、不改写提示词再调一次**；失败时本插件自己发一句
 *      `imageFail` 句池话术（零 token），并在抛回模型的错误里写明"已代答、别补话、别重试"
 *      —— 一次失败只对应一条消息（旧实现里模型自发改写重试导致用户先看到"画不过来"）。
 *   ③ **冷却计的是触发次数（含失败）**：从触发那一刻起算，防上游抖动时反复打、反复花钱。
 *   ④ **「在画了」只在真调工具时发（execute 里）**：绝不按用户文本关键词提前应声。
 */

import fs from 'node:fs'
import path from 'node:path'
import { detectImageMediaType, imagePixelSize, pickImageSizeByRatio } from '../../kernel/format.js'
import { isInsidePath, resolveTmpDir } from '../../platform/paths.js'
import { cqImage } from '../../platform/cq-file.js'
import { atomicWriteFileSync } from '../../platform/atomic.js'
import { DEFAULT_OPTIMIZE_PROMPT, refinePrompt } from './prompt-refine.js'

// 句池取不到时的兜底话（不带角色口吻，换人设也不会穿帮）
const FALLBACK_ACK = '在画了，稍等'
const FALLBACK_BUSY = '画不过来，等会儿再叫'
const FALLBACK_FAIL = '画失败了…等会儿再试'

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** 支持的生图协议（与 kernel/config-store.js 的校验口径一致） */
const PROTOCOLS = ['openai-images', 'openai-chat']

/** 生图错误统一带「当前协议」前缀：控制台/模型都能看出挂在哪条线上 */
function protocolError(protocol, message) {
  return new Error(`生图(${protocol}协议)失败：${message}`)
}

/**
 * 控制台的「额外请求字段」→ 对象。
 * 空/未填 = {}（完全不加字段，行为与旧版一致）；非法 JSON 直接报错（宁可不发，也不静默失效）。
 */
function parseExtraBody(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text || text === '{}') return {}
  let parsed
  try { parsed = JSON.parse(text) } catch (e) {
    throw new Error(`「额外请求字段」不是合法 JSON（${e.message}）：${text.slice(0, 120)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('「额外请求字段」必须是 JSON 对象，例如 {"watermark": false}')
  }
  const out = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

/** multipart 追加：对象/数组按 JSON 串，布尔用 'true'/'false'（与 OpenAI 兼容接口的习惯一致）。 */
function appendFormFields(form, extras) {
  for (const [k, v] of Object.entries(extras || {})) {
    if (v === undefined || v === null) continue
    const vals = Array.isArray(v) ? v : [v]
    for (const one of vals) {
      if (one === undefined || one === null) continue
      form.append(k, typeof one === 'object' ? JSON.stringify(one) : String(one))
    }
  }
}

let tmpSeq = 0

/** 生成快照存平台临时目录（用完由内核 best-effort 清理）；按真实文件头定扩展名 */
function saveBuf(buf, tmp) {
  const ext = IMG_EXT[detectImageMediaType(buf)] || 'png'
  const file = tmp?.file
    ? tmp.file('imagegen', `.${ext}`)
    : path.join(resolveTmpDir('imagegen'), `qq_imagegen_${Date.now()}_${++tmpSeq}.${ext}`)
  fs.writeFileSync(file, buf)
  return file
}

/** 带超时 fetch：生图/下载都是几十秒级，不限时会把整轮挂死 */
async function fetchWithTimeout(url, opts, timeoutMs, label) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 240000)) })
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`${label}超时 (${Math.round((Number(timeoutMs) || 240000) / 1000)}s)`)
    }
    throw e
  }
}

/** 上游失败时把可读原因挖出来（别把整页 HTML 甩给模型） */
async function throwImagegenError(res) {
  const raw = await res.text().catch(() => '')
  let emsg = ''
  try { emsg = JSON.parse(raw).error?.message || raw } catch { emsg = `HTTP ${res.status}` }
  throw new Error(String(emsg || `HTTP ${res.status}`).slice(0, 200))
}

/** 统一解析响应：`data[0].{url|b64_json}` → 本地图片路径（两条线共用） */
async function imagegenResult(res, what, timeoutMs, tmp) {
  if (!res.ok) await throwImagegenError(res)
  const data = await res.json()
  const item = (data.data || [])[0]
  if (!item) throw new Error(`${what}响应无 data`)
  if (item.url) {
    const rf = await fetchWithTimeout(item.url, { method: 'GET' }, timeoutMs, '图片下载')
    if (!rf.ok) throw new Error(`图片下载 HTTP ${rf.status}`)
    return saveBuf(Buffer.from(await rf.arrayBuffer()), tmp)
  }
  if (item.b64_json) return saveBuf(Buffer.from(item.b64_json, 'base64'), tmp)
  throw new Error('无法取得图片内容')
}

/**
 * 从一个值里尽量宽容地挖出图片引用：data URI / markdown 图 / 裸 URL / 纯 base64。
 * 返回 `{kind:'b64', mediaType?, data}` 或 `{kind:'url', url}`；挖不到返回 null。
 */
function extractImageRef(value) {
  if (value == null) return null
  if (typeof value === 'object') {
    // 常见形态：{ url } / { image_url: { url } } / { b64_json } / { data } / { image } / { text }
    for (const key of ['url', 'b64_json', 'data', 'image', 'image_url', 'content', 'text']) {
      if (!(key in value)) continue
      const found = extractImageRef(value[key])
      if (found) return found
    }
    return null
  }
  const text = String(value || '').trim()
  if (!text) return null
  // ① data URI（有些网关直接把图 base64 嵌进 content，甚至整条消息就是 data URI）
  const dataUri = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/i.exec(text)
  if (dataUri) return { kind: 'b64', mediaType: dataUri[1].toLowerCase(), data: dataUri[2].replace(/\s+/g, '') }
  // ② markdown 图 `![alt](url)`
  const md = /!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/i.exec(text)
  if (md) return extractImageRef(md[1])
  // ③ 裸 http(s) URL（chat 出图最常见的返回形态）
  const url = /https?:\/\/[^\s"'<>()]+/i.exec(text)
  if (url) return { kind: 'url', url: url[0] }
  // ④ 纯 base64 大块（没有 data URI 前缀的网关）
  if (/^[A-Za-z0-9+/=\r\n]{256,}$/.test(text)) return { kind: 'b64', data: text.replace(/\s+/g, '') }
  return null
}

/** 解析 chat/completions 响应里的图片：按宽容优先级逐个字段试 */
function extractChatImage(data) {
  if (!data || typeof data !== 'object') return null
  const choice = (Array.isArray(data.choices) ? data.choices[0] : null) || {}
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {}
  // ① message.images[]（部分兼容层这么返回）
  for (const item of Array.isArray(message.images) ? message.images : []) {
    const found = extractImageRef(item)
    if (found) return found
  }
  // ② message.content：字符串（含 markdown/URL/data URI）或数组（image_url / image 项与文本片段）
  const content = message.content
  if (Array.isArray(content)) {
    for (const part of content) {
      const found = extractImageRef(part)
      if (found) return found
    }
  } else if (content != null) {
    const found = extractImageRef(content)
    if (found) return found
  }
  // ③ 有些网关直接回 data[0].{url,b64_json}（与 /images 同形）
  const fromData = extractImageRef(Array.isArray(data.data) ? data.data[0] : null)
  if (fromData) return fromData
  // ④ 兜底扫整个响应（极少见；已按上面优先级排除常见形态）
  return extractImageRef(data)
}

/** 把解析出来的图片引用落成本地快照（下载 URL / 解码 base64） */
async function materializeChatImage(found, timeoutMs, tmp, protocol) {
  if (found?.kind === 'b64') {
    const buf = Buffer.from(found.data, 'base64')
    if (!buf.length) throw protocolError(protocol, '响应里的 base64 图片为空')
    return saveBuf(buf, tmp)
  }
  if (!found?.url) throw protocolError(protocol, '响应里没有可下载的图片地址')
  const res = await fetchWithTimeout(found.url, { method: 'GET' }, timeoutMs, '生图(chat协议)图片下载')
  if (!res.ok) throw protocolError(protocol, `图片下载 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const head = buf.subarray(0, 64).toString('utf8').trimStart().toLowerCase()
  if (!buf.length || head.startsWith('<')) throw protocolError(protocol, '下载到的内容不是图片（可能是 HTML/错误页）')
  return saveBuf(buf, tmp)
}

/**
 * openai-chat 协议：`POST {base}/chat/completions`，参考图以 data URL 放进 user 消息。
 * 为什么需要：部分中转站只暴露 chat/completions 出图（models 里给的是 image 模型但走 chat 接口）。
 * 失败一律抛 `生图(openai-chat协议)失败：…`（调用方统一代答 + 禁止重试）。
 */
async function chatGenerate({ prompt, refs, extras = {}, timeoutMs, creds, tmp }) {
  const protocol = 'openai-chat'
  const base = String(creds.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('未配置生图凭据：请设置环境变量 QQ_IMAGEGEN_BASE_URL / QQ_IMAGEGEN_API_KEY，或在实例配置 credentials.gptImage 里填')
  const content = [{ type: 'text', text: prompt }]
  for (const real of refs) {
    const buf = fs.readFileSync(real)
    const mediaType = detectImageMediaType(buf)
    content.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${buf.toString('base64')}` } })
  }
  const body = { model: creds.model, stream: false, messages: [{ role: 'user', content }], ...extras }
  const what = refs.length ? `图生图(${refs.length}张参考)` : '生图'
  let res
  try {
    res = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs, `${what}(chat协议)`)
  } catch (e) {
    throw protocolError(protocol, e.message)
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const raw = await res.text()
      try { detail = JSON.parse(raw).error?.message || raw || detail } catch { detail = raw || detail }
    } catch { /* 读不到 body 就用状态码 */ }
    throw protocolError(protocol, `${what}请求失败：${String(detail).slice(0, 200)}`)
  }
  let data
  try { data = await res.json() } catch { throw protocolError(protocol, `${what}响应不是 JSON（该中转站可能不支持 chat 出图）`) }
  const found = extractChatImage(data)
  if (!found) {
    throw protocolError(protocol, `${what}响应里没找到图片（支持 content 里的 URL/markdown/data URI、message.images[]、data[0].{url,b64_json}）`)
  }
  return materializeChatImage(found, timeoutMs, tmp, protocol)
}

/**
 * 参考图 / 头像白名单：只允许真实文件，且落在这些根目录下（realpath 解析，软链穿不出去）。
 * 为什么必须有：图生图会把文件内容发给第三方中转，不能让人拿任意本地文件（配置/凭据）外流。
 * 根目录 = 配置的参考图/头像目录 + 数据目录 + 平台临时根（内核注入），不写死任何机器路径。
 */
function resolveAllowedImage(file, cfg, bot) {
  const raw = String(file ?? '').trim()
  const dataDir = bot?.core?.dataDir ? String(bot.core.dataDir) : ''
  // 相对路径依次试：参考图目录（最常用）→ 数据目录（list_images 给的相对路径/工作区/上传目录）→ 头像目录
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
      path.join(cfg.refDir, raw),
      ...(dataDir ? [path.join(dataDir, raw)] : []),
      ...(cfg.avatarDir ? [path.join(cfg.avatarDir, raw)] : []),
    ]
  const p = candidates.find((c) => { try { return fs.existsSync(c) } catch { return false } })
  if (!p) throw new Error(`图片文件不存在: ${raw}`)
  const real = fs.realpathSync(p)
  const roots = [...new Set([
    cfg.refDir,
    cfg.avatarDir,
    bot?.core?.dataDir,
    bot?.core?.tmp?.root,
  ].filter(Boolean).map((r) => path.resolve(String(r))))]
  if (!roots.some((root) => isInsidePath(root, real))) {
    throw new Error(`图片路径必须在白名单目录下（当前白名单：${roots.join(' / ')}）: ${file}`)
  }
  if (!fs.statSync(real).isFile()) throw new Error(`不是文件: ${file}`)
  return real
}

/** 按协议分派；未知协议给可读错误（带上当前值，便于控制台自检） */
async function gptGenerate(opts) {
  const protocol = String(opts?.creds?.protocol || 'openai-images')
  if (!PROTOCOLS.includes(protocol)) {
    throw new Error(`未知生图协议：${protocol}（可用 ${PROTOCOLS.join(' / ')}；改 credentials.gptImage.protocol 或环境变量 QQ_IMAGEGEN_PROTOCOL）`)
  }
  if (protocol === 'openai-chat') return chatGenerate(opts)
  return imagesGenerate(opts)
}

/** openai-images 协议：文生图 JSON，图生图 multipart（重复 `image` 字段 = 多张参考，顺序即传入顺序） */
async function imagesGenerate({ prompt, refs, size, extras = {}, timeoutMs, creds, tmp }) {
  const base = String(creds.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('未配置生图凭据：请设置环境变量 QQ_IMAGEGEN_BASE_URL / QQ_IMAGEGEN_API_KEY，或在实例配置 credentials.gptImage 里填')
  const headers = { authorization: `Bearer ${creds.apiKey}` }
  if (!refs.length) {
    // 额外字段最后并进去：用户显式写的优先（比如关水印 {"watermark": false}）
    const body = { model: creds.model, prompt, n: 1, ...(size ? { size } : {}), ...extras }
    const res = await fetchWithTimeout(`${base}/images/generations`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, timeoutMs, '生图')
    return imagegenResult(res, '生图', timeoutMs, tmp)
  }
  const form = new FormData()
  form.append('model', creds.model)
  form.append('prompt', prompt)
  form.append('n', '1')
  if (size) form.append('size', size)
  appendFormFields(form, extras)
  refs.forEach((real, i) => {
    const buf = fs.readFileSync(real)
    const mediaType = detectImageMediaType(buf)
    form.append('image', new Blob([buf], { type: mediaType }), `ref${i + 1}.${IMG_EXT[mediaType] || 'png'}`)
  })
  const what = refs.length > 1 ? `图生图(${refs.length}张参考)` : '图生图'
  // ⚠️ edits 只吃 multipart，不要给它加 content-type（浏览器/Node 会自己带 boundary）
  const res = await fetchWithTimeout(`${base}/images/edits`, { method: 'POST', headers, body: form }, timeoutMs, what)
  return imagegenResult(res, what, timeoutMs, tmp)
}

/** 控制台「提示词优化提示词」框没填时的默认提示词（同时用于生成时兜底）。 */
function defaultOptimizePromptText() {
  return DEFAULT_OPTIMIZE_PROMPT
}

/**
 * 控制台「试优化一条提示词」：用**当前（或面板上正在编辑的）**提示词跑一次优化，只返回结果、不画图。
 * payload: { text: 需求原话, system?: 面板上正在编辑的优化提示词 }
 */
async function previewOptimizeText({ bot, cfg, log, payload }) {
  const demand = String(payload?.text ?? '').trim()
  if (!demand) return { ok: false, error: '先写一条需求（比如「画只胖鱼在吃拉面」）再试' }
  if (!bot.llm || (typeof bot.llm.available === 'function' && !bot.llm.available())) {
    return {
      ok: false,
      error: '宿主没有可用的模型服务（llm）—— 该 DSH 版本或 profile 未加载 dsh-llm，这条功能只在机器人自己身上可用',
    }
  }
  const system = String(payload?.system ?? '').trim() || String(cfg.promptOptimizeText || '').trim() || DEFAULT_OPTIMIZE_PROMPT
  const t0 = Date.now()
  const r = await refinePrompt({
    llm: bot.llm,
    prompt: demand,
    system,
    timeoutMs: Math.max(5000, Number(cfg.promptOptimizeTimeoutMs) || 30000),
    maxTokens: 400,
    log,
  })
  const route = r.route || ''
  if (!r.used) {
    return {
      ok: false,
      error: `优化没成功：${r.reason || '未知原因'}（聊天里生图会按原文照画，不会失败）`,
      original: demand,
      prompt: r.prompt || demand,
      route,
      ms: Date.now() - t0,
    }
  }
  return {
    ok: true,
    original: demand,
    prompt: r.prompt,
    route,
    ms: Date.now() - t0,
    message: `✅ 优化完成（${route ? `${route}，` : ''}${r.prompt.length} 字）`,
  }
}

/**
 * 提示词优化器：一次生图**最多**调一次（不重试、不二次改写），失败退回原文。
 * 返回 { prompt, used, reason, route, ms }；used=false 时 prompt === 原文。
 */
async function optimizePromptMaybe({ bot, cfg, log, prompt, genTarget }) {
  if (!cfg.optimizePrompt) return { prompt, used: false, reason: '未开启优化' }
  const system = String(cfg.promptOptimizeText || '').trim() || DEFAULT_OPTIMIZE_PROMPT
  const r = await refinePrompt({
    llm: bot.llm,
    prompt,
    system,
    context: promptContextOf(bot, genTarget),
    timeoutMs: Math.max(5000, Number(cfg.promptOptimizeTimeoutMs) || 30000),
    maxTokens: 400,
    log,
  })
  if (!r.used) {
    log.info(`[生图] 提示词优化跳过（${r.reason}）：按原文生图`)
  }
  return { prompt: r.prompt, used: r.used, reason: r.reason, route: r.route || '', ms: r.ms || 0 }
}

/**
 * 给优化器看的会话语境（最近两句，纯文本、截断）。
 * 为什么给：用户说"画成他那样""再来一张刚才那个"时必须知道"他/刚才"指谁；
 * 但语气/玩笑不能原样进生图提示词，所以只在优化提示词里当**参考**，抄不抄由模型判断。
 */
function promptContextOf(bot, target) {
  try {
    const st = bot?.state?.get?.(target)
    const turns = Array.isArray(st?.turns) ? st.turns : []
    const last = turns.slice(-2).map((t) => String(t?.text || '').trim()).filter(Boolean)
    return last.join(' / ').slice(0, 240)
  } catch {
    return ''
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 本机 ComfyUI（PC 独有）
//
// 为什么单开一层而不是加第三种"协议"：本地和远端是**两条并存的线**，
// 不是二选一 —— 本地活就用本地（免费、约 11 秒），本地没起来就回落中转站。
// 所以它挂在"来源"上，不改 `credentials.gptImage.protocol`（那个仍然描述中转站怎么说话）。
//
// 对接的是 ComfyUI 外面那层 server.py（默认 127.0.0.1:8899），不是 8188 原生 API：
// 原生 API 要自己拼工作流 JSON，换模型就得改代码；server.py 已经把这些封好了。
// ─────────────────────────────────────────────────────────────────────────────

/** 本地尺寸映射：插件按比例给的是 1536 档，8GB 显存上比 1280² 还险，降一档。 */
const LOCAL_SIZE_MAP = {
  '1536x1024': { w: 1216, h: 832 },
  '1024x1536': { w: 832, h: 1216 },
  '512x512': { w: 768, h: 768 },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)))

/**
 * 本地 ComfyUI 是否**真的能出图**。
 * 判据是 `/api/status` 里的 `comfy.alive`：8899 活着但 8188 没起来时它是 false，
 * 那种情况提交任务会 500，不如现在就判掉、直接回落。
 * **不抛错**：探不通只是"没有本地"，由调用方决定回落还是报错。
 * @returns {Promise<{ok:boolean, reason:string, gpu?:string, vramFreeMB?:number}>}
 */
async function probeLocalComfy(baseUrl, timeoutMs = 2000) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return { ok: false, reason: '没配本地地址' }
  try {
    const res = await fetchWithTimeout(base + '/api/status', { method: 'GET' }, timeoutMs, '本地生图探测')
    if (!res.ok) return { ok: false, reason: '本地服务返回 HTTP ' + res.status }
    const j = await res.json()
    const comfy = j && j.comfy ? j.comfy : {}
    if (!comfy.alive) return { ok: false, reason: 'ComfyUI 主程序没起来（' + (comfy.error || '8188 不通') + '）' }
    const vramFreeMB = Number(comfy.vram_free) > 0 ? Math.round(Number(comfy.vram_free) / 1048576) : 0
    return { ok: true, reason: '', gpu: String(comfy.gpu || ''), vramFreeMB }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e).slice(0, 120) }
  }
}

/** POST/GET JSON：非 2xx 直接抛（带上是哪一步），别把错误页当 JSON 解析。 */
async function fetchJsonOrThrow(url, opts, timeoutMs, label) {
  const res = await fetchWithTimeout(url, opts, timeoutMs, label)
  if (!res.ok) throw new Error(label + ' HTTP ' + res.status)
  try {
    return await res.json()
  } catch {
    throw new Error(label + ' 响应不是 JSON（服务没起或地址填错？）')
  }
}

/**
 * 本地 ComfyUI 出图：提交 → 轮询 → 取图。
 *
 * 状态机（server.py 的 /api/progress 只有这几种）：
 *   running / pending / waiting → 继续等（waiting 是"还不在队列里"的瞬时态，**不是失败**）
 *   done + images[]             → 成功，取第一张
 *   done + 空 images            → ComfyUI 执行出错（它把错误吞在 status 里）
 *   unknown                     → 8188 主程序挂了
 * 超时用调用方给的总预算，不无限等。
 */
async function comfyGenerate({ prompt, refs, size, timeoutMs, local, tmp, log }) {
  const base = String(local.baseUrl || '').replace(/\/+$/, '')
  const model = String(local.model || 'zimage')
  const sizeStr = String(size || '1024x1024')
  const mapped = LOCAL_SIZE_MAP[sizeStr]
  const [wRaw, hRaw] = sizeStr.split('x')
  const dim = mapped || { w: Number(wRaw) || 1024, h: Number(hRaw) || 1024 }
  const totalMs = Math.max(10000, Number(timeoutMs) || 240000)

  // 图生图：底图必须先传到 ComfyUI 的 input 目录（它自己的 LoadImage 只认那里）
  let initImage = ''
  if (refs && refs.length) {
    const buf = fs.readFileSync(refs[0])
    const mediaType = detectImageMediaType(buf)
    const ext = IMG_EXT[mediaType] || 'png'
    const name = 'qqbot_' + Date.now() + '.' + ext
    const up = await fetchJsonOrThrow(base + '/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, data: 'data:' + mediaType + ';base64,' + buf.toString('base64') }),
    }, Math.min(totalMs, 60000), '本地生图(上传底图)')
    if (!up.ok) throw new Error('上传底图失败：' + (up.error || '未知原因'))
    initImage = String(up.name || name)
  }

  const body = { model, prompt, width: dim.w, height: dim.h, seed: 0, batch: 1 }
  if (initImage) {
    body.init_image = initImage
    body.denoise = Number(local.denoise) > 0 ? Number(local.denoise) : 0.65
  }
  const sub = await fetchJsonOrThrow(base + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, Math.min(totalMs, 60000), '本地生图(提交)')
  if (!sub.ok) {
    const detail = sub.error || JSON.stringify(sub.node_errors || '').slice(0, 160) || '未知原因'
    throw new Error('提交失败：' + detail)
  }
  const pid = String(sub.prompt_id || '')
  if (!pid) throw new Error('提交成功但没拿到 prompt_id')

  const deadline = Date.now() + totalMs
  let lastState = ''
  while (Date.now() < deadline) {
    await sleep(1500)
    let st = null
    try {
      st = await fetchJsonOrThrow(base + '/api/progress/' + encodeURIComponent(pid), { method: 'GET' }, 15000, '本地生图(进度)')
    } catch (e) {
      lastState = String(e && e.message ? e.message : e)
      continue
    }
    const state = String((st && st.state) || '')
    if (state === 'done') {
      const name = (st.images || [])[0]
      if (!name) throw new Error('任务结束但没出图（ComfyUI 执行出错，去看它自己的窗口）')
      const img = await fetchWithTimeout(base + '/image/' + encodeURIComponent(name), { method: 'GET' }, totalMs, '本地生图(取图)')
      if (!img.ok) throw new Error('取图 HTTP ' + img.status)
      const buf = Buffer.from(await img.arrayBuffer())
      if (!buf.length) throw new Error('取到的图是空的')
      if (log) log.info('[生图] 本地出图完成（' + model + ' ' + dim.w + 'x' + dim.h + '，' + Math.round((totalMs - (deadline - Date.now())) / 1000) + 's 内）')
      return saveBuf(buf, tmp)
    }
    if (state === 'unknown') {
      throw new Error('ComfyUI 主程序没响应了（' + ((st && st.error) || '8188 不通') + '）')
    }
    lastState = state || lastState
  }
  throw new Error('本地生图超时（' + Math.round(totalMs / 1000) + 's，最后状态 ' + (lastState || '?') + '）')
}

/** 凭据解析：实例配置注入优先，其次环境变量；代码里永远没有明文 key / 默认 baseUrl */
function resolveCreds(injected) {
  const env = process.env
  const pick = (...names) => names.map((n) => env[n]).find((v) => v && String(v).trim())
  const gpt = injected?.gptImage || injected?.['gpt-image'] || injected?.gpt || {}
  return {
    // 协议：实例配置 > 环境变量 > 默认 openai-images（config-store 已做配置校验/环境变量覆盖，这里兜底）
    protocol: String(gpt.protocol || pick('QQ_IMAGEGEN_PROTOCOL') || 'openai-images').trim(),
    baseUrl: String(gpt.baseUrl || pick('QQ_IMAGEGEN_BASE_URL', 'OPENAI_BASE_URL') || ''),
    apiKey: String(gpt.apiKey || pick('QQ_IMAGEGEN_API_KEY', 'OPENAI_API_KEY') || ''),
    model: gpt.model || pick('QQ_IMAGEGEN_MODEL') || 'gpt-image-2',
  }
}

export default {
  id: 'imagegen',
  title: '生图 / 头像',
  order: 60,

  configSchema: {
    info: {
      type: 'info', group: '生图',
      text: '生图是可选能力：填好地址 / 模型 / API Key 后，模型就能在聊天里生成或修改图片。\n'
        + '· 协议怎么选：中转站兼容 /images/generations 与 /images/edits → 选「OpenAI 兼容 /images/*」（默认）；\n'
        + '  只提供 chat/completions 出图的（部分中转站）→ 选「OpenAI 兼容 chat/completions」。\n'
        + '· 地址填到 /v1 为止（例：https://relay.example/v1）；模型名以你的中转站为准。\n'
        + '· API Key 的优先级：环境变量 QQ_IMAGEGEN_API_KEY > 下面这个输入框。\n'
        + '· 没配置时生图工具会明确提示"未配置生图凭据"，不影响聊天；填完（离开输入框即保存）点「运维」页的「🖼 检查生图配置」验证。',
    },
    // 凭据归属「生图」页（属于 imagegen 插件）；存储路径仍是 credentials.gptImage.* → 旧配置 / 环境变量零迁移。
    protocol: {
      type: 'enum', group: '生图', label: '生图协议', default: 'openai-images',
      key: 'credentials.gptImage.protocol', configPath: ['credentials', 'gptImage', 'protocol'],
      options: [
        { value: 'openai-images', label: 'OpenAI 兼容 /images/*' },
        { value: 'openai-chat', label: 'OpenAI 兼容 chat/completions' },
      ],
      hint: '默认 openai-images；中转站只支持 chat 出图时选 openai-chat。环境变量 QQ_IMAGEGEN_PROTOCOL 优先于这里。',
    },
    baseUrl: {
      type: 'str', group: '生图', label: 'API 地址（填到 /v1）', default: '',
      key: 'credentials.gptImage.baseUrl', configPath: ['credentials', 'gptImage', 'baseUrl'],
      hint: '例：https://relay.example/v1 。环境变量 QQ_IMAGEGEN_BASE_URL 优先于这里。',
    },
    model: {
      type: 'str', group: '生图', label: '模型', default: 'gpt-image-2',
      key: 'credentials.gptImage.model', configPath: ['credentials', 'gptImage', 'model'],
      suggestions: ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'flux-1.1-pro', 'gemini-2.5-flash-image-preview'],
      hint: '模型名以你的中转站为准；环境变量 QQ_IMAGEGEN_MODEL 优先于这里。',
    },
    apiKey: {
      type: 'str', group: '生图', label: 'API Key', default: '', secret: true,
      key: 'credentials.gptImage.apiKey', configPath: ['credentials', 'gptImage', 'apiKey'],
      hint: '保存后只回显占位符；环境变量 QQ_IMAGEGEN_API_KEY 优先于这个输入框。',
    },
    enabled: { type: 'bool', default: true, group: '生图', label: '生图', hint: '开：群里叫它画图时调用生图模型出图并发出来；关：完全不出图。' },
    localFirst: {
      type: 'bool', default: false, group: '生图', label: '优先用本机 ComfyUI',
      hint: '开：每次生图先探一下本机画图服务（默认 http://127.0.0.1:8899），**活着就用它出图**（免费、约 11 秒）；'
        + '没起来就**自动回落**到下面的中转站，行为与关掉时一致。\n'
        + '关（默认）：完全按中转站走，跟以前一样。\n'
        + '· 只探一次、最多等 2.5 秒；探不通只记一行日志，不打扰用户、不占冷却。\n'
        + '· 本机服务不会自动拉起，需要你自己双击启动脚本（这是故意的：静默加载 6GB 权重太粗暴）。\n'
        + '· 中转站也没配时，报错与以前一致（提示去填地址/Key）。',
    },
    localUrl: {
      type: 'str', default: 'http://127.0.0.1:8899', group: '生图', label: '本机画图服务地址',
      hint: 'ComfyUI 外面那层 server.py 的地址（默认 http://127.0.0.1:8899）。留空按默认。\n'
        + '不要填 8188（那是 ComfyUI 原生 API，要自己拼工作流）。',
    },
    localModel: {
      type: 'str', default: 'zimage', group: '生图', label: '本机模型',
      suggestions: ['zimage', 'sdxl'],
      hint: 'zimage = Z-Image Turbo（默认）：支持中文提示词、约 11 秒、反向提示词无效。\n'
        + 'sdxl = SDXL Base：只认英文、约 22 秒、反向提示词有效。',
    },
    localDenoise: {
      type: 'float', default: 0.65, group: '生图', label: '本机图生图降噪', min: 0.2, max: 1, step: 0.05,
      hint: '只有图生图（带参考图）时才用：0.2~0.3 轻微改、0.4~0.6 中等改、0.7~0.8 大幅改、0.9+ 几乎重画。\n'
        + 'Z-Image 建议 0.5~0.65。填 1.0 会被服务端强制压到 0.65。',
    },
    cooldownMs: { type: 'int', unit: '秒', scale: 1000, default: 60, group: '生图', label: '全局冷却', hint: '两次生图之间至少隔多久（所有群共用），防止连刷烧额度。' },
    ackCooldownMs: { type: 'int', unit: '秒', scale: 1000, default: 30, group: '生图', label: '「在画了」冷却', hint: '同一会话几秒内只说一次「在画了」，避免每张图都刷这句。' },
    timeoutMs: { type: 'int', unit: '秒', scale: 1000, default: 240, group: '生图', label: '生图超时', hint: '单次生图最多等多久；超时就放弃并回一句失败说明。' },
    optimizePrompt: {
      type: 'bool', default: true, group: '生图', label: '先让大模型优化提示词',
      hint: '开：每次生成/改图前，先让**你的聊天模型**把需求改写成"画面要素齐全"的生图提示词（主体/外观/动作/场景/光线/构图/画风），再交给生图模型 —— '
        + '这是画质差别最大的一步（直接把用户原话丢给生图模型，出来的东西往往又糊又没重点）。\n'
        + '关：原文直出（旧行为）。\n'
        + '优化单独占一次很短的模型调用（超时/失败都**自动退回原文**，不会让这次生图失败、也不会多花钱重试）。',
    },
    promptOptimizeText: {
      // default 故意留空：让控制台第一次就显示**完整可编辑的默认提示词**（helper 函数形态），
      // 而配置里不落一份千年不变的副本 —— 代码改了默认值，没改过的人自动跟上。
      type: 'text', group: '生图', label: '提示词优化提示词（给大模型）', default: '',
      helper: defaultOptimizePromptText,
      // hint 写成函数：提示词规则要跟着"现在在用哪份"走，用户改过就说一声，别让他以为默认还生效
      hint: (kernel) => {
        // "有没有改过"以**已加载插件的生效 cfg** 为准（配置层可能又落了默认文案，raw 里不一定能看出差别）
        const loaded = (Array.isArray(kernel?.plugins) ? kernel.plugins : []).find((p) => String(p?.id) === 'imagegen')
        const cur = String(loaded?.cfg?.promptOptimizeText || '').trim()
        return '上面那步"优化"用的提示词，**可以随便改**——它决定大模型把你的需求翻译成什么样。\n'
          + '末尾保留了「用户需求：」这一行：你的原话会接在它后面；想加约束（画风偏好、比例习惯、写实 or 二次元）就写在这里。\n'
          + `当前状态：${cur ? '用你改过的版本（清空并保存 = 回到内置默认）' : '内置默认（没改过，默认提示词升级会自动跟上）'}。改完下一张图就生效。\n`
          + '想先看效果再去聊天里试：点本页底部「🧪 试优化一条提示词」。'
      },
    },
    promptOptimizeTimeoutMs: {
      type: 'int', unit: '秒', scale: 1000, default: 30, group: '生图', label: '优化超时',
      hint: '优化最多等多久；超时就按原文生图（不会因此让整次生图失败）。',
    },
    extraBody: {
      type: 'text', group: '生图', label: '额外请求字段（JSON）', default: '',
      hint: '不同平台/中转站的请求字段不一样，这里可以自己补。写一个 JSON 对象，留空 = 不加任何额外字段。\n'
        + '· 文生图：并进 JSON 请求体（可覆盖 model/prompt/size/n 等）；\n'
        + '· 图生图：逐项追加为 multipart 字段（布尔/数字会转成字符串，数组 = 重复同名字段）；\n'
        + '· openai-chat 协议：并进 /chat/completions 的 JSON 顶层。\n'
        + '示例：关掉服务端水印（sensenova／商汤默认开）→ {"watermark": false}；\n'
        + '　　　别的平台要画质/风格 → {"quality": "hd", "style": "vivid"}。\n'
        + '注释这种写法不支持（不是合法 JSON 会直接报错、不发请求）。',
    },
    refDir: { type: 'str', default: 'qq-refs', group: '生图', label: '角色参考图目录', hint: '角色参考图放这个目录（图生图用）；留空 = <数据目录>/qq-refs。' },
    avatarDir: {
      type: 'str', default: 'qq_avatars', group: '头像', label: '头像缓存目录',
      hint: '取群成员头像后的本地缓存目录（相对路径按数据目录解析；留空 = <数据目录>/qq_avatars）。缓存文件按 QQ 号命名，可随时手动删；磁盘紧张就换目录。',
    },
    avatarCacheHours: {
      type: 'int', unit: '小时', default: 24, group: '头像', label: '头像缓存时长',
      hint: '同一 QQ 的头像缓存多少小时后重新下载：调大 = 更省请求但头像更新慢；调小 = 更勤快但请求多。0 或负数按 24 处理。',
    },
  },

  setup(bot, opts = {}) {
    const cfg = bot.cfg
    const log = bot.log
    // 凭据每次调用现取：控制台「生图」页改完协议/地址/Key 后热生效，不用重启。
    // 优先级：bot.credentials（实例配置 live getter，热重载后指向新值）→ setup 第二参注入（兼容旧装配）→ 环境变量。
    const credsNow = () => resolveCreds(bot.credentials || opts.credentials || null)
    /** 本机 ComfyUI 配置（每次现取，控制台改完下一张就生效） */
    const localNow = () => ({
      enabled: cfg.localFirst === true,
      baseUrl: String(cfg.localUrl || '').trim() || 'http://127.0.0.1:8899',
      model: String(cfg.localModel || '').trim() || 'zimage',
      denoise: Number(cfg.localDenoise) > 0 ? Number(cfg.localDenoise) : 0.65,
    })
    const refDirNow = () => String(cfg.refDir || '').trim() || path.join(String(bot.core?.dataDir || '.'), 'qq-refs')
    const avatarDirNow = () => String(cfg.avatarDir || '').trim() || path.join(String(bot.core?.dataDir || '.'), 'qq_avatars')

    // 全局冷却：跨群 / 跨私聊 / 网页本地共用一个池子（旧 imageGenAt 的 'global' 键）
    let lastGenAt = 0
    // 「在画了」按 target 冷却：同一会话 ackCooldownMs 内只应一声（旧 imageAckAt）
    const ackAt = new Map()

    // 面板单位是「秒」（如 60 / 120 / 240），若传入 <1000 则 ×1000 转为 ms；若已是 ms（≥1000）则原样用
    const toMs = (v, defMs) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return defMs
      return n >= 1000 ? Math.round(n) : Math.round(n * 1000)
    }
    const cdMs = () => toMs(cfg.cooldownMs, 60000)
    const ackCdMs = () => toMs(cfg.ackCooldownMs, 30000)
    const timeoutMs = () => toMs(cfg.timeoutMs, 240000)
    // 额外请求字段：每次现读（控制台改完下一张就生效）；非法 JSON 由 parseExtraBody 抛清晰错误
    const extrasNow = () => parseExtraBody(cfg.extraBody)
    const inCooldown = () => lastGenAt > 0 && Date.now() - lastGenAt < cdMs()

    // 句池取不到时按兜底句发 —— 不能因为句池文件坏了就沉默
    const pick = (...sections) => {
      for (const s of sections) {
        try {
          const v = bot.linesPool?.pick?.(s)
          if (v) return String(v)
        } catch { /* 句池异常不影响生图 */ }
      }
      return ''
    }

    /**
     * 发一句「在画了」（零 token、零步，免得模型为了说一声多占一步上下文）。
     * ⚠️ 只在 execute() 真调生图时调用：**不看用户文本** ——
     *    否则群里聊到「改图/生图」就被误应一声（线上事故，见文件头④）。
     */
    async function maybeAck(target) {
      if (!/^(group|private):\d{1,12}$/.test(String(target || ''))) return
      const last = ackAt.get(target) || 0
      if (Date.now() - last < ackCdMs()) return
      ackAt.set(target, Date.now())
      const line = pick('imagegenAck', 'imageAck') || FALLBACK_ACK
      try {
        await bot.deliver(target, line)
      } catch (e) {
        log.warn(`生图应答发送失败 (${target}): ${e.message}`)
      }
    }

    /**
     * 尺寸：显式 size > 按**第一张参考图**比例自动选 1K 档 > 方图 1024x1024。
     * 为什么不交给上游 auto：实测不传 size / 传 auto 会给 2048 级（超出"一般不大于 1K"的约定）。
     */
    function chooseSize(explicit, refs) {
      const s = String(explicit || '').trim()
      if (s) {
        if (!/^\d{2,4}x\d{2,4}$/.test(s)) throw new Error(`size 需形如 1024x1024，收到: "${s}"`)
        return s
      }
      if (refs.length) {
        try { return pickImageSizeByRatio(fs.readFileSync(refs[0])) } catch (e) {
          log.warn(`按参考图选尺寸失败(退回 1024x1024): ${e.message}`)
        }
      }
      return '1024x1024'
    }

    // ── 入口 ⓪：图片清单工具 list_images ────────────────────────────────────
    // 为什么不再每轮往 prompt 里塞图库清单（2026-10-26 主人要求）：
    //   `ev.hint` 会拼进**用户消息正文**，每轮都出现（库大时 300+ token），看着烦也白烧。
    //   改成按需查询：模型要画图/找图时自己调一次，平时 0 成本、0 噪音。
    const REF_EXT_RE = /\.(png|jpe?g|webp|gif)$/i
    const dataDirNow = () => String(bot.core?.dataDir || '.')
    const IMG_SCOPES = {
      refs: { label: '角色参考图', dir: () => refDirNow() },
      avatars: { label: '头像缓存', dir: () => avatarDirNow() },
      uploads: { label: 'QQ 发来的文件', dir: () => path.join(dataDirNow(), 'qq_uploads') },
      workspace: { label: 'QQ 工作区', dir: () => path.join(dataDirNow(), 'workspace') },
    }
    const DEFAULT_SCOPES = ['refs', 'workspace', 'uploads', 'avatars']

    /** 递归列某个根下的图片（深度 ≤3，跳过隐藏目录/node_modules；最多扫 800 个文件）。 */
    const scanImages = (root, { limit, scanned = { n: 0 } }) => {
      const out = []
      const walk = (dir, depth) => {
        if (out.length >= limit || scanned.n >= 800) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const ent of entries) {
          if (out.length >= limit || scanned.n >= 800) return
          const name = ent.name
          if (name.startsWith('.') || name === 'node_modules') continue
          const full = path.join(dir, name)
          let st
          try { st = fs.lstatSync(full) } catch { continue }
          if (st.isSymbolicLink()) continue
          if (st.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue }
          if (!st.isFile() || !REF_EXT_RE.test(name)) continue
          scanned.n += 1
          out.push({ path: full, name, bytes: st.size })
        }
      }
      walk(root, 1)
      return out
    }

    /** 参考图目录里的图片名（给 generate_image 的报错文案用；只列文件名，不递归）。 */
    const refNamesNow = () => {
      try {
        return fs.readdirSync(refDirNow())
          .filter((n) => REF_EXT_RE.test(n))
          .filter((n) => { try { return fs.statSync(path.join(refDirNow(), n)).isFile() } catch { return false } })
          .sort((a, b) => a.localeCompare(b, 'zh'))
          .slice(0, 20)
      } catch { return [] }
    }

    bot.registerTool('list_images', {
      description:
        '列出本机白名单目录里的图片文件（角色参考图、QQ 工作区、QQ 发来的文件、头像缓存）。'
        + 'QQ 线**没有文件工具**，看不到本机目录 —— 想知道有哪些图可用、或用户提到某张图但你不知道文件名时，先调这个工具查。'
        + '返回的 `path` 可以直接当 generate_image 的 image 参数（也支持只传文件名）。',
      parameters: {
        where: {
          type: 'string',
          description: '在哪个范围找：refs(角色参考图) / workspace(QQ 工作区) / uploads(QQ 发来的文件) / avatars(头像缓存) / all(全部，默认)',
        },
        dir: { type: 'string', description: '可选：子目录（相对所选范围，如 `stroke_anim`），留空 = 该范围根目录' },
        limit: { type: 'number', description: '最多返回几张（默认 30，最多 100）' },
      },
      execute: async (args = {}) => {
        const where = String(args.where || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 30)))
        const scopes = where && where !== 'all'
          ? (IMG_SCOPES[where] ? [where] : null)
          : DEFAULT_SCOPES
        if (!scopes) throw new Error(`where 只能是 ${['all', ...Object.keys(IMG_SCOPES)].join(' / ')}`)
        const roots = scopes.map((k) => {
          const base = IMG_SCOPES[k].dir()
          const sub = String(args.dir || '').trim()
          const target = sub ? path.resolve(base, sub) : path.resolve(base)
          if (!isInsidePath(path.resolve(base), fs.existsSync(target) ? (() => { try { return fs.realpathSync(target) } catch { return target } })() : target)) {
            throw new Error(`dir 不能跳出「${IMG_SCOPES[k].label}」目录: ${sub}`)
          }
          return { key: k, label: IMG_SCOPES[k].label, dir: target }
        })
        const scanned = { n: 0 }
        const items = []
        for (const r of roots) {
          if (items.length >= limit) break
          for (const it of scanImages(r.dir, { limit: limit - items.length, scanned })) {
            let px = null
            try {
              if (it.bytes <= 8 * 1024 * 1024) {
                const buf = fs.readFileSync(it.path)
                const p = imagePixelSize(buf)
                if (p) px = `${p.w}x${p.h}`
              }
            } catch { /* 读不到就不给尺寸，不影响列清单 */ }
            items.push({ ...it, where: r.key, label: r.label, size: px })
          }
        }
        const truncated = items.length >= limit
        log.info(`[图片] list_images ${where || 'all'}${args.dir ? `/${args.dir}` : ''} → ${items.length} 张${truncated ? '（已截断）' : ''}`)
        return {
          ok: true,
          count: items.length,
          truncated,
          items,
          note: truncated ? `只列了前 ${limit} 张，要更多就传更大的 limit 或指定 where/dir` : undefined,
        }
      },
    })

    bot.registerTool('generate_image', {
      description:
        '按提示词生成或修改图片。不传 image = 文生图；传了 image = 图生图/改图，以那张图为参考，'
        + 'image 可给多张（数组，按顺序 = 图1、图2）。传了 target 就生成后直接发到该 QQ 会话。'
        + '⚠️ 画图有全局冷却：冷却中被挡会返回 {blocked:true,retryAfterMs,suggestedText} —— 此时**必须自己**用 '
        + 'mcp__qq__send_message 回一句（口吻照 suggestedText），然后结束本轮，**不要再调、不要重试**。'
        + '生成失败时本插件已代答，**不要重试、不要改写提示词再调一次**。',
      parameters: {
        prompt: {
          type: 'string', required: true,
          description: '画面描述（提示词），越具体越好。'
            + '**原样写用户想要什么就行**：开了「先让大模型优化提示词」时插件会先把它改写成规范的生图提示词再画'
            + '（自动补主体外观/动作/场景/光线/构图/画风），不需要你自己堆砌画质词，也**别**把语气、梗、聊天背景写进去。'
            + '想先看看会变成什么，可以调 refine_image_prompt。',
        },
        image: {
          description: '图生图的参考图：本地图片绝对路径，或**文件名**（如 `大肥鱼_三视图.jpg`；插件会到参考图目录/数据目录里找）。'
            + '不知道有哪些图可用时**先调 `list_images`** 查（QQ 线没有文件工具，看不到目录）。'
            + '多张传字符串数组（按顺序 = 图1、图2）；不传就是文生图',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        target: { type: 'string', description: '会话目标 group:123456 或 private:123456；传了就生成后直接发过去，不传只返回本地文件路径' },
        text: { type: 'string', description: '随图发送的一句说明文字，可选' },
        size: { type: 'string', description: '一般不用传：不传时按图1比例自动选 1K 档（竖 1024x1536 / 横 1536x1024 / 方 1024x1024）；只有要特定比例才传' },
      },

      async execute(args = {}) {
        if (!cfg.enabled) throw new Error('生图功能未启用 (imagegen.enabled=false)')
        const prompt = String(args.prompt ?? '').trim()
        if (!prompt) throw new Error('prompt 不能为空')
        const genTarget = String(args.target || '')
        const canReply = /^(group|private):\d{1,12}$/.test(genTarget)

        // image 可字符串（含逗号分隔多张）或数组；逐个过白名单（发往第三方中转，不能任意本地文件外流）
        const asRefList = (v) => {
          if (Array.isArray(v)) return v
          const raw = String(v ?? '').trim()
          if (!raw) return []
          // Windows 路径本身可能含逗号：整串能落到真实文件时按单张处理，别拆坏
          try { if (fs.existsSync(raw)) return [raw] } catch { /* ignore */ }
          return raw.split(/[\r\n,]+/)
        }
        const rawImgs = asRefList(args.image)
        const refRoots = { ...cfg, refDir: refDirNow(), avatarDir: avatarDirNow() }
        const refLib = refNamesNow()
        const refs = []
        for (const item of rawImgs.map((x) => String(x || '').trim()).filter(Boolean)) {
          try {
            refs.push(resolveAllowedImage(item, refRoots, bot))
          } catch (e) {
            // 不做代码侧匹配：把清单交回模型，让它自己挑（选错不占冷却：这一步在冷却之前）
            if (path.isAbsolute(item)) throw e
            const known = refLib.length ? `参考图目录里有：${refLib.join('、')}` : '参考图目录是空的'
            throw new Error(`找不到图片「${item}」（${known}）`
              + '；先调 list_images 看有哪些图，再挑文件名传给 image')
          }
        }
        // 同一张被重复列到时只上一次
        refs.splice(0, refs.length, ...new Set(refs))

        const creds = credsNow()
        const local = localNow()
        // 本机优先：只在开了开关时才探（探一次最多 2.5 秒，探不通静默回落，不打扰用户）
        let localReady = false
        let localWhy = ''
        if (local.enabled) {
          const probe = await probeLocalComfy(local.baseUrl, 2500)
          localReady = probe.ok
          localWhy = probe.reason
          if (probe.ok) {
            log.info(`[生图] 本机 ComfyUI 可用（${probe.gpu || '?'}，显存余 ${probe.vramFreeMB || '?'}MB），走本地出图`)
          } else {
            log.info(`[生图] 本机 ComfyUI 不可用（${probe.reason}），回落中转站`)
          }
        }
        // 中转站凭据：本地能出图时不需要；否则沿用旧口径（两样都得有）
        if (!localReady && (!creds.apiKey || !creds.baseUrl)) {
          throw new Error('未配置生图凭据：请设置环境变量 QQ_IMAGEGEN_BASE_URL / QQ_IMAGEGEN_API_KEY，或在实例配置 credentials.gptImage 里填'
            + (local.enabled ? `（本机 ComfyUI 也没起来：${localWhy}）` : ''))
        }
        const size = chooseSize(args.size, refs)
        // 额外请求字段先解析：JSON 写错要**立刻**报错（不占冷却、也不先说「在画了」）
        const extras = extrasNow()

        // ① 全局冷却：被挡的**不生成、不排队、不代答**，只把「被挡 + 还剩多久 + 一句参考话」交回模型
        if (inCooldown()) {
          const left = Math.max(0, cdMs() - (Date.now() - lastGenAt))
          log.info(`[生图] 冷却中(还剩 ${Math.ceil(left / 1000)}s): 本次不生成不入队, 交模型自己回 (${genTarget || '无 target'})`)
          return {
            ok: true,
            blocked: true,
            replied: false,
            cooldownMs: cdMs(),
            retryAfterMs: left,
            suggestedText: pick('imagegenBusy', 'imageBusy') || FALLBACK_BUSY,
            note: `画图冷却中（还剩约 ${Math.ceil(left / 1000)} 秒）：本次**没生成、没入队**，本插件**没有**替你回话。`
              + '请**自己**用 mcp__qq__send_message 回一句（口吻参考 suggestedText，一两句、别解释机制），然后结束本轮；'
              + '**不要**再调 generate_image，也不要重试。',
          }
        }
        // 先让大模型把需求改写成"能画出来的描述"（可关；失败/超时一律退回原文，绝不打断这次生图）。
        // 放在冷却计数**之前**：这一步失败不该吃掉一次配额 —— 它不花钱画图，只是没拿到更好的提示词。
        const opt = await optimizePromptMaybe({ bot, cfg, log, prompt, genTarget })
        const finalPrompt = opt.prompt

        // ② 冷却从**触发那一刻**起算、含失败 —— 防上游抖动时反复打、反复花钱
        lastGenAt = Date.now()
        const turn = bot.currentTurn?.()
        if (turn) turn.imagegenUsed += 1
        if (canReply) await maybeAck(genTarget)

        const t0 = Date.now()
        const source = localReady ? 'local' : 'remote'
        let file
        try {
          file = localReady
            ? await comfyGenerate({
              prompt: finalPrompt, refs, size, timeoutMs: timeoutMs(), local, tmp: bot.core?.tmp, log,
            })
            : await gptGenerate({
              prompt: finalPrompt, refs, size, extras, timeoutMs: timeoutMs(), creds, tmp: bot.core?.tmp,
            })
        } catch (e) {
          log.error(`[生图] ${refs.length ? '图生图' : '生图'}失败(${source === 'local' ? '本地' : creds.protocol}) (${Date.now() - t0}ms, prompt=${finalPrompt.slice(0, 60)}): ${e.message}`)
          // ③ **失败就到此为止**：本插件自己如实说一句（零 token），并在错误里写明"已代答、别补话、别重试"。
          //    ⚠️ 这里**没有、也不要加**任何重试逻辑 —— 重试是模型自发行为，靠错误文案三处一起掐。
          if (canReply) {
            const failLine = pick('imagegenFail', 'imageFail') || FALLBACK_FAIL
            bot.deliver(genTarget, failLine).catch((err) => log.warn(`生图失败应答发送失败 (${genTarget}): ${err.message}`))
          }
          const rawReason = String(e.message || '')
          // 错误信息里带上「走的是哪条线」（chat 协议自己已带前缀，别重复拼）
          const reason = /生图\([^)]*协议\)/.test(rawReason) || source === 'local'
            ? rawReason.slice(0, 140)
            : `生图(${creds.protocol}协议)失败：${rawReason.slice(0, 140)}`
          throw new Error(`${reason}${canReply
            ? '｜已把失败如实告诉用户，本轮不要再发任何消息，也不要重试、不要改提示词再调一次'
            : '｜不要重试'}`)
        }

        const buf = fs.readFileSync(file)
        const px = imagePixelSize(buf)
        const out = {
          ok: true,
          file,
          bytes: buf.length,
          ms: Date.now() - t0,
          mode: refs.length ? 'edit' : 'generate',
          // 走的哪条线：local = 本机 ComfyUI；remote = 中转站（protocol 仍描述中转站怎么说话）
          source,
          protocol: source === 'local' ? 'comfyui' : creds.protocol,
          size,
          refs: refs.length,
          actualSize: px ? `${px.w}x${px.h}` : null,
          // 提示词优化：原文 / 实际发给生图模型的提示词 / 有没有真优化成功
          prompt: finalPrompt,
          promptOptimized: opt.used,
          promptOriginal: prompt,
          ...(opt.used ? {} : { promptOptimizeNote: opt.reason }),
        }
        log.info(`[生图] (${out.protocol}${source === 'local' ? '/本地' : ''}) ${out.mode === 'edit' ? '图生图' : '生图'}完成 (${out.ms}ms, ${out.bytes}B, `
          + `请求尺寸=${size}, 实际=${out.actualSize || '?'}${refs.length ? `, ref=${refs.join(' + ')}` : ''}, `
          + `${Object.keys(extras).length ? `额外字段=${Object.keys(extras).join(',')}, ` : ''}prompt=${finalPrompt.slice(0, 60)}`
          + `${opt.used ? `, 优化=${opt.route || '?'}/${opt.ms}ms` : ''}) → ${file}`)
        if (!canReply) return out

        const r = await bot.sendMedia(genTarget, cqImage(file), args.text ? String(args.text) : '')
        log.info(`[生图] 已发送 ${genTarget}`)
        return { ...out, target: genTarget, message_id: r?.messageId ?? r?.id ?? null }
      },
    })

    // 控制台「🧪 试优化一条提示词」的后端（admin/endpoints 经 kernel.previewImagePrompt 调它）。
    // 注意 coreOf() **每次调用都新建对象** —— 往 bot.core 上挂东西等于扔掉，白写一场。
    // 所以内核启动时显式装配：kernel.shared.imagegen.previewOptimize。
    if (bot.shared && typeof bot.shared === 'object') {
      bot.shared.imagegen = {
        ...(bot.shared.imagegen && typeof bot.shared.imagegen === 'object' ? bot.shared.imagegen : {}),
        previewOptimize: (payload) => previewOptimizeText({ bot, cfg, log, payload }),
      }
    }

    bot.registerTool('refine_image_prompt', {
      description:
        '把一句需求（或用户原话）改写成可以直接交给生图模型的提示词，**只返回文字、不画图、不占冷却**。'
        + '用途：拿不准该怎么写提示词时先看一眼；或者想把结果给用户过目再决定画不画。'
        + '注意：generate_image 在「先让大模型优化提示词」开着时会**自动**做这一步，正常情况下不需要先调它。',
      parameters: {
        prompt: { type: 'string', required: true, description: '用户的需求原话（照抄即可，不用自己加工）' },
        template: { type: 'string', description: '可选：临时换一份优化提示词（不传就用控制台「生图」页里那份）' },
      },
      async execute(args = {}) {
        const demand = String(args.prompt ?? '').trim()
        if (!demand) throw new Error('prompt 不能为空')
        const llm = bot.llm
        if (!llm || (typeof llm.available === 'function' && !llm.available())) {
          throw new Error('没有可用的模型服务（llm），只能自己写提示词再用 generate_image')
        }
        const r = await refinePrompt({
          llm,
          prompt: demand,
          system: String(args.template ?? '').trim() || String(cfg.promptOptimizeText || '').trim() || DEFAULT_OPTIMIZE_PROMPT,
          timeoutMs: Math.max(5000, Number(cfg.promptOptimizeTimeoutMs) || 30000),
          maxTokens: 400,
          log,
        })
        if (!r.used) return { ok: false, reason: r.reason, original: demand, prompt: demand }
        log.info(`[生图] refine_image_prompt ${demand.slice(0, 40)} → ${r.prompt.slice(0, 60)}`)
        return { ok: true, original: demand, prompt: r.prompt, route: r.route || '', ms: r.ms || 0 }
      },
    })

    bot.registerTool('avatar', {
      description:
        '取某个群成员（或自己）的 QQ 头像，存到工作区并返回本地路径。'
        + '拿到的 path 可以直接当 generate_image 的 image 参数做图生图。'
        + 'user **优先给 QQ 号**；群会话里也可给群名片/昵称（按当前群成员表反查，昵称会变，号码更稳）。',
      parameters: {
        target: { type: 'string', required: true, description: '哪个会话：group:<群号> 或 private:<QQ号>（通常填本轮会话，见开头 [QQ会话 …]）' },
        user: { type: 'string', required: true, description: '看谁：**优先 QQ 号**；群会话里也可给群名片/昵称' },
      },

      async execute(args = {}) {
        const target = String(args.target || '')
        const m = /^(group|private):(\d{1,12})$/.exec(target)
        if (!m) throw new Error(`target 格式错误: "${target}"，应为 group:<群号> 或 private:<QQ号>`)
        const kind = m[1]
        const gid = m[2]
        const raw = String(args.user || '').trim().replace(/^@/, '')
        if (!raw) throw new Error('user 不能为空（QQ 号，或群会话里的群名片/昵称）')

        if (!/^\d{5,12}$/.test(raw)) {
          // 昵称 → QQ 号要读群成员表；这个能力在适配器里（契约：bot.onebot.fetchAvatar），不在这重复实现
          if (kind !== 'group') throw new Error('私聊里只能按 QQ 号取头像')
          if (typeof bot.onebot?.fetchAvatar !== 'function') throw new Error(`群里没找到「${raw}」—— 换成 QQ 号再试`)
          return await bot.onebot.fetchAvatar(target, raw)
        }

        // QQ 头像是公开 CDN（协议端没有可用头像接口，实测 `get_qq_avatar` 回"不支持的Api"）
        const qq = raw
        const dir = avatarDirNow()
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${qq}.jpg`)
        const cacheMs = (Number(cfg.avatarCacheHours) > 0 ? Number(cfg.avatarCacheHours) : 24) * 3600 * 1000
        let cached = false
        try {
          const st = fs.statSync(file)
          if (st.isFile() && st.size > 100 && Date.now() - st.mtimeMs < cacheMs) cached = true
        } catch { /* 没有或过期 → 重新下载 */ }
        const url = `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`
        if (!cached) {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
          if (!res.ok) throw new Error(`头像下载失败: HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length < 100) throw new Error('头像下载失败: 内容过小（可能不是图片）')
          atomicWriteFileSync(file, buf) // 原子替换（Windows 上 rename 被占用会退避重试）
        }
        const real = fs.realpathSync(file)
        const bytes = fs.statSync(real).size
        log.info(`[头像] ${qq} → ${real}（${cached ? '用缓存' : '刚下载'} ${bytes} 字节）`)
        // path 在 workspace 下 → 天然过 generate_image 的参考图白名单，不需要加特例
        return { ok: true, user_id: qq, name: raw, path: real, url, cached, bytes }
      },
    })
  },
}
