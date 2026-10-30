/**
 * kernel/onebot-adapter.js — 唯一碰外部的地方（OneBot v11 正向 WS + HTTP API）。
 *
 * 纪律：
 *  · **不导出任何"裸 send"给插件**。聊天出站只能走 `bot.deliver()`（脱敏/长度/引用/留档的唯一实现）；
 *    这里只负责"把已经拼好的 CQ 串发出去"，不脱敏、不留档、不判断该不该发。
 *  · 例外（2026-10-30）：**QQ 空间说说**不经过 deliver，所以 `sendQzoneMsg` 自己过一遍六项脱敏 ——
 *    群里发错还能撤回，空间发出去是公开的、收不回来。以后再加"不经 deliver 的出站"，同样在这里脱敏。
 *  · 加一个新外部接口 = 在这个类里加一个方法；别让 fetch/WebSocket 散到别的文件去。
 *  · 所有平台差异（默认目录 / 本地文件引用格式）走 `platform/`，本文件不出现私有绝对路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDataDir } from '../platform/paths.js'
import { fromOneBotFileRef } from '../platform/cq-file.js'
import { atomicWriteFileSync } from '../platform/atomic.js'
import { sanitizeSensitive } from './format.js'

const SEND_TIMEOUT_MS = 12000   // 单条发送超时：协议端 HTTP 半死时不能让一条消息把整轮对话拖死
const SEND_MAX_RETRY = 2        // 超时/网络错误/5xx 才重试，4xx 直接放弃（请求本身有问题，重试无意义）
const MEDIA_TIMEOUT_MS = 180000 // 媒体要长超时：大文件/视频正常上传就要几十秒
const API_TIMEOUT_MS = 10000
const RECONNECT_MS = 3000
const MEMBER_CACHE_MS = 5 * 60 * 1000
/**
 * 假连接判定阈值：协议端每 30s 推一次心跳，超过这个时长一个帧都没有 = 连接已成僵尸
 * （TCP 还是 ESTAB、readyState 还是 OPEN，但协议端早不认了）。
 * 线上出现过掉线重登后静默数小时，就是缺这道看门狗。
 */
const STALE_MS = 100 * 1000

/** QQ 登录状态主动探测间隔（WS 连着不代表 QQ 在线：协议端可能仍保持心跳）。 */
const LOGIN_CHECK_MS = 30000
/** 同一检测结果的缓存时间，避免控制台 5s 轮询频繁打协议端。 */
const LOGIN_CHECK_TTL_MS = 10000

function chatTarget(chatKey) {
  const m = /^(group|private):(\d{1,12})$/.exec(String(chatKey ?? ''))
  if (!m) throw new Error(`chatKey 格式错误: "${chatKey}"，应为 group:<群号> 或 private:<QQ号>`)
  return { type: m[1], id: Number(m[2]) }
}

/**
 * 撤回失败的人话：协议端的原始报错（NTEvent / EventRet / decode failed…）**只进日志**，
 * 绝不回显到 QQ 出站或模型上下文——2026-10-23 线上出过整段报错被当回复发出的问题。
 */
function recallFailureText(raw, timedOut = false) {
  const s = String(raw || '')
  if (timedOut || /Timeout|NTEvent|EventRet|decode failed|recallMsg/i.test(s)) {
    return '撤回失败：撤回接口超时/返回异常（消息可能已过期、已删除，或协议端临时故障）'
  }
  if (/权限|permission|denied|no\s+privilege|not\s+(the\s+)?(admin|owner)/i.test(s)) {
    return '撤回失败：本机没有权限撤这条消息'
  }
  return '撤回失败：协议端拒绝了这次撤回（可能已过期或消息不存在）'
}

export class OneBotAdapter {
  /**
   * @param {{wsUrl?: string, wsToken?: string, httpUrl: string, httpToken?: string, selfId?: number|string|null, log?: object,
   *          avatarDir?: string, avatarCacheHours?: number}} cfg
   */
  constructor({ wsUrl = '', wsToken = '', httpUrl, httpToken = '', selfId = null, log = console, avatarDir = '', avatarCacheHours = 24 }) {
    this.wsUrl = wsUrl
    this.wsToken = wsToken || httpToken
    this.httpUrl = String(httpUrl || '').replace(/\/+$/, '')
    this.httpToken = httpToken
    this.selfId = selfId != null ? Number(selfId) : null
    this.selfNickname = null // get_login_info 拿到；留档与合并转发卡片的节点名要用
    this.log = log
    // 头像缓存目录由宿主注入（通常是 <dataDir>/avatars）；单独实例化时退回 dataDir 派生，不用系统临时目录。
    this.avatarDir = avatarDir || path.join(resolveDataDir(''), 'avatars')
    this.avatarCacheHours = avatarCacheHours
    this.ws = null
    this.closed = false
    this.handlers = new Set()
    this.lastFrameAt = 0      // 最近一次收到协议端任何帧（含心跳/API 响应）的时刻
    this._waiters = new Map() // echo → wsApi 等待者
    this._memberCache = new Map() // gid → { at, list:[{qq,names}] }（只服务 [AT:名字] → 号码）
    this._connecting = false
    this._wsGen = 0            // socket 代际：旧 socket 的迟到事件一律忽略（防重连叠出第二条 WS）
    this._reconnectTimer = null
    this._livenessTimer = null
    // QQ 登录状态（主动探测）：协议端 WS 连着但 QQ 掉线时，靠它发现并提醒
    this.loginOk = null
    this.loginCheckedAt = 0
    this.loginError = ''
    // 协议端自报的"接收链路健康"：SnowLuma 心跳/ get_status 里有 good（hook 卡住时会翻 false，
    // 发得出去、收不进来）；协议端不提供这个字段时保持 null（未知，不参与判定）。
    this.receiveGood = null
    this._loginTimer = null
    this._loginChecking = null
  }

