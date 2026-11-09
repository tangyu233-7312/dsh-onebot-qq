/**
 * plugins/long-memory/relay.js — 整理模型的**接口薄封装**（自有实现，不依赖 dcp / 宿主 llm）。
 *
 * 为什么直连而不是借宿主 `bot.llm`：
 *   · 记忆整理是后台高频小任务，用户要能**自己选便宜的模型和接口**（和生图一样的口径）；
 *   · 借宿主默认模型 = 和主对话抢限流，且别人装完不一定配了默认模型。
 * 但不填接口也不能整功能死掉 —— 调用方见到 `{ok:false, code:'not_configured'}` 就只降级（记忆照样能读能查）。
 *
 * 协议：OpenAI 兼容（`chat/completions`，也支持 Responses 风格的 `/responses` 时走 completions 兜底）。
 * 安全：baseUrl 只允许 http/https；Key 只在请求头里，日志永不打印。
 */

const DEFAULT_TIMEOUT_MS = 60000

/** 拼出最终的 completions 地址：用户填到 /v1 或填到 /chat/completions 都认。 */
export function completionsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

/** 归一化用户填的接口配置；缺什么返回 missing 列表（不 throw）。 */
export function normalizeLlmConfig(raw = {}) {
  const cfg = {
    protocol: String(raw.protocol || 'openai-chat'),
    baseUrl: String(raw.baseUrl || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    model: String(raw.model || '').trim(),
    reasoningEffort: String(raw.reasoningEffort || '').trim(),
    timeoutMs: Math.max(5000, Math.min(180000, Number(raw.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.2,
    maxTokens: Math.max(64, Math.min(16000, Number(raw.maxTokens) || 1200)),
  }
  const missing = []
  if (!cfg.baseUrl) missing.push('API 地址')
  else if (!/^https?:\/\//i.test(cfg.baseUrl)) missing.push('API 地址（要以 http:// 或 https:// 开头）')
  if (!cfg.model) missing.push('模型')
  if (!cfg.apiKey) missing.push('API Key')
  return { cfg, missing }
}

/** 从模型回复里抠出正文（兼容 chat.completions / responses / 个别中转站包一层）。 */
export function extractText(data) {
  if (!data || typeof data !== 'object') return ''
  const choice = Array.isArray(data.choices) ? data.choices[0] : null
  const msg = choice?.message || choice?.delta || null
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : String(c?.text || c?.content || ''))).join('')
  }
  if (typeof data.output_text === 'string') return data.output_text
  if (Array.isArray(data.output)) {
    const parts = []
    for (const item of data.output) {
      for (const c of item?.content || []) if (typeof c?.text === 'string') parts.push(c.text)
    }
    if (parts.length) return parts.join('')
  }
  const alt = data.data?.[0]?.content || data.result?.content || data.text
  return typeof alt === 'string' ? alt : ''
}

/**
 * 发一次对话补全。
 * @param {{baseUrl:string, apiKey:string, model:string, protocol?:string, reasoningEffort?:string,
 *   timeoutMs?:number, temperature?:number, maxTokens?:number, fetchImpl?:Function}} cfg
 * @param {{system?:string, prompt:string}} req
 * @returns {Promise<{ok:boolean, text:string, code:string, reason:string, ms:number, status?:number}>}
 */
export async function chatComplete(cfg, { system = '', prompt = '' } = {}) {
  const t0 = Date.now()
  const { cfg: c, missing } = normalizeLlmConfig(cfg)
  if (missing.length) {
    return { ok: false, text: '', code: 'not_configured', reason: `整理接口没填全：缺 ${missing.join(' / ')}`, ms: 0 }
  }
  const url = completionsUrl(c.baseUrl)
  const body = {
    model: c.model,
    temperature: c.temperature,
    max_tokens: c.maxTokens,
    messages: [
      ...(String(system).trim() ? [{ role: 'system', content: String(system) }] : []),
      { role: 'user', content: String(prompt || '') },
    ],
  }
  if (c.reasoningEffort) body.reasoning_effort = c.reasoningEffort
  const fetchImpl = cfg.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, text: '', code: 'no_fetch', reason: '当前运行时没有 fetch（Node 版本过低？需要 >=18）', ms: 0 }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), c.timeoutMs)
  timer.unref?.()
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = String(e?.name || '') === 'AbortError' || /abort|timeout/i.test(String(e?.message || ''))
    return {
      ok: false, text: '', code: aborted ? 'timeout' : 'network',
      reason: aborted ? `请求超时（${c.timeoutMs}ms）` : `连不上接口：${String(e?.message || e).slice(0, 160)}`,
      ms: Date.now() - t0,
    }
  }
  clearTimeout(timer)
  let raw = ''
  try { raw = await res.text() } catch { raw = '' }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { detail = JSON.parse(raw)?.error?.message || raw.slice(0, 200) || detail } catch { detail = raw.slice(0, 200) || detail }
    const auth = res.status === 401 || res.status === 403
    return {
      ok: false, text: '', code: auth ? 'auth' : (res.status >= 500 ? 'server' : 'http'),
      reason: `接口返回 ${detail}`, ms: Date.now() - t0, status: res.status,
    }
  }
  let data
  try { data = JSON.parse(raw) } catch {
    return { ok: false, text: '', code: 'bad_json', reason: `接口返回的不是 JSON：${raw.slice(0, 120)}`, ms: Date.now() - t0, status: res.status }
  }
  const text = extractText(data)
  if (!text.trim()) {
    return { ok: false, text: '', code: 'empty', reason: '接口返回里没有正文（模型名写错或被中转站改写？）', ms: Date.now() - t0, status: res.status }
  }
  return { ok: true, text, code: '', reason: '', ms: Date.now() - t0, status: res.status }
}

/**
 * 剥掉模型为了好看而加的外壳：```json 围栏、前后废话。只认数组。
 * @returns {{ok:boolean, list:any[], reason:string}}
 */
export function parseMemoryJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, list: [], reason: '模型返回空' }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  let body = fence ? fence[1] : raw
  // 从第一个 [ 到最后一个 ]（模型常在前面写“好的，如下：”）
  const lb = body.indexOf('[')
  const rb = body.lastIndexOf(']')
  if (lb >= 0 && rb > lb) body = body.slice(lb, rb + 1)
  body = body.trim()
  if (!body) return { ok: false, list: [], reason: '模型返回里没有 JSON 数组' }
  let parsed
  try { parsed = JSON.parse(body) } catch (e) {
    return { ok: false, list: [], reason: `JSON 解析失败：${String(e?.message || e).slice(0, 120)}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, list: [], reason: '模型返回的不是数组（可能写成了一篇文字）' }
  return { ok: true, list: parsed, reason: '' }
}
