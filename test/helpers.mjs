/**
 * test/helpers.mjs — 测试公用夹具（不是测试文件，node --test 不会直接跑它）。
 *
 * 目标：所有套件统一「临时数据目录 + 实例 config.json + mock Cordis ctx」的装配方式，
 * 不依赖真实 DSH / OneBot / 站点路径。需要真实 WS/HTTP 的套件用 test/fake-onebot.mjs。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { defaultConfig, deepMerge } from '../kernel/config-store.js'

/** 合成占位值（与文档一致；真实号码一律不进仓库）。 */
export const ADMIN_QQ = 10001
export const GROUP_ID = 20001
export const MEMBER_QQ = 10002

export function tmpDir(tag = 't') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-${tag}-`))
}

/** v2 实例配置：默认值 + 占位 协议端地址 + 关留档。 */
export function baseConfig(forbiddenOverrides = {}) {
  return deepMerge(defaultConfig(), {
    adminQq: ADMIN_QQ,
    onebot: {
      wsUrl: 'ws://127.0.0.1:1',
      wsToken: '',
      httpUrl: 'http://127.0.0.1:1',
      httpToken: '',
    },
    archive: { enabled: false, dir: 'logs/qq_chat' },
    dsh: { agentPreset: '', qqWorkspacePath: 'workspace', sessionsFile: 'state/sessions.json' },
  })
}

export function writeInstanceConfig(dataDir, overrides = {}) {
  const raw = deepMerge(baseConfig(), overrides)
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'config.json')
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 4)}\n`)
  return { raw, file }
}

/**
 * 最小 Cordis 宿主 ctx（只模拟本插件用到的服务面）。
 * @param {{workspacePath?:string, onPrompt?:(req:object)=>any}} opts
 */
export function createMockCtx(opts = {}) {
  const registeredTools = new Map()
  const effects = []
  const listeners = new Map()
  const sessions = new Map()
  const prompts = []
  let sessionSeq = 0
  let promptHandler = opts.onPrompt || null

  // 假工作区注册表：list() 返回已注册的；create() 登记并记到 created（断言「自举」用）。
  const workspaceRegistry = {
    workspaces: opts.workspacePath ? [{ id: 'ws-qq', path: opts.workspacePath, title: '' }] : [],
    created: [],
    list() { return this.workspaces.map((w) => ({ ...w })) },
    async resolveByPath(p) {
      const want = path.resolve(String(p))
      return this.workspaces.find((w) => path.resolve(String(w.path)) === want)
    },
    async create(p, title) {
      const ws = { id: `ws-${this.workspaces.length + 1}`, path: p, title: title || '' }
      this.workspaces.push(ws)
      this.created.push({ ...ws })
      return { ...ws }
    },
    archivedSessionIds: [],
    archived: [],
    async archiveSession(id) {
      workspaceRegistry.archived.push(id)
      workspaceRegistry.archivedSessionIds.push(id)
    },
    async unarchiveSession(id) {
      const i = workspaceRegistry.archivedSessionIds.indexOf(id)
      if (i >= 0) workspaceRegistry.archivedSessionIds.splice(i, 1)
    },
  }

  // 假 agentPresets 服务：默认已声明内置 qq-chat（对齐 bundle patch 随包声明的现网行为）。
  const agentPresets = {
    presets: [...(opts.presets || ['qq-chat'])],
    async list() { return agentPresets.presets.map((id) => ({ id })) },
    async get(id) { return agentPresets.presets.includes(id) ? { id } : undefined },
    register(def) {
      if (def?.id && !agentPresets.presets.includes(def.id)) agentPresets.presets.push(def.id)
      return () => {}
    },
  }

  const sessionController = {
    async create(req) {
      const sessionId = `mock-session-${++sessionSeq}`
      sessions.set(sessionId, { ...req, id: sessionId, title: '' })
      return { sessionId }
    },
    async prompt(req) {
      prompts.push(req)
      if (promptHandler) await promptHandler(req)
      return { accepted: true }
    },
    async rename({ sessionId, title }) {
      const s = sessions.get(sessionId)
      if (s) s.title = title
      return { title, seq: 1 }
    },
    async cancel() {
      return { cancelled: true }
    },
    async list() {
      return { items: [...sessions.values()] }
    },
  }

  const toolsService = {
    register(toolDef) {
      const name = String(toolDef?.name || '')
      registeredTools.set(name, toolDef)
      return () => registeredTools.delete(name)
    },
    restrict() {
      return () => {}
    },
  }

  const services = new Map() // 模拟 Cordis 服务表（ctx.plugin 注册、ctx.get 取用）

  const ctx = {
    tools: toolsService,
    sessionController,
    inject(_deps, fn) {
      const child = Object.create(ctx)
      child.tools = toolsService
      fn(child)
      return child
    },
    get(name) {
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'sessionController') return sessionController
      if (name === 'agentPresets') return agentPresets
      return services.get(name)
    },
    plugin(PluginClass, options) {
      // 真 Cordis：ctx.plugin(ServiceClass, options) 把服务挂到 ctx 上。
      // 夹具里不实例化真 Service（依赖 Cordis 内部），只登记 qqBot 服务，形状对齐 `{ kernel }`。
      if (options && typeof options === 'object' && options.deliver) services.set('qqBot', { kernel: options })
      return () => services.delete('qqBot')
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const list = listeners.get(event) || []
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args)
    },
    /** 测试里换 mock 模型的应答逻辑 */
    setPromptHandler(fn) {
      promptHandler = fn
    },
    _registeredTools: registeredTools,
    _effects: effects,
    _prompts: prompts,
    _sessions: sessions,
    _workspaceRegistry: workspaceRegistry,
    _agentPresets: agentPresets,
    _listeners: listeners,
  }
  return ctx
}