  /**
   * 建立 WS 连接（并启动心跳看门狗）。外部只需在启动时调一次；断线由内部自己重连。
   * 返回 Promise 是给宿主 `onebot.connect().catch(...)` 用的 —— 连接失败由内部重连，不 throw。
   */
  async connect() {
    this.closed = false
    this._startLiveness()
    this._startLoginWatch()
    this._open()
  }

  close() {
    this.closed = true
    this._wsGen += 1          // 让旧 socket 的 onclose/onmessage 全部失效
    this._connecting = false
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    if (this._livenessTimer) clearInterval(this._livenessTimer)
    this._livenessTimer = null
    if (this._loginTimer) clearInterval(this._loginTimer)
    this._loginTimer = null
    this.loginOk = null
    this.loginError = ''
    this.receiveGood = null
    for (const w of this._waiters.values()) {
      clearTimeout(w.timer)
      w.reject(new Error('适配器已关闭'))
    }
    this._waiters.clear()
    const old = this.ws
    this.ws = null
    try { old?.close() } catch { /* 已断开 */ }
  }

  /** 订阅入站事件；返回取消函数。fn 收到的是 OneBot 原始事件（message / notice）。 */
  onEvent(fn) {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  /** 热更新连接参数（控制台改 wsUrl/token 后调用）：地址变了就重连。 */
  applyConfig({ wsUrl, wsToken, httpUrl, httpToken } = {}) {
    const next = {
      wsUrl: wsUrl ?? this.wsUrl,
      wsToken: wsToken ?? this.wsToken,
      httpUrl: httpUrl ?? this.httpUrl,
      httpToken: httpToken ?? this.httpToken,
    }
    const wsChanged = String(next.wsUrl) !== String(this.wsUrl) || String(next.wsToken) !== String(this.wsToken)
    // 只有"本来就在连/已连"时才需要重连；autoConnect:false 的实例改配置不该被顺手连上去
    const wasLive = Boolean(this.ws) || this._connecting
    this.wsUrl = next.wsUrl
    this.wsToken = next.wsToken
    this.httpUrl = String(next.httpUrl || '').replace(/\/+$/, '')
    this.httpToken = next.httpToken
    if (wsChanged && wasLive && !this.closed) {
      this._forceReconnect(4001, 'config changed')
    }
  }

  /** 链路健康快照（供 /status、自检用） */
  health() {
    const ago = this.lastFrameAt ? Date.now() - this.lastFrameAt : null
    return {
      linked: !!this.ws && this.ws.readyState === 1,
      selfId: this.selfId,
      selfNickname: this.selfNickname,
      lastFrameAgoMs: ago,
      stale: ago == null || ago > STALE_MS, // 与看门狗同阈值，别在两个地方各写一个数
      // QQ 登录状态：null=尚未探测/未知，false=WS 在但 QQ 不在线
      qqLoggedIn: this.loginOk,
      qqLoginCheckedAt: this.loginCheckedAt || null,
      qqLoginError: this.loginError || '',
      qqReceiveGood: this.receiveGood, // null=协议端没报/未知；false=接收链路异常
    }
  }

  // ── WS ────────────────────────────────────────────────────

  _open() {
    if (this.closed || this._connecting) return
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return // 已有连接/正在握手：绝不叠第二条
    if (!this.wsUrl) { this.log.warn('未配置 onebot.wsUrl，OneBot 入站不可用'); return }
    this._connecting = true
    const gen = ++this._wsGen
    // WS 鉴权兼容两种 OneBot 11 标准形态（纯客户端适配，**不动协议端任何配置**）：
    //   · wsUrl 里已带 `access_token=` → 用它（部分部署把 token 直接拼在连接串上）；
    //   · 否则 token 走 `Authorization: Bearer` 头（OneBot 11 标准，协议端认）。
    const headers = this.wsToken && !/access_token=/.test(this.wsUrl) ? { Authorization: `Bearer ${this.wsToken}` } : {}
    // 握手看门狗：10 秒不 open 视为失败。Node 的 WS 某些失败只触发 onerror 不触发 onclose，
    // 不补这道会永远卡在"正在连接"、日志里什么都不出现。
    const watchdog = setTimeout(() => {
      if (gen !== this._wsGen) return // 已被更新一代的连接/close() 取代
      this._connecting = false
      this.log.warn('OneBot WS 握手超时, 3 秒后重连')
      try { this.ws?.close() } catch { /* 已断开 */ }
      this._scheduleReconnect()
    }, 10000)
    try {
      this.ws = new WebSocket(this.wsUrl, { headers })
    } catch (e) {
      clearTimeout(watchdog)
      this._connecting = false
      this.log.warn(`WebSocket 创建失败: ${e.message}, 3 秒后重连`)
      this._scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      if (gen !== this._wsGen) return
      clearTimeout(watchdog)
      this._connecting = false
      this.lastFrameAt = Date.now()
      this.log.info('OneBot WS 已连接') // 运维验收就 grep 这一句，别改措辞
      this._fetchLoginInfo()
    }

    this.ws.onmessage = (ev) => {
      if (gen !== this._wsGen) return
      this.lastFrameAt = Date.now() // 任何帧（含心跳/API 响应）都算活着
      let data
      try { data = JSON.parse(ev.data) } catch { return }
      if (data.echo !== undefined) { this._resolveApi(data); return } // API 响应
      if (data.post_type === 'meta_event') {
        // 心跳顺便记协议端的接收链路自评（SnowLuma：status.good；其它实现没这个字段就忽略）
        const good = data?.status?.good
        if (typeof good === 'boolean') this.receiveGood = good
        return
      }
      if (data.post_type === 'lifecycle') { this.log.info(`OneBot lifecycle: ${data.sub_type || 'connect'}`); return }
      if (data.post_type !== 'message' && data.post_type !== 'notice') return
      for (const h of this.handlers) {
        try { h(data) } catch (e) { this.log.error(`事件处理异常: ${e.stack || e.message}`) }
      }
    }

    this.ws.onerror = () => { if (gen === this._wsGen) this.log.warn('OneBot WS 错误 (等待握手超时或断开)') }
    this.ws.onclose = () => {
      if (gen !== this._wsGen) return // 旧 socket 的迟到 close：忽略，不要触发重连
      clearTimeout(watchdog)
      this._connecting = false
      this.ws = null
      this.loginOk = null
      this.loginError = '协议端 WS 断开'
      this.receiveGood = null
      this.log.info('OneBot WS 已断开')
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    if (this.closed || this._reconnectTimer) return
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._open() }, RECONNECT_MS)
  }

