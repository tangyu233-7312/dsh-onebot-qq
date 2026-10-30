/**
 * admin/endpoints.js — 控制台 **8 端点**实现（响应形状与浏览器半边 client.js 的读取字段对齐）。
 *
 *   schema  控制表 + 子插件 + 动作按钮 + 当前值
 *   status  健康 / QQ 线 / 群管控 / 人设 / 句池 / 主动接话 / 迎宾 / 子插件 / 服务
 *           + 新手引导（meta / onboarding / onebot / imagegen；**绝不回显任何 key**）
 *   set     写一个白名单配置键（热生效）
 *   module  子插件启停（写 pluginConfig.<id>.enabled）
 *   group   群管控：ignore / allowlist / blocklist / keywords / spont / welcome 的 add/remove/toggle/ensure
 *   memory  群记忆：list / read / save / config / setcfg / refresh
 *   persona 人设：list / switch（platform/persona-ref.js，跨平台软链→复制降级）
 *   action  动作：reply-preset / reset-session / welcome-images / welcome-test / clear-qq-sessions
 *           + 新手引导（onebot-check / onebot-reconnect / imagegen-check）
 *           + 运维诊断（diagnose → admin/diagnostics.js，生成脱敏报告）
 *           + 运维动作（selfcheck / cleanup-tmp / dedup-baks）→ ops provider，没有则“本机未配置”
 *
 * 纪律：
 *   · **不 spawn 任何系统命令**、不读包外私有路径；运维能力全走 ops provider；
 *   · 所有业务失败返回 `{ok:false,error:"人话"}`（不 throw —— RPC host 直接把它塞进 value 信封）；
 *   · 写配置只经 admin/store.js；文件只经 platform 的路径/原子写工具。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRuntimePaths, validateConfig } from '../kernel/config-store.js'
import { atomicWriteFileSync } from '../platform/atomic.js'
import { ensureDir, isInsidePath, resolveDataPath } from '../platform/paths.js'
import { activePersona, listPersonas, personaSources, switchPersona } from '../platform/persona-ref.js'
import { createConfigStore } from './store.js'
import { runDiagnostics } from './diagnostics.js'
import {
  ACTIONS, GROUP_PATHS, SECRET_MASK, allControls, collectModules, collectSchema, findControl,
  getPath, pluginDefs, readValue, setPath, writeValue,
} from './schema.js'
import { hasOps } from '../ops/provider.js'

/** 8 个端点名（host 的未知端点报错信息也用它）。 */
export const ENDPOINTS = ['schema', 'status', 'set', 'module', 'group', 'memory', 'persona', 'action']

/** 包版本兜底（优先 kernel.version；内核没给时读自身 package.json）。 */
const requirePkg = createRequire(import.meta.url)
const PKG_VERSION = (() => {
  try { return String(requirePkg('../package.json').version || '') } catch { return '' }
})()

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (structuredClone(v))
const toStr = (v) => (v == null ? '' : String(v)).trim()

/** 数组 / 逗号分隔串 → 去空去重字符串数组（群号、唤醒词共用）。 */
function toStrList(v) {
  if (v == null || v === '') return []
  const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/)
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))]
}