/** 给 kernel.onebot 打桩（autoConnect:false 下不会碰真实网络）。 */
export function stubNapcat(kernel) {
  const sent = []
  let seq = 5000
  kernel.onebot.selfId = 999999
  kernel.onebot.selfNickname = '测试机器人'
  kernel.onebot.sendMessage = async (target, wire) => {
    sent.push({ kind: 'msg', target, wire })
    return ++seq
  }
  kernel.onebot.sendForward = async (target, nodes) => {
    sent.push({ kind: 'forward', target, nodes })
    return ++seq
  }
  kernel.onebot.sendMedia = async (target, wire) => {
    sent.push({ kind: 'media', target, wire })
    return ++seq
  }
  kernel.onebot.groupHistory = async () => []
  kernel.onebot.groupList = async () => [{ id: GROUP_ID, name: '测试群', group_id: GROUP_ID, group_name: '测试群' }]
  kernel.onebot.friendList = async () => [{ user_id: ADMIN_QQ, nickname: '主人' }]
  kernel.onebot.memberInfo = async (_gid, qq) => ({ user_id: Number(qq), nickname: Number(qq) === ADMIN_QQ ? '主人' : '新人' })
  kernel.onebot.msgById = async (id) => ({ message_id: Number(id), sender: { user_id: ADMIN_QQ, nickname: '主人' }, message: '被引用的消息' })
  kernel.onebot.recall = async () => ({ ok: true })
  kernel.onebot.poke = async () => ({ ok: true })
  kernel.onebot.sendQzoneMsg = async () => ({ ok: true })
  kernel.onebot.fetchAvatar = async () => ({ ok: true, path: '' })
  kernel.onebot.getFile = async () => ''
  kernel.onebot.resolveMemberByName = async (_gid, name) => (name === '奶茶' ? 123456789 : null)
  return sent
}

/**
 * 建临时数据目录 → 写实例配置 → apply()。
 * @param {{dataDir?:string, config?:object, bundle?:object, ctx?:object, onPrompt?:Function, workspacePath?:string}} opts
 */
export async function bootKernel(opts = {}) {
  const dataDir = opts.dataDir || tmpDir('kernel')
  const ctx = opts.ctx || createMockCtx({
    onPrompt: opts.onPrompt,
    workspacePath: opts.workspacePath || path.join(dataDir, 'workspace'),
  })
  const { raw, file } = writeInstanceConfig(dataDir, opts.config || {})
  await apply(ctx, {
    dataDir,
    autoConnect: false,
    compatServer: false,
    ...(opts.bundle || {}),
  })
  // Cordis 语义：apply 不返回普通对象（返回值会被当 effect）；内核经 qqBot 服务暴露。
  const kernel = ctx.get('qqBot')?.kernel
  if (!kernel) throw new Error('apply() 后 qqBot 服务为空（内核装配失败）')
  const sent = stubNapcat(kernel)
  const dispose = () => {
    for (const fn of [...ctx._effects].reverse()) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
  }
  return { kernel, ctx, dataDir, configPath: file, raw, sent, dispose }
}

/** 把原始 OneBot 事件喂给内核（等价于 OneBot WS 推一条）。 */
export async function emitRaw(kernel, raw) {
  for (const h of [...kernel.onebot.handlers]) await h(raw)
}

export function groupAtEvent({ text = '你好', messageId = 5001, userId = ADMIN_QQ, at = true, replyTo = null } = {}) {
  const message = []
  if (replyTo != null) message.push({ type: 'reply', data: { id: String(replyTo) } })
  if (at) message.push({ type: 'at', data: { qq: '999999' } })
  message.push({ type: 'text', data: { text } })
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: userId,
    message_id: messageId,
    sender: { user_id: userId, nickname: userId === ADMIN_QQ ? '主人' : '群友', card: '' },
    message,
  }
}

export function privateEvent({ text = '你好', messageId = 6001, userId = ADMIN_QQ } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    message_id: messageId,
    sender: { user_id: userId, nickname: userId === ADMIN_QQ ? '主人' : '网友' },
    message: [{ type: 'text', data: { text } }],
  }
}

export async function waitFor(fn, { timeoutMs = 8000, label = '条件' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * 旁路记录内核实收的入站事件（Pipeline.run 入口），断言 stopReason / wake 用。
 * 返回 { events, last() }；不改变管线行为。
 */
export function tapInbound(kernel) {
  const events = []
  const pipeline = kernel.pipeline
  const original = pipeline.run.bind(pipeline)
  pipeline.run = async (ev, terminal, opts) => {
    events.push(ev)
    return original(ev, terminal, opts)
  }
  return { events, last: () => events[events.length - 1] }
}