  _startLiveness() {
    if (this._livenessTimer) return
    this._livenessTimer = setInterval(() => {
      if (this.closed) return
      if (!this.ws || this.ws.readyState !== 1) return // 没连上归握手看门狗管
      const idle = Date.now() - this.lastFrameAt
      if (this.lastFrameAt && idle > STALE_MS) {
        this.log.warn(`OneBot 已 ${Math.round(idle / 1000)}s 没有任何帧(含心跳), 判定假连接 → 强制重连`)
        this._forceReconnect()
      }
    }, 30000)
    this._livenessTimer.unref?.()
  }

  /** 丢弃当前 socket 并重连。僵尸连接的 close() 可能不触发 onclose，所以这里手动接管重连。 */
  _forceReconnect(code = 4000, reason = 'liveness timeout') {
    this._wsGen += 1           // 旧 socket 之后的事件全部失效
    const old = this.ws
    this.ws = null
    this._connecting = false
    this.lastFrameAt = 0
    this.loginOk = null
    this.loginError = '连接重建中'
    try { old?.close(code, reason) } catch { /* 已断开 */ }
    this._scheduleReconnect()
  }

  /** 通过 WS 发 OneBot API（需要它的回包时用；发消息走 HTTP，更可靠） */
  wsApi(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('WS 未连接'))
      const echo = randomUUID()
      const timer = setTimeout(() => {
        this._waiters.delete(echo)
        reject(new Error(`WS API 超时: ${action}`))
      }, API_TIMEOUT_MS)
      this._waiters.set(echo, { resolve, reject, timer, action })
      this.ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  _resolveApi(data) {
    const w = this._waiters.get(data.echo)
    if (!w) return
    this._waiters.delete(data.echo)
    clearTimeout(w.timer)
    if (data.status === 'ok' && data.retcode === 0) w.resolve(data)
    else w.reject(new Error(`OneBot API 失败: ${w.action} ${data?.wording || data?.retcode || ''}`))
  }

  // ── HTTP 发送 ─────────────────────────────────────────────

  /** POST 一个 OneBot HTTP API；网络/超时抛错，业务失败留给调用方按 status 判断 */
  async _post(action, params, timeoutMs = API_TIMEOUT_MS) {
    const headers = { 'content-type': 'application/json' }
    if (this.httpToken) headers.Authorization = `Bearer ${this.httpToken}`
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }

  /** 发一条普通文本/CQ 串。默认 12s 超时 + 重试 2 次（间隔 0.5s/1s）。返回 message_id。 */
  async sendMessage(chatKey, text, opts = {}) {
    const { type, id } = chatTarget(chatKey)
    const action = type === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = type === 'group' ? { group_id: id, message: text } : { user_id: id, message: text }
    const attempt = Number(opts.attempt) || 0
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : SEND_TIMEOUT_MS
    const maxRetry = opts.retries == null ? SEND_MAX_RETRY : Math.max(0, Number(opts.retries) || 0)
    let status
    let data = {}
    try {
      ({ status, data } = await this._post(action, params, timeoutMs))
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? `发送超时(${Math.round(timeoutMs / 1000)}s)` : `发送请求失败: ${e.message}`
      if (attempt < maxRetry) {
        this.log.warn(`发送失败将重试(${attempt + 1}/${maxRetry}) ${chatKey} — ${reason}`)
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        return this.sendMessage(chatKey, text, { ...opts, attempt: attempt + 1 })
      }
      throw new Error(reason)
    }
    if (data.status === 'ok') return data.data?.message_id ?? null
    const msg = `send ${action} 失败: ${data?.wording || status}`
    if (!(status >= 400 && status < 500) && attempt < maxRetry) {
      this.log.warn(`发送失败将重试(${attempt + 1}/${maxRetry}) ${chatKey} — ${msg}`)
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      return this.sendMessage(chatKey, text, { ...opts, attempt: attempt + 1 })
    }
    throw new Error(msg)
  }

  /** 发合并转发卡片（nodes = OneBot node 数组）。**非幂等**：长文场景调用方传 retries:0。 */
  async sendForward(chatKey, nodes, opts = {}) {
    const { type, id } = chatTarget(chatKey)
    const action = type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg'
    const params = type === 'group' ? { group_id: id, messages: nodes } : { user_id: id, messages: nodes }
    const attempt = Number(opts.attempt) || 0
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : SEND_TIMEOUT_MS
    const maxRetry = opts.retries == null ? SEND_MAX_RETRY : Math.max(0, Number(opts.retries) || 0)
    let status
    let data = {}
    try {
      ({ status, data } = await this._post(action, params, timeoutMs))
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? `转发卡片超时(${Math.round(timeoutMs / 1000)}s)` : `转发卡片请求失败: ${e.message}`
      if (attempt < maxRetry) {
        this.log.warn(`转发卡片失败将重试(${attempt + 1}/${maxRetry}) ${chatKey} — ${reason}`)
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        return this.sendForward(chatKey, nodes, { ...opts, attempt: attempt + 1 })
      }
      throw new Error(reason)
    }
    if (data.status === 'ok') return data.data?.message_id ?? null
    const msg = `转发卡片失败: ${data?.wording || status}`
    if (!(status >= 400 && status < 500) && attempt < maxRetry) {
      this.log.warn(`转发卡片失败将重试(${attempt + 1}/${maxRetry}) ${chatKey} — ${msg}`)
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      return this.sendForward(chatKey, nodes, { ...opts, attempt: attempt + 1 })
    }
    throw new Error(msg)
  }

  /**
   * 发一条**带媒体的 CQ 串**（图/视频/文件）。
   * ⚠️ **强制 retries:0**：发送非幂等 —— HTTP 超时只说明"我们不等了"，协议端收到请求后会继续上传并发出；
   * 此时重试 = 又发一遍（线上出现过同一个视频发好几遍）。长超时让大文件正常传完。
   */
  async sendMedia(chatKey, cqBody, opts = {}) {
    return this.sendMessage(chatKey, cqBody, { timeoutMs: MEDIA_TIMEOUT_MS, ...opts, retries: 0 })
  }

  // ── 其它 OneBot 接口 ──────────────────────────────────────

  /** 撤回一条消息（OneBot delete_msg）。加 15s 超时：协议端 recallMsg 会卡十几秒。 */
  async recall(messageId) {
    try {
      const { data } = await this._post('delete_msg', { message_id: Number(messageId) }, 15000)
      if (data.status === 'ok') return { ok: true }
      const raw = String(data?.wording || data?.message || '')
      this.log.warn(`[撤回] 失败 (message_id=${messageId}): ${raw.slice(0, 500) || '（无原文）'}`)
      return { ok: false, raw, msg: recallFailureText(raw) }
    } catch (e) {
      const raw = String(e?.message || e)
      this.log.warn(`[撤回] 请求异常 (message_id=${messageId}): ${raw.slice(0, 500)}`)
      return { ok: false, raw, msg: recallFailureText(raw, e?.name === 'TimeoutError') }
    }
  }

