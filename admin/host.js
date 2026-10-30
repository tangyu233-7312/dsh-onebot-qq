/**
 * admin/host.js — 控制台 **host 半边**：把 8 端点挂到 DSH 原生 RPC 通道 `/qq-console`。
 *
 * 通道契约（2026-10-18 踩过的坑，照抄注释别删）：
 *   · 原生 RPC（`ctx.connection.rpc.handle`）与旧的直挂路由**返回形状不同**：
 *     `rpcFetchHandler` 直接把 handler 返回对象当 result 透传，所以 handler 必须自己返回
 *     `{ ok:true, value }` 信封 —— 漏了这层包装，前端 `ctx.connection.rpc.call(...)` 拿到的
 *     `r.value` 就是 undefined，控制台会渲染成空面板（HTTP 200 但所有 value 全空）。
 *   · 业务错误（配置校验/白名单/未知端点）放在 **value 里**传下去（`{ok:false,error}`），
 *     前端按业务错处理；RPC 信封的 `{ok:false,error:{code,message}}` 只留给通道级异常。
 *   · 绝不在这里直读 `ctx.qqBotKernel` —— 真 Cordis Proxy 会抛
 *     `cannot get property "..." without inject`；内核由 index.js 显式传进来。
 *
 * 另导出 `handleAdminRpc(endpoint,payload)` 供内核/compat-server 直调（无需浏览器）。
 */
import os from 'node:os'
import { createAdminEndpoints, ENDPOINTS } from './endpoints.js'
import { loadOpsProvider } from '../ops/provider.js'

/** 浏览器 → host 的 RPC 通道名（前端 client.js 的 CHANNEL 必须一致）。 */
export const CHANNEL = '/qq-console'

/** 最近一次创建的控制面（给 handleAdminRpc 直调用；多实例时以最后一个为准）。 */
let active = null

function warn(log, message) {
  try { log?.warn?.(`[qq-console] ${message}`) } catch { /* ignore */ }
}
function info(log, message) {
  try { log?.info?.(`[qq-console] ${message}`) } catch { /* ignore */ }
}

/** 读 ctx 上的服务：优先普通属性（需 index.js 声明 inject），失败退回 `ctx.get()`（无需 inject）。 */
function serviceOf(ctx, name) {
  try {
    const direct = ctx?.[name]
    if (direct) return direct
  } catch {
    /* Cordis Proxy：未 inject 的属性能读会抛，退回 get() */
  }
  try {
    return ctx?.get?.(name) ?? null
  } catch {
    return null
  }
}

/**
 * 把 RPC handler 的返回值包成 DSH 信封：`{ok:true, value}` / 通道级错误 `{ok:false,error}`。
 * 业务错误在 value 里（由 endpoints 返回 `{ok:false,...}`），不会走到这里。
 */
async function rpcEnvelope(api, endpoint, payload) {
  try {
    return { ok: true, value: await api.handle(endpoint, payload) }
  } catch (e) {
    return {
      ok: false,
      error: { code: 'qq-console/handler-error', message: String(e?.message || e), details: { issues: [] } },
    }
  }
}

/**
 * webServer 直挂兜底（原生 RPC 不可用时）：自己拼 `{type:'server-response', rpcId, result}`。
 * 只接受回环 Host（与现网 console host 一致；正常部署走原生 RPC，不会走到这里）。
 */
/**
 * 允许访问控制台的 Host 名单。
 *
 * 为什么不能只写回环（2026-10-30 线上踩了两次）：
 *   部署在 NAS 上时，浏览器是拿 `http://<NAS 的局域网 IP>:3080` 打开的，
 *   `Host` 头就是 `<NAS_IP>`，不在回环名单里 → 整个 QQ 控制台 403，
 *   表现是「设置里点 QQ 控制台，读取失败 transport failure / HTTP 403」。
 *   历史上有两次是在 NAS 上**手工把 IP 加进白名单**，一重装就被覆盖回去了。
 *
 * 现在的做法（不再靠手改）：
 *   ① 回环永远放行；
 *   ② **本机所有网卡地址自动放行**（`os.networkInterfaces()`）—— 换 IP / 换网络都不用改代码；
 *   ③ 额外允许 `QQ_CONSOLE_ALLOWED_HOSTS` 环境变量（逗号分隔，给反代 / 蒲公英跨网段留口子）。
 *
 * 注意这条只作用于 **webServer 直挂兜底**（原生 RPC 不可用时才会走到）。
 */
