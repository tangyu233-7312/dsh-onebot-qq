/**
 * index.js — `dsh-onebot-qq` 的宿主入口（**整条链路唯一的装配处**）。
 *
 * 结构：
 *   协议端 WS 帧 → normalizeEvent → Pipeline(5 阶段) → 决定是否进模型
 *                                          └→ DshDriver.prompt → agent 一轮
 *   agent 调原生工具 → deliver()（唯一出站口：抽 [AT:] → 脱敏 → 插件 decorate → 发 + 留档）
 *
 * 三条架构纪律（改本文件前先读）：
 *   1. **出站只有 deliver() / deliver.media()**。插件拿到的 `bot` 上没有任何裸 send —— 这是结构性的，不是纪律性的。
 *   2. **插件不自带状态**。所有跨轮状态进 ChatState / TurnContext，禁止插件自己开全局 Map。
 *   3. **工具 execute 跑在受限 ctx 上**：必须 `ctx.inject(['tools'], child => ...)` 里注册并用闭包
 *      捕获服务（直接在 apply 的 ctx 上取服务会报 `cannot get property "xxx" without inject`）。
 *
 * 配置唯一真源是 `kernel/config-store.js` 的实例配置；本文件只放 bundle 引导项（dataDir / configPath /
 * autoConnect / compat*），业务配置全部从 `<dataDir>/config.json` 读。
 * 子插件按 `plugins/<id>/index.js` **目录自动发现**（不再有 PLUGIN_IDS 硬编码）。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Service } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { CONTRACT_VERSION, STAGES, withDefaults, createEvent, createTurnContext } from './contracts.js'
import {
  normalizeEvent, buildPromptText, extractText, renderForward, senderNameOf, detectImageMediaType, parseKeywordLines,
} from './kernel/format.js'

import { OneBotAdapter } from './kernel/onebot-adapter.js'
import { ChatState, Pipeline, createDeliver, turnStore } from './kernel/state-pipeline.js'
import { createPacing, REPLY_DEFAULTS } from './kernel/pacing.js'
import { createSelfLog } from './kernel/self-log.js'
import { createDshDriver } from './kernel/dsh-driver.js'
import { startCompatServer } from './kernel/compat-server.js'
import { loadConfig, validateConfig, resolveRuntimePaths, saveConfig } from './kernel/config-store.js'
import { ensureDir, resolveTmpDir, normForCompare } from './platform/paths.js'
import { DEFAULT_PERSONA_NAME, ensureDefaultPersona } from './platform/persona-seed.js'
import { newestVersionOf } from './platform/persona-ref.js'

const require = createRequire(import.meta.url)

/** 包根目录（插件目录 = <包根>/plugins）。 */
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_DIR = path.join(PACKAGE_ROOT, 'plugins')

/** 包版本（控制台/status 显示用；打包形态读不到也不影响运行）。 */
let PACKAGE_VERSION = ''
try { PACKAGE_VERSION = String(require('./package.json')?.version || '') } catch { /* ignore */ }

/** 会话被**彻底清理**（会话目录被删、DSH 里没有这条会话）时，`session/prompt` 报 not-found。 */
function isSessionGone(e) {
  const text = [e?.code, e?.message, e?.details?.reason].filter(Boolean).join(' ')
  return /session\/not-found|session[^\n]{0,20}not[-\s]?found|未知会话|会话不存在/i.test(text)
}

/** 借用 DSH 自带的 sharp 将超长截图（单边 > 8000px）缩到附件限额内；拿不到 sharp 时原样返回。 */
let sharpMod
function getSharp() {
  if (sharpMod !== undefined) return sharpMod
  const candidates = []
  const configured = String(process.env.DSH_QQ_SHARP || '').trim()
  if (configured) candidates.push(configured)
  candidates.push('sharp')
  // DSH 自己装了一份 sharp（dsh 安装目录/node_modules/sharp）：从 dsh 可执行文件路径反推，
  // 避免硬编码安装路径（Linux / Windows / 自定义 prefix 都适用）。
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : ''
    const marker = `${path.sep}@deepseek-ai${path.sep}dsh${path.sep}`
    const at = argv1.indexOf(marker)
    if (at >= 0) candidates.push(path.join(argv1.slice(0, at + marker.length - 1), 'node_modules', 'sharp'))
  } catch { /* 推不出来就只试包名 */ }
  for (const cand of candidates) {
    try { sharpMod = require(cand); break } catch { /* 试下一个 */ }
  }
  if (sharpMod === undefined) sharpMod = null
  return sharpMod
}

async function shrinkImageForModel(buf) {
  const MAX_SIDE = 8000
  const sharp = getSharp()
  if (!sharp) return buf
  try {
    const meta = await sharp(buf, { limitInputPixels: false }).metadata()
    const side = Math.max(Number(meta.width) || 0, Number(meta.height) || 0)
    if (side <= MAX_SIDE) return buf
    const wide = (Number(meta.width) || 0) >= (Number(meta.height) || 0)
    const out = await sharp(buf, { limitInputPixels: false })
      .resize(wide ? { width: MAX_SIDE } : { height: MAX_SIDE })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .toBuffer()
    return out.length && out.length < buf.length ? out : buf
  } catch {
    return buf
  }
}

function logFor(prefix) {
  const tag = `[onebot-qq:${prefix}]`
  return {
    debug: (m) => { if (process.env.QQ_BOT_DEBUG) console.error(`${tag} ${m}`) },
    info: (m) => console.error(`${tag} ${m}`),
    warn: (m) => console.error(`${tag} WARN ${m}`),
    error: (m) => console.error(`${tag} ERROR ${m}`),
  }
}

/** 按聊天窗口归档（JSONL，一行一条）。失败了绝不影响聊天。 */
function makeArchiver(archiveCfg, log) {
  let readyDir = ''
  return (chatKey, rec) => {
    if (!archiveCfg?.enabled) return
    const dir = String(archiveCfg.dir || '')
    if (!dir) return
    try {
      if (readyDir !== dir) { fs.mkdirSync(dir, { recursive: true }); readyDir = dir }
      const [kind, id] = String(chatKey).split(':')
      fs.appendFileSync(path.join(dir, `${kind}_${id}.jsonl`), `${JSON.stringify(rec)}\n`)
    } catch (e) { log.warn(`留档失败: ${e.message}`) }
  }
}

/** 能力服务：外部插件（独立包）可 `inject: ['qqBot']` 拿到受控出站能力。 */
class QqBotService extends Service {
  constructor(ctx, kernel) {
    super(ctx, 'qqBot')
    this.kernel = kernel
  }
  deliver(target, text, opts) { return this.kernel.deliver(target, text, opts) }
  sendMedia(target, cqBody, caption) { return this.kernel.sendMedia(target, cqBody, caption) }
  status() { return this.kernel.status() }
}

export const name = 'dsh-onebot-qq'

/** 没有 tools 就没法注册原生工具；没有 sessionController 就没法在进程内驱动会话。 */
export const inject = ['tools', 'sessionController']

/** bundle 引导配置：只放跨升级保留的少量项，业务配置全在实例 config.json。 */
export const Config = z.object({
  dataDir: z.string().default(''),          // '' = $DSH_HOME/dsh-onebot-qq
  configPath: z.string().default(''),       // '' = <dataDir>/config.json
  autoConnect: z.boolean().default(true),
  compatServer: z.boolean().default(false),
  compatPort: z.number().default(3971),
})

/**
 * 目录自动发现：`readdir(plugins/)` → `import(plugins/<id>/index.js)` → 校验 id/契约 → 按 order 排序。
 * 单个插件 import 失败只记日志（不影响其他插件）；`plugins[id]===false` 的不加载但保留定义。
 * @returns {Promise<Array<{id:string, plugin:object, cfg:object, disabled:boolean}>>}
 */
async function discoverPlugins({ runtime, dataDir, log }) {
  let ids = []
  try {
    ids = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((id) => fs.existsSync(path.join(PLUGINS_DIR, id, 'index.js')))
      .sort()
  } catch (e) {
    log.error(`子插件目录读取失败: ${e.message}`)
    return []
  }
  const found = []
  for (const id of ids) {
    const file = path.join(PLUGINS_DIR, id, 'index.js')
    try {
      const mod = await import(pathToFileURL(file).href)
      const plugin = mod.default
      if (!plugin || typeof plugin !== 'object') throw new Error('没有默认导出的插件对象')
      if (String(plugin.id) !== id) throw new Error(`插件 id=${plugin.id} 与目录名 ${id} 不一致`)
      if (typeof plugin.setup !== 'function') throw new Error('缺少 setup(bot)')
      const cfg = buildPluginCfg(plugin, runtime, dataDir)
      found.push({ id, plugin, cfg, disabled: runtime.plugins?.[id] === false, lastError: null })
    } catch (e) {
      log.error(`插件 ${id} 导入失败（跳过，内核继续运行）: ${e.stack || e.message}`)
    }
  }
  found.sort((a, b) => (Number(a.plugin.order) || 100) - (Number(b.plugin.order) || 100) || a.id.localeCompare(b.id))
  return found
}

/**
 * 单个插件的生效配置：schema 默认值 → 实例配置覆盖 → 相对 dataDir 的路径解析成绝对路径。
 * 内核负责的跨插件约定也在这里落地（gate-wake.adminQq、file-transfer 白名单默认值、
 * pacing.reply.style → 拆条/表情概率同步）。
 */
function buildPluginCfg(plugin, runtime, dataDir) {
  const id = String(plugin.id)
  const merged = withDefaults(plugin.configSchema, runtime.pluginConfig?.[id])
  const cfg = resolveRuntimePaths(merged, dataDir)
  // gate-wake 的 adminQq：实例配置里只有一个权威值（runtime.adminQq）
  if (id === 'gate-wake' && !(Number(cfg.adminQq) > 0)) cfg.adminQq = Number(runtime.adminQq) || 0
  // file-transfer 图片白名单：缺省 = [dataDir, 系统临时目录]（内核注入，插件里不写死任何机器路径）
  if (id === 'file-transfer' && !(Array.isArray(cfg.imageWhitelist) && cfg.imageWhitelist.length)) {
    cfg.imageWhitelist = [dataDir, os.tmpdir()]
  }
  // 回复节奏的「风格」以顶层 pacing.reply.style 为权威（控制台「主动接话」页）；插件字段作 fallback。
  const style = runtime.pacing?.reply?.style
  if (style && typeof style === 'object') {
    if (id === 'persona-voice') {
      if (typeof style.splitEnabled === 'boolean') cfg.splitReplyEnabled = style.splitEnabled
      if (Number(style.splitProbability) >= 0) cfg.splitReplyProbability = Math.round(Number(style.splitProbability) * 100)
      if (Number(style.splitMinLen) > 0) cfg.splitReplyMinLen = Number(style.splitMinLen)
      if (Number(style.splitDelayMs) >= 0) cfg.splitReplyDelayMs = Math.round(Number(style.splitDelayMs) / 1000)
      if (Number(style.splitMaxParts) >= 2) cfg.splitReplyMaxParts = Math.min(4, Math.round(Number(style.splitMaxParts)))
    } else if (id === 'stickers') {
      if (Number(style.stickerProbability) >= 0) cfg.offerPercent = Math.round(Number(style.stickerProbability) * 100)
      // 权威开关在顶层 pacing.reply.style.stickerEnabled：关掉 = 不再提醒模型发表情
      if (style.stickerEnabled === false) cfg.offerPercent = 0
    }
  }
  return cfg
}

/** 原地更新配置对象（保持对象身份：插件 setup 时捕获的 `bot.cfg` 引用继续有效 → 热改立即生效）。 */
function replaceInPlace(target, next) {
  for (const k of Object.keys(target)) {
    if (!(k in next)) delete target[k]
  }
  Object.assign(target, next)
  return target
}