  /**
   * 发一条 QQ 空间说说（协议端扩展 API `send_qzone_msg`，非 OneBot v11 标准）。
   *
   * 返回 `{ ok: true }` / `{ ok: false, msg }`，不抛错 —— 说说失败不该拖垮聊天链路。
   * 协议端不支持该扩展时，返回 ok:false 并说明原因，调用方自行降级。
   *
   * @param {{ content: string, images?: string[] }} params
   *   content — 说说正文（必填）
   *   images  — 可选，本地图片绝对路径数组（最多 9 张，协议端限制）
   */
  async sendQzoneMsg({ content = '', images = [] } = {}) {
    // ⚠️ 说说也是**出站**，一样要过六项脱敏（2026-10-30 补）。
    // 这条路径原来声明"不脱敏"，而 qzone 直接调它 —— 于是「红线：文本只走 deliver()」被绕开：
    // 群里发错还能撤回，空间发出去是公开的、收不回来。这里和 deliver 用**同一份**实现，
    // 不另写第二套（改一处忘一处的老毛病）。
    const { text: safe, hits } = sanitizeSensitive(content || '')
    if (hits.length) this.log.warn(`[空间] 说说里有敏感内容，已隐去 ${hits.join('/')}`)
    const text = String(safe || '').trim()
    if (!text) return { ok: false, msg: '说说内容不能为空' }
    const params = { content: text }
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean).map(String)
    if (list.length) params.images = list.slice(0, 9)
    try {
      const { data } = await this._post('send_qzone_msg', params, 30000)
      if (data.status === 'ok') return { ok: true }
      const raw = String(data?.wording || data?.message || data?.retcode || '')
      this.log.warn(`[空间] 发说说失败: ${raw.slice(0, 300) || '（无原文）'}`)
      return { ok: false, raw, msg: raw || '协议端返回失败' }
    } catch (e) {
      const raw = String(e?.message || e)
      this.log.warn(`[空间] 发说说请求异常: ${raw.slice(0, 300)}`)
      return { ok: false, raw, msg: e?.name === 'TimeoutError' ? '发说说超时' : raw }
    }
  }

  /**
   * 群消息历史（升序；锚点 0 = 从最新开始）。失败返回 []，群上文/提取都只是锦上添花。
   * 锚点参数名各实现不同：多数实现认 `message_seq`，SnowLuma 认 `message_id`（0 = 最新，负值锚点也合法）。
   * 两边都会忽略自己不认识的键，所以两个都发（2026-10-27 SnowLuma 兼容）。
   */
  async groupHistory(groupId, count = 100) {
    try {
      const { data } = await this._post('get_group_msg_history', {
        group_id: Number(groupId), message_id: 0, message_seq: 0, count: Number(count) || 100,
      }, 8000)
      return Array.isArray(data?.data?.messages) ? data.data.messages : []
    } catch (e) {
      this.log.debug(`取群历史失败 (${groupId}): ${e.message}`)
      return []
    }
  }

  /** 群成员资料（名片/昵称/角色/等级/入群时间）。取不到返回 null。 */
  async memberInfo(groupId, qq) {
    try {
      const { data } = await this._post('get_group_member_info', { group_id: Number(groupId), user_id: Number(qq) })
      return data?.data && typeof data.data === 'object' ? data.data : null
    } catch (e) {
      this.log.debug(`取群成员资料失败 (${groupId}/${qq}): ${e.message}`)
      return null
    }
  }

  /**
   * 通用只读接口调用：给插件取协议端信息用（如 qzone 读自己说说要先 get_cookies）。
   * 只暴露 `_post` 这一层，不暴露裸发消息 —— 出站仍只能走 deliver / sendMedia / sendQzoneMsg。
   * 失败不抛：返回 `{ ok:false, msg }`，调用方自行降级。
   */
  async callApi(action, params = {}, timeoutMs = 8000) {
    const name = String(action || '').trim()
    if (!name) return { ok: false, msg: 'action 为空' }
    try {
      const { data } = await this._post(name, params || {}, timeoutMs)
      if (data?.status === 'ok') return { ok: true, data: data.data ?? null }
      const raw = String(data?.wording || data?.message || data?.retcode || '')
      return { ok: false, msg: raw || '协议端返回失败' }
    } catch (e) {
      return { ok: false, msg: String(e?.message || e) }
    }
  }

  /** 按消息 ID 反查单条消息（OneBot get_msg，用于引用唤醒判定与被引正文/图片提取）。 */
  async msgById(messageId) {
    try {
      const { data } = await this._post('get_msg', { message_id: Number(messageId) }, 6000)
      return data?.status === 'ok' && data?.data ? data.data : null
    } catch (e) {
      this.log.debug(`get_msg 失败 (${messageId}): ${e.message}`)
      return null
    }
  }

  /**
   * 取一条合并转发的内容（OneBot get_forward_msg）。
   * 返回的 `messages` 每项形如 `{ sender, time, message }`（`message` 是段数组）。
   * 拿不到返回 null —— 调用方据此降级成「(转发内容取不到)」，不阻塞这一轮。
   * @returns {Promise<{messages:Array}|null>}
   */
  async getForwardMsg(forwardId) {
    try {
      const { data } = await this._post('get_forward_msg', { id: String(forwardId) }, 15000)
      if (data?.status !== 'ok' || !data?.data) return null
      const d = data.data
      // 协议端有的版本把 messages 直接放 data，有的放 data.data
      const messages = Array.isArray(d.messages) ? d.messages
        : (Array.isArray(d.data?.messages) ? d.data.messages : null)
      return messages ? { messages } : null
    } catch (e) {
      this.log.debug(`get_forward_msg 失败 (${forwardId}): ${e.message}`)
      return null
    }
  }

  /**
   * 按 file_id 溯源协议端本地文件/直链（OneBot get_file）。
   * 返回的 `file` 可能是 `file://` URL 或原生路径 → 统一经 from协议端FileRef() 归一成本地路径，
   * 调用方（入站文件/表情采集）就不用各写一份 URL 解析。
   */
  async getFile(fileId) {
    try {
      const { data } = await this._post('get_file', { file_id: String(fileId) }, 10000)
      const hit = data?.status === 'ok' && data?.data ? { ...data.data } : null
      if (hit && typeof hit.file === 'string') hit.file = fromOneBotFileRef(hit.file)
      return hit
    } catch (e) {
      this.log.debug(`get_file 失败 (${fileId}): ${e.message}`)
      return null
    }
  }

  /**
   * 群列表（OneBot v11 `get_group_list`，只读）。失败返回 [] —— 调用方拿不到群名就只显示号码，
   * 绝不因为这层查询坏掉影响聊天。
   * @returns {Promise<Array<{id:number, name:string}>>}
   */
  async groupList() {
    try {
      const { data } = await this._post('get_group_list', {})
      return (Array.isArray(data?.data) ? data.data : [])
        .map((g) => ({ id: Number(g.group_id), name: String(g.group_name || '').trim() }))
        .filter((g) => Number.isInteger(g.id) && g.id > 0)
    } catch (e) {
      this.log.debug(`取群列表失败: ${e.message}`)
      return []
    }
  }

  /**
   * 好友列表（OneBot v11 `get_friend_list`，只读）。失败返回 []。
   * name 优先备注（群主/主人给的名字），没有备注就用昵称。
   * @returns {Promise<Array<{qq:number, name:string}>>}
   */
  async friendList() {
    try {
      const { data } = await this._post('get_friend_list', {})
      return (Array.isArray(data?.data) ? data.data : [])
        .map((f) => ({ qq: Number(f.user_id), name: String(f.remark || f.nickname || '').trim() }))
        .filter((f) => Number.isInteger(f.qq) && f.qq > 0)
    } catch (e) {
      this.log.debug(`取好友列表失败: ${e.message}`)
      return []
    }
  }

  /**
   * 取登录账号（selfId / selfNickname）：先 WS，失败再 HTTP。
   * 为什么要有 HTTP 兜底：WS 刚 open 的那一下 API 偶发超时/未就绪，而 selfId 为空会让
   * "自己发的消息过滤"、合并卡片节点名、健康快照全跟着瞎 —— 两条通道都是 OneBot 11 标准，
   * 纯客户端适配，不动协议端任何配置。
   */
  async _fetchLoginInfo() {
    return this.checkLogin({ force: true, quiet: true })
  }

  /** 启动登录状态轮询（连接期间每 30s 主动 get_login_info；断线时暂停）。 */
  _startLoginWatch() {
    if (this._loginTimer) return
    this._loginTimer = setInterval(() => {
      if (this.closed) return
      if (!this.ws || this.ws.readyState !== 1) return
      this.checkLogin({ quiet: true }).catch(() => {})
    }, LOGIN_CHECK_MS)
    this._loginTimer.unref?.()
  }

  /**
   * 主动检查 QQ 是否还在线。WS 连着只说明协议端在，不代表 QQ 账号在线。
   * 先 WS get_login_info，失败再走 HTTP；成功置 loginOk=true，失败置 false 并记录原因。
   * @param {{force?:boolean, quiet?:boolean}} [opts]
   * @returns {Promise<{ok:boolean|null, selfId:number|null, nickname:string|null, error:string|null, checkedAt:number}>}
   */
  async checkLogin({ force = false, quiet = false } = {}) {
    const now = Date.now()
    if (!force && this.loginCheckedAt && now - this.loginCheckedAt < LOGIN_CHECK_TTL_MS) {
      return { ok: this.loginOk, selfId: this.selfId, nickname: this.selfNickname, error: this.loginError || null, checkedAt: this.loginCheckedAt }
    }
    if (this._loginChecking) return this._loginChecking
    const task = (async () => {
      if (!this.ws || this.ws.readyState !== 1) {
        return { ok: null, selfId: this.selfId, nickname: this.selfNickname, error: 'OneBot 连接未建立', checkedAt: this.loginCheckedAt }
      }
      let info = null
      let err = null
      // get_login_info 在 QQ 掉线后仍可能返回缓存账号（协议端实测），不能单独作为在线依据
      try { info = (await this.wsApi('get_login_info'))?.data } catch (e) { err = e }
      if (!info?.user_id) {
        try { info = (await this._post('get_login_info', {}))?.data?.data } catch (e) { err = e }
      }
      if (info?.user_id) {
        this.selfId = Number(info.user_id)
        this.selfNickname = info.nickname || this.selfNickname
      }
      if (!this.selfId) {
        this.loginOk = false
        this.loginError = err ? String(err.message || err) : '协议端未返回登录账号'
        this.loginCheckedAt = Date.now()
        if (!quiet) this.log.warn(`QQ 登录状态检查失败: ${this.loginError}`)
        return { ok: false, selfId: this.selfId, nickname: this.selfNickname, error: this.loginError, checkedAt: this.loginCheckedAt }
      }

      // 协议端健康信号（SnowLuma 的 get_status 明确区分 online / good；多数实现也有 get_status）：
      // online=false → 已掉线；good=false → 接收链路停滞（hook 卡住时"发得出、收不进"，光看
      // get_stranger_info 会误判在线）。只在明确 false 时降级；拿不到/字段缺省继续走下面的探针，
      // 不改变纯协议端的既有判定（协议端的 get_status 会命中缓存，2026-10-22 实测）。
      let statusData = null
      try {
        const r = await this._post('get_status', {}, 6000)
        if (r?.data?.status === 'ok' && r.data.data && typeof r.data.data === 'object') statusData = r.data.data
      } catch { /* 协议端没有 get_status 时忽略 */ }
      if (!statusData) {
        try {
          const r = await this.wsApi('get_status', {})
          if (r?.status === 'ok' && r.data && typeof r.data === 'object') statusData = r.data
        } catch { /* 忽略，走探针 */ }
      }
      if (statusData && typeof statusData.good === 'boolean') this.receiveGood = statusData.good
      if (statusData && (statusData.online === false || statusData.good === false)) {
        this.loginOk = false
        this.loginError = statusData.online === false
          ? 'QQ 已离线（协议端 get_status.online=false）'
          : '协议端接收链路异常（get_status.good=false，发得出但收不进）'
        this.loginCheckedAt = Date.now()
        if (!quiet) this.log.warn(`QQ 登录状态检查失败: ${this.loginError}`)
        return { ok: false, selfId: this.selfId, nickname: this.selfNickname, error: this.loginError, checkedAt: this.loginCheckedAt }
      }

      // 真·在线探测：get_stranger_info 需要 QQ 服务端往返。离线时协议端会返回
      // retcode!=0 / "网络连接异常" / coreInfo null；在线时 retcode=0。
      // 仅用 get_status/get_login_info 都会命中缓存，发现不了这种掉线（2026-10-22 实测）。
      let probePayload = null
      let probeError = null
      try {
        const r = await this._post('get_stranger_info', { user_id: this.selfId })
        probePayload = r?.data && typeof r.data === 'object' && ('retcode' in r.data || 'status' in r.data) ? r.data : null
      } catch (e) { probeError = e }
      if (!probePayload) {
        try {
          const r = await this.wsApi('get_stranger_info', { user_id: this.selfId })
          probePayload = r && typeof r === 'object' && ('retcode' in r || 'status' in r) ? r : null
        } catch (e) { probeError = e }
      }
      const probeOk = Boolean(probePayload && probePayload.status === 'ok' && Number(probePayload.retcode) === 0)
      this.loginCheckedAt = Date.now()
      if (probeOk) {
        this.loginOk = true
        this.loginError = ''
        if (!quiet) this.log.info(`机器人 QQ: ${this.selfId} (${this.selfNickname || ''}) 在线`)
        return { ok: true, selfId: this.selfId, nickname: this.selfNickname, error: null, checkedAt: this.loginCheckedAt }
      }
      this.loginOk = false
      this.loginError = String(probePayload?.wording || probePayload?.message || probeError?.message || 'QQ 网络连接异常（协议端仍缓存了登录信息）')
      if (!quiet) this.log.warn(`QQ 登录状态检查失败（已掉线）: ${this.loginError}`)
      return { ok: false, selfId: this.selfId, nickname: this.selfNickname, error: this.loginError, checkedAt: this.loginCheckedAt }
    })().finally(() => { this._loginChecking = null })
    this._loginChecking = task
    return task
  }

  /** 戳一戳（群聊带 group_id，私聊只带 user_id）。协议端不支持时**静默降级**：回戳是锦上添花。 */
  async poke(chatKey, userId) {
    const { type, id } = chatTarget(chatKey)
    const params = type === 'group' ? { group_id: id, user_id: Number(userId) } : { user_id: Number(userId) }
    try {
      const { data } = await this._post('send_poke', params)
      return data.status === 'ok'
    } catch (e) {
      this.log.debug(`戳一戳失败(忽略): ${e.message}`)
      return false
    }
  }

  /**
   * 名字 → QQ 号（给出站 `[AT:名字]` 用；成员表缓存 5 分钟）。
   * ① 群名片/昵称**完全相同**且唯一 → 用它；② 否则唯一子串命中 → 用它；③ 命中多个/没有 → null
   * （宁可不 @，绝不乱 @ 人）。
   */
  async resolveMemberByName(groupId, name) {
    const want = String(name || '').trim().replace(/^@/, '')
    if (!want) return null
    let list
    try { list = await this._members(groupId) } catch (e) { this.log.warn(`群成员表查询失败 (${groupId}): ${e.message}`); return null }
    const exact = list.filter((m) => m.names.some((n) => n === want))
    if (exact.length === 1) return exact[0].qq
    if (exact.length > 1) { this.log.debug(`[AT] 名字「${want}」在 ${groupId} 有 ${exact.length} 个完全匹配, 不 @`); return null }
    const part = list.filter((m) => m.names.some((n) => n.includes(want)))
    if (part.length === 1) return part[0].qq
    this.log.debug(`[AT] 名字「${want}」${part.length ? `${part.length} 个模糊匹配` : '没匹配到'}, 不 @ (${groupId})`)
    return null
  }

  /**
   * 取群友 / 自己的头像（契约 `bot.onebot.fetchAvatar`；产物要能直接拿去图生图）。
   *
   * 为什么走 CDN：协议端没有通用头像接口（`get_qq_avatar` 在多数版本回"不支持的Api"），
   * `get_group_member_info` / `get_friend_list` 里也都没有头像字段。QQ 头像是公开的：
   * `https://q1.qlogo.cn/g?b=qq&nk=<QQ>&s=640`（实测 200 + JPEG）。
   *
   * @param {string} target group:<群号> | private:<QQ号>（按昵称找人时需要群号）
   * @param {string} user QQ 号（优先）或群名片/昵称
   * @returns {Promise<{ok:true, user_id:number, name:string, path:string, url:string, cached:boolean, bytes:number}>}
   */
  async fetchAvatar(target, user) {
    const { type, id } = chatTarget(target)
    const raw = String(user || '').trim().replace(/^@/, '')
    if (!raw) throw new Error('user 不能为空（QQ 号，或群会话里的群名片/昵称）')
    let qq = null
    let name = raw
    if (/^\d{5,12}$/.test(raw)) qq = Number(raw)
    else if (type === 'group') {
      qq = await this.resolveMemberByName(id, raw) // 昵称会变，优先给 QQ 号
      if (!qq) throw new Error(`群里没找到「${raw}」—— 换成 QQ 号再试`)
    } else throw new Error('私聊里只能按 QQ 号取头像')
    if (type === 'group') {
      // 顺手补全群名片/昵称（失败不影响取图）
      try {
        const mem = (await this._members(id)).find((m) => String(m.qq) === String(qq))
        if (mem?.names?.[0]) name = mem.names[0]
      } catch { /* 忽略 */ }
    }
    const url = `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`
    fs.mkdirSync(this.avatarDir, { recursive: true })
    const file = path.join(this.avatarDir, `${qq}.jpg`)
    const cacheMs = this.avatarCacheHours * 3600 * 1000
    let cached = false
    try {
      const st = fs.statSync(file)
      if (st.isFile() && st.size > 100 && Date.now() - st.mtimeMs < cacheMs) cached = true
    } catch { /* 没缓存就下载 */ }
    if (!cached) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error(`头像下载失败: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 100) throw new Error('头像下载失败: 内容过小（可能不是图片）')
      atomicWriteFileSync(file, buf) // 原子替换（Windows 上 rename 被占用会退避重试）
    }
    const real = fs.realpathSync(file)
    const bytes = fs.statSync(real).size
    this.log.info(`[头像] ${name}(${qq}) → ${real}（${cached ? '用缓存' : '刚下载'} ${bytes} 字节）`)
    return { ok: true, user_id: qq, name, path: real, url, cached, bytes }
  }

  async _members(gid) {
    const key = String(gid)
    const hit = this._memberCache.get(key)
    if (hit && Date.now() - hit.at < MEMBER_CACHE_MS) return hit.list
    const { data } = await this._post('get_group_member_list', { group_id: Number(gid) })
    const list = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => ({ qq: Number(m.user_id), names: [m.card, m.nickname].map((v) => String(v || '').trim()).filter(Boolean) }))
      .filter((m) => Number.isInteger(m.qq) && m.qq > 0 && m.names.length)
    if (list.length) this._memberCache.set(key, { at: Date.now(), list })
    return list.length ? list : (hit?.list ?? [])
  }
}
