/**
 * kernel/llm-text.js — **一次性文本补全**（内核能力，插件经 `bot.llm` 使用）。
 *
 * 为什么要单独一层：
 *   · 生图提示词优化这类辅助任务"要模型、但不要 QQ 线、不要工具、不要会话持久化"。
 *     用 runIsolatedTask 起独立会话太重（落一个会话、走 preset、每轮再归档），
 *     而且一旦模型在那里顺手调工具就是副作用。
 *   · 宿主本来就有 `ctx.llm` 服务（唯一受支持的模型调用路径），这里只做**薄封装**：
 *     路由解析 → 流式调用 → 拼接 text-delta → 超时/取消。不做任何重试（重试是调用方的事）。
 *
 * 路由解析（按优先级，每次**现取**，控制台换默认模型后下一句话就生效）：
 *   ① 显式传的 { provider, model }
 *   ② 宿主的 agentDefaultModel.currentSelection()（新 agent 的默认 provider/model）
 *   ③ 宿主默认模型配置 DSH_DEFAULT_MODEL / DSH_DEFAULT_PROVIDER 环境变量
 *   ④ 宿主只注册了一个 provider 时用它 + 该 provider 目录里的第一个模型
 *
 * 永不 throw 到底：拿不到路由/没服务/流里报错，统一返回 `{ ok:false, reason }`，由调用方决定降级。
 */

/** 读宿主服务：优先 ctx.get(name)（无需 inject），失败返回 null（Cordis Proxy 未 inject 读属性会抛）。 */
function serviceOf(ctx, name) {
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
    return svc || null
  } catch {
    return null
  }
}

/** 从 llm 流分片里取出文本增量（兼容 text-delta / delta / content 三种形状）。 */
function textOfChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text
  // 少数适配器把增量塞在 delta.content；这里宁可宽容，也不要让整段优化结果变空
  const c = chunk.delta?.content ?? chunk.content
  if (typeof c === 'string' && typeof chunk.text !== 'string') return chunk.type === 'block-start' ? '' : c
  return ''
}

/** 终止分片：{ type:'finish', reason:{ kind, failure? } } / { finishReason: ... } 两种写法都认。 */
function finishOfChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  if (chunk.type === 'finish') return chunk.reason || chunk.finish || { kind: 'stop' }
  if (chunk.type === 'finish-reason' || chunk.finishReason) return chunk.reason || chunk.finishReason
  return null
}

/**
 * 解析一次调用要用的路由。**拿不到就返回 null**（不抛）。
 * @returns {{provider:string, model:string, source:string}|null}
 */
async function resolveRoute(llm, preferred, env = process.env) {
  const p = String(preferred?.provider || '').trim()
  const m = String(preferred?.model || '').trim()
  if (p && m) return { provider: p, model: m, source: '显式指定' }

  const dm = serviceOf(llm?.ctx, 'agentDefaultModel')
  if (dm && typeof dm.currentSelection === 'function') {
    try {
      const sel = await dm.currentSelection()
      const sp = String(sel?.provider || '').trim()
      const sm = String(sel?.model || '').trim()
      if (sp && sm) return { provider: sp, model: sm, source: '宿主默认模型' }
    } catch { /* 服务在但当前不可用 → 继续兜底 */ }
  }

  const ep = String(env?.DSH_DEFAULT_PROVIDER || '').trim()
  const em = String(env?.DSH_DEFAULT_MODEL || '').trim()
  if (ep && em) return { provider: ep, model: em, source: 'DSH_DEFAULT_*' }

  // 最后兜底：宿主只挂了一个 provider → 用它目录里的第一个模型（仍然不猜跨 provider）
  try {
    const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
    if (Array.isArray(providers) && providers.length === 1) {
      const only = providers[0]
      const id = String(only?.provider ?? only?.id ?? only?.name ?? only ?? '').trim()
      const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
      const first = (Array.isArray(models) ? models : []).map((x) => String(x?.model ?? x?.id ?? x)).find(Boolean)
      if (id && first) return { provider: id, model: first, source: '唯一 provider' }
    }
  } catch { /* 目录读不到就算了 */ }

  return null
}

/**
 * 建一个"一次性文本补全"能力。
 * @param {{ctx:object, log?:object, env?:object}} opts
 * @returns {{
 *   available: () => boolean,
 *   route: (preferred?:{provider?:string,model?:string}) => Promise<{provider:string,model:string,source:string}|null>,
 *   complete: (opts:{system?:string, prompt:string, maxTokens?:number, timeoutMs?:number,
 *     purpose?:string, provider?:string, model?:string}) =>
 *     Promise<{ok:boolean, text:string, reason:string, provider?:string, model?:string, ms?:number}>
 * }}
 */
export function createTextCompletion({ ctx, log = console, env = process.env } = {}) {
  const llm = serviceOf(ctx, 'llm')
  const defaultTimeoutMs = 45000

  return {
    available: () => Boolean(llm && typeof llm.stream === 'function'),
    route: (preferred) => resolveRoute(llm, preferred, env),

    async complete(opts = {}) {
      const prompt = String(opts.prompt ?? '').trim()
      if (!prompt) return { ok: false, text: '', reason: '提示词为空' }
      if (!llm || typeof llm.stream !== 'function') {
        return { ok: false, text: '', reason: '宿主没有提供 llm 服务（DSH 版本过低或 profile 未加载 dsh-llm）' }
      }
      const route = await resolveRoute(llm, { provider: opts.provider, model: opts.model }, env)
      if (!route) {
        return { ok: false, text: '', reason: '找不到可用的模型路由（宿主未配置默认模型）' }
      }

      const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || defaultTimeoutMs)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      timer.unref?.()
      const t0 = Date.now()
      const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      let text = ''
      let failure = ''
      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          ...(String(opts.system || '').trim() ? { system: String(opts.system) } : {}),
          ...(Number(opts.maxTokens) > 0 ? { maxTokens: Math.round(Number(opts.maxTokens)) } : {}),
          messages,
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          const fin = finishOfChunk(chunk)
          if (fin) {
            const kind = String(fin.kind || fin.type || '')
            if (kind === 'error' || kind === 'aborted') {
              failure = String(fin.failure?.message || fin.message || kind)
            }
            continue
          }
          text += textOfChunk(chunk)
        }
      } catch (e) {
        failure = String(e?.message || e)
      } finally {
        clearTimeout(timer)
      }
      const out = text.trim()
      if (!out) {
        return { ok: false, text: '', reason: failure || '模型没有返回任何文字', provider: route.provider, model: route.model, ms: Date.now() - t0 }
      }
      try { log?.debug?.(`[llm-text] ${route.provider}/${route.model} ${Date.now() - t0}ms ${out.length}B`) } catch { /* ignore */ }
      return { ok: true, text: out, reason: '', provider: route.provider, model: route.model, ms: Date.now() - t0 }
    },
  }
}