export async function apply(ctx, bundleConfig = {}) {
  // 幂等：同一 fiber 重复 apply 只装一次（单例保护 —— 每条退出路径都要复位，别留半装状态）。
  // ⚠️ 不能直接读写 `ctx.qqBotKernel`：真 Cordis 的 Context 是 Proxy，未在 inject 声明的属性
  //    读/写会抛 `cannot get property "..." without inject`。服务用 ctx.get('qqBot') 查。
  const existing = typeof ctx.get === 'function' ? ctx.get('qqBot') : ctx.qqBotKernel
  // 幂等早退：**不要返回内核对象**（Cordis 会把 apply 的返回值当 effect，非函数即 Invalid effect）
  if (existing) return
  const log = logFor('kernel')

  // ── 1. 实例配置（唯一真源）──────────────────────────────────
  const loaded = loadConfig({
    dataDir: bundleConfig.dataDir,
    configPath: bundleConfig.configPath,
  })
  const { dataDir, configPath } = loaded
  let raw = loaded.raw
  let runtime = loaded.runtime
  // 「待配置模式」：全新安装只有 adminQq 未填（其余都有通用默认值）→ 不拖垮整行激活，
  // 控制台/工具照常可用，等用户在「QQ 控制台 → 新手向导」里填完再自动连接。
  // 其它任何必填项错误仍然直接抛（真正跑不起来的配置不能静默半启动）。
  let configReady = true
  const errors = validateConfig(runtime)
  if (errors.length) {
    const onlyAdminQqMissing = errors.length === 1 && /adminQq/.test(String(errors[0]))
    if (onlyAdminQqMissing) {
      configReady = false
      log.warn('实例配置未完成（缺 adminQq）：已进入**待配置模式** —— 控制台与工具可用、暂不连接 OneBot；'
        + '请在 设置 → QQ 控制台 → 新手向导 里填写「主人 QQ」和 OneBot 协议端地址并保存，配置就绪后会自动连接。'
        + `（配置文件：${configPath}）`)
    } else {
      throw new Error(`QQ 机器人配置未就绪：${errors.join('；')}（配置文件：${configPath}）`)
    }
  }
  if (loaded.created) log.info(`已创建默认实例配置：${configPath}（请到控制台填写 adminQq / OneBot 地址）`)
  if (loaded.migrated) log.warn('检测到旧版配置格式：已按 v2 在内存中迁移；建议用 CLI 的 import-legacy 落盘')

  // ── 2. 子插件发现（import + 配置解析；单个插件坏不拖垮内核）──────
  const discovered = await discoverPlugins({ runtime, dataDir, log })

  // 控制台/CLI 常用的绝对路径（人设目录取已解析的 persona-voice cfg；默认人设模板随包）
  const kernelPaths = {
    dataDir: path.resolve(dataDir),
    workspaceDir: path.resolve(String(runtime.dsh?.qqWorkspacePath || '').trim() || dataDir),
    personaDir: path.resolve(String(discovered.find((d) => d.id === 'persona-voice')?.cfg?.personaDir || '').trim()
      || path.join(dataDir, 'personas')),
    packageRoot: PACKAGE_ROOT,
    defaultPersonaDir: path.join(PACKAGE_ROOT, 'examples', 'personas'),
  }

  // 工作区/session 文件目录必须存在：DSH 每轮 assemble 会 workingDirectory.ensure()，
  // 目录不存在会直接抛 working-directory: directory does not exist（QQ 里只看到「⚠️ 出错了」）。
  try { ensureDir(kernelPaths.workspaceDir) } catch (e) { log.warn(`工作区目录创建失败（${kernelPaths.workspaceDir}）：${e.message}`) }
  try { ensureDir(path.dirname(path.resolve(String(runtime.dsh?.sessionsFile || path.join(dataDir, 'state', 'sessions.json'))))) } catch (e) {
    log.warn(`session 文件目录创建失败：${e.message}`)
  }
  // ── 安装即用：首次启动自动投递内置默认人设（已有投递/已配人设就跳过，不覆盖用户文件）──
  try {
    const pvCfg = runtime.pluginConfig && typeof runtime.pluginConfig === 'object'
      ? runtime.pluginConfig['persona-voice'] : null
    const configuredPersona = pvCfg && typeof pvCfg === 'object' ? String(pvCfg.activePersona || '') : ''
    const seeded = ensureDefaultPersona({
      dataDir: kernelPaths.dataDir,
      personaDir: kernelPaths.personaDir,
      workspaceDir: kernelPaths.workspaceDir,
      examplesDir: kernelPaths.defaultPersonaDir,
      configured: configuredPersona,
    })
    if (seeded.ok) {
      log.info(`已自动投递内置默认人设「${seeded.name}」（${seeded.mode === 'symlink' ? '软链' : '复制'}模式；想换人设见安装说明）`)
      if (!configuredPersona) {
        runtime.pluginConfig = runtime.pluginConfig && typeof runtime.pluginConfig === 'object' ? runtime.pluginConfig : {}
        runtime.pluginConfig['persona-voice'] = { ...(runtime.pluginConfig['persona-voice'] || {}), activePersona: DEFAULT_PERSONA_NAME }
        if (raw && typeof raw === 'object') {
          raw.pluginConfig = raw.pluginConfig && typeof raw.pluginConfig === 'object' ? raw.pluginConfig : {}
          raw.pluginConfig['persona-voice'] = { ...(raw.pluginConfig['persona-voice'] || {}), activePersona: DEFAULT_PERSONA_NAME }
          try { saveConfig(configPath, raw) } catch (e) { log.warn(`默认人设 activePersona 写回失败（下次启动会自动重试）：${e.message}`) }
        }
      }
    } else if (seeded.error) {
      log.warn(`默认人设投递失败：${seeded.error}`)
    }
  } catch (e) {
    log.warn(`默认人设投递失败：${e.message}`)
  }
  // ── 内置 preset「qq-chat」：随包声明（cordis.patch.yml 的 preset-qq-chat 行）──
  // 安装插件即声明；配置里没手动填 preset 时自动启用它（纯聊天 + 联网，已裁掉 shell / 文件工具）。
  // 宿主还没有 agentPresets 服务（启动早期 / 测试夹具）时只把 exists 置 null，不阻断激活。
  const presetStatus = { id: 'qq-chat', exists: null }
  const listPresetIds = async () => {
    const svc = (() => {
      try { return typeof ctx?.get === 'function' ? ctx.get('agentPresets') : null } catch { return null }
    })()
    if (!svc || typeof svc.list !== 'function') return null
    const list = await svc.list()
    return (Array.isArray(list) ? list : [])
      .map((p) => String(p?.id ?? p ?? '')).filter(Boolean)
  }
  async function syncPresetDefault() {
    try {
      const ids = await listPresetIds()
      if (ids === null) { presetStatus.exists = null; return }
      presetStatus.exists = ids.includes(presetStatus.id)
      if (presetStatus.exists && !String(runtime?.dsh?.agentPreset || '').trim()) {
        runtime.dsh.agentPreset = presetStatus.id
        if (raw?.dsh) raw.dsh.agentPreset = presetStatus.id
        log.info(`QQ 线启用内置 preset「${presetStatus.id}」（纯聊天 + 联网；已裁掉 shell / 文件工具）`)
        // 落盘（带 .bak-console 备份）：否则控制台面板读磁盘会显示为空，用户以为没生效
        try { saveConfig(configPath, raw) } catch (e) { log.warn(`写回内置 preset 失败（下次启动会自动重试）: ${e.message}`) }
      }
    } catch (e) {
      presetStatus.exists = null
      log.debug(`preset 探测失败: ${e.message}`)
    }
  }
  await syncPresetDefault()
  // 安全提示：既没配 preset、内置 qq-chat 又不可用 → 会继承 profile 默认工具面（可能含 bash/文件写入）
  if (configReady && !String(runtime.dsh?.agentPreset || '').trim()) {
    log.warn('未配置 dsh.agentPreset 且内置「qq-chat」不可用：QQ 线将使用 DSH profile 的默认 preset'
      + '（工具面可能包含 bash/文件写入等）。请在控制台「DSH 连接」页填一个已存在的 preset。')
  }

  // ── 3. 临时目录（入站图 / 生图快照；用后 best-effort 清理）────────
  const tmpRoot = resolveTmpDir()
  const tmpFiles = new Set()
  const tmp = {
    root: tmpRoot,
    dir: (kind) => resolveTmpDir(String(kind || 'misc')),
    /** 分配一个本次进程专属的临时文件路径（自动登记清理清单）。 */
    file(kind, ext = '') {
      const dir = resolveTmpDir(String(kind || 'misc'))
      const file = path.join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${ext}`)
      tmpFiles.add(file)
      return file
    },
    track(file) {
      if (file) tmpFiles.add(String(file))
      return file
    },
    cleanup() {
      for (const file of tmpFiles) { try { fs.unlinkSync(file) } catch { /* 可能已被清理 */ } }
      tmpFiles.clear()
    },
  }
  // 启动时顺手清掉上次运行留下的老临时图（只清自己目录下、超过 24h 的）
  pruneTmpDirs(['incoming', 'imagegen'], log)

  // ── 4. 适配器 + 状态 + 管线 + 节奏 + 出站 + DSH 驱动 ─────────────
  const imagegenCfg = discovered.find((d) => d.id === 'imagegen')?.cfg
  const avatarDir = String(imagegenCfg?.avatarDir || '').trim() || path.join(dataDir, 'avatars')
  const onebot = new OneBotAdapter({
    ...runtime.onebot,
    log: logFor('onebot'),
    avatarDir,
    avatarCacheHours: Number(imagegenCfg?.avatarCacheHours) > 0 ? Number(imagegenCfg.avatarCacheHours) : 24,
  })
  const state = new ChatState({ log })
  const pipeline = new Pipeline({ log })
  const pacing = createPacing({ log: logFor('pacing'), state })
  pacing.apply(runtime.pacing)
  const archiveCfg = { ...runtime.archive }
  const archive = makeArchiver(archiveCfg, log)
  const greetedSessions = new Set() // sessionId 集合：首轮带 [QQ会话 chatKey｜...]，后续轮只带 [本条消息ID ...]

  const kernel = {
    log, onebot, state, pipeline, pacing, tmp,
    adminQq: Number(runtime.adminQq) || 0,
    configReady,
    version: PACKAGE_VERSION,
    paths: kernelPaths,
    greetedSessions,
    commands: new Map(),
    toolDefs: new Map(),
    outboundHooks: [],
    /** 插件之间共享的能力槽（`bot.linesPool` / `bot.readWakeWords` 走这里）。 */
    shared: Object.create(null),
    plugins: [],
    pluginDefs: [],
    pluginErrors: new Map(),
    activeTurns: new Map(), // chatKey → TurnContext（**正在跑**的那一轮：turn/start → turn/end）
    turnBySession: new Map(), // sessionId → TurnContext（同上；工具执行时按 DSH 会话认线）
    pendingTurns: new Map(), // sessionId → TurnContext[]（prompt 已 admission、等 turn/start 的队列）
    maintSessionIds: new Set(), // 后台任务会话（群记忆积累等）：工具入口只放行 MAINT_ALLOWED_TOOLS（memory_append）
    // 受限会话表：sessionId → { label, tools: Set<toolName> }。
    // 「只做一件事」的系统会话（空间工作区 / 看视频的地方…）都登记在这里，
    // 各有各的一套工具白名单，加新插件不用改内核。
    // （2026-10-29 合并掉原先单独的 deskSessionIds —— 两套做同一件事的机制，
    //   而且 qzone 曾经调过不存在的 core.desk 却没报错，白名单静默失效。）
    scopedSessions: new Map(),
    dataDir,
    configPath,
    archive,
    discovered,
  }
  kernel.tools = kernel.toolDefs // 兼容旧测试面：工具注册表

  // ── 我自己的流水账（跨会话的自我记录，2026-10-30）───────────────
  // 为什么放内核而不是某个插件：所有插件 + 内核自己都要写它，且要能热改配置（保留天数）。
  // 「谁干活谁 append」，读取方是每轮 before-turn 的那一行「我今天的经历」。
  /**
   * 当前生效的人设版本名（2026-10-30 人设版本化）。
   * 唯一真相是 workspace/.persona.json 的 name / 配置里的 activePersona ——
   * 这里只是把它读出来，并**尽量解析成最新一版**（角色 + 日期 + 序号）。
   * 目的：每轮头顶那行「我：角色·版本」让它在任何时候都知道自己是哪一版，
   * 也顺便解决「改了人设没生效」这种查起来最费劲的问题。
   */
  kernel.personaLabel = () => {
    try {
      const directed = path.join(kernelPaths.workspaceDir || runtime.dsh?.qqWorkspacePath || '', '.persona.json')
      let name = ''
      try {
        const p = JSON.parse(fs.readFileSync(directed, 'utf8'))
        name = String(p?.name || '')
      } catch { /* 没有指针文件就往下走 */ }
      if (!name) {
        const pv = runtime.pluginConfig?.['persona-voice']
        name = String(pv?.activePersona || '')
      }
      if (!name) return ''
      // 有同角色的多个日期版本时，取最新那版（控制台存的是角色名而不是带日期的版本名）
      try {
        const dir = path.resolve(String(kernelPaths.personaDir || '') || path.join(dataDir, 'personas'))
        const all = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).map((n) => n.slice(0, -3))
        const newest = newestVersionOf(all, name)
        if (newest) name = newest
      } catch { /* 目录读不到就按文件里的名字 */ }
      return name
    } catch {
      return ''
    }
  }
  kernel.selfLog = createSelfLog({
    dataDir,
    log: logFor('self-log'),
    keepDays: Number(runtime.selfLog?.keepDays) || 14,
  });

  // ── QQ 工作区自举：安装/启动时自动在 DSH 侧栏建一个「QQ 聊天」工作区 ──
  // 路径 = dsh.qqWorkspacePath（默认 <dataDir>/workspace），名称 = dsh.workspaceTitle。
  // 已注册则复用（幂等）；宿主没有 workspaceRegistry 时跳过，会话仍按 cwd 建（不影响收发）。
  // 目标：QQ 会话不再散在侧栏「未分组」，而是固定归到一个专属工作区。
  async function ensureQqWorkspace({ quiet = false } = {}) {
    try {
      const dir = path.resolve(String(runtime.dsh?.qqWorkspacePath || '').trim() || dataDir)
      ensureDir(dir)
      const title = String(runtime.dsh?.workspaceTitle || '').trim() || 'QQ 聊天'
      const registry = (() => {
        try { return typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : null } catch { return null }
      })()
      if (!registry || typeof registry.list !== 'function') {
        if (!quiet) log.warn('宿主未提供 workspaceRegistry：跳过 QQ 工作区创建（会话以 cwd 创建，侧栏不分组）')
        return null
      }
      const want = normForCompare(dir)
      let ws = null
      if (typeof registry.resolveByPath === 'function') {
        try { ws = await registry.resolveByPath(dir) } catch { /* 目录不存在/规范化失败：退回 list 比对 */ }
      }
      if (!ws) ws = [...registry.list()].find((w) => normForCompare(path.resolve(String(w?.path || ''))) === want) || null
      let created = false
      if (!ws) {
        if (typeof registry.create !== 'function') {
          if (!quiet) log.warn('workspaceRegistry 没有 create()：无法创建 QQ 工作区，会话将以 cwd 创建')
          return null
        }
        ws = await registry.create(dir, title)
        created = true
      }
      const info = {
        id: String(ws?.id || ''),
        path: String(ws?.path || dir),
        title: String(ws?.title || title),
        created,
      }
      kernel.qqWorkspace = info
      if (!quiet) log.info(`QQ 工作区${created ? '已创建' : '已就绪'}：「${info.title}」（${info.path}）id=${info.id}`)
      return info
    } catch (e) {
      log.warn(`QQ 工作区准备失败（${e.message}）：QQ 会话仍会以 cwd 创建，不影响收发`)
      return null
    }
  }
  kernel.ensureQqWorkspace = ensureQqWorkspace
  kernel.presetStatus = presetStatus
  await ensureQqWorkspace()

  // ── 出站：唯一实现（deliver + deliver.media） ──────────────────
  const outboundHooks = kernel.outboundHooks
  const deliver = createDeliver({
    onebot, log, adminQq: kernel.adminQq,
    longForward: {
      threshold: runtime.outbound?.longForwardThreshold ?? 400,
      chunkSize: runtime.outbound?.longForwardChunkSize ?? 800,
      nodeName: runtime.outbound?.nodeName ?? '',
    },
    replyMaxLength: runtime.outbound?.replyMaxLength ?? 3000,
    outboundHooks,
    onAfterSend: (rec) => {
      state.markSent(rec.target)
      pacing.noteOutbound(rec.target)
      // 主动接话的统计只认"这一轮真的发了"（普通回话不参合）
      if (rec.turnCtx?.wakeKind === 'proactive') pacing.markProactiveSent(rec.target)
      // 连续对话：普通回话真的发出去了，才从这一刻开始算"隔多久再检查"
      pacing.noteReplySent(rec.target, rec.turnCtx)
      archive(rec.target, { dir: 'out', ts: Date.now(), messageId: rec.messageId ?? null, text: rec.text, mode: rec.mode })
    },
  })
  kernel.deliver = deliver
  // 媒体发送同样走 deliver.media（强制 caption 脱敏 + toWellFormedText + 留档）
  kernel.sendMedia = (target, cqBody, caption = '') => deliver.media(target, cqBody, caption)

  // ── 内置出站钩子①：主动接话轮的硬约束（代码强制，不靠提示词）──
  //   · 不 @、不引用：主动接话不指人、不挂"我在回你"的语义
  //   · 不套长文卡片：群友随口接一句不该甩一张卡片（deliver 认 noForward 字段）
  //   · 一轮发几条：拆条数目在控制台动态修改（`pacing.reply.style.splitMaxParts`），内核不再按固定条数拦
  deliver.onDecorate((out) => {
    const turnCtx = out.turnCtx ?? kernel.activeTurns.get(out.target) ?? null
    const kind = turnCtx?.wakeKind
    // 主动接话 / 连续对话都是"它自己找的话"：默认不指人、不挂引用
    if (!turnCtx || (kind !== 'proactive' && kind !== 'continuation')) return
    // 例外：续聊开了「引用最后一条人类消息」时，只保留这一个引用目标（其余一律清掉）
    const forceQuote = kind === 'continuation' ? (Number(turnCtx._forceReplyTo) || null) : null
    if (out.ats?.length || (out.replyTo != null && out.replyTo !== forceQuote)) {
      log.info(`[主动接话] 丢掉 @/引用（${out.target}）：主动接话不指人、不挂引用`)
    }
    out.ats = []
    out.replyTo = forceQuote
    out.noForward = true
    const maxChars = Number(pacing.config?.reply?.maxChars) || 120
    if (out.text.length > maxChars) {
      log.warn(`[主动接话] 超字数 ${out.text.length}/${maxChars} 字（照发；提示里已要求精简）`)
    }
  })

  // ── 内置出站钩子②：自动引用（锚在 turn/start → turn/end 之间有效，取队首＝正在回的那轮） ──
  deliver.onDecorate((out) => {
    // 只有模型经 send_message 发的回复才自动挂引用。命令 / 答应声 / 冷却 / 生图失败
    // 这些出站没有自己的回合上下文，以前回退 activeTurns 会把引用挂到上一个人身上。
    if (!out.autoQuote) return
    const turnCtx = out.turnCtx ?? null
    // 主动接话/续聊不挂引用（上一道钩子已清掉显式值，这里也不再补）
    if (!turnCtx || turnCtx.wakeKind === 'proactive' || turnCtx.wakeKind === 'continuation') return
    if (out.noReply || out.replyTo != null || out.ats?.length) return
    const need = Number(runtime.outbound?.quoteAfterMsgs ?? 3)
    if (need <= 0) return
    // 锚队列队首 = 正在回的那一轮（turn/start 后才存在，turn/end 就消费掉）
    const q = state.quoteNeed(out.target, need)
    if (q.allow && q.triggerId != null) out.replyTo = q.triggerId
  })

  // ── 受限会话 API ───────────────────────────────────────────────
  // 两个地方都要用：dsh driver（起会话时）和 bot.core（插件登记 / 查询）。
  // 2026-10-29 之前只传给了 driver，**没暴露到 bot.core** ——
  // 结果 qzone 调 core.desk.mark（另一个专用槽）能work，而 video-wander 调的
  // core.scopeOf 一直是 undefined，防递归判断静默失效（永远以为"不在观看会话里"）。
  const scopeApi = {
    /**
     * 通用受限会话：插件给「系统自己用的会话」登记一套工具白名单。
     * 登记后除白名单之外的一切工具都会被拒（连 send_message 都调不到）——
     * 这是「让它在后台干活，但别顺手往群里发东西」的硬约束。
     * @param {string} sessionId DSH 会话 id
     * @param {string} label 排错用的人类可读名（出现在报错里）
     * @param {Iterable<string>} tools 允许的工具名（带不带 mcp 前缀都认）
     */
    markScope: (sessionId, label, tools) => {
      const id = String(sessionId || '')
      if (!id) return
      // 允许传带前缀的名字（mcp__qq__report_watched），统一剥成裸名再存
      const set = new Set([...(tools || [])].map((t) => String(t).replace(/^.*__/, '')).filter(Boolean))
      kernel.scopedSessions.set(id, { label: String(label || id), tools: set })
    },
    clearScope: (sessionId) => kernel.scopedSessions.delete(String(sessionId || '')),
    scopeOf: (sessionId) => kernel.scopedSessions.get(String(sessionId || '')) || null,
  }

  // ── DSH 会话驱动（只保留 in-process） ──────────────────────────
  const dsh = createDshDriver({
    ctx,
    log: logFor('dsh'),
    sessionsFile: runtime.dsh.sessionsFile,
    workspacePath: runtime.dsh.qqWorkspacePath,
    workspaceId: kernel.qqWorkspace?.id || '',
    agentPreset: runtime.dsh.agentPreset,
    state,
    onebot,
    maintSessionIds: kernel.maintSessionIds,
    ...scopeApi,
  })
  kernel.dsh = dsh

  // ── 历史会话归位：升级 / 换数据目录后，旧 session 的 header cwd 可能是旧路径 ──
  // 旧数据目录名（dsh-qq-bot）现在是指向新目录的兼容软链时，attachSession 会按 header cwd 的
  // realpath 校验并允许挂到新工作区；不挂的话这些映射里的旧会话会一直停在侧栏「未分组」。
  async function attachMappedSessionsToQqWorkspace() {
    try {
      const info = kernel.qqWorkspace
      if (!info?.id) return
      const registry = (() => {
        try { return typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : null } catch { return null }
      })()
      const ws = registry?.get?.(info.id)
      if (!ws || typeof ws.attachSession !== 'function') return
      let attached = 0
      for (const [chatKey, sid] of (dsh.sessions || [])) {
        try {
          const before = Array.isArray(ws.sessionIds) ? ws.sessionIds.includes(sid) : true
          await ws.attachSession(sid)
          if (!before) attached += 1
        } catch (e) {
          log.debug(`历史会话挂到 QQ 工作区失败（${chatKey} / ${sid}）：${e.message}`)
        }
      }
      if (attached > 0) log.info(`已把 ${attached} 条历史 QQ 会话挂到「${info.title}」工作区`)
    } catch (e) {
      log.debug(`历史会话归位失败：${e.message}`)
    }
  }
  await attachMappedSessionsToQqWorkspace()

  // ── 取当前 TurnContext（优先 ALS store → 按 DSH 会话 id → 按 target）──
  // ⚠️ 绝不再"兜底取最后一条活跃线"：两条线并发回合时必然认错线
  //    （实测：表情包/生图在别的线回合期间拿错 TurnContext，图会发错群）。
  //    拿不到就返回 null，让需要的工具自己报错让模型重试。
  const turnOfSession = (sessionId) => {
    if (!sessionId) return null
    return kernel.turnBySession.get(String(sessionId)) || null
  }
  const resolveCurrentTurn = (target, sessionId) => {
    const fromStore = turnStore.getStore()
    if (fromStore) return fromStore
    const bySession = turnOfSession(sessionId)
    if (bySession) return bySession
    if (target && kernel.activeTurns.has(String(target))) return kernel.activeTurns.get(String(target))
    return null
  }
  /** 工具执行入口专用：按 DSH 会话 id（exec.agent.session.id）认线，认不出再按模型中给的 target */
  const resolveToolTurn = (exec, target) => resolveCurrentTurn(target, exec?.agent?.session?.id)

  // ── 内核自带的 2 个核心工具：send_message 与 recall ───────────
  kernel.toolDefs.set('send_message', {
    pluginId: 'kernel',
    description:
      '把一条文本消息发到 QQ（群或私聊）。这是给 QQ 用户回话的唯一正确方式：不要在正文里写要发的内容，直接调用本工具。'
      + 'target 用会话开头提示里的 [QQ会话 <target>] 原样传入；引用默认不用你管（内核按回复期间群里插话数自动决定）；'
      + '只在想引用更早的另一条时才传 reply_to（传 0 = 明确不要挂）；内容会被网关强制脱敏并限长。'
      + '提示里出现 `[表情:…]` 时，给本工具加 sticker 参数就能顺手带一张表情包（比单独调 send_sticker 省一步）。',
    parameters: {
      target: { type: 'string', required: true, description: '会话目标，形如 group:123456 或 private:123456' },
      text: { type: 'string', required: true, description: '要发送的纯文本内容' },
      reply_to: { type: 'integer', description: '要引用回复的消息 ID（可选，传 0 明确不挂）' },
      sticker: { type: 'string', description: '顺手带一张表情包：心情/关键词（「无语」「夸人」）或 `#12` 点名；只有提示里出现 [表情:…] 时才传，不传 = 不发' },
    },
    async execute(args = {}) {
      const turnCtx = resolveCurrentTurn(args.target)
      const r = await deliver(args.target, args.text, {
        replyTo: args.reply_to,
        turnCtx,
        // 只有模型显式调 send_message 的回复才由内核自动挂引用（锚已绑定当前 DSH 回合）
        autoQuote: true,
        fromTool: true, // 标记"这是模型写给群里的话"：拆条等加工只认它
      })
      const out = { ok: true, target: r.target, message_id: r.messageId, mode: r.mode, redacted: r.hits }
      // 表情包：正文发完后顺手带一张（插件通过 bot.shared.stickerSend 注册；没装/没开就如实说）
      const wantSticker = String(args.sticker ?? '').trim()
      if (wantSticker) {
        const sendSticker = kernel.shared?.stickerSend
        if (typeof sendSticker !== 'function') out.sticker = { ok: false, reason: '表情包插件未启用（sticker 参数被忽略）' }
        else {
          try { out.sticker = await sendSticker({ target: r.target, query: wantSticker, turnCtx }) }
          catch (e) { out.sticker = { ok: false, reason: e.message } }
        }
      } else if (turnCtx?.stickerOffer && !(Number(turnCtx.stickersSent) > 0) && !(Number(turnCtx.stickerNudged) >= 2)) {
        // 本轮掷骰命中过「可以发一张」但还没发 → 在工具返回里轻推一次（模型一定会读到工具结果）
        turnCtx.stickerNudged = (Number(turnCtx.stickerNudged) || 0) + 1
        const tag = String(turnCtx.stickerOffer.tag || '').trim()
        out.stickerNote = tag
          ? `本轮本来提醒过表情包还没发：下一条 send_message 加 sticker:"${tag}" 就能带一张（不发也行）`
          : '本轮本来提醒过表情包还没发：下一条 send_message 加 sticker:"随便挑" 就能带一张（不发也行）'
      }
      return out
    },
  })

  kernel.toolDefs.set('recall', {
    pluginId: 'kernel',
    description: '撤回一条消息（只支持单条，且只能撤本账号权限内、约 2 分钟内的消息）。',
    parameters: {
      message_id: { type: 'integer', required: true, description: '要撤回的消息 ID' },
    },
    async execute(args = {}) {
      const r = await onebot.recall(args.message_id)
      if (!r?.ok) throw new Error(r?.msg || '撤回失败')
      return { ok: true, message_id: Number(args.message_id) }
    },
  })

  // ── bot 能力对象（每个插件一份，能力由 contracts.js 定义） ────
  const coreOf = () => ({
    contractVersion: CONTRACT_VERSION,
    adminQq: Number(runtime.adminQq) || 0,
    dataDir,
    configPath,
    toolPrefix: String(runtime.toolPrefix || 'mcp__qq__'),
    outbound: runtime.outbound,
    archive: runtime.archive,
    pacing: runtime.pacing,
    credentials: runtime.credentials,
    dsh: runtime.dsh,
    onebot: runtime.onebot,
    compat: runtime.compat,
    keywordTable: kernel.shared.keywordsTable || {},
    tmp,
    // 人设版本化（2026-10-30）：插件要靠它找到人设库、读「现在生效的是哪一版」、切版本
    paths: kernelPaths,
    personaLabel: () => kernel.personaLabel(),
    switchPersona: (name) => {
      const target = String(name || '').trim()
      if (!target) throw new Error('人设名不能为空')
      // 和 bin / 控制台切人设走同一套投递（软链 → 复制降级），权威指针是 workspace/.persona.json
      const r = switchPersona({
        workspaceDir: kernelPaths.workspaceDir,
        personaDir: kernelPaths.personaDir,
        name: target,
        mode: 'auto',
      })
      // 配置里如果**钉死**了 activePersona，它会盖过指针 —— 这种情况不去改配置文件（那是控制台的活），
      // 只回一条 warn，免得用户以为"切了没生效"却查不出原因。
      const pinned = String(runtime.pluginConfig?.['persona-voice']?.activePersona || '').trim()
      if (pinned && pinned !== target) {
        log.warn(`[人设版本] 配置里钉死了 activePersona=${pinned}，可能盖过指针 ${target}；` +
          '要长期生效请到控制台「人设」页切换（它会同步改配置）')
      } else if (!pinned) {
        // 没钉死时顺手把配置也记成目标（和安装时写默认人设同口径），下次重启仍然指向它
        try {
          runtime.pluginConfig['persona-voice'] = {
            ...(runtime.pluginConfig['persona-voice'] || {}),
            activePersona: target,
          }
        } catch (e) {
          log.warn('人设切换后同步内存配置失败：' + e.message)
        }
      }
      return r
    },
    // 插件能登记 / 查询「受限会话」（空间工作区、看视频的地方各自登记自己的工具集）
    ...scopeApi,
  })
  const pluginDisposers = [] // 插件注册的卸载回调（定时器/监听器等），fiber 卸载时逆序执行
  const botProto = {
    get contractVersion() { return CONTRACT_VERSION },
    /** 注册卸载回调（插件启动的定时器/订阅必须走这里，否则重载会叠实例）。 */
    onDispose(fn) {
      if (typeof fn === 'function') pluginDisposers.push(fn)
      return () => {
        const i = pluginDisposers.indexOf(fn)
        if (i >= 0) pluginDisposers.splice(i, 1)
      }
    },
    get selfId() { return onebot.selfId },
    get commands() { return kernel.commands },
    get core() { return coreOf() },
    get credentials() { return runtime.credentials },
    get onebot() {
      // 只读 + 受控动作视图：插件拿不到任何裸 sendMessage/sendForward/sendMedia，只能调受控查询与 poke/recall。
      return {
        get selfId() { return onebot.selfId },
        get selfNickname() { return onebot.selfNickname },
        groupHistory: (...a) => onebot.groupHistory(...a),
        groupList: (...a) => onebot.groupList(...a),
        friendList: (...a) => onebot.friendList(...a),
        memberInfo: (...a) => onebot.memberInfo(...a),
        msgById: (...a) => onebot.msgById(...a),
        getFile: (...a) => onebot.getFile(...a),
        getForwardMsg: (...a) => onebot.getForwardMsg(...a),
        poke: (...a) => onebot.poke(...a),
        recall: (...a) => onebot.recall(...a),
        fetchAvatar: (...a) => onebot.fetchAvatar(...a),
        // QQ 空间说说：不是聊天消息，不经过 deliver（脱敏/留档只针对聊天出站），
        // 但它仍属于受控动作 —— 由内核封装、失败降级，插件拿不到裸 send。
        sendQzoneMsg: (...a) => onebot.sendQzoneMsg(...a),
        callApi: (...a) => onebot.callApi(...a),
        health: () => onebot.health(),
      }
    },
    get dsh() { return dsh },
    /** 我自己的流水账（跨会话）：插件用它记「我今天干了什么」，内核用它拼每轮的一行提示。 */
    get selfLog() { return kernel.selfLog },
    /** 当前生效的人设版本名（人设版本化）：工具回执与每轮头顶那行都用它。 */
    get personaLabel() { return kernel.personaLabel() },
    /** 跨插件共享能力槽（只读视图）：插件把自己的能力挂上来供内核/控制台调用（如 memoryAccumulate）。 */
    get shared() { return kernel.shared },
    /** 回复节奏能力（合批窗口 / 主动接话调度 + 状态）：插件可读 `config`、`stats()` 做控制台/自检 */
    get pacing() { return kernel.pacing },
    get state() { return state },
    on(stage, fn, opts = {}) {
      if (!STAGES.includes(stage)) throw new Error(`未知入站阶段: ${stage}`)
      pipeline.use(stage, fn, { order: opts.order ?? this.__order, pluginId: this.id })
    },
    onOutbound(fn) { return deliver.onDecorate(fn) },
    registerCommand(cmdName, def) { kernel.commands.set(String(cmdName).toLowerCase(), { ...def, pluginId: this.id }) },
    registerTool(toolName, def) { kernel.toolDefs.set(toolName, { ...def, pluginId: this.id }) },
    deliver: (target, text, opts = {}) => deliver(target, text, { turnCtx: resolveCurrentTurn(target), ...opts }),
    sendMedia: (target, cqBody, caption = '') => deliver.media(target, cqBody, caption),
    currentTurn: (target) => resolveCurrentTurn(target),
  }

  // `bot.linesPool` / `bot.readWakeWords` / `bot.linesSource` / `bot.wakeSource` 是插件之间共享的能力，落到 kernel.shared 上
  for (const prop of ['linesPool', 'readWakeWords', 'linesSource', 'wakeSource']) {
    Object.defineProperty(botProto, prop, {
      get() { return kernel.shared[prop] },
      set(v) { kernel.shared[prop] = v },
      configurable: true,
    })
  }

  // ── 加载子插件（逐个 try/catch：一个插件坏了不许拖垮内核） ─────
  for (const entry of discovered) {
    const id = entry.id
    if (entry.disabled) {
      log.info(`插件 ${id}: 已禁用（配置 plugins.${id} = false）`)
      continue
    }
    try {
      const rawCfg = entry.cfg
      const bot = Object.create(botProto)
      bot.id = id
      bot.cfg = rawCfg
      bot.log = logFor(id)
      bot.__order = Number(entry.plugin.order) || 100
      entry.plugin.setup(bot, { credentials: runtime.credentials })
      kernel.plugins.push({ id, plugin: entry.plugin, cfg: rawCfg })
      log.info(`插件 ${id}: 已加载 (enabled=${rawCfg.enabled !== false})`)
    } catch (e) {
      entry.lastError = e
      kernel.pluginErrors.set(id, e)
      log.error(`插件 ${id} 加载失败（内核继续运行）: ${e.stack || e.message}`)
    }
  }
  // 唤醒词表：权威存储是 pluginConfig['gate-wake'].keywords（文本行格式），内核解析后共享给
  // persona-voice（唤醒词来源）与 gate-wake（匹配兜底）。
  const refreshKeywordTable = () => {
    const gw = discovered.find((d) => d.id === 'gate-wake')
    const table = parseKeywordLines(gw?.cfg?.keywords ?? '')
    kernel.shared.keywordsTable = table
    return table
  }
  refreshKeywordTable()

  const refreshPluginDefs = () => {
    const loadedIds = new Set(kernel.plugins.map((p) => p.id))
    kernel.pluginDefs = discovered.map((entry) => ({
      id: entry.id,
      title: String(entry.plugin.title || entry.id),
      order: Number(entry.plugin.order) || 100,
      configSchema: entry.plugin.configSchema || {},
      cfg: entry.cfg,
      disabled: entry.disabled,
      enabled: !entry.disabled && entry.cfg?.enabled !== false,
      loaded: loadedIds.has(entry.id),
      error: entry.lastError ? String(entry.lastError.message || entry.lastError) : null,
    }))
  }
  refreshPluginDefs()

  // ── 内置管线钩子 0：入站留档（passive-tap 阶段，跑在 pre-gate 黑名单之后！） ──
  pipeline.use('passive-tap', (ev) => {
    archive(ev.chatKey, { dir: 'in', ts: ev.time, sender: ev.sender, messageId: ev.messageId, text: ev.text })
  }, { order: 0, pluginId: 'kernel:archive' })

  // ── 内置管线钩子 1：斜杠命令分发（intercept 阶段，order 5 最先跑） ──
  pipeline.use('intercept', async (ev) => {
    if (ev.stopped) return
    const t = String(ev.text || '').trim()
    if (!t.startsWith('/')) return
    const [head, ...rest] = t.slice(1).trim().split(/\s+/)
    const def = kernel.commands.get(String(head || '').toLowerCase())
    if (def) await def.handler(ev, rest)
  }, { order: 5, pluginId: 'kernel:commands' })

  // ── 内置管线钩子 1.5：before-turn 注入「我今天的经历」一行（2026-10-30）──────
  // 这是「跨会话的自我」：DSH 的会话是一条 QQ 线一个，它在家（私聊）不知道自己在群里/看视频的地方
  // 干过什么 —— 于是会出现「唉？已经看了吗？」。这里把它自己的流水账压成一行，每轮都带上。
  //
  // 只给**有唤醒**（真要进模型）的轮加，且只在一轮开头顶一次（ev._scratch 兜底防重复）。
  // 群里只给极简一句（防止它在群里莫名其妙自曝"我早上看了个视频"），私聊给完整一行。
  pipeline.use('before-turn', async (ev) => {
    if (ev.stopped || !ev.wake) return
    if (ev._scratch.selfLogInjected) return
    ev._scratch.selfLogInjected = true
    try {
      const tl = kernel.selfLog?.todayLine?.() || ''
      const me0 = kernel.personaLabel?.() || ''
      if (!tl) {
        // 没有经历也要报"我现在是哪一版"：人设版本化之后，这一行是它认识自己的唯一依据
        if (me0) ev.hint.push('[我：' + me0 + ']')
        return
      }
      const me = kernel.personaLabel?.() || ''
      const who = me ? '[我：' + me + '] ' : ''
      if (ev.isGroup) {
        ev.hint.push(who + '[我自己的事] 你今天还做过这些（跟这个群无关，别主动说出来）：' + tl)
      } else {
        ev.hint.push(who + '[我今天的经历] ' + tl + '（这些是你自己做的，不是在别的地方听到的）')
      }
    } catch (e) {
      log.warn(`注入今日经历失败（不影响本轮）: ${e.message}`)
    }
  }, { order: 90, pluginId: 'kernel:self-log' })

  // ── 内置管线钩子 2：before-turn 补齐群聊增量上文、引用消息与多模态识图缩放 ──────────
  pipeline.use('before-turn', async (ev) => {
    if (ev.stopped || !ev.wake) return
    // 1. 增量群上文（/history 命令已经填过 historyBlock 时不再覆盖）
    const ctxCount = Number(runtime.outbound?.groupContextCount ?? runtime.groupContextCount ?? 5)
    if (ev.isGroup && !ev.historyBlock && ctxCount > 0 && typeof dsh.fetchGroupContext === 'function') {
      try {
        const block = await dsh.fetchGroupContext(ev, ctxCount)
        if (block) ev.historyBlock = block.replace(/^\n+/, '')
      } catch (e) { log.warn(`拉取群上文失败: ${e.message}`) }
    }
    // 2. 引用消息正文与被引图反查（供 buildPromptText 的 quoteText 与识图使用）
    if (ev.replyToId && !ev._scratch.quoteText) {
      try {
        const qMsg = await onebot.msgById(ev.replyToId)
        if (qMsg) {
          const parsed = extractText(qMsg.message ?? qMsg.raw_message ?? '', onebot.selfId)
          const qSender = senderNameOf(qMsg.sender, qMsg.sender?.user_id ?? qMsg.user_id)
          const imgTag = parsed.images?.length ? ` [被引图×${parsed.images.length}]` : ''
          ev._scratch.quoteText = `[${qSender}(QQ:${qMsg.sender?.user_id ?? qMsg.user_id ?? '?'})]: ${parsed.text || '[媒体/富文本]'}${imgTag}`
          if (parsed.images?.length) ev.images.push(...parsed.images)
          // 顺手把被引消息的**原始段**留给插件：文本化之后视频/文件段就没了，
          // 而 video-read 要靠它去抽帧（QQ 里"发视频"和"@它"必然是两条消息，第二条只能引用）。
          // 这里已经调过 msgById，插件不必再打一次同一个接口。
          ev._scratch.replyRawSegments = Array.isArray(qMsg.message) ? qMsg.message : []
        }
      } catch { /* 引用反查失败不阻塞本轮 */ }
    }
    // 2.5 合并转发：正文要在这一步再取一次（get_forward_msg）。
    // 只在**这条消息真要进模型**（ev.wake 已有）时取，避免给每条消息都打接口。
    //
    // ⚠️ 关键：QQ 里「发转发」和「@它」**必然是两条消息**（客户端限制），第二条只能引用第一条。
    //    before-turn 跑在"@它"那条上，它的 _scratch.forwards 是空的 —— 转发 id 在被引消息里。
    //    所以这里必须**反查一次被引消息**把 forwards 挖出来。这跟 video-read 拿被引视频同构。
    // forwards 现在是 [{ id, content }]：content 是协议端在 get_msg 里已经内联好的转发正文
    // （真机上 get_forward_msg(id) 常直接失败："消息已过期或者为内层消息"，所以内联才是主路径）
    let fwdItems = Array.isArray(ev._scratch?.forwards) ? ev._scratch.forwards : []
    if (ev.wake && !fwdItems.length && ev.replyToId) {
      try {
        const qMsg = await onebot.msgById(ev.replyToId)
        const qParsed = qMsg ? extractText(qMsg.message ?? qMsg.raw_message ?? '', onebot.selfId) : null
        if (qParsed?.forwards?.length) fwdItems = qParsed.forwards
      } catch (e) {
        log.debug(`反查被引消息失败（不影响本轮）: ${e.message}`)
      }
    }
    if (ev.wake && fwdItems.length) {
      const parts = []
      for (const item of fwdItems.slice(0, 2)) {   // 一条消息最多两条转发
        // ① 先用已经内联好的正文（主路径，省一次接口且更可靠）
        let rendered = renderForward(Array.isArray(item?.content) ? { content: item.content } : null)
        // ② 内联没有才回退请求（有些来源确实只给 id）
        if (!rendered && item?.id) {
          try {
            const fwd = await onebot.getForwardMsg(item.id)
            rendered = fwd ? renderForward(fwd) : ''
          } catch (e) {
            log.warn(`取合并转发失败（id=${item.id}）: ${e.message}`)
          }
        }
        parts.push(rendered || '（这条转发的内容取不到）')
      }
      if (parts.length) ev.hint.push(`[合并转发内容（原文，按条分隔）]\n${parts.join('\n---\n')}`)
    }

    // 3. 入站图片（含被引图）三级溯源下载 → sharp 缩图(≤8000px) → 填 ev.imageParts & ev.imagePaths
    if (Array.isArray(ev.images) && ev.images.length && !ev.imageParts.length) {
      for (const im of ev.images) {
        const file = String(im?.file || '')
        const url = String(im?.url || '')
        if (!file && !url) continue
        try {
          let buf = null
          if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
            buf = fs.readFileSync(file)
          } else if (file && typeof onebot.getFile === 'function') {
            const info = await onebot.getFile(file)
            if (info?.file && fs.existsSync(info.file) && fs.statSync(info.file).isFile()) {
              buf = fs.readFileSync(info.file)
            } else if (info?.url && /^https?:\/\//.test(info.url)) {
              const r = await fetch(info.url, { signal: AbortSignal.timeout(15000) })
              if (r.ok) buf = Buffer.from(await r.arrayBuffer())
            }
          }
          if (!buf && /^https?:\/\//.test(url)) {
            const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
            if (r.ok) buf = Buffer.from(await r.arrayBuffer())
          }
          if (!buf || !buf.length) continue
          buf = await shrinkImageForModel(buf)
          const mediaType = detectImageMediaType(buf)
          ev.imageParts.push({ mediaType, data: buf.toString('base64'), name: 'qq-image' })
          const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/gif' ? 'gif' : mediaType === 'image/webp' ? 'webp' : 'jpg'
          const tmpPath = tmp.file('incoming', `.${ext}`)
          fs.writeFileSync(tmpPath, buf)
          ev.imagePaths.push(tmpPath)
        } catch (e) {
          log.warn(`入站图片处理失败: ${e.message}`)
        }
      }
    }
  }, { order: 50, pluginId: 'kernel:context' })

  // ── 原生工具注册：必须 inject 后再注册（受限 ctx 的坑，见文件头纪律 3） ──
  // 后台任务（群记忆积累）允许调用的工具白名单：只有「提交结果」型的 memory_append。
  // 这样后台会话能结构化提交数据，但调不到 send_message / 生图 / bash 等（防误发、防乱动系统）。
  const MAINT_ALLOWED_TOOLS = new Set(['memory_append'])
  const prefix = String(runtime.toolPrefix || 'mcp__qq__')
  ctx.inject(['tools'], (child) => {
    const tools = child.tools
    for (const [toolName, def] of kernel.toolDefs) {
      try {
        tools.register(defineTool({
          name: `${prefix}${toolName}`,
          description: def.description,
          parameters: def.parameters ?? {},
          output: {
            // DSH JSON Schema 子集要求 object 根必须显式声明 additionalProperties: true/false
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          },
          async execute(args, exec) {
            // 工具守卫（两道）：
            // ① 后台任务会话（群记忆积累等）只允许 memory_append（提交群记忆要点），其它工具一律拒；
            // ② memory_append 反过来只允许后台任务会话调，普通 QQ 会话调不到（不让它顺手改记忆）。
            const sid = String(exec?.agent?.session?.id || '')
            const isMaint = kernel.maintSessionIds.has(sid)
            // 受限会话（见 coreOf().markScope）：白名单之外一律拒。
            // 空间工作区、看视频的地方都走这一条，各自登记自己的工具集。
            const scope = kernel.scopedSessions.get(sid)
            if (scope && !scope.tools.has(toolName)) {
              throw new Error('「' + scope.label + '」只允许调用 ' + [...scope.tools].join(' / ') + '（这里不能调用 ' + toolName + '）')
            }
            if (isMaint && !MAINT_ALLOWED_TOOLS.has(toolName)) {
              throw new Error(`后台任务只允许调用 ${[...MAINT_ALLOWED_TOOLS].join('/')}（提交群记忆要点），不要调用其它工具`)
            }
            if (!isMaint && MAINT_ALLOWED_TOOLS.has(toolName)) {
              throw new Error('这个工具只能由后台任务调用（普通会话不需要）')
            }
            const turnCtx = resolveToolTurn(exec, args?.target)
            // 会话认出来了就以"本轮会话"为准：模型把 target 写错（或从旧上文抄来）时别发错群。
            let callArgs = args
            if (turnCtx?.chatKey && args && typeof args === 'object' && typeof args.target === 'string'
              && args.target !== turnCtx.chatKey) {
              log.warn(`[工具] ${toolName} 的 target=${args.target} 与本次会话 ${turnCtx.chatKey} 不一致 → 按会话纠正`)
              callArgs = { ...args, target: turnCtx.chatKey }
            }
            return turnStore.run(turnCtx, () => def.execute(callArgs, exec))
          },
        }))
      } catch (e) {
        log.error(`注册工具 ${toolName} 失败: ${e.message}`)
      }
    }
    log.info(`已注册 ${kernel.toolDefs.size} 个原生工具（前缀 ${prefix}）`)
  })

  // ── 轮次上下文：绑定到 DSH 的 turn/start → turn/end ─────────
  // ⚠️ `sessionController.prompt()` 只是 **admission**（内部是 agent.followup），模型真正
  //    开始跑是之后的事。所以：
  //    · prompt 提交后先放 pendingTurns（等 turn/start）；
  //    · turn/start 才把这一轮挂到 turnBySession / activeTurns（工具执行时按它认轮）；
  //    · turn/end 才清上下文 + 消费引用锚（旧桥接 consumeTrigger 的语义）。
  //    以前在 runTurn.finally（admission 时）就 pop 锚/清映射，回复发出时只能猜"最后一轮"，
  //    这正是引用引错人的根因。
  const ACTIVE_TURN_TTL_MS = 5 * 60000
  const activeTurnTimers = new Map()
  // 会话 id → TurnContext：工具 execute 拿到的 exec.agent.session.id 就是它。
  const turnSessionTimers = new Map()
  const holdTurnSession = (sessionId, turnCtx) => {
    if (!sessionId) return
    const key = String(sessionId)
    kernel.turnBySession.set(key, turnCtx)
    const old = turnSessionTimers.get(key)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => {
      if (kernel.turnBySession.get(key) === turnCtx) kernel.turnBySession.delete(key)
      turnSessionTimers.delete(key)
    }, ACTIVE_TURN_TTL_MS)
    timer.unref?.()
    turnSessionTimers.set(key, timer)
  }
  const holdActiveTurn = (chatKey, turnCtx) => {
    kernel.activeTurns.set(chatKey, turnCtx)
    const old = activeTurnTimers.get(chatKey)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => {
      if (kernel.activeTurns.get(chatKey) === turnCtx) kernel.activeTurns.delete(chatKey)
      activeTurnTimers.delete(chatKey)
    }, ACTIVE_TURN_TTL_MS)
    timer.unref?.()
    activeTurnTimers.set(chatKey, timer)
  }

  // ── DSH 回合与引用锚的绑定 ──────────────────────────────────
  const boundTurnHooks = new Set()
  const pushPendingTurn = (sessionId, turnCtx) => {
    const key = String(sessionId || '')
    if (!key) return
    const q = kernel.pendingTurns.get(key) || []
    q.push(turnCtx)
    kernel.pendingTurns.set(key, q)
  }
  const removePendingTurn = (sessionId, turnCtx) => {
    const key = String(sessionId || '')
    const q = kernel.pendingTurns.get(key)
    if (!q) return
    const i = q.indexOf(turnCtx)
    if (i >= 0) q.splice(i, 1)
    if (!q.length) kernel.pendingTurns.delete(key)
  }
  const hasPendingTurn = (chatKey) => {
    for (const q of kernel.pendingTurns.values()) {
      for (const t of q) if (String(t.chatKey) === String(chatKey)) return true
    }
    return false
  }
  function bindTurnHooks(sessionId) {
    const key = String(sessionId || '')
    if (!key || boundTurnHooks.has(key)) return
    boundTurnHooks.add(key)
    dsh.onTurnStart(key, () => startPendingTurn(key))
    dsh.onTurnEnd(key, () => finishRunningTurn(key))
  }
  function startPendingTurn(sessionId) {
    const key = String(sessionId || '')
    const q = kernel.pendingTurns.get(key)
    const turnCtx = q?.shift()
    if (q && !q.length) kernel.pendingTurns.delete(key)
    if (!turnCtx) {
      log.debug(`turn/start 没有待启动的 QQ 回合 (${key})`)
      return
    }
    turnCtx._turnStarted = true
    holdTurnSession(key, turnCtx)
    holdActiveTurn(turnCtx.chatKey, turnCtx)
    log.debug(`turn/start 绑定 ${key} → ${turnCtx.chatKey}#${turnCtx.triggerMsgId ?? '-'}`)
  }
  function finishRunningTurn(sessionId) {
    const key = String(sessionId || '')
    const turnCtx = kernel.turnBySession.get(key) || null
    if (turnCtx) {
      if (kernel.turnBySession.get(key) === turnCtx) kernel.turnBySession.delete(key)
      if (kernel.activeTurns.get(turnCtx.chatKey) === turnCtx) kernel.activeTurns.delete(turnCtx.chatKey)
      // 一轮真正结束才消费锚：一轮发多条也只消费一次
      if (turnCtx._hasAnchor) state.consumeTurnAnchor(turnCtx.chatKey, turnCtx.triggerMsgId)
      log.debug(`turn/end 清理 ${key} → ${turnCtx.chatKey}#${turnCtx.triggerMsgId ?? '-'}`)
    }
    const st = turnSessionTimers.get(key)
    if (st) { clearTimeout(st); turnSessionTimers.delete(key) }
    if (turnCtx) {
      const at = activeTurnTimers.get(turnCtx.chatKey)
      if (at) { clearTimeout(at); activeTurnTimers.delete(turnCtx.chatKey) }
    }
  }

  // ── 入站：一条消息走完全部阶段，末端交给 agent ───────────────
  const runTurn = async (ev) => {
    if (!ev.wake) return
    // 第二道防线：chatKey 必须是 group:<数字> / private:<数字>。异常事件（如无身份的 notice）
    // 曾造出 `private:undefined` 会话；到这里一律丢弃并留一行错误日志，绝不建会话。
    if (!/^(group|private):\d{1,12}$/.test(String(ev.chatKey || ''))) {
      const notice = ev._scratch?.notice
      log.error(`丢弃非法 chatKey 的入站：chatKey=${JSON.stringify(ev.chatKey)}`
        + `${notice ? ` notice=${notice.type}/${notice.subType}` : ''}（不建会话、不进模型）`)
      return
    }
    // Pipeline.run 已经创建了 ev.turnCtx 并放入 turnStore
    const turnCtx = ev.turnCtx
    // 连续对话的起点：只有"真人唤醒"才会登记链（pacing 内部还会再按 wake.kind 过滤一次）
    pacing.noteWake(ev)
    turnCtx.quoteAfterMsgs = Number(runtime.outbound?.quoteAfterMsgs ?? 3)
    // 引用锚：入站事件自带 message_id，记下来；活到这一轮的 DSH turn/end
    turnCtx._hasAnchor = ev.wake.kind !== 'proactive' && ev.wake.kind !== 'continuation'
    // 2026-10-30：给"这一轮是谁起的"一个**机器可读**的标记，别让工具去猜。
    //   _wakeKind：合成轮（主动接话/续聊）才有的旧标记；
    //   _triggeredBy：'master' = 主人发的消息触发的；'other' = 群友/系统触发的。
    // 踩过的坑：只认 _wakeKind 时，主人正常说话触发的轮它是空的，
    // 工具就把"主人叫它看"当成"它自己起念"，吃了自己的冷却。
    turnCtx._triggeredBy = ev.sender?.isMaster === true ? 'master' : 'other'
    turnCtx._turnStarted = false
    if (turnCtx._hasAnchor) state.markTurnAnchor(ev.chatKey, ev.messageId)

    let sessionId = ''
    try {
      sessionId = await dsh.ensureSession(ev.chatKey, ev.sender?.name || '')
      const makePrompt = (sid) => buildPromptText(ev, {
        greeted: greetedSessions.has(sid),
        quoteText: ev._scratch.quoteText || '',
        fileHint: ev._scratch.fileHint || '',
      })
      const submit = async (sid) => {
        turnCtx.sessionId = sid
        turnCtx.promptText = makePrompt(sid)
        // 2026-10-30：上一轮工具（watch_now）攒下的画面，这一轮挂上。
        // 取空即毁 —— 只给一轮，之后不会每轮都重发同一批帧。
        if (Array.isArray(turnCtx.nextImageParts) && turnCtx.nextImageParts.length) {
          const pending = turnCtx.nextImageParts.splice(0, turnCtx.nextImageParts.length)
          ev.imageParts.push(...pending)
          log.info(`[看视频] 本轮挂上 ${pending.length} 帧（上一轮自己看的）`)
        }
        bindTurnHooks(sid)
        pushPendingTurn(sid, turnCtx)
        await dsh.prompt(sid, turnCtx.promptText, ev.imageParts)
      }
      try {
        await submit(sessionId)
      } catch (e) {
        // 会话被彻底清理（删了会话目录）→ 映射已失效：删映射、建新会话、重试一次
        if (!isSessionGone(e) || typeof dsh.forgetSession !== 'function') throw e
        log.warn(`会话 ${sessionId} 已不存在（可能被彻底清理），删映射重建后重试 (${ev.chatKey})`)
        removePendingTurn(sessionId, turnCtx)
        dsh.forgetSession(ev.chatKey)
        sessionId = await dsh.ensureSession(ev.chatKey, ev.sender?.name || '')
        await submit(sessionId)
      }
      greetedSessions.add(sessionId)
      dsh.syncSessionTitles?.().catch(() => {})
      log.debug(`turn 已提交 ${ev.chatKey} → ${sessionId}`)
    } catch (e) {
      // prompt 没提交成功：这一轮不会发生，清掉 pending + 锚（还没到 turn/start）
      if (!turnCtx._turnStarted) {
        removePendingTurn(sessionId, turnCtx)
        if (turnCtx._hasAnchor) state.consumeTurnAnchor(ev.chatKey, ev.messageId)
      }
      log.error(`提交 agent 失败 (${ev.chatKey}): ${e.message}`)
      // 兜底也必须走 deliver（强制脱敏 + 留档）—— 根治旧实现错误裸发漏脱敏的 bug！
      // 主动接话轮是"自己找话"，出错时**静默**（群里没人在等它，别突然冒一句「出错了」）。
      if (ev._scratch?.silentFailure) log.warn(`[主动接话] 本轮失败（已静默）: ${e.message}`)
      else await deliver(ev.chatKey, `⚠️ 出错了: ${e.message}`, { turnCtx }).catch(() => {})
    }
    // ⚠️ 不能在 finally 里 pop 锚/清上下文：prompt admission 时模型还没跑，
    //    真正的清理在 turn/end 回调（finishRunningTurn）。
  }

  // ── 主动接话：没入站也能起一轮候选（走正规管线语义，出站不 @ 不引用由 decorate 钩子硬挡） ──
  const runProactiveTurn = async ({ chatKey, groupId, reason, humanMsgs, quoteTo, isGroup }) => {
    const isContinuation = reason === 'continuation'
    // 群聊 / 私聊都走这里：isGroup 由 pacing 传下来，
    // 缺省时按 chatKey 前缀推断（老的调用点只传 chatKey/groupId）
    const groupChat = isGroup != null ? !!isGroup : String(chatKey).startsWith('group:')
    const isPrivateChat = !groupChat
    const ev = createEvent({
      chatKey,
      isGroup: groupChat,
      groupId: groupChat ? groupId : null,
      messageId: null,
      // 主动轮的触发不是「某个人发的消息」，两种场景都不挂说话人前缀；
      // 私聊仍带上对方 QQ，让门禁 / 人设插件能认出「这是谁」，而不是一个匿名 0
      sender: { qq: isPrivateChat ? (Number(String(chatKey).slice(8)) || 0) : 0, name: '', card: null, isMaster: false },
      text: '', time: Date.now(),
    })
    ev.wake = { kind: isContinuation ? 'continuation' : 'proactive', reason }
    if (isPrivateChat) ev.wake.chatType = 'private'
    ev._scratch.silentFailure = true
    // 合成轮的口径由这里**统一给**（format.js 只留一个极简标签，不再重复写一遍）。
    // 文案本身**不写死**：默认值在 pacing.js 的 REPLY_DEFAULTS.prompts，
    // 控制台「主动接话 → 提示词（可改）」六个框随便改（{n} 会替换成新消息条数）。
    const P = { ...REPLY_DEFAULTS.prompts, ...(runtime.pacing?.reply?.prompts || {}) }
    const fill = (tpl) => String(tpl || '').replace(/\{n\}/g, String(Number(humanMsgs) || 0)).trim()
    const tailPrompt = fill(isPrivateChat ? P.tailPrivate : P.tailGroup)
    ev.hint.push(isContinuation
      ? fill(isPrivateChat ? P.privateContinuation : P.groupContinuation)
      : isPrivateChat
        ? fill(P.private)
        : reason === 'silence'
          ? fill(P.group)
          : fill(P.group))
    // 收尾提醒交给 format.js 贴到最后一行（合成轮才有；普通回话仍是那句通用的）
    if (tailPrompt) ev._tail = tailPrompt
    // 私聊没有「群上文」可拉（协议端也没有私聊历史接口）：上下文来自 DSH 会话本身，
    // 所以这里只对群拉上文，私聊直接跳过，别去调一个必然失败的接口。
    const ctxCount = Number(runtime.outbound?.groupContextCount ?? runtime.groupContextCount ?? 5)
    if (groupChat && ctxCount > 0 && typeof dsh.fetchGroupContext === 'function') {
      try {
        const block = await dsh.fetchGroupContext(ev, ctxCount)
        if (block) ev.historyBlock = block.replace(/^\n+/, '')
      } catch (e) { log.warn(`[主动接话] 拉取群上文失败: ${e.message}`) }
    }
    ev.turnCtx = createTurnContext(ev)
    // 2026-10-30：给工具留一个"这一轮是谁起的"的标记。
    // watch_video 靠它区分「它自己起的念头（占额度）」和「主人叫的（不占额度）——
    // 不给这个标记，工具只能一律当"对话里自己看"，就会出现
    // 「自己看了 2 个、主人叫了 1 个，可额度显示 3/7」的矛盾。
    ev.turnCtx._wakeKind = ev.wake?.kind || 'proactive'
    // 2026-10-30：「在当前对话里真的看视频」用。
    // 工具（watch_now）在调用时把抽好的帧 push 到这里，下一轮 prompt 时由内核取走挂上 ——
    // 这样它是在**自己的会话**里看到画面，而不是被另一个会话代看、再转述给它。
    ev.turnCtx.nextImageParts = []
    // 续聊可选「引用最后一条人类消息」：把目标 message_id 带进本轮，出站钩子①会用它（其它轮一律清掉）
    if (isContinuation && quoteTo) ev.turnCtx._forceReplyTo = Number(quoteTo) || null
    holdActiveTurn(chatKey, ev.turnCtx)
    log.info(`[${isContinuation ? '连续对话' : '主动接话'}] ${chatKey} 候选入站（${isContinuation ? '续聊检查' : isPrivateChat ? '私聊冷场' : reason === 'silence' ? '冷场找话' : '话题合适'}）→ 交模型判断接不接`)
    return turnStore.run(ev.turnCtx, () => state.serialize(ev.chatKey, () => runTurn(ev)))
  }
  pacing.start({
    onProactiveTurn: runProactiveTurn,
    isBusy: (chatKey) => kernel.activeTurns.has(String(chatKey)) || hasPendingTurn(String(chatKey)),
    // 私聊主动接话的「只对好友开口」：好友名单走白名单视图
    friendList: () => onebot.friendList(),
  })

  // 冷场判据的"起点"：开机时把每个允许主动接话的群的**最后一条消息时间**播种进 ChatState。
  // 否则重启后必须等群里有人说话才会进入冷场判定 —— 而"一直没人说话"恰恰是冷场要找话的情况。
  const seedProactiveBaseline = async () => {
    const groups = pacing.allowedGroupIds?.() ?? []
    for (const gid of groups) {
      try {
        const msgs = await onebot.groupHistory(gid, 1)
        const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null
        if (!last) continue
        const ts = Number(last.time) * 1000 || Date.now()
        state.get(`group:${gid}`).lastInboundAt = ts
        log.info(`[主动接话] 播种 ${gid}：最后一条消息 ${Math.round((Date.now() - ts) / 60000)} 分钟前`)
      } catch (e) {
        log.debug(`[主动接话] 播种失败 ${gid}: ${e.message}`)
      }
    }

    // ── 私聊播种（2026-10-30）──────────────────────────────
    // 之前只播种了群：重启后 private 会话的 ChatState 是空的（lastInboundAt=0），
    // tickPrivateSilence 的判据 `now - lastTouch >= coldMs` 直接 continue ——
    // 表现就是「重启后它永远不主动私聊我，直到我先发一条消息」。
    // 私聊没有历史接口，基线从留档推；连留档都没有就按开机时间起算（别一开机就冒出来）。
    const privateQqs = pacing.allowedPrivateQqs?.() ?? []
    if (privateQqs.length) {
      const archRaw = String(runtime.archive?.dir || 'logs/qq_chat')
      const archDir = path.isAbsolute(archRaw) ? archRaw : path.join(dataDir, archRaw)
      // 匹配 private_<QQ>.jsonl 或 private_<QQ>.jsonl.<分片号>
      const fileRe = (qq) => new RegExp('^private_' + qq + '[.]jsonl([.]\\d+)?$')
      for (const qq of privateQqs) {
        try {
          let ts = 0
          let from = ''
          let names = []
          try { names = fs.readdirSync(archDir).filter((n) => fileRe(qq).test(n)) } catch { /* 没有留档目录 */ }
          for (const n of names) {
            const rows = fs.readFileSync(path.join(archDir, n), 'utf8').split('\n')
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              const s = rows[i].trim()
              if (!s) continue
              try {
                const r = JSON.parse(s)
                const t0 = Number(r && r.ts) || 0
                if (t0 > ts) ts = t0
              } catch { /* 坏行跳过 */ }
              break
            }
          }
          if (ts) from = '留档'
          if (!ts) { ts = Date.now(); from = '无历史，按开机起算' }
          const st = state.get('private:' + qq)
          if (!Number(st.lastInboundAt)) st.lastInboundAt = ts
          log.info('[主动接话] 播种 private:' + qq + '：' + from + '，' + Math.round((Date.now() - ts) / 60000) + ' 分钟前')
        } catch (e) {
          log.debug('[主动接话] 播种私聊失败 ' + qq + ': ' + e.message)
        }
      }
    }
  }
  seedProactiveBaseline().catch(() => {})
  kernel.seedProactiveBaseline = seedProactiveBaseline

  onebot.onEvent(async (raw) => {
    const t0 = Date.now()
    let ev
    try {
      ev = normalizeEvent(raw, onebot.selfId, kernel.adminQq)
    } catch (e) {
      log.warn(`事件归一失败: ${e.message}`)
      return
    }
    if (!ev) return

    // 同群"本轮期间又插了几条"——出站要靠它决定要不要自动挂引用。
    // ⚠️ 只对真正的消息算：notice（入群/戳一戳…）没有 messageId，算进去会把未答复锚 +1、
    //    让下一轮误挂引用，也会刷新"群活跃"时间干扰主动接话。
    const isNoticeEvent = Boolean(ev._scratch?.notice)
    if (!isNoticeEvent) {
      pacing.noteInbound(ev)
      state.countArrival(ev.chatKey, ev.messageId)
      const active = kernel.activeTurns.get(ev.chatKey)
      if (active && ev.messageId !== active.triggerMsgId) active.arrivedDuringTurn += 1
      // 已 admission、还没 turn/start 的回合也要计数（它们还没被提升到 activeTurns）
      for (const q of kernel.pendingTurns.values()) {
        for (const t of q) {
          if (String(t.chatKey) === String(ev.chatKey) && ev.messageId !== t.triggerMsgId) t.arrivedDuringTurn += 1
        }
      }
    }

    try {
      // 静默合批：同群几百毫秒内的多条唤醒并成一轮（主动接话轮不进来）
      await pipeline.run(ev, (wokenEv) => pacing.submit(wokenEv, (e) => state.serialize(e.chatKey, () => runTurn(e))))
      // 没唤醒的群消息 → 交给主动接话：到点了就按语境挑时机（有 wake 的不进来，避免被叫时同时抢话）
      if (!ev.wake && !ev.stopped) pacing.consider(ev)
    } catch (e) {
      log.error(`入站处理异常 (${ev.chatKey}): ${e.stack || e.message}`)
    } finally {
      log.debug(`入站 ${ev.chatKey} 用时 ${Date.now() - t0}ms wake=${ev.wake?.kind ?? 'none'} stopped=${ev.stopped}`)
    }
  })

  // ── 健康快照 ─────────────────────────────────────────────────
  kernel.status = () => ({
    contractVersion: CONTRACT_VERSION,
    onebot: onebot.health(),
    dsh: dsh.health(),
    plugins: kernel.pluginDefs.map((p) => ({
      id: p.id, title: p.title, order: p.order, enabled: p.enabled, loaded: p.loaded, lastError: p.error,
    })),
    tools: [...kernel.toolDefs.keys()].map((k) => `${prefix}${k}`),
    commands: [...kernel.commands.keys()],
    proactive: pacing.stats(),
    config: { dataDir, configPath, toolPrefix: prefix, adminQq: kernel.adminQq, configReady, version: PACKAGE_VERSION },
  })

  // ── 控制面（admin/host.js 由工作流 B 提供；未就绪时只记 TODO，不挡内核） ──
  let adminHost = null
  const ADMIN_TODO = '控制面未就绪（admin/host.js 尚未提供）'
  try {
    const mod = await import('./admin/host.js')
    if (typeof mod.createAdminHost === 'function') {
      const host = await mod.createAdminHost({ ctx, kernel, configPath, dataDir, log: logFor('admin') })
      if (typeof host === 'function') adminHost = { dispose: host }
      else if (host && typeof host === 'object') adminHost = host
      if (adminHost) log.info('控制面已挂载（/qq-console RPC）')
    } else {
      log.warn(`admin/host.js 没有导出 createAdminHost（${ADMIN_TODO}）`)
    }
  } catch (e) {
    const isMissing = e?.code === 'ERR_MODULE_NOT_FOUND' && /admin[\\/]host\.js/.test(String(e.message))
    if (isMissing) log.warn(`[控制面] admin/host.js 尚未就绪（TODO：待控制面工作流提供）— RPC 控制台暂不可用`)
    else log.error(`[控制面] admin/host.js 加载失败: ${e.message}`)
  }
  // 与控制面契约一致：业务失败返回 {ok:false,error}，不 throw（compat-server / 测试直调都吃这个形状）
  const adminHandle = async (endpoint, payload) => {
    if (!adminHost?.handle) return { ok: false, error: ADMIN_TODO }
    try { return await adminHost.handle(endpoint, payload) } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  // 兼容旧内部形态（同步取 schema / 读值 / 写值）：控制面就绪时直接复用它的实现
  kernel.adminSchema = () => (
    adminHost?.api?.schema ? adminHost.api.schema() : { ok: false, error: ADMIN_TODO }
  )
  kernel.adminRead = () => {
    if (!adminHost?.api?.schema) return { ok: false, error: ADMIN_TODO }
    const schema = adminHost.api.schema() || {}
    return Object.fromEntries((schema.controls || []).map((c) => [c.key, c.value]))
  }
  kernel.adminWrite = (key, value) => {
    if (!adminHost?.handle) throw new Error(ADMIN_TODO)
    return adminHost.handle('set', { key, value })
  }
  kernel.handleAdminRpc = adminHandle

  // ── 配置热重载（控制台写盘后调用；插件每轮回读 bot.cfg，所以原地同步即可） ──
  /**
   * 应用一份新配置。
   * 两种情形：
   *   · 配置完整 → 正常热应用，configReady=true；若此前是待配置模式则自动连接一次。
   *   · **只缺 adminQq**（新手先填协议端地址、后填主人 QQ 的中间态）→ 进入/保持待配置模式：
   *     其余配置（协议端地址/token、生图凭据、节奏…）**照常热应用**（否则「测试 OneBot 连接」会用旧地址），
   *     但 configReady=false、不自动连接；返回 `{ok:true,pending:true,...}` 而不是抛错。
   *     其它必填错误仍然抛。
   */
  const applyRuntimeConfigValue = async (next, nextRaw, { allowPending = true } = {}) => {
    const errs = validateConfig(next)
    const pending = errs.length > 0 && allowPending && errs.length === 1 && /adminQq/.test(String(errs[0]))
    if (errs.length && !pending) throw new Error('QQ 机器人配置校验失败：' + errs.join('；'))
    const wasReady = configReady
    configReady = !pending
    kernel.configReady = configReady
    if (pending) {
      log.warn('配置仍缺 adminQq：已先热应用其余配置（待配置模式），暂不连接 OneBot 协议端；'
        + '填好主人 QQ 后保存会自动连接。')
    }
    runtime = next
    if (nextRaw !== undefined) raw = nextRaw
    // 配置里没写 preset（或被清空）时，若内置 qq-chat 可用就自动补上（幂等）
    await syncPresetDefault()
    kernel.adminQq = Number(runtime.adminQq) || 0
    // 子插件配置原地同步（保持对象身份 → 插件 setup 时捕获的 bot.cfg 引用继续有效）
    for (const entry of discovered) {
      const nextCfg = buildPluginCfg(entry.plugin, runtime, dataDir)
      replaceInPlace(entry.cfg, nextCfg)
    }
    refreshKeywordTable()
    refreshPluginDefs()
    pacing.apply(runtime.pacing)
    deliver.configure({
      adminQq: kernel.adminQq,
      longForward: {
        threshold: runtime.outbound?.longForwardThreshold ?? 400,
        chunkSize: runtime.outbound?.longForwardChunkSize ?? 800,
        nodeName: runtime.outbound?.nodeName ?? '',
      },
      replyMaxLength: runtime.outbound?.replyMaxLength ?? 3000,
    })
    replaceInPlace(archiveCfg, runtime.archive || {})
    onebot.applyConfig?.(runtime.onebot)
    // 工作区路径/名称可能被改过：按新值创建或复用（幂等），再让驱动绑到它
    const wsInfo = await ensureQqWorkspace({ quiet: true })
    await dsh.applyConfig?.({
      sessionsFile: runtime.dsh.sessionsFile,
      workspacePath: runtime.dsh.qqWorkspacePath,
      workspaceId: wsInfo?.id || kernel.qqWorkspace?.id || '',
      agentPreset: runtime.dsh.agentPreset,
    })
    // 路径快照同步（人设目录可能被控制台改过；其余项随 dataDir/配置派生）
    kernel.paths = {
      ...kernel.paths,
      workspaceDir: path.resolve(String(runtime.dsh?.qqWorkspacePath || '').trim() || dataDir),
      personaDir: path.resolve(String(discovered.find((d) => d.id === 'persona-voice')?.cfg?.personaDir || '').trim()
        || path.join(dataDir, 'personas')),
    }
    // 首次配置完成（待配置模式 → 已就绪）：按 bundle 引导项自动连接一次；失败只警告，控制台可手动重连
    if (!pending && !wasReady && bundleConfig.autoConnect !== false) {
      onebot.connect().catch((e) => log.warn(`配置就绪后自动连接协议端失败（可在控制台点「重新连接 OneBot」）: ${e.message}`))
    }
    return {
      ok: true,
      configReady,
      pending,
      ...(pending ? { pendingErrors: errs } : {}),
      adminQq: kernel.adminQq,
      plugins: kernel.pluginDefs.map((p) => ({ id: p.id, enabled: p.enabled, loaded: p.loaded })),
    }
  }
  /**
   * 控制台写盘后热应用：传 runtime 对象则直接用它（raw 快照按 runtime 近似）；
   * 不传/传的就是当前 runtime → 重新读盘（拿最新 raw + runtime）。
   */
  kernel.applyRuntimeConfig = async (nextRuntime) => {
    const useGiven = nextRuntime && nextRuntime !== runtime && nextRuntime.onebot && nextRuntime.adminQq !== undefined
    if (useGiven) return applyRuntimeConfigValue(nextRuntime, deepClone(nextRuntime))
    const reloaded = loadConfig({ dataDir: bundleConfig.dataDir, configPath: bundleConfig.configPath, createIfMissing: false })
    return applyRuntimeConfigValue(reloaded.runtime, reloaded.raw)
  }
  kernel.reloadConfig = async () => {
    const result = await kernel.applyRuntimeConfig()
    return { ok: true, configPath, dataDir, ...result }
  }
  Object.defineProperties(kernel, {
    runtime: { get: () => runtime, configurable: true },
    raw: { get: () => raw, configurable: true },
    archiveConfig: { get: () => archiveCfg, configurable: true },
  })

  // ── 控制台 action 端点会用的辅助能力 ─────────────────────────
  kernel.clearAllLines = async () => {
    const keys = [...dsh.sessions.keys()]
    let archived = 0
    for (const key of keys) {
      const sid = dsh.forgetSession(key)
      if (!sid) continue
      try { await dsh.archive(sid); archived += 1 } catch (e) { log.warn(`归档会话失败 (${sid}): ${e.message}`) }
    }
    return { cleared: keys.length, archived }
  }
  /** 控制台「测试入群欢迎」：把合成通知喂给所有入站订阅者（走真实管线，出站仍走 deliver）。 */
  kernel.simulateNotice = async (rawEvent) => {
    const handlers = [...(onebot.handlers || [])]
    return Promise.all(handlers.map((h) => h(rawEvent)))
  }
  kernel.reconnectNapcat = async () => {
    try { onebot.close() } catch { /* 已断开 */ }
    await onebot.connect()
    return onebot.health()
  }
  /**
   * 控制台「测试 OneBot 连接」：未连接直接给出原因；已连接用 `get_login_info` 实测一次（5s 超时），
   * 顺便刷新 selfId / 昵称。**不 throw**（端点契约要求业务失败返回 {ok:false,error}）。
   * @returns {Promise<{ok:boolean, linked:boolean, stale:boolean, lastFrameAgoMs:number|null,
   *   selfId:number|null, nickname:string|null, latencyMs?:number, error?:string}>}
   */
  kernel.checkOneBot = async () => {
    const t0 = Date.now()
    // 先主动查一次登录状态：协议端 WS 连着但 QQ 掉线时，只有 get_login_info 能发现
    const login = await onebot.checkLogin?.({ force: true }).catch((e) => ({ ok: null, error: e?.message || String(e) }))
    const health = onebot.health?.() || {}
    const base = {
      ok: false,
      linked: !!health.linked,
      stale: !!health.stale,
      lastFrameAgoMs: health.lastFrameAgoMs ?? null,
      selfId: onebot.selfId ?? null,
      nickname: onebot.selfNickname ?? null,
      qqLoggedIn: health.qqLoggedIn ?? null,
      qqLoginCheckedAt: health.qqLoginCheckedAt ?? null,
      qqLoginError: health.qqLoginError || '',
    }
    if (!base.linked) return { ...base, error: 'OneBot 未连接' }
    if (health.qqLoggedIn === false) {
      return {
        ...base,
        ok: false,
        error: `QQ 未登录或已掉线：${health.qqLoginError || login?.error || '协议端未返回登录账号'}`,
        latencyMs: Date.now() - t0,
      }
    }
    if (health.qqLoggedIn !== true) {
      return { ...base, ok: false, error: `无法确认 QQ 登录状态：${login?.error || health.qqLoginError || 'get_login_info 未返回账号'}`, latencyMs: Date.now() - t0 }
    }
    return { ...base, ok: true, linked: true, latencyMs: Date.now() - t0 }
  }

  /**
   * 检查配置的 agent preset 在宿主里是否存在（运维诊断/DSH 侧自检用）。
   * 读 `runtime.dsh.agentPreset`（每次现取，控制台改完热重载后自动生效）；
   * 宿主没有 agentPresets 服务时返回 exists:null 的提示，**不 throw**。
   * @returns {Promise<{ok:boolean, mode:'default'|'explicit', name:string,
   *   exists:boolean|null, presets:string[], detail:string}>}
   */
  kernel.checkAgentPreset = async () => {
    const name = String(runtime?.dsh?.agentPreset || '').trim()
    if (!name) {
      return { ok: true, mode: 'default', name: '', exists: true, presets: [], detail: '未指定 preset，使用 DSH 默认' }
    }
    const ids = await listPresetIds().catch(() => null)
    if (ids === null) {
      return { ok: true, mode: 'explicit', name, exists: null, presets: [], detail: '宿主未提供 agentPresets 服务，无法校验存在性' }
    }
    const exists = ids.includes(name)
    return {
      ok: exists,
      mode: 'explicit',
      name,
      exists,
      presets: ids.slice(0, 20),
      detail: exists
        ? `preset "${name}" 存在`
        : `preset "${name}" 不存在（可用：${ids.slice(0, 10).join(', ') || '无'}）`,
    }
  }

  /**
   * 宿主运行环境自检（「安装即用」用）：一次列出装好以后到底缺什么，每项带人话修复建议。
   * 控制台「运维 → 🧪 检查运行环境」、CLI doctor、给 DSH 的安装说明都读这个结果。
   * **永不 throw**：拿不到的项按 `ok:null`/`ok:false` 记，不打断插件。
   * @returns {Promise<{ok:boolean, items:Array<{id:string,ok:boolean|null,required:boolean,
   *   detail:string,hint:string}>, env:{node:string,dataDir:string,configPath:string}}>}
   */
  kernel.checkHostDeps = async () => {
    const getSvc = (name) => {
      try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
    }
    const items = []
    const add = (id, ok, required, detail, hint) => items.push({ id, ok, required, detail, hint })
    /** 宿主服务项：detail 只给「已就绪 / 宿主未提供」，怎么做进 hint。 */
    const need = (id, required, hint) => {
      const ok = Boolean(getSvc(id))
      add(id, ok, required, ok ? '已就绪' : '宿主未提供', hint)
    }

    // ① 必需：会话驱动与工具面（dsh-base 提供）
    need('sessionController', true, 'DSH 核心服务；缺少 = DSH 版本过低或 profile 没加载 dsh-base（升级 DSH ≥ 0.2.1-rc.2）')
    // tools 是 ctx 上的属性服务（不走 ctx.get），单独判
    add('tools', Boolean(ctx?.tools), true, ctx?.tools ? '已就绪' : '宿主未提供',
      '原生 qq 工具注册面；缺少则模型看不到 mcp__qq__*（profile 加载 dsh-base 后重启 DSH）')
    // ② 可选：工作区 / preset 注册表（决定「单开工作区」「纯聊天 preset」是否生效）
    need('workspaceRegistry', false, '缺少只影响会话归组，收发不受影响（profile 加 @deepseek-ai/dsh-workspace）')
    need('agentPresets', false, '缺少 = 内置纯聊天 preset 不生效（profile 加 @deepseek-ai/dsh-agent-preset-registry）')

    // ③ 插件自己的自举结果
    const presetIds = await listPresetIds().catch(() => null)
    const builtinOk = presetIds ? presetIds.includes(presetStatus.id) : null
    add('preset:qq-chat', builtinOk, false,
      builtinOk === null ? '无法校验（宿主无 agentPresets）' : builtinOk ? '已注册' : '未注册',
      builtinOk === false
        ? '确认插件按 bundle 安装（cordis.patch.yml 被应用），否则手动合并 examples/presets/qq-chat.patch.yml 后重启'
        : '内置纯聊天 preset（纯聊天 + 联网，裁掉 shell / 文件工具）')
    add('qqWorkspace', Boolean(kernel.qqWorkspace?.id), false,
      kernel.qqWorkspace ? `${kernel.qqWorkspace.title}（${kernel.qqWorkspace.path}）` : '未创建',
      kernel.qqWorkspace ? 'QQ 聊天工作区，QQ 会话都归这里' : '点控制台「运维 → 📁 检查 / 创建 QQ 工作区」；仍失败看日志')

    // ④ 数据目录可写（装好即用最容易踩的权限/杀软坑）
    try {
      const probe = path.join(dataDir, `.probe-${process.pid}-${Date.now()}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      add('dataDirWritable', true, true, dataDir, '配置/留档/人设都写在这里')
    } catch (e) {
      add('dataDirWritable', false, true, `不可写：${e.message}`, '换一个可写目录（bundle config.dataDir）或用管理员权限运行')
    }

    return {
      ok: !items.some((it) => it.required && it.ok !== true),
      items,
      env: { node: process.version, dataDir, configPath, packageVersion: PACKAGE_VERSION || '' },
    }
  }

  // ── 可选兼容网关 / 连接 ──────────────────────────────────────
  const compat = bundleConfig.compatServer === true
    ? startCompatServer({
        port: Number(bundleConfig.compatPort) > 0 ? Number(bundleConfig.compatPort) : 3971,
        kernel,
        log: logFor('compat'),
        imageRoots: [...(runtime.compat?.imageRoots || []), resolveTmpDir('incoming'), resolveTmpDir('imagegen')],
      })
    : null
  if (configReady && bundleConfig.autoConnect !== false) {
    onebot.connect().catch((e) => log.error(`OneBot 连接失败: ${e.message}`))
  } else if (!configReady) {
    log.warn('待配置模式：已跳过协议端自动连接（填完 adminQq / 协议端地址后自动连接，或在控制台手动重连）')
  }

  // ── 能力服务（可选；外部插件 inject: ['qqBot'] 用） ─────────
  try {
    ctx.plugin(QqBotService, kernel)
  } catch (e) {
    log.warn(`qqBot 服务注册跳过: ${e.message}`)
  }

  // fiber 卸载时按逆序回收（单例保护的铁律：每条退出路径都要复位）。
  ctx.effect(() => () => {
    for (const fn of pluginDisposers.splice(0).reverse()) {
      try { fn() } catch (e) { log.warn(`插件卸载回调异常: ${e.message}`) }
    }
    try { adminHost?.dispose?.() } catch { /* ignore */ }
    try { compat?.close() } catch { /* ignore */ }
    try { pacing.stop() } catch { /* ignore */ }
    try { onebot.close() } catch { /* ignore */ }
    try { dsh.close?.() } catch { /* ignore */ }
    tmp.cleanup()
    kernel.activeTurns.clear()
    kernel.turnBySession.clear()
    kernel.pendingTurns.clear()
    boundTurnHooks.clear()
    log.info('已卸载')
  })

  log.info(`内核就绪（契约 v${CONTRACT_VERSION}，插件 ${kernel.plugins.length}/${discovered.length}，工具 ${kernel.toolDefs.size}，`
    + `命令 ${kernel.commands.size}，版本 ${PACKAGE_VERSION || '?'}，配置${configReady ? '已就绪' : '待配置'}）`)
  // ⚠️ 不返回任何值：Cordis 会把 apply 的返回值当 effect 处理，返回普通对象会抛 `Invalid effect`。
  //    内核对象已通过 `ctx.plugin(QqBotService, kernel)` 服务 + 闭包暴露给控制面。
}

/** 深拷贝（只用于只读快照 raw；配置里不会有函数/循环引用）。 */
function deepClone(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch { return value }
}

/** 清理本包自己的临时目录里超过 maxAgeMs 的残留文件（best-effort，只删文件）。 */
function pruneTmpDirs(kinds, log, maxAgeMs = 24 * 3600 * 1000) {
  for (const kind of kinds) {
    let dir
    try { dir = resolveTmpDir(kind) } catch { continue }
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const st = fs.statSync(file)
        if (st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(file)
      } catch { /* 别的进程正在用/已删 */ }
    }
    log.debug(`临时目录已清理: ${dir}`)
  }
}