/** 卡片/群清单用的数字列表（非法值丢弃）。 */
function toNumList(v) {
  return toStrList(v).map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

function positiveInt(v, label) {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} 必须是正整数`)
  return n
}

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

async function safeAsync(fn, fallback = null) {
  try { return await fn() } catch { return fallback }
}

/** Promise 超时兜底：协议端挂掉时 status 不能被群列表拖十几秒。 */
function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 服务探活结果归一：支持 `{服务名: 'active'}` 与单服务 `{unit, state}` 两种 ops 返回。 */
function normalizeServiceProbe(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.unit === 'string' && raw.state !== undefined) return { [raw.unit]: String(raw.state) }
  const map = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') map[name] = value
    else if (value && typeof value === 'object' && value.state !== undefined) map[name] = String(value.state)
  }
  return Object.keys(map).length ? map : null
}

/** 文件大小（拿不到 = 0）。 */
function sizeOf(file) {
  try { return fs.statSync(file).size } catch { return 0 }
}

// ── 配置读取辅助 ─────────────────────────────────────────────

/** 本插件 raw 配置里的某个子插件段（不存在返回 {}）。 */
function pluginCfg(raw, id) {
  const v = raw?.pluginConfig && raw.pluginConfig[id]
  return isPlainObject(v) ? v : {}
}

/** gate-wake 的群号→QQ 名单：兼容对象 `{群号:[QQ]}` 与文本 `"群号:QQ,QQ;群号:QQ"` 两种存法。 */
export function parseGroupMap(raw) {
  const map = new Map()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [gid, qqs] of Object.entries(raw)) map.set(String(gid), toNumList(qqs))
    return map
  }
  for (const part of String(raw ?? '').split(/[;；\n]/)) {
    const idx = part.search(/[:：]/)
    if (idx < 0) continue
    const gid = part.slice(0, idx).trim()
    if (!gid) continue
    map.set(gid, toNumList(part.slice(idx + 1)))
  }
  return map
}

/** 名单 Map → 配置里的存法：原本是对象就继续用对象，否则用控制台的文本格式。 */
function serializeGroupMap(map, preferObject) {
  if (preferObject) {
    const out = {}
    for (const [gid, qqs] of map) if (qqs.length) out[gid] = qqs.map(Number)
    return out
  }
  return [...map]
    .filter(([, qqs]) => qqs.length)
    .map(([gid, qqs]) => `${gid}:${qqs.join(',')}`)
    .join(';')
}

/**
 * 唤醒词表：兼容对象 `{群号:[词]}`（"*" = 全局）与文本行格式
 * `*: 词1,词2` + `<群号>: 词`（一行一个键）。返回 Map<群号|'*', 词数组>。
 */
export function parseKeywordMap(raw) {
  const map = new Map()
  const add = (gid, words) => {
    const key = String(gid)
    const cur = map.get(key) || []
    map.set(key, [...new Set([...cur, ...toStrList(words)])])
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [gid, words] of Object.entries(raw)) add(gid, words)
    return map
  }
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const idx = text.search(/[:：]/)
    if (idx < 0) { add('*', text); continue } // 没写群号的裸词算全局
    add(text.slice(0, idx).trim() || '*', text.slice(idx + 1))
  }
  return map
}

/** 唤醒词表 → 配置存法（原本对象就对象，否则文本行）。 */
function serializeKeywordMap(map, preferObject) {
  const entries = [...map].filter(([, words]) => words.length)
  if (preferObject) return Object.fromEntries(entries.map(([gid, words]) => [gid, [...words]]))
  return entries
    .sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : Number(a) - Number(b)))
    .map(([gid, words]) => `${gid}: ${words.join(',')}`)
    .join('\n')
}

/** 唤醒词写哪里：权威落点 = `pluginConfig['gate-wake'].keywords`（见 docs/architecture §四/内核约定）。 */
function keywordConfigPath() {
  return GROUP_PATHS.keywords
}

// ── 内核状态读取辅助（都对 mock/不同内核实现容错）────────────────

function sessionsMapOf(kernel) {
  const s = kernel?.dsh?.sessions
  if (s instanceof Map) return s
  if (s && typeof s === 'object') return new Map(Object.entries(s))
  return new Map()
}

function sessionKeysOf(kernel) {
  if (typeof kernel?.dsh?.listChatKeys === 'function') return safe(() => kernel.dsh.listChatKeys(), []) || []
  return [...sessionsMapOf(kernel).keys()]
}

function sessionIdOf(kernel, chatKey) {
  const direct = safe(() => kernel?.dsh?.sessionOf?.(chatKey), null)
  if (direct) return String(direct)
  return String(sessionsMapOf(kernel).get(chatKey) || '')
}

async function fetchGroupList(kernel) {
  if (typeof kernel?.onebot?.groupList !== 'function') return []
  try {
    const list = await withTimeout(kernel.onebot.groupList(), 4000)
    return (Array.isArray(list) ? list : [])
      .map((g) => ({ id: String(g.id), name: toStr(g.name) }))
      .filter((g) => /^\d+$/.test(g.id))
  } catch {
    return []
  }
}

function runtimeIgnoreList(kernel) {
  const ri = kernel?.state?.runtimeIgnore
  if (!ri) return []
  if (typeof ri.list === 'function') return toStrList(safe(() => ri.list(), []))
  if (ri.set instanceof Set) return [...ri.set].map(String)
  if (ri instanceof Set) return [...ri].map(String)
  return []
}

function isRuntimeIgnored(kernel, gid) {
  const ri = kernel?.state?.runtimeIgnore
  if (!ri) return false
  if (typeof ri.has === 'function') return safe(() => ri.has(gid) === true, false)
  if (ri.set instanceof Set) return ri.set.has(String(gid)) || ri.set.has(Number(gid))
  return false
}

/** 入群欢迎图片池：扫目录里的常见图片格式（只读；失败 = 空池，不影响控制台）。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
function listWelcomeImages(dirRaw, limit = 200) {
  const dir = String(dirRaw || '')
  const out = { dir, exists: false, count: 0, images: [] }
  if (!dir) return out
  try {
    if (!fs.statSync(dir).isDirectory()) return out
    const names = fs.readdirSync(dir)
      .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
      .sort()
    out.exists = true
    out.count = names.length
    out.images = names.slice(0, limit).map((name) => {
      let size = 0
      let mtime = 0
      try {
        const st = fs.statSync(path.join(dir, name))
        size = st.size
        mtime = st.mtimeMs
      } catch { /* 并发删除等忽略 */ }
      return { name, size, mtime }
    })
    return out
  } catch {
    return out
  }
}

// ============================================================
// 端点实现
// ============================================================

/**
 * 建 8 端点控制器。
 * @param {{kernel?:object, configPath?:string, dataDir?:string, log?:object, ops?:object}} opts
 * @returns {{handle:(endpoint:string,payload?:object)=>Promise<object>, setOps:(ops:object)=>void,
 *            store:object, configPath:string, endpoints:string[], schema:Function, status:Function}}
 */
export function createAdminEndpoints({ kernel = {}, configPath = '', dataDir = '', log = console, ops = null } = {}) {
  const store = createConfigStore({ kernel, configPath, dataDir, log })
  let opsRef = ops || null

  const warn = (m) => { try { log?.warn?.(`[控制台] ${m}`) } catch { /* ignore */ } }

  /** 解析后的运行配置（路径绝对化、凭据覆盖）：内核有就直接用，否则现场 loadConfig。 */
  function runtimeOf() {
    const rt = kernel?.runtime
    if (isPlainObject(rt)) return rt
    const file = configPath || kernel?.configPath || ''
    try {
      const loaded = loadConfig({ dataDir: dataDir || kernel?.dataDir || '', configPath: file, createIfMissing: false })
      return loaded.runtime || resolveRuntimePaths(loaded.raw || {}, loaded.dataDir || dataDir || '')
    } catch {
      return resolveRuntimePaths(safe(() => store.read(), {}), dataDir || kernel?.dataDir || '')
    }
  }

  /**
   * 某个子插件的**运行时已解析 cfg**（含 schema 默认值、路径已绝对化）。
   * 来源优先级：kernel.plugins 条目（内核 buildPluginCfg 的产物）→ kernel.runtime.pluginConfig → raw.pluginConfig。
   * 控制台读人设目录 / 记忆目录 / 欢迎图池这类**路径**必须走这里（raw 里可能没写、默认值在内核侧）。
   */
  function pluginCfgRuntime(id) {
    const rt = runtimeOf()
    const fromRuntime = rt?.pluginConfig?.[id]
    const base = fromRuntime && typeof fromRuntime === 'object' ? fromRuntime : {}
    const keyOf = (p) => String(p?.id || p?.plugin?.id || '')
    // 内核已加载条目优先；停用的插件不在 kernel.plugins 里 → 用 kernel.pluginDefs[].cfg（同一份已解析 cfg）
    const loadedEntry = (Array.isArray(kernel?.plugins) ? kernel.plugins : []).find((p) => keyOf(p) === id)
    const defEntry = (Array.isArray(kernel?.pluginDefs) ? kernel.pluginDefs : []).find((p) => keyOf(p) === id)
    const loadedCfg = loadedEntry?.cfg && typeof loadedEntry.cfg === 'object' ? loadedEntry.cfg : null
    const defCfg = defEntry?.cfg && typeof defEntry.cfg === 'object' ? defEntry.cfg : null
    // 合并：runtime 里的显式值打底，内核 buildPluginCfg 的**已解析默认值**覆盖在最上面
    return { ...base, ...(defCfg || {}), ...(loadedCfg || {}) }
  }

  /** 数据目录（路径类配置的相对基准）。 */
  function dataDirOf() {
    return dataDir || kernel?.dataDir || ''
  }

  /** 配置里的路径值 → 绝对路径（相对 dataDir；已是绝对路径/`~` 的原样归一）。 */
  function resolvedPathOf(value) {
    const input = String(value || '').trim()
    if (!input) return ''
    return resolveDataPath(input, dataDirOf())
  }

  // ── 新手引导辅助（契约 §3.2）────────────────────────────────

  /** 包根目录：优先 kernel.paths.packageRoot，退回本文件所在包的上一级。 */
  function packageRootOf() {
    const fromKernel = toStr(kernel?.paths?.packageRoot)
    if (fromKernel) return fromKernel
    try { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } catch { return '' }
  }

  /** 关键路径（全部绝对）：优先 kernel.paths，缺项按 dataDir / 插件已解析 cfg 派生。 */
  function pathsOf() {
    const kp = isPlainObject(kernel?.paths) ? kernel.paths : {}
    const rt = runtimeOf()
    const ddRaw = toStr(kp.dataDir || kernel?.dataDir || dataDir)
    const dd = ddRaw ? path.resolve(ddRaw) : ''
    const packageRoot = packageRootOf()
    const workspaceRaw = toStr(kp.workspaceDir || rt?.dsh?.qqWorkspacePath || (dd ? path.join(dd, 'qq-lines') : ''))
    const personaRaw = toStr(kp.personaDir || pluginCfgRuntime('persona-voice').personaDir || (dd ? path.join(dd, 'personas') : ''))
    const defaultRaw = toStr(kp.defaultPersonaDir || (packageRoot ? path.join(packageRoot, 'examples', 'personas') : ''))
    return {
      dataDir: dd,
      workspaceDir: workspaceRaw ? path.resolve(workspaceRaw) : '',
      personaDir: personaRaw ? path.resolve(personaRaw) : '',
      packageRoot,
      defaultPersonaDir: defaultRaw ? path.resolve(defaultRaw) : '',
    }
  }

  /** 配置是否已完成（内核 configReady 优先；老内核退回 validateConfig）。 */
  function configReadyOf(raw) {
    if (typeof kernel?.configReady === 'boolean') return kernel.configReady
    const errors = safe(() => validateConfig(raw), null)
    return Array.isArray(errors) ? errors.length === 0 : false
  }

  /** 数据目录 / 配置文件是否可读写（向导第一项）。 */
  function configAccessOk() {
    const dd = pathsOf().dataDir
    if (!dd) return false
    try { fs.accessSync(dd, fs.constants.R_OK | fs.constants.W_OK) } catch { return false }
    const file = toStr(store.configPath || configPath || kernel?.configPath)
    if (!file) return true // 没有配置文件路径时，至少数据目录可写就能落盘
    try {
      if (fs.existsSync(file)) fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK)
    } catch { return false }
    return true
  }

  /**
   * 测一次 OneBot 协议端连接：优先内核 `kernel.checkOneBot()`（A 提供）；
   * 老内核退回「health + get_login_info（5s 超时）」。
   */
  async function checkOneBotNow() {
    if (typeof kernel?.checkOneBot === 'function') {
      const r = await safeAsync(() => kernel.checkOneBot(), null)
      if (r && typeof r === 'object') return r
      return { ok: false, linked: false, error: 'OneBot 连接自检失败（checkOneBot 抛错，详见内核日志）' }
    }
    const health = safe(() => kernel?.onebot?.health?.(), {}) || {}
    const base = {
      linked: Boolean(health.linked),
      stale: Boolean(health.stale),
      lastFrameAgoMs: health.lastFrameAgoMs ?? null,
      selfId: health.selfId ?? null,
      nickname: toStr(health.selfNickname),
    }
    if (!base.linked) return { ok: false, ...base, error: 'OneBot 未连接（检查协议端是否启动、WS 地址/token 是否正确）' }
    const t0 = Date.now()
    try {
      if (typeof kernel?.onebot?.wsApi !== 'function') return { ok: true, ...base, latencyMs: 0 }
      const raw = await withTimeout(kernel.onebot.wsApi('get_login_info', {}), 5000)
      const info = raw?.data?.data ?? raw?.data ?? raw ?? {}
      return {
        ok: true,
        ...base,
        selfId: Number(info.user_id ?? base.selfId) || null,
        nickname: toStr(info.nickname || base.nickname),
        latencyMs: Date.now() - t0,
      }
    } catch (e) {
      return { ok: false, ...base, latencyMs: Date.now() - t0, error: toStr(e?.message) || '协议端无响应' }
    }
  }

  /** 生图配置快照：**绝不回显 apiKey**，只给 apiKeySet + envOverride 标记。 */
  function imagegenStateOf(raw) {
    const rt = runtimeOf()
    const eff = isPlainObject(rt?.credentials?.gptImage) ? rt.credentials.gptImage : {}
    const rawCred = isPlainObject(raw?.credentials?.gptImage) ? raw.credentials.gptImage : {}
    const env = (typeof process !== 'undefined' && process.env) || {}
    const envSet = (name) => toStr(env[name]) !== ''
    const protocol = toStr(eff.protocol || rawCred.protocol) || 'openai-images'
    const baseUrl = toStr(eff.baseUrl || rawCred.baseUrl)
    const model = toStr(eff.model || rawCred.model) || 'gpt-image-2'
    const apiKeySet = toStr(eff.apiKey) !== ''
    return {
      configured: Boolean(baseUrl && apiKeySet),
      protocol,
      model,
      baseUrl,
      apiKeySet,
      envOverride: {
        protocol: envSet('QQ_IMAGEGEN_PROTOCOL'),
        baseUrl: envSet('QQ_IMAGEGEN_BASE_URL'),
        model: envSet('QQ_IMAGEGEN_MODEL'),
        apiKey: envSet('QQ_IMAGEGEN_API_KEY'),
      },
    }
  }

  /** 协议端连接配置快照（token 只报"有没有填"，不回显）。 */
  function onebotStateOf(raw, health) {
    const nap = isPlainObject(raw?.onebot) ? raw.onebot : {}
    return {
      wsUrl: toStr(nap.wsUrl),
      httpUrl: toStr(nap.httpUrl),
      wsTokenSet: toStr(nap.wsToken) !== '',
      httpTokenSet: toStr(nap.httpToken) !== '',
      linked: Boolean(health?.linked),
      stale: Boolean(health?.stale),
      lastFrameAgoMs: health?.lastFrameAgoMs ?? null,
      selfId: health?.selfId ?? null,
      // QQ 登录状态：null=未知/检查中，false=WS 连着但 QQ 不在线（要靠它提醒）
      qqLoggedIn: health?.qqLoggedIn ?? null,
      qqLoginCheckedAt: health?.qqLoginCheckedAt ?? null,
      qqLoginError: toStr(health?.qqLoginError),
    }
  }

  /** 新手向导清单（契约 §3.2 的 5 项）。 */
  function onboardingOf(raw, persona, health, imagegen) {
    const adminQq = Number(getPath(raw, 'adminQq')) || 0
    const napOk = Boolean(health?.linked) && !health?.stale
    return [
      {
        id: 'config', label: '配置文件', required: true, ok: configAccessOk(),
        hint: configAccessOk() ? '数据目录与配置文件可读写' : '数据目录/配置文件不可写：检查目录权限（Windows 用管理员/换目录）',
      },
      {
        id: 'adminQq', label: '主人 QQ', required: true, ok: adminQq > 0,
        hint: adminQq > 0 ? `已填 ${adminQq}` : '在「群聊」页顶部填上你的 QQ（必填）',
      },
      {
        id: 'onebot', label: 'OneBot 连接', required: true, ok: napOk,
        hint: napOk ? '已连接' : '在「OneBot 连接」页填地址 → 点「测试 OneBot 连接」',
      },
      {
        id: 'persona', label: '人设', required: true, ok: Boolean(persona?.current),
        hint: persona?.current
          ? `当前人设：${persona.current}（安装时已自动投递「蓝色大肥鱼」；想换人设见安装说明）`
          : '安装时已自动投递「蓝色大肥鱼」；若缺失可重启插件，或按安装说明自己放人设文件',
      },
      {
        id: 'imagegen', label: '生图（可选）', required: false, ok: Boolean(imagegen?.configured),
        hint: imagegen?.configured ? '生图凭据已就绪' : '可选：在「生图」页填地址/模型/API Key（不填不影响聊天）',
      },
    ]
  }

  /** 控制项 → 前端「群记忆·工具配置」那一行的形状。 */
  function controlPayload(entry, raw) {
    return {
      key: entry.key,
      group: entry.group,
      label: entry.label,
      type: entry.type,
      unit: entry.unit || '',
      min: entry.min,
      max: entry.max,
      step: entry.step,
      options: entry.options || null,
      hint: entry.hint || '',
      value: safe(() => readValue(kernel, entry.key, raw), entry.default),
    }
  }

  // ── schema ─────────────────────────────────────────────────
  function schema() {
    const raw = store.read()
    return { ok: true, ...collectSchema(kernel, raw) }
  }

  // ── status ─────────────────────────────────────────────────
  async function status() {
    const raw = store.read()
    const rt = runtimeOf()
    const onebotHealth = safe(() => kernel?.onebot?.health?.(), {}) || {}
    const dshHealth = safe(() => kernel?.dsh?.health?.(), {}) || {}
    const lines = { mapped: 0, group: [], private: [] }
    for (const key of sessionKeysOf(kernel)) {
      if (!key.startsWith('group:') && !key.startsWith('private:')) continue
      lines.mapped += 1
      if (key.startsWith('group:')) lines.group.push(key)
      else lines.private.push(key)
    }

    // 群管控快照（全部来自 raw 配置；运行时屏蔽另算）
    const gate = pluginCfg(raw, 'gate-wake')
    const ignore = toNumList(gate.ignoreGroups)
    const allowMap = parseGroupMap(gate.groupUserAllowlist)
    const blockMap = parseGroupMap(gate.groupUserBlocklist)
    const keywordMap = parseKeywordMap(gate.keywords)
    const spontList = toNumList(getPath(raw, GROUP_PATHS.spont))
    const welcomeCfg = pluginCfg(raw, 'group-welcome')
    const welcomeGroups = toStrList(welcomeCfg.groups)

    const onebotGroups = await fetchGroupList(kernel)
    const nameByGid = new Map(onebotGroups.map((g) => [g.id, g.name]))
    const lineGids = lines.group.map((k) => String(k).replace(/^group:/, ''))

    // 群清单口径（与现网一致）：屏蔽 ∪ 名单 ∪ 唤醒词 ∪ 欢迎群 ∪ 已有群会话
    const gids = [...new Set([
      ...ignore.map(String),
      ...allowMap.keys(),
      ...blockMap.keys(),
      ...[...keywordMap.keys()].filter((g) => g !== '*'),
      ...welcomeGroups.filter((g) => g !== '*'),
      ...lineGids,
    ])].filter((g) => g !== '*' && /^\d+$/.test(g))
    const groupList = gids
      .map((id) => ({
        id,
        name: nameByGid.get(id) || '',
        ignored: ignore.includes(Number(id)),
        runtimeIgnored: isRuntimeIgnored(kernel, id),
        allowlist: (allowMap.get(id) || []).map(String),
        blocklist: (blockMap.get(id) || []).map(String),
        keywords: keywordMap.get(id) || [],
        spont: spontList.includes(Number(id)),
        welcome: welcomeGroups.includes(id) || welcomeGroups.includes('*'),
        hasLine: lineGids.includes(id),
      }))
      .sort((a, b) => Number(a.id) - Number(b.id))

    // 人设 / 句池 / 唤醒词 / 主动接话状态：优先内核共享槽（内核热读），拿不到给配置兜底
    const persona = personaList()
    const linesPool = safe(() => kernel?.shared?.linesPool?.source?.(), null)
      ?? safe(() => kernel?.linesPool?.source?.(), null)
    const wake = safe(() => kernel?.shared?.readWakeWords?.source?.(), null)
      ?? safe(() => kernel?.wakeSource?.(), null)
      ?? wakeFallback(keywordMap)
    const reply = safe(() => kernel?.pacing?.stats?.(), null)
    const welcome = welcomeStatus(raw, rt)
    const dshSessions = Number(dshHealth.sessions ?? dshHealth.follows ?? lines.mapped) || 0

    const services = hasOps(opsRef, 'systemdProbe') ? normalizeServiceProbe(await opsRef.systemdProbe()) : null

    // 新手引导 / 连接状态（契约 §3.2）：路径、配置完成度、OneBot 连接、生图（key 永不回显）
    const paths = pathsOf()
    const imagegen = imagegenStateOf(raw)
    const onebot = onebotStateOf(raw, onebotHealth)
    const meta = {
      version: toStr(kernel?.version) || PKG_VERSION,
      dataDir: paths.dataDir,
      configPath: toStr(store.configPath || configPath || kernel?.configPath),
      configReady: configReadyOf(raw),
      platform: toStr(safe(() => process.platform, '')),
      node: toStr(safe(() => process.version, '')),
    }
    const onboarding = onboardingOf(raw, persona, onebotHealth, imagegen)

    const modules = collectModules(kernel, raw)
    const longForward = (() => {
      const max = Number(getPath(raw, 'outbound.replyMaxLength')) || 3000
      const threshold = Number(getPath(raw, 'outbound.longForwardThreshold'))
      return {
        enabled: true,
        threshold: threshold > 0 ? threshold : max,
        chunkSize: Number(getPath(raw, 'outbound.longForwardChunkSize')) || 800,
      }
    })()
    const agentPreset = toStr(getPath(raw, 'dsh.agentPreset'))
    // QQ 工作区 / preset 自举状态（插件启动时已自动创建/声明；这里只回显）
    const qqWorkspace = safe(() => kernel?.qqWorkspace ?? null, null)
    const presetStatus = safe(() => kernel?.presetStatus ?? null, null)

    return {
      ok: true,
      health: {
        dshLinked: Boolean(dshHealth.linked ?? true),
        dshMode: toStr(dshHealth.mode) || 'in-process',
        follows: Number(dshHealth.follows ?? dshSessions) || 0,
        sessions: dshSessions,
        onebotLinked: Boolean(onebotHealth.linked),
        onebotStale: Boolean(onebotHealth.stale),
        onebotLastFrameAgoMs: onebotHealth.lastFrameAgoMs ?? null,
        lastFrameAgo: onebotHealth.lastFrameAgoMs ?? null,
        selfId: onebotHealth.selfId ?? null,
        selfNickname: toStr(onebotHealth.selfNickname),
        qqLoggedIn: onebotHealth.qqLoggedIn ?? null,
        qqLoginCheckedAt: onebotHealth.qqLoginCheckedAt ?? null,
        qqLoginError: toStr(onebotHealth.qqLoginError),
        plugins: {
          total: modules.length,
          loaded: modules.filter((m) => m.loaded).length,
          errored: modules.filter((m) => m.lastError).length,
        },
      },
      services,
      meta,
      onboarding,
      onebot,
      imagegen,
      lines,
      groups: {
        ignore: ignore.map(String),
        allowlist: Object.fromEntries([...allowMap].map(([gid, qqs]) => [gid, qqs.map(String)])),
        blocklist: Object.fromEntries([...blockMap].map(([gid, qqs]) => [gid, qqs.map(String)])),
        keywords: Object.fromEntries([...keywordMap].map(([gid, words]) => [gid, words])),
        spont: spontList.map(String),
        welcome: welcomeGroups,
      },
      groupList,
      persona,
      linesPool,
      wake,
      reply,
      welcome,
      modules,
      preset: { private: agentPreset, group: agentPreset, builtin: presetStatus },
      workspace: qqWorkspace,
      longForward,
    }
  }

  /** 内核没有 wakeSource（老内核/测试）时，用配置里的唤醒词表拼一个。 */
  function wakeFallback(keywordMap) {
    const global = keywordMap.get('*') || []
    return {
      from: 'config',
      wakeFile: '',
      persona: [],
      cfgGlobal: global,
      effectiveGlobal: global,
    }
  }

  function welcomeStatus(raw, rt) {
    const cfg = pluginCfg(raw, 'group-welcome')
    const groups = toStrList(cfg.groups)
    const imageDir = resolvedPathOf(pluginCfgRuntime('group-welcome').imageDir || cfg.imageDir)
    return {
      enabled: cfg.enabled !== false,
      mode: cfg.mode === 'model' ? 'model' : 'fixed',
      groups,
      imageDir,
      error: '',
    }
  }

  function personaList() {
    // 路径统一走 pathsOf()：优先 kernel.paths（A 暴露的权威绝对路径），缺项按 runtime/插件 cfg 派生
    const paths = pathsOf()
    const pv = pluginCfgRuntime('persona-voice')
    const personaDir = String(paths.personaDir || '')
    const workspaceDir = String(paths.workspaceDir || '')
    const configured = String(pv.activePersona || '')
    let current = ''
    try { current = activePersona({ configured, workspaceDir, personaDir }) || '' } catch { current = '' }
    const names = safe(() => listPersonas(personaDir), []) || []
    const personas = names.map((name) => {
      const sources = safe(() => personaSources(personaDir, name), {}) || {}
      return {
        name,
        bytes: sizeOf(sources.md || ''),
        hasLines: Boolean(sources.lines),
        hasPoke: fs.existsSync(path.join(personaDir, `${name}.poke.txt`)),
      }
    })
    return { dir: personaDir, workspaceDir, configured, current, personas }
  }

  /** 当前人设的 wake 文件路径（没有 → ''）。控制台「删人设词」改它，而不是改 config。 */
  function personaWakePath() {
    const paths = pathsOf()
    const pv = pluginCfgRuntime('persona-voice')
    const configured = String(pv.activePersona || '')
    let current = ''
    try {
      current = activePersona({
        configured, workspaceDir: String(paths.workspaceDir || ''), personaDir: String(paths.personaDir || ''),
      }) || ''
    } catch { return '' }
    if (!current) return ''
    const sources = safe(() => personaSources(String(paths.personaDir || ''), current), {}) || {}
    return String(sources.wake || '')
  }

  /** 从人设 .wake.txt 删掉一个词：保留注释/其它行，原子写。改的是人设文件本身（不是 config）。 */
  function removePersonaWakeWord(word) {
    const file = personaWakePath()
    if (!file || !/\.wake\.txt$/i.test(file)) throw new Error('当前人设没有 .wake.txt（没有可删的人设唤醒词）')
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch (e) { throw new Error(`读人设唤醒词文件失败：${e.message}`) }
    const bom = text.startsWith('\ufeff') ? '\ufeff' : ''
    const body = bom ? text.slice(1) : text
    const trailing = /\r?\n$/.test(body)
    const target = String(word).trim().toLowerCase()
    const kept = []
    let removed = 0
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) { kept.push(line); continue }
      if (trimmed.toLowerCase() === target) { removed += 1; continue }
      kept.push(line)
    }
    if (!removed) throw new Error(`人设唤醒词文件里没有「${word}」（可能已经删过了）`)
    atomicWriteFileSync(file, bom + kept.join('\n') + (trailing ? '\n' : ''))
    return removed
  }

  // ── set ────────────────────────────────────────────────────
  async function set(payload = {}) {
    const key = toStr(payload.key)
    if (!key) throw new Error('set 需要 key')
    const raw = store.read()
    const next = clone(raw)
    const written = writeValue(kernel, key, payload.value, next)
    if (written.unchanged) {
      return { ok: true, key, value: readValue(kernel, key, raw), message: '未修改（秘密字段写回占位符 = 保持原值）' }
    }
    const control = findControl(kernel, key)
    const isSecret = control?.secret === true
    // 秘密字段（token / API Key）：日志、RPC 返回、控制台消息里都不得出现明文
    const what = isSecret ? `${key} = <已更新>` : `${key} = ${JSON.stringify(written.value)}`
    const saved = await store.save(next, { what, allowPending: true })
    const pendingNote = saved.pending ? '（待配置模式：已保存，其余配置已热应用；填完主人 QQ 后自动连接）' : ''
    if (isSecret) {
      return {
        ok: true, key, secret: true, configured: Boolean(written.stored),
        backup: saved.backup, pending: Boolean(saved.pending),
        message: '已更新（秘密字段不回显）' + pendingNote,
      }
    }
    return { ok: true, key, value: written.value, stored: written.stored, backup: saved.backup, pending: Boolean(saved.pending), message: pendingNote }
  }

  // ── module ─────────────────────────────────────────────────
  async function module(payload = {}) {
    const id = toStr(payload.id)
    if (!id) throw new Error('module 需要 id')
    const known = pluginDefs(kernel).some((p) => p.id === id)
    if (!known) throw new Error(`未知子插件：${id}`)
    const on = payload.on === true
    const raw = store.read()
    const next = clone(raw)
    const hasEnabledField = Boolean(findControl(kernel, `${id}.enabled`))
    if (hasEnabledField) {
      // 常规路径：软开关，插件保持加载、每轮现读 cfg → 立即生效
      writeValue(kernel, `${id}.enabled`, on, next)
    } else if (!on) {
      // 没有 enabled 字段的插件只能走插件级开关：plugins[id] = false 表示下次加载不加载
      setPath(next, ['plugins', id], false)
    }
    // 配置里被内核级禁用过（plugins.<id> = false）的插件：启用时顺手解除，否则 UI 显示"开"但根本没加载
    const hardOff = Boolean(next.plugins && next.plugins[id] === false)
    if (on && hardOff) delete next.plugins[id]
    const saved = await store.save(next, { what: `子插件 ${id} → ${on ? '启用' : '停用'}`, allowPending: true })
    const pendingNote = saved.pending ? '（待配置模式：已保存，其余配置已热应用；填完主人 QQ 后自动连接）' : ''
    const reloadNote = on && hardOff ? '；已解除 plugins.<id>=false（重启 DSH 后真正加载）' : ''
    if (!on && !hasEnabledField) {
      return { ok: true, id, on, backup: saved.backup, pending: Boolean(saved.pending), message: `子插件 ${id} → 停用（重启 DSH 后卸载）${pendingNote}` }
    }
    return { ok: true, id, on, backup: saved.backup, pending: Boolean(saved.pending), message: `子插件 ${id} → ${on ? '启用' : '停用'}（热生效）${reloadNote}${pendingNote}` }
  }

  // ── group（群管控）─────────────────────────────────────────
  const GROUP_KINDS = ['ignore', 'allowlist', 'blocklist', 'keywords', 'spont', 'welcome']
  const GROUP_OPS = ['add', 'remove', 'toggle', 'ensure']

  async function group(payload = {}) {
    const kind = toStr(payload.kind)
    const op = toStr(payload.op)
    if (!GROUP_KINDS.includes(kind)) throw new Error(`未知群管控类型：${kind}（可用：${GROUP_KINDS.join(' / ')}）`)
    if (!GROUP_OPS.includes(op)) throw new Error(`未知操作：${op}（可用：${GROUP_OPS.join(' / ')}）`)
    const isGlobalKw = kind === 'keywords' && String(payload.group_id) === '*'
    const gid = isGlobalKw ? '*' : String(positiveInt(payload.group_id, 'group_id'))
    const raw = store.read()
    const next = clone(raw)
    let detail = ''

    if (kind === 'ignore' || kind === 'spont' || kind === 'welcome') {
      // 群号数组：屏蔽 / 每群主动接话 / 每群入群欢迎
      const dotted = GROUP_PATHS[kind]
      const list = new Set(toNumList(getPath(next, dotted)))
      const gidNum = Number(gid)
      if (op === 'add' || op === 'ensure') list.add(gidNum)
      else if (op === 'remove') list.delete(gidNum)
      else if (op === 'toggle') (list.has(gidNum) ? list.delete(gidNum) : list.add(gidNum))
      setPath(next, dotted, [...list].sort((a, b) => a - b))
      const has = list.has(gidNum)
      detail = kind === 'ignore'
        ? (has ? `已屏蔽群 ${gid}` : `已放行群 ${gid}`)
        : kind === 'spont'
          ? (has ? `群 ${gid} 允许主动接话：开` : `群 ${gid} 允许主动接话：关`)
          : (has ? `群 ${gid} 允许入群欢迎：开` : `群 ${gid} 允许入群欢迎：关`)
    } else if (kind === 'allowlist' || kind === 'blocklist') {
      // 群内名单：{群号:[QQ]}（存对象或文本，按原存法写回）
      const dotted = GROUP_PATHS[kind]
      const currentRaw = getPath(next, dotted)
      const preferObject = isPlainObject(currentRaw)
      const map = parseGroupMap(currentRaw)
      const label = kind === 'blocklist' ? '黑名单' : '白名单'
      const qqs = new Set(map.get(gid) || [])
      if (op === 'ensure') {
        if (!map.has(gid)) map.set(gid, [])
      } else {
        const qq = positiveInt(payload.value, `${label}需要合法 QQ 号`)
        if (op === 'add') qqs.add(qq)
        else if (op === 'remove') qqs.delete(qq)
        else throw new Error(`${label}不支持 toggle；请用 add / remove`)
        if (qqs.size) map.set(gid, [...qqs].sort((a, b) => a - b))
        else map.delete(gid)
      }
      setPath(next, dotted, serializeGroupMap(map, preferObject))
      detail = `${label} ${(map.get(gid) || []).length} 人`
    } else {
      // 唤醒词：兼容全局键 '*'；文本行 / 对象两种存法
      const dotted = keywordConfigPath()
      const currentRaw = getPath(next, dotted)
      const preferObject = isPlainObject(currentRaw)
      const map = parseKeywordMap(currentRaw)
      const words = new Set(map.get(gid) || [])
      if (op === 'ensure') {
        if (!map.has(gid)) map.set(gid, [])
      } else {
        const word = toStr(payload.value)
        if (!word) throw new Error('唤醒词不能为空')
        if (/[\r\n]/.test(word)) throw new Error('唤醒词不能包含换行')
        if (op === 'add') words.add(word)
        else if (op === 'remove') words.delete(word)
        else if (op === 'toggle') (words.has(word) ? words.delete(word) : words.add(word))
        if (words.size) map.set(gid, [...words])
        else map.delete(gid)
      }
      setPath(next, dotted, serializeKeywordMap(map, preferObject))
      const left = map.get(gid) || []
      detail = `唤醒词 ${left.length} 个${gid === '*' ? '（全局）' : `（群 ${gid}）`}`
      if (left.length === 0 && op !== 'ensure') {
        detail += gid === '*' ? '　⚠️ 全局词表空了，群聊只剩 @ 能叫醒' : ''
      }
    }

    // 人设自带的唤醒词：删除改人设文件（wake.txt），否则控制台点了 × 也删不掉（config 里本来就没有）
    if (isGlobalKw && toStr(payload.source) === 'persona') {
      if (op !== 'remove') throw new Error('人设唤醒词只支持删除；要加词请加到 config（不传 source）')
      const word = toStr(payload.value)
      if (!word) throw new Error('唤醒词不能为空')
      removePersonaWakeWord(word)
      const detail = `已从人设文件删除唤醒词「${word}」`
      return { ok: true, kind, op, group_id: '*', source: 'persona', detail, message: detail }
    }

    const saved = await store.save(next, { what: `${kind} ${op} ${gid}${payload.value ? ` ${payload.value}` : ''}`, allowPending: true })
    const pendingNote = saved.pending ? '（待配置模式：已保存，其余配置已热应用；填完主人 QQ 后自动连接）' : ''
    return {
      ok: true, kind, op, group_id: isGlobalKw ? '*' : Number(gid),
      detail, backup: saved.backup, pending: Boolean(saved.pending), message: detail + pendingNote,
    }
  }

  // ── memory（群记忆）──────────────────────────────────────────
  const MEMORY_SECTIONS = ['## 唤醒与对话风格', '## 群里的人', '## 其它']
  const gmCfg = () => pluginCfgRuntime('group-memory')
  /** 单篇读取上限（字节）：控制台保存也按它限制，避免“保存成功但模型读不到尾巴”。 */
  const memoryMaxBytes = () => Math.max(1000, Number(gmCfg().maxBytes) || 24000)
  /** 历史版本保留份数（和积累器共用同一个配置键；控制台手改的 -manual 备份也按它清）。 */
  const memoryRetain = () => Math.max(0, Math.min(200, Number(gmCfg().accumulateRetainRevisions ?? 20)))
  const revisionStamp = () => {
    const iso = new Date().toISOString().replace(/[-:T.]/g, '')
    return `${iso.slice(0, 8)}-${iso.slice(8, 14)}`
  }
  /** 只留某群最近 keep 份（积累器 `<id>-YYYYMMDD-HHmmss[-n].md` + 控制台 `<id>-...-manual.md` 一起算）。 */
  function pruneRevisionsFor(id, keep) {
    if (keep <= 0) return 0
    const revDir = path.join(memoryDir(), '.revisions')
    let names = []
    try { names = fs.readdirSync(revDir) } catch { return 0 }
    const re = new RegExp(`^${id}-(?:\\d{8}-\\d{6}(?:-\\d+)?|\\d{8}-\\d{6}-manual)\\.md$`)
    const entries = names.filter((n) => re.test(n))
      .map((n) => ({ n, at: (() => { try { return fs.statSync(path.join(revDir, n)).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => a.at - b.at || a.n.localeCompare(b.n))
    let removed = 0
    for (const e of entries.slice(0, Math.max(0, entries.length - keep))) {
      try { fs.unlinkSync(path.join(revDir, e.n)); removed += 1 } catch { /* ignore */ }
    }
    return removed
  }

  function memoryDir() {
    const rt = runtimeOf()
    const resolved = resolvedPathOf(pluginCfgRuntime('group-memory').dir)
    if (resolved) return resolved
    const rawDir = String(getPath(store.read(), ['pluginConfig', 'group-memory', 'dir']) || 'qq-memory')
    return resolveDataPath(rawDir, dataDir || kernel?.dataDir || rt?.dataDir || '')
  }

  function memFile(gid) {
    const id = String(gid == null ? '' : gid).trim()
    if (!/^\d{4,12}$/.test(id)) throw new Error(`群号不合法：${JSON.stringify(gid)}`)
    const file = path.join(memoryDir(), `${id}.md`)
    if (!isInsidePath(memoryDir(), file)) throw new Error('记忆文件路径越界')
    return { id, file }
  }

  function memInfo(gid) {
    const { id, file } = memFile(gid)
    try {
      const st = fs.statSync(file)
      const text = fs.readFileSync(file, 'utf8')
      return {
        group_id: id, exists: true, bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        mtimeMs: st.mtimeMs,
        bullets: text.split(/\r?\n/).filter((l) => l.startsWith('- ')).length,
      }
    } catch {
      return { group_id: id, exists: false, bytes: 0, mtime: '', bullets: 0 }
    }
  }

  async function memoryGroupIds(onebotGroupsIn) {
    // 口径（与现网 group-memory 的 discover_groups 一致）：有群线会话的群 ∪ 唤醒词数字键 ∪ 已有文件。
    // ⚠️ 唤醒词键可能是 1–3 位/13+ 位纯数字（不是群号）：必须过滤成 4–12 位，否则 memFile 抛错会整页挂掉。
    const ids = new Set()
    for (const gid of (parseKeywordMap(pluginCfg(store.read(), 'gate-wake').keywords).keys())) {
      if (/^\d{4,12}$/.test(gid)) ids.add(gid)
    }
    const dir = memoryDir()
    try {
      for (const name of fs.readdirSync(dir)) {
        const m = /^(\d{4,12})\.md$/.exec(name)
        if (m) ids.add(m[1])
      }
    } catch { /* 目录还没建 */ }
    const lineGids = new Set(sessionKeysOf(kernel).filter((k) => k.startsWith('group:')).map((k) => String(k).slice(6)))
    const onebotGroups = onebotGroupsIn || await fetchGroupList(kernel)
    for (const g of onebotGroups) if (lineGids.has(g.id)) ids.add(g.id)
    return [...ids].sort((a, b) => Number(a) - Number(b))
  }

  /** 群记忆自动积累的现状：优先内置积累器（插件自带定时器），否则退回 ops provider。 */
  function memoryAccumulateStatus() {
    const fn = kernel?.shared?.memoryAccumulateStatus
    if (typeof fn === 'function') {
      const st = safe(() => fn(), null)
      if (st) return { source: 'builtin', ...st }
    }
    if (hasOps(opsRef, 'memoryAccumulate')) return { source: 'ops', enabled: true, running: false }
    return { source: 'none', enabled: false, running: false }
  }

  function memorySchedule(acc = memoryAccumulateStatus()) {
    if (acc.source === 'builtin') {
      if (!acc.enabled) return { cron: '', text: '自动积累已关闭（可在本页打开「自动积累群记忆」）' }
      const fmt = (ts) => { try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }) } catch { return '' } }
      const modeLabel = acc.mode === 'rewrite' ? '重写全文' : acc.mode === 'per-group' ? '逐群' : '增量要点'
      const parts = [`每 ${acc.intervalHours} 小时`, modeLabel]
      const keep = []
      if (acc.keepDays) keep.push(`${acc.keepDays} 天`)
      if (acc.keepRows) keep.push(`${acc.keepRows} 行`)
      if (keep.length) parts.push(`原始记录保留 ${keep.join(' / ')}`)
      if (acc.running) parts.push('正在积累…')
      if (acc.lastRunAt) parts.push(`上次 ${fmt(acc.lastRunAt)}（${acc.lastResult?.message || '—'}）`)
      if (acc.lastError) parts.push(`⚠️ 上次失败：${String(acc.lastError).slice(0, 120)}`)
      if (acc.nextDueAt) parts.push(`下次约 ${fmt(acc.nextDueAt)}`)
      return { cron: '', text: parts.join(' · '), status: acc }
    }
    if (acc.source === 'ops') return { cron: '', text: '由本机运维能力驱动（ops.memoryAccumulate）', status: acc }
    return { cron: '', text: '（未启用自动积累；可打开「自动积累群记忆」或手动积累）', status: acc }
  }

  function memoryControls(raw) {
    return allControls(kernel)
      .filter((e) => e.kind === 'plugin' && e.plugin === 'group-memory')
      .map((e) => controlPayload(e, raw))
  }

  async function memory(payload = {}) {
    const op = toStr(payload.op) || 'list'
    const raw = store.read()

    if (op === 'list') {
      const accumulate = memoryAccumulateStatus()
      const schedule = memorySchedule(accumulate)
      const dir = memoryDir()
      const onebotGroups = await fetchGroupList(kernel)
      const nameByGid = new Map(onebotGroups.map((g) => [g.id, g.name]))
      const keywordMap = parseKeywordMap(pluginCfg(raw, 'gate-wake').keywords)
      const ids = await memoryGroupIds(onebotGroups)
      const groups = ids.map((id) => ({
        ...memInfo(id),
        name: nameByGid.get(id) || '',
        managed: keywordMap.has(id),
      }))
      return {
        ok: true, op, dir, groups, sections: MEMORY_SECTIONS,
        schedule: schedule.text,
        accumulate,
        estimate: null,
      }
    }

    if (op === 'read') {
      const { id, file } = memFile(payload.group_id)
      let content = ''
      try { content = fs.readFileSync(file, 'utf8') } catch { content = '' }
      return { ok: true, op, ...memInfo(id), content }
    }

    if (op === 'save') {
      const { id, file } = memFile(payload.group_id)
      const content = String(payload.content == null ? '' : payload.content)
      if (!content.trim()) throw new Error('内容不能为空（真要清空请直接删文件）')
      const bytes = Buffer.byteLength(content, 'utf8')
      const limit = memoryMaxBytes()
      if (bytes > limit) {
        throw new Error(`内容 ${bytes} 字节，超过单篇读取上限 ${limit} 字节（超过的部分模型读不到）。请精简，或先在「工具配置」调大 maxBytes。`)
      }
      // 乐观并发：页面读进来后可能积累器已经写过；带 ifMtime 时不匹配就拒绝，避免旧编辑器整篇覆盖新要点。
      const ifMtime = payload.ifMtime == null ? null : Number(payload.ifMtime)
      if (ifMtime != null && Number.isFinite(ifMtime) && fs.existsSync(file)) {
        let cur = 0
        try { cur = fs.statSync(file).mtimeMs } catch { cur = 0 }
        if (cur && Math.abs(cur - ifMtime) > 0.5) {
          throw new Error('这份记忆在你编辑期间已被更新（可能刚积累过），请点「刷新」看清后再保存，避免覆盖新内容')
        }
      }
      const keep = memoryRetain()
      if (fs.existsSync(file) && keep > 0) {
        // 旧版留档：与积累器同一命名/同一保留策略（-manual 后缀也计入 retainRevisions）
        try {
          const revDir = ensureDir(path.join(memoryDir(), '.revisions'))
          let revFile = path.join(revDir, `${id}-${revisionStamp()}-manual.md`)
          for (let i = 1; fs.existsSync(revFile) && i < 100; i += 1) {
            revFile = path.join(revDir, `${id}-${revisionStamp()}-${i}-manual.md`)
          }
          fs.copyFileSync(file, revFile)
          try { fs.chmodSync(revFile, 0o600) } catch { /* Windows 无 chmod 语义 */ }
          pruneRevisionsFor(id, keep)
        } catch (e) { warn(`记忆旧版留档失败 ${id}: ${e.message}`) }
      }
      atomicWriteFileSync(file, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 })
      const missing = MEMORY_SECTIONS.filter((s) => !content.includes(s))
      return {
        ok: true, op, ...memInfo(id),
        message: `已保存 ${bytes} 字节${missing.length ? `　⚠️ 缺少小节：${missing.join('、')}` : ''}`,
      }
    }

    if (op === 'config') {
      return { ok: true, op, controls: memoryControls(raw) }
    }

    if (op === 'setcfg') {
      const key = toStr(payload.key)
      const entry = findControl(kernel, key)
      if (!entry || entry.plugin !== 'group-memory') throw new Error(`不在群记忆配置白名单里：${key}`)
      // dir 是唯一能影响读写的路径键：必须落在 dataDir 内（validateConfig 不校验 pluginConfig，
      // 否则 `../` 可以逃逸到任意目录读写 `<数字>.md`）。
      if (entry.field === 'dir') {
        const dirVal = toStr(payload.value).trim()
        if (dirVal) {
          const target = resolveDataPath(dirVal, dataDirOf())
          if (!isInsidePath(dataDirOf(), target)) throw new Error('记忆目录必须位于数据目录内（不允许 ../ 逃逸）')
        }
      }
      const next = clone(raw)
      const written = writeValue(kernel, key, payload.value, next)
      const saved = await store.save(next, { what: `群记忆配置 ${key} = ${JSON.stringify(written.value)}`, allowPending: true })
      const pendingNote = saved.pending ? '（待配置模式：已保存，其余配置已热应用；填完主人 QQ 后自动连接）' : '（已热重载）'
      return { ok: true, op, key, value: written.value, backup: saved.backup, pending: Boolean(saved.pending), message: `${entry.label} ✓${pendingNote}` }
    }

    if (op === 'refresh') {
      if (payload.confirm !== true) {
        return { ok: true, op, needsConfirm: true, message: '（未执行）「立刻积累一轮」会调用一次大模型，确定吗？' }
      }
      // ① 内置积累器（插件自带调度器）优先；② 退回 ops provider（老部署）
      const builtin = kernel?.shared?.memoryAccumulate
      if (typeof builtin === 'function') {
        const result = await builtin({ ...payload, confirm: true })
        if (result && result.ok === false) return { ok: false, error: result.error || '内置积累器拒绝执行' }
        return {
          ok: true, op, ...(isPlainObject(result) ? result : {}),
          message: result?.message || '已在后台开始积累（过会儿点「刷新」看结果）',
        }
      }
      if (!hasOps(opsRef, 'memoryAccumulate')) {
        return {
          ok: false,
          error: '没有可用的群记忆积累器：请在「群记忆」页打开「自动积累群记忆」，或安装带 ops.memoryAccumulate 的本机运维能力',
        }
      }
      const result = await opsRef.memoryAccumulate({ ...payload, confirm: true })
      if (result == null) return { ok: false, error: '本机群记忆积累器调用失败（详见日志）' }
      return { ok: true, op, ...(isPlainObject(result) ? result : {}), message: result?.message || '已在后台开始积累（过会儿点「刷新」看结果）' }
    }

    throw new Error(`未知记忆操作：${op}（可用：list / read / save / config / setcfg / refresh）`)
  }

  // ── persona（人设）──────────────────────────────────────────
  const PERSONA_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,64}$/

  async function persona(payload = {}) {
    const op = toStr(payload.op) || 'list'
    if (op === 'list') return { ok: true, op, ...personaList() }
    if (op !== 'switch') throw new Error(`未知人设操作：${op}（可用：list / switch）`)
    const name = toStr(payload.name).replace(/\.md$/i, '')
    if (!name || !PERSONA_NAME_RE.test(name) || name.startsWith('.')) throw new Error(`人设名不合法：${JSON.stringify(payload.name)}`)
    const before = personaList()
    if (!before.personas.some((p) => p.name === name)) {
      throw new Error(`没有「${name}」这套人设。现有：${before.personas.map((p) => p.name).join(' / ') || '（人设库为空）'}`)
    }

    let switched
    if (hasOps(opsRef, 'personaSwitch')) {
      const result = await opsRef.personaSwitch(name)
      if (result == null) throw new Error('本机人设切换能力（ops.personaSwitch）调用失败，详见日志')
      if (isPlainObject(result) && result.ok === false) throw new Error(String(result.error || result.message || '本机人设切换失败'))
      switched = isPlainObject(result) ? result : {}
    } else {
      switched = switchPersona({
        workspaceDir: before.workspaceDir || '',
        personaDir: before.dir || '',
        name,
        mode: 'auto',
      })
    }

    // 配置里钉死了 activePersona 的话要同步改，否则面板会一直显示旧人设
    let backup = ''
    const raw = store.read()
    const pinned = toStr(getPath(raw, ['pluginConfig', 'persona-voice', 'activePersona']))
    if (pinned && pinned !== name) {
      const next = clone(raw)
      setPath(next, ['pluginConfig', 'persona-voice', 'activePersona'], name)
      const saved = await store.save(next, { what: `切人设 → ${name}`, allowPending: true })
      backup = saved.backup
    }

    const after = personaList()
    const fallbackMessage = `已切到「${name}」：人设 + 句池一起换 —— 下一条消息生效（不用重置、不丢上下文）`
    return {
      ok: true,
      op,
      name,
      ...switched,
      ...after,
      backup,
      // ops 实现自己的提示优先（可能说明了它额外做了什么）
      message: toStr(switched.message) || fallbackMessage,
    }
  }

  // ── action（动作按钮）────────────────────────────────────────

  const REPLY_PRESETS = {
    quiet: { hourlyMax: 1, minGapMs: 45 * 60000, coldSilenceMs: 20 * 60000, sensitivity: 0.75, maxChars: 100 },
    semi: { hourlyMax: 3, minGapMs: 15 * 60000, coldSilenceMs: 5 * 60000, sensitivity: 0.6, maxChars: 120 },
    active: { hourlyMax: 6, minGapMs: 8 * 60000, coldSilenceMs: 3 * 60000, sensitivity: 0.45, maxChars: 140 },
  }
  const REPLY_PRESET_NAMES = { quiet: '安静', semi: '适中', active: '活泼' }

  async function action(payload = {}) {
    const id = toStr(payload.id)
    if (!id) throw new Error('action 需要 id')
    if (!ACTIONS.some((a) => a.id === id)) throw new Error(`未知动作：${id}`)

    // ── 自己找视频看（按钮长在它自己的配置页）──────────────────
    if (id === 'wander-run-now') {
      const fn = kernel?.shared?.videoWanderRunNow
      if (typeof fn !== 'function') return { ok: false, error: '「自己找视频看」插件没启用（或还没装配）' }
      // 异步：下载 + 抽帧 + 起一轮模型要一两分钟，别让控制台转圈等到超时
      fn('控制台手动触发').catch(() => {})
      return { ok: true, message: '已经让它去看了，去「看视频的地方」会话等一会儿' }
    }

    if (id === 'wander-reset-quota') {
      const fn = kernel?.shared?.videoWanderResetQuota
      if (typeof fn !== 'function') return { ok: false, error: '「自己找视频看」插件没启用（或还没装配）' }
      return fn()
    }

    // ── 空间日记（按钮长在「空间日记」配置页）──────────────────
    if (id === 'qzone-run-now') {
      const fn = kernel?.shared?.qzoneRunNow
      if (typeof fn !== 'function') return { ok: false, error: '空间日记插件没启用（或还没装配）' }
      return fn('控制台手动触发')
    }
    if (id === 'qzone-reset-today') {
      const fn = kernel?.shared?.qzoneResetToday
      if (typeof fn !== 'function') return { ok: false, error: '空间日记插件没启用（或还没装配）' }
      return fn({ preview: !payload.confirm })
    }

    if (id === 'reply-preset') {
      const preset = toStr(payload.preset)
      const p = REPLY_PRESETS[preset]
      if (!p) throw new Error(`未知档位：${payload.preset}（可用：quiet / semi / active）`)
      const raw = store.read()
      const next = clone(raw)
      setPath(next, ['pacing', 'reply', 'enabled'], true)
      for (const [k, v] of Object.entries(p)) setPath(next, ['pacing', 'reply', k], v)
      const saved = await store.save(next, { what: `主动接话档位 → ${preset}`, allowPending: true })
      return {
        ok: true, id, preset, value: p, backup: saved.backup,
        message: `✅ 已切到「${REPLY_PRESET_NAMES[preset]}」档：每小时最多 ${p.hourlyMax} 次`
          + `（两次实际间隔 ≥ ${Math.round(Math.max(p.minGapMs, 3600000 / p.hourlyMax) / 60000)} 分钟）、`
          + `冷场 ${Math.round(p.coldSilenceMs / 60000)} 分钟、敏感度 ${Math.round(p.sensitivity * 100)}%。`,
      }
    }

    if (id === 'reset-session') {
      const chat = toStr(payload.chat)
      if (!/^(group|private):\d{1,12}$/.test(chat)) {
        throw new Error(`reset-session 需要 chat（形如 group:123456 或 private:123456），收到 ${JSON.stringify(payload.chat)}`)
      }
      const sessionId = sessionIdOf(kernel, chat)
      let archived = false
      if (sessionId && typeof kernel?.dsh?.archive === 'function') {
        try {
          await kernel.dsh.archive(sessionId)
          archived = true
        } catch (e) { warn(`归档旧会话失败 (${sessionId}): ${e.message}`) }
      }
      const forget = kernel?.dsh?.forgetSession || kernel?.dsh?.forget || kernel?.dsh?.resetSession
      if (typeof forget === 'function') forget.call(kernel.dsh, chat)
      return {
        ok: true, id, chat, sessionId: sessionId || null, archived,
        message: sessionId
          ? (archived
            ? `✅ 已重置 ${chat} 的对话：旧会话已归档，下一条消息会开新会话。`
            : `⚠️ 已重置 ${chat} 的对话，但旧会话归档失败 —— 它可能仍留在侧栏（原因见内核日志）。`)
          : `✅ ${chat} 本来就没有会话记录（无需重置）。`,
      }
    }

    if (id === 'welcome-images') {
      const dir = resolvedPathOf(pluginCfgRuntime('group-welcome').imageDir || pluginCfg(store.read(), 'group-welcome').imageDir)
      return { ok: true, id, ...listWelcomeImages(dir) }
    }

    if (id === 'welcome-test') {
      const gid = positiveInt(payload.group_id, 'group_id')
      const raw = store.read()
      const wc = pluginCfg(raw, 'group-welcome')
      const mode = wc.mode === 'model' ? 'model' : 'fixed'
      const imageDir = resolvedPathOf(pluginCfgRuntime('group-welcome').imageDir || wc.imageDir)
      const adminQq = Number(getPath(raw, 'adminQq')) || Number(kernel?.adminQq) || 0
      const testQq = positiveInt(payload.user_id || adminQq, '测试用户 QQ（adminQq 未配置时可传 user_id）')
      const wgroups = toStrList(wc.groups)
      const whitelisted = wgroups.includes('*') || wgroups.includes(String(gid))
      if (payload.confirm !== true) {
        const lines = String(wc.lines || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        const sample = (lines.length ? lines[0] : '🎉 欢迎 {name} 加入本群～')
          .replace(/\{(name|qq|group)\}/g, (_m, k) => (k === 'name' ? '示例新人' : k === 'qq' ? String(testQq) : `群${gid}`))
        const img = listWelcomeImages(imageDir)
        return {
          ok: true, id, needsConfirm: true, mode, group_id: gid, user_id: testQq,
          previewLines: [
            ...(wc.enabled === false ? ['⚠️ 总开关是关的：模拟通知会被忽略，先在「入群欢迎」页打开总开关。'] : []),
            ...(whitelisted ? [] : ['⚠️ 这个群还没勾「允许入群欢迎」：模拟通知会被忽略，先去「群聊」页该群卡片勾上。']),
            `向群 ${gid} 模拟一条「新人入群」通知（测试用户 QQ ${testQq}）`,
            mode === 'model'
              ? '当前是模型模式：会走一次真实模型回合，由模型自己发欢迎语（约几秒到几十秒，烧一个回合的 token）。'
              : `当前是固定句池模式：延迟 ${Math.round(Number(wc.delayMs ?? 3))} 秒后随机发一句，例如：${sample}`,
            `图片池：${img.exists && img.count > 0 ? `${img.count} 张，按 ${Math.round(Number(wc.imageChance ?? 100))}% 概率附一张` : '目录不存在/为空（只发文字）'}`,
            '这是**真实发群**：群里会看到欢迎语。仅在测试群或你确认过的群里点。',
          ],
          message: `（未执行）将模拟入群并真实发送到群 ${gid}。`,
        }
      }
      if (typeof kernel?.simulateNotice !== 'function') {
        return { ok: false, error: '内核未暴露 simulateNotice，无法模拟入群通知（请升级/检查内核装配）' }
      }
      await kernel.simulateNotice({
        post_type: 'notice',
        notice_type: 'group_increase',
        sub_type: 'approve',
        group_id: gid,
        user_id: testQq,
        time: Math.floor(Date.now() / 1000),
      })
      return {
        ok: true, id, mode, group_id: gid, user_id: testQq,
        message: `✅ 已模拟入群通知（群 ${gid}，测试用户 ${testQq}，模式 ${mode}）；欢迎语马上发出。`,
      }
    }

    if (id === 'clear-qq-sessions') {
      const keys = sessionKeysOf(kernel)
      if (payload.confirm !== true) {
        return {
          ok: true, id, needsConfirm: true, dryRun: true,
          wouldClearLines: keys.length, wouldArchiveSessions: keys.filter((k) => sessionIdOf(kernel, k)).length,
          previewLines: [
            `将清掉 ${keys.length} 条 QQ 线映射（群 + 私聊）`,
            '并归档这些会话（其中游离会话也会被清掉）',
            '归档只影响侧栏显示、不删文件；但各群与私聊的对话上下文会清空。',
          ],
          message: `（未执行）将清空 ${keys.length} 条 QQ 线映射并归档对应会话。`,
        }
      }
      let result
      if (typeof kernel?.clearAllLines === 'function') {
        result = await kernel.clearAllLines()
      } else {
        // 内核没给聚合方法时自己来：逐条 forget + 尽力归档
        let archived = 0
        for (const key of keys) {
          const sid = sessionIdOf(kernel, key)
          const forget = kernel?.dsh?.forgetSession || kernel?.dsh?.forget || kernel?.dsh?.resetSession
          if (typeof forget === 'function') forget.call(kernel.dsh, key)
          if (sid && typeof kernel?.dsh?.archive === 'function') {
            try { await kernel.dsh.archive(sid); archived += 1 } catch { /* 归档失败只记日志 */ }
          }
        }
        result = { cleared: keys.length, archived }
      }
      const cleared = Number(result?.cleared ?? result?.lines ?? keys.length) || 0
      const archived = Number(result?.archived) || 0
      return {
        ok: true, id, cleared, archived,
        message: `✅ 已清空：${cleared} 条线映射 / 归档 ${archived} 个会话。下一条 QQ 消息会开启一段全新对话。`,
      }
    }

    // ── 新手引导：OneBot 连接自检 / 重连 ────────────────────────
    if (id === 'onebot-check') {
      const result = await checkOneBotNow()
      const ok = result.ok !== false
      const who = result.nickname ? `${result.nickname}${result.selfId ? `（${result.selfId}）` : ''}` : (result.selfId ? `QQ ${result.selfId}` : '')
      const detail = result.latencyMs != null ? `（${result.latencyMs}ms）` : ''
      return {
        ok, id, ...(isPlainObject(result) ? result : {}),
        error: ok ? undefined : (result.error || 'OneBot 未连接'),
        message: ok
          ? `✅ OneBot 连接正常${detail}${who ? `：${who}` : ''}`
          : `OneBot 未连接：${result.error || '未知原因'}`,
      }
    }

    if (id === 'onebot-reconnect') {
      if (typeof kernel?.reconnectNapcat !== 'function') {
        return { ok: false, error: '内核未提供 reconnectNapcat（请升级内核或检查装配）' }
      }
      const health = await kernel.reconnectNapcat()
      const linked = Boolean(health?.linked)
      return {
        ok: true, id, ...(isPlainObject(health) ? health : {}),
        message: linked
          ? '✅ 已重新连接 OneBot'
          : '⚠️ 重连已发起，但当前仍未连接 —— 检查协议端是否启动、WS 地址/token 是否正确（日志里有重连原因）',
      }
    }

    // ── 新手引导：检查生图配置（可选的 GET {base}/models）──────
    if (id === 'imagegen-check') {
      const state = imagegenStateOf(store.read())
      const checks = []
      const protocolOk = ['openai-images', 'openai-chat'].includes(state.protocol)
      checks.push({
        name: '协议', ok: protocolOk,
        hint: protocolOk ? state.protocol : `不支持的协议：${state.protocol || '(空)'}（可用 openai-images / openai-chat）`,
      })
      let urlOk = false
      let urlText = state.baseUrl
      try {
        const u = new URL(state.baseUrl)
        urlOk = u.protocol === 'http:' || u.protocol === 'https:'
        if (urlOk) urlText = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
      } catch { urlOk = false }
      checks.push({
        name: 'API 地址', ok: urlOk,
        hint: urlOk ? urlText : (state.baseUrl ? '不是合法的 http(s) URL（例：https://relay.example/v1）' : '未填写（例：https://relay.example/v1）'),
      })
      checks.push({
        name: '模型', ok: Boolean(state.model),
        hint: state.model ? state.model : '未填写（例：gpt-image-2）',
      })
      const keyCheck = {
        name: 'API Key', ok: state.apiKeySet,
        hint: state.apiKeySet
          ? (state.envOverride.apiKey ? '已由环境变量 QQ_IMAGEGEN_API_KEY 提供' : '已配置（不回显）')
          : '未填写（也可用环境变量 QQ_IMAGEGEN_API_KEY）',
      }
      checks.push(keyCheck)

      let advice = ''
      if (urlOk && state.apiKeySet) {
        const base = state.baseUrl.replace(/\/+$/, '')
        const key = toStr(runtimeOf()?.credentials?.gptImage?.apiKey)
        const init = { method: 'GET', headers: key ? { Authorization: `Bearer ${key}` } : {} }
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(5000)
        try {
          const res = await withTimeout(fetch(`${base}/models`, init), 5500)
          if (res.ok) advice = `✅ GET ${base}/models 成功：地址与凭据可用。`
          else if (res.status === 401 || res.status === 403) {
            keyCheck.ok = false
            advice = `⚠️ 凭据被拒绝（HTTP ${res.status}）：检查 API Key 是否正确/有权限。`
          } else advice = `提示：GET ${base}/models 返回 HTTP ${res.status}（部分中转站不提供该接口；不影响生图，可先保存后直接试一张）。`
        } catch (e) {
          advice = `提示：GET ${base}/models 连不上（${toStr(e?.message) || '超时'}）；部分中转站不提供该接口，可先保存后直接在聊天里试一张。`
        }
      } else {
        advice = '必填项填全后再点一次检查；未配置生图不影响文字聊天。'
      }
      const requiredOk = checks.every((c) => c.ok)
      const failHint = checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.hint}`).join('；')
      return {
        ok: requiredOk, id, checks, advice,
        error: requiredOk ? undefined : `生图配置不完整 —— ${failHint || '见逐项提示'}`,
        message: requiredOk ? (advice || '✅ 生图配置完整') : '生图配置还不完整（见下面逐项提示）',
      }
    }

    // ── 运维：检查 / 创建 QQ 工作区（幂等；插件启动时已自动做一次）──
    if (id === 'ensure-workspace') {
      if (typeof kernel?.ensureQqWorkspace !== 'function') {
        return { ok: false, error: '内核未提供 ensureQqWorkspace（请升级内核或检查装配）' }
      }
      const ws = await kernel.ensureQqWorkspace()
      if (!ws) {
        return { ok: false, id, error: '工作区创建失败（宿主可能没有 workspaceRegistry 服务），详见机器人日志' }
      }
      return {
        ok: true, id, workspace: ws,
        message: `✅ QQ 工作区${ws.created ? '已创建' : '已就绪'}：「${ws.title}」（${ws.path}）`,
      }
    }

    // ── 运维：宿主运行环境自检（「安装即用」：缺什么、怎么补，一次说清）──
    if (id === 'check-host-deps') {
      if (typeof kernel?.checkHostDeps !== 'function') {
        return { ok: false, error: '内核未提供 checkHostDeps（请升级内核或检查装配）' }
      }
      const r = await kernel.checkHostDeps()
      const bad = r.items.filter((it) => it.required && it.ok !== true)
      return {
        ok: r.ok, id, ...r,
        message: r.ok
          ? `✅ 运行环境就绪（${r.items.filter((it) => it.ok === true).length}/${r.items.length} 项通过）`
          : `❌ 缺少必需依赖：${bad.map((it) => it.id).join(', ')} —— 把这份结果交给 DSH，让它按 hint 安装`,
      }
    }

    // ── 运维诊断：检查 + 脱敏报告（永不 throw，落盘失败也给正文）──
    if (id === 'diagnose') {
      return await runDiagnostics({ kernel, store, log })
    }

    // ── 运维动作 → ops provider（没有就明确说“本机未配置”，不是 500）──
    if (id === 'selfcheck') return await runOpsAction('selfcheck', payload, '离线自检')
    if (id === 'cleanup-tmp') return await runOpsAction('cleanup', payload, '清理临时文件')
    if (id === 'dedup-baks') return await runOpsAction('dedup', payload, '备份代际去重')

    throw new Error(`动作未接线：${id}`)
  }

  /** 运维动作统一入口：没配置/调用失败都返回 ok:false + 人话。 */
  async function runOpsAction(name, payload, title) {
    if (!hasOps(opsRef, name)) {
      return { ok: false, error: `本机未配置运维能力（ops.${name}）：${title}需要站点私有实现，见 docs/运维接口.md` }
    }
    const result = await opsRef[name](payload)
    if (result == null) return { ok: false, error: `本机运维能力调用失败（ops.${name}，详见日志）` }
    return { ok: true, ...(isPlainObject(result) ? result : {}) }
  }

  // ── 分发 ───────────────────────────────────────────────────
  const HANDLERS = { schema, status, set, module, group, memory, persona, action }

  /**
   * 分发一个端点调用。**永不 throw**：业务失败 = `{ok:false,error}`（host 把它塞进 value 信封）。
   * @param {string} endpoint
   * @param {object} [payload]
   */
  async function handle(endpoint, payload = {}) {
    const name = toStr(endpoint)
    const fn = HANDLERS[name]
    if (!fn) return { ok: false, error: `未知控制台端点：${name || '(空)'}（可用：${ENDPOINTS.join(' / ')}）` }
    try {
      return await fn(isPlainObject(payload) ? payload : {})
    } catch (e) {
      const message = String(e?.message || e)
      warn(`${name} 失败：${message}`)
      return { ok: false, error: message }
    }
  }

  return {
    handle,
    setOps(next) { opsRef = next || null },
    store,
    get configPath() { return store.configPath },
    endpoints: ENDPOINTS,
    schema,
    status,
    set,
    module,
    group,
    memory,
    persona,
    action,
    // 给测试/调试用的纯函数
    helpers: { parseGroupMap, parseKeywordMap, listWelcomeImages, SECRET_MASK },
  }
}