function allowedConsoleHosts() {
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])
  // ② 本机网卡地址：v4 + v6 都收
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (!it || !it.address) continue
        set.add(it.address)
        if (it.address.includes(':')) set.add('[' + it.address + ']')
      }
    }
  } catch { /* 拿不到网卡就用回环，不至于把控制台搞死 */ }
  // ③ 额外名单（可选）
  for (const h of String(process.env.QQ_CONSOLE_ALLOWED_HOSTS || '').split(',')) {
    const v = h.trim()
    if (v) set.add(v)
  }
  return set
}

function webServerHandler(api) {
  const prefix = `${CHANNEL}/`
  const allowed = allowedConsoleHosts()
  return async (req, res) => {
    const raw = String(req.headers?.host || '')
    const host = raw.split(':')[0]
    if (!allowed.has(host)) {
      // 打一行日志：不然"为什么 403"只能靠猜（这行以前没有，排错花了很久）
      info(api.log, `拒绝 Host=${raw}：不在允许名单（回环 / 本机网卡 / QQ_CONSOLE_ALLOWED_HOSTS）`)
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const endpoint = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let message = {}
      try { message = body ? JSON.parse(body) : {} } catch { message = {} }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const method = typeof message.method === 'string' ? message.method : endpoint
      const result = method !== endpoint
        ? {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(method)} 与端点 ${JSON.stringify(endpoint)} 不一致`,
            details: { issues: [] },
          },
        }
        : await rpcEnvelope(api, endpoint, message.payload)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
    })
  }
}

/**
 * 建控制台 host 并注册 RPC 通道。
 *
 * @param {object} opts
 * @param {object} opts.ctx     宿主 Cordis ctx（index.js apply 的 ctx）
 * @param {object} opts.kernel  内核对象（见 docs/architecture §七；mock 见 test/）
 * @param {string} [opts.configPath] 实例配置路径（缺省 kernel.configPath）
 * @param {string} [opts.dataDir]    数据目录（缺省 kernel.dataDir）
 * @param {object} [opts.log]        日志器（默认 console）
 * @param {object} [opts.ops]        显式注入 ops provider（默认按 DSH_QQ_OPS / ~/.dsh 加载）
 * @returns {Promise<{handle:Function, handleRpc:Function, dispose:Function, ops:object, api:object, channel:string}>}
 */
export async function createAdminHost({ ctx, kernel, configPath = '', dataDir = '', log = console, ops } = {}) {
  if (!kernel || typeof kernel !== 'object') throw new Error('createAdminHost 需要 kernel（index.js 装配后传入）')
  const opsProvider = ops || await loadOpsProvider({ log, dataDir: dataDir || kernel.dataDir || '' })
  const api = createAdminEndpoints({
    kernel,
    configPath: configPath || kernel.configPath || '',
    dataDir: dataDir || kernel.dataDir || '',
    log,
    ops: opsProvider,
  })
  const handleRpc = (endpoint, payload = {}) => rpcEnvelope(api, endpoint, payload)

  const disposers = []
  let mode = ''
  let childFiber = null

  /**
   * 在**已 inject 好服务**的 ctx 上注册通道（关键：`connection.rpc.handle` 内部会访问
   * `owner.webServer`，所以 owner ctx 必须同时 inject webServer/Vary；
   * 直接用 `ctx.get('connection')` 拿到的 traceable 代理会把 owner 认成当前插件 ctx，
   * 而本插件按设计不声明 connection/webServer —— 那样注册会报 `cannot get property "webServer" without inject`）。
   * ① 原生 RPC 优先；② 失败/不可用 → webServer 直挂兜底。
   */
  function registerOn(child) {
    if (mode) return
    let rpcError = ''
    try {
      const rpc = child?.connection?.rpc
      if (rpc && typeof rpc.handle === 'function') {
        const dispose = rpc.handle(CHANNEL, handleRpc)
        if (typeof dispose === 'function') disposers.push(dispose)
        mode = 'rpc'
        info(log, `原生 RPC 通道已注册 ${CHANNEL}（端点：${ENDPOINTS.join(' / ')}）`)
        return
      }
      rpcError = 'connection.rpc.handle 不存在'
    } catch (e) {
      rpcError = e?.message || String(e)
    }
    // 兜底：webServer 直挂路由（信封形状见文件头注释）
    try {
      const webServer = child?.webServer
      if (webServer && typeof webServer.register === 'function') {
        const dispose = webServer.register({ kind: 'prefix', path: CHANNEL, handler: webServerHandler(api) })
        if (typeof dispose === 'function') disposers.push(dispose)
        mode = 'webServer'
        info(log, `webServer 直挂路由已注册 ${CHANNEL}/*（信封 {type:'server-response'}）`)
        return
      }
    } catch (e) {
      warn(log, `webServer 直挂路由注册失败：${e?.message || e}`)
      return
    }
    warn(log, `控制台接口不可用（原生 RPC：${rpcError || '未 inject connection/webServer'}；内核继续运行，控制台只是点不开）`)
  }

  // 首选：用 ctx.inject 建一个只负责"注册通道"的子 fiber —— 服务到齐才加载，卸载时随父 fiber 一起销毁。
  // （dsh-web 里 connection / webServer 都是 core 服务，会立刻到齐；非 Web 宿主则一直不加载，控制台自然不可用。）
  if (typeof ctx?.inject === 'function') {
    try {
      childFiber = ctx.inject(['connection', 'webServer'], (child) => {
        registerOn(child)
      })
    } catch (e) {
      warn(log, `ctx.inject(connection/webServer) 失败：${e?.message || e}，改直取服务兜底`)
    }
  }
  // 兜底（旧宿主/测试桩没有 ctx.inject 时）：直取服务注册。拿不到 webServer 时原生 RPC 也会失败，只记日志。
  if (!childFiber) {
    registerOn({ connection: serviceOf(ctx, 'connection'), webServer: serviceOf(ctx, 'webServer') })
  }

  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    for (const d of disposers.splice(0)) {
      try { d() } catch { /* 上下文可能已卸载 */ }
    }
    try { childFiber?.dispose?.() } catch { /* 父 fiber 先销毁时这里可能已失效 */ }
    childFiber = null
    if (active && active.api === api) active = null
  }

  // 清理挂到宿主 effect 上：插件卸载时自动 dispose（连接服务自己也有 effect，这里幂等兜底）
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'qq-console: admin host')
    } catch (e) {
      warn(log, `ctx.effect 注册失败（插件卸载时可能不会自动清理）：${e?.message || e}`)
    }
  }

  active = { api, ops: opsProvider }
  return {
    handle: api.handle,
    handleRpc,
    dispose,
    ops: opsProvider,
    api,
    channel: CHANNEL,
    /** 注册结果可能异步到齐（ctx.inject 子 fiber 等 connection/webServer），用 getter 读实时值。 */
    get mode() { return mode },
  }
}

/**
 * 内核/compat-server 直调入口（不经过浏览器 RPC）：返回端点 value（业务失败形如 `{ok:false,error}`）。
 * 需先调用过 `createAdminHost()`；未初始化时返回明确的错误对象，不抛。
 */
export async function handleAdminRpc(endpoint, payload = {}) {
  if (!active) return { ok: false, error: '控制台未初始化（createAdminHost 尚未调用）' }
  try {
    return await active.api.handle(endpoint, payload)
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 取当前控制面（调试/测试用；未初始化返回 null）。 */
export function getAdminHost() {
  return active ? active.api : null
}
