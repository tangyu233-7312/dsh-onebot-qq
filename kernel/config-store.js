/**
 * kernel/config-store.js — **实例配置的唯一真源**（读 / 校验 / 迁移 / 原子写 / 路径解析）。
 *
 * 分层：
 *   · bundle Config（profile patch）：只放引导项 dataDir / configPath / autoConnect / compat*；
 *   · 实例 config.json（本文件）：全部业务配置，控制台改的就是它；
 *   · 环境变量：凭据覆盖（QQ_IMAGEGEN_*）；
 *   · 数据目录：所有相对路径相对 dataDir 解析（跨平台，Windows 可用）。
 *
 * 配置格式 v2：
 *   {
 *     "version": 2,
 *     "adminQq": 123456,                       // 必填（无默认）
 *     "onebot": { wsUrl, wsToken, httpUrl, httpToken },
 *     "dsh": { agentPreset, qqWorkspacePath, sessionsFile },
 *     "outbound": { replyMaxLength, longForwardThreshold, longForwardChunkSize, quoteAfterMsgs },
 *     "archive": { enabled, dir },
 *     "toolPrefix": "mcp__qq__",
 *     "plugins": { "<id>": false },            // 子插件总开关
 *     "pluginConfig": { "<id>": { ... } },     // 子插件配置（与各自 configSchema 对齐）
 *     "pacing": { reply: {...}, merge: {...} },
 *     "credentials": { gptImage: { baseUrl, apiKey, model } },
 *     "compat": { imageRoots: [] }
 *   }
 *
 * 兼容：读取到旧版（含 `bridge` 段）配置时自动迁移（in-memory），`bin import-legacy` 可落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataDir, resolveDataPath } from '../platform/paths.js'
import { readJsonFile, writeJsonFileSync, backupFileSync, atomicWriteFileSync } from '../platform/atomic.js'

export const CONFIG_VERSION = 2

/** 不含任何私有值的默认配置（adminQq = 0 表示未配置，激活时会明确报错）。 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    adminQq: 0,
    onebot: {
      wsUrl: 'ws://127.0.0.1:3001',
      wsToken: '',
      httpUrl: 'http://127.0.0.1:3000',
      httpToken: '',
      // 媒体（图片/文件）发送超时与重试：大文件/慢中转站要放宽，默认贴近旧行为
      mediaSendTimeoutMs: 180000,
      mediaSendRetries: 0,
    },
    dsh: {
      // 随包声明的内置 preset（cordis.patch.yml 里的 preset-qq-chat）：
      // 纯聊天 + 联网，裁掉 shell / 文件 / 任务 / 技能 / 插件管理类工具。
      agentPreset: 'qq-chat',
      qqWorkspacePath: 'workspace',
      // 控制台「DSH 连接」页可改；插件启动时按它创建（或复用）QQ 聊天工作区。
      workspaceTitle: 'QQ 聊天',
      sessionsFile: 'state/sessions.json',
    },
    outbound: {
      replyMaxLength: 3000,
      longForwardThreshold: 400,
      longForwardChunkSize: 800,
      quoteAfterMsgs: 3,
      groupContextCount: 10,
    },
    archive: { enabled: true, dir: 'logs/qq_chat' },
    toolPrefix: 'mcp__qq__',
    plugins: {},
    pluginConfig: {},
    pacing: {
      merge: {
        enabled: true,
        windowMs: 2000,
        maxWaitMs: 6000,
        skipIfSlowMs: 30000,
        windowActiveMs: 4000,
        activeGapMs: 15000,
      },
      reply: {
        enabled: false,
        hourlyMax: 6,
        minGapMs: 480000,
        coldSilenceMs: 180000,
        silenceEnabled: true,     // 冷场找话（关掉 = 只在有群消息时接话）
        topicWindowMs: 600000,
        topicMinMsgs: 3,
        sensitivity: 0.45,
        maxChars: 140,
        groups: [],
        // 静默时段（回流自 NAS 生产副本）：这段时间内不主动开口，被叫照常回
        quietEnabled: true,
        quietStart: 0,
        quietEnd: 7,
        // 私聊主动接话（2026-10-29）：默认关；开启后按"对方多久没说话"判断，比群聊保守
        privateEnabled: false,
        privateQqs: [],
        privateFriendsOnly: true,
        privateColdSilenceMs: 7200000,
        privateHourlyMax: 1,
        privateMaxPerDay: 3,
        privateMinGapMs: 10800000,
        // 连续对话（只暴露 3 个可调项，其余是内部闸门；见 kernel/pacing.js 的同名默认值）
        continuation: {
          enabled: false,
          delayMs: 120000,
          bonus: 1.5,
          hourlyMax: 5,
          minGapMs: 300000,
          maxPerChain: 1,
          requireNewMessage: true,
          quoteLastHuman: false,
        },
        style: {
          splitEnabled: true,
          splitProbability: 0.5,
          splitMinLen: 12,
          splitDelayMs: 1000,
          splitMaxParts: 3,
          stickerEnabled: true,
          stickerProbability: 0.8,
        },
        weights: {
          intercept: -1.2005,
          mentionBot: 1.5852,
          atOther: -1.1157,
          hasQuestion: 0.4807,
          placeholderOnly: -1.0281,
          selfRatio: 2.6525,
          recentCount: -0.0367,
          logSecondsSinceBot: 0.0571,
          pendingCount: 0.1012,
        },
      },
    },
    credentials: {
      // 生图协议：openai-images（/images/generations + /images/edits）| openai-chat（部分中转站用 chat/completions 出图）
      gptImage: { protocol: 'openai-images', baseUrl: '', apiKey: '', model: 'gpt-image-2' },
    },
    compat: { imageRoots: [] },
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 深合并（数组/标量整体覆盖）。 */
export function deepMerge(base, override) {
  if (!isPlainObject(base)) return override === undefined ? base : override
  const out = { ...base }
  if (!isPlainObject(override)) return out
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

/** 老配置（含 bridge 段）→ v2。纯内存迁移；未知键丢弃。 */
export function migrateLegacyConfig(old = {}) {
  if (!isPlainObject(old)) return defaultConfig()
  const cfg = defaultConfig()
  const bridge = isPlainObject(old.bridge) ? old.bridge : {}
  const pluginConfig = {}

  // 空字符串 = 没配过（用内置默认）；只有真填了 preset 名才迁移过来。
  if (String(old?.dsh?.agentPreset || '').trim()) cfg.dsh.agentPreset = String(old.dsh.agentPreset)
  if (old?.dsh?.qqWorkspacePath) cfg.dsh.qqWorkspacePath = String(old.dsh.qqWorkspacePath)
  if (String(old?.dsh?.workspaceTitle || '').trim()) cfg.dsh.workspaceTitle = String(old.dsh.workspaceTitle)
  if (bridge.sessionsFile) cfg.dsh.sessionsFile = String(bridge.sessionsFile)
  if (Array.isArray(bridge.admins) && bridge.admins[0]) cfg.adminQq = Number(bridge.admins[0])
  if (isPlainObject(old.onebot)) cfg.onebot = deepMerge(cfg.onebot, old.onebot)
  // 旧键兼容：2026-10-27 之前这段叫 `napcat`（当时只有一家实现）。
  // 新键 `onebot` 优先；旧键只补新键没给的字段，所以老 config.json 不改也能直接跑。
  // 这里必须保留旧名字面量 —— 它是历史配置的键名，删了线上配置就读不到。
  const legacyOneBot = isPlainObject(old.napcat) ? old.napcat : null
  if (legacyOneBot) {
    const cur = isPlainObject(old.onebot) ? old.onebot : {}
    for (const k of Object.keys(legacyOneBot)) {
      if (cur[k] === undefined) cfg.onebot[k] = legacyOneBot[k]
    }
  }
  if (isPlainObject(bridge.chatArchive)) cfg.archive = deepMerge(cfg.archive, bridge.chatArchive)
  if (isPlainObject(old.pacing)) cfg.pacing = deepMerge(cfg.pacing, old.pacing)
  if (isPlainObject(bridge.pacing)) cfg.pacing = deepMerge(cfg.pacing, bridge.pacing)
  if (isPlainObject(bridge.reply)) cfg.pacing.reply = deepMerge(cfg.pacing.reply, bridge.reply)
  if (isPlainObject(bridge.longForward)) {
    if (Number(bridge.longForward.threshold) > 0) cfg.outbound.longForwardThreshold = Number(bridge.longForward.threshold)
    if (Number(bridge.longForward.chunkSize) > 0) cfg.outbound.longForwardChunkSize = Number(bridge.longForward.chunkSize)
  }
  if (Number(bridge.replyMaxLength) > 0) cfg.outbound.replyMaxLength = Number(bridge.replyMaxLength)
  if (Number(bridge.quoteAfterMsgs) >= 0) cfg.outbound.quoteAfterMsgs = Number(bridge.quoteAfterMsgs)
  if (Number(bridge.groupContextCount) >= 0) cfg.outbound.groupContextCount = Number(bridge.groupContextCount)

  // 门禁 / 唤醒
  const gw = {}
  for (const k of ['ignoreGroups', 'groupUserBlocklist', 'groupUserAllowlist', 'allowedUsers', 'groupAtRequired', 'groupFollowUpMs', 'keywordCooldownMs', 'callAck', 'pokeBack']) {
    if (bridge[k] !== undefined) gw[k] = bridge[k]
  }
  if (Array.isArray(bridge.groupKeywords)) gw.keywords = `*: ${bridge.groupKeywords.join(',')}`
  if (typeof bridge.groupKeywords === 'object' && bridge.groupKeywords) {
    // { "*": [...], "<群号>": [...] } → 文本行格式
    gw.keywords = Object.entries(bridge.groupKeywords)
      .map(([gid, words]) => `${gid}: ${(Array.isArray(words) ? words : [words]).join(',')}`)
      .join('\n')
  }
  if (Object.keys(gw).length) pluginConfig['gate-wake'] = gw

  // 人设 / 句池 / 拆条
  const pv = {}
  const style = isPlainObject(bridge.reply?.style) ? bridge.reply.style : {}
  if (style.splitEnabled !== undefined) pv.splitReplyEnabled = style.splitEnabled
  if (Number(style.splitProbability) >= 0) pv.splitReplyProbability = Math.round(Number(style.splitProbability) * 100)
  if (Number(style.splitMinLen) > 0) pv.splitReplyMinLen = Number(style.splitMinLen)
  if (Number(style.splitDelayMs) >= 0) pv.splitReplyDelayMs = Math.round(Number(style.splitDelayMs))
  if (Number(style.splitMaxParts) >= 2) pv.splitReplyMaxParts = Math.min(4, Math.round(Number(style.splitMaxParts)))
  if (bridge.quoteEnforce !== undefined) pv.quoteEnforce = Boolean(bridge.quoteEnforce)
  if (Object.keys(pv).length) pluginConfig['persona-voice'] = pv

  // 表情包
  if (Number(style.stickerProbability) >= 0) {
    pluginConfig.stickers = { ...(pluginConfig.stickers || {}), offerPercent: Math.round(Number(style.stickerProbability) * 100) }
  }
  if (isPlainObject(bridge.stickers)) {
    const st = {}
    for (const [from, to] of [
      ['enabled', 'enabled'], ['tagging', 'tagging'], ['dir', 'dir'], ['skipGif', 'skipGif'],
      ['maxItems', 'max'], ['offerCooldownMs', 'offerCooldownMs'], ['maxPerTurn', 'maxPerTurn'],
    ]) {
      if (bridge.stickers[from] !== undefined) st[to] = bridge.stickers[from]
    }
    if (Number(bridge.stickers.offerCooldownMs) > 0) st.offerCooldownMs = Math.round(Number(bridge.stickers.offerCooldownMs) / 1000)
    if (Object.keys(st).length) pluginConfig.stickers = { ...(pluginConfig.stickers || {}), ...st }
  }

  // 群记忆
  if (isPlainObject(bridge.groupMemory)) {
    const gm = {}
    for (const k of ['enabled', 'dir', 'maxBytes']) if (bridge.groupMemory[k] !== undefined) gm[k] = bridge.groupMemory[k]
    if (Object.keys(gm).length) pluginConfig['group-memory'] = gm
  }

  // 头像
  if (bridge.avatarDir || bridge.avatarCacheHours) {
    pluginConfig.imagegen = { ...(pluginConfig.imagegen || {}) }
    if (bridge.avatarDir) pluginConfig.imagegen.avatarDir = bridge.avatarDir
    if (Number(bridge.avatarCacheHours) > 0) pluginConfig.imagegen.avatarCacheHours = Number(bridge.avatarCacheHours)
  }

  // 生图
  if (isPlainObject(old.imagegen)) {
    const im = old.imagegen
    if (im.baseUrl || im.apiKey || im.model) {
      cfg.credentials.gptImage = {
        protocol: String(im.protocol || 'openai-images'),
        baseUrl: String(im.baseUrl || ''),
        apiKey: String(im.apiKey || ''),
        model: String(im.model || 'gpt-image-2'),
      }
    }
    const pic = { ...(pluginConfig.imagegen || {}) }
    for (const [from, to] of [['enabled', 'enabled'], ['cooldownMs', 'cooldownMs'], ['ackCooldownMs', 'ackCooldownMs'], ['timeoutMs', 'timeoutMs']]) {
      if (im[from] !== undefined) pic[to] = im[from]
    }
    for (const [k, mul] of [['cooldownMs', 1 / 1000], ['ackCooldownMs', 1 / 1000], ['timeoutMs', 1 / 1000]]) {
      if (Number(im[k]) > 0) pic[k] = Math.round(Number(im[k]) * mul)
    }
    if (Object.keys(pic).length) pluginConfig.imagegen = pic
  }

  // 链接解析
  if (isPlainObject(old.parser)) {
    const lp = {}
    for (const [from, to] of [['enabled', 'enabled'], ['serviceUrl', 'parserUrl'], ['modelTextThreshold', 'modelTextThreshold']]) {
      if (old.parser[from] !== undefined) lp[to] = old.parser[from]
    }
    if (Object.keys(lp).length) pluginConfig['link-parser'] = lp
  }

  // 入群欢迎
  if (isPlainObject(old.welcome)) {
    const wc = {}
    for (const k of ['enabled', 'mode', 'groups', 'lines', 'modelPrompt', 'atNewcomer', 'modelFallback', 'imageDir']) {
      if (old.welcome[k] !== undefined) wc[k] = old.welcome[k]
    }
    for (const [k, mul] of [['delayMs', 1 / 1000], ['cooldownMs', 1 / 60000], ['modelFallbackMs', 1 / 1000], ['modelMinGapMs', 1 / 1000]]) {
      if (Number(old.welcome[k]) > 0) wc[k] = Math.round(Number(old.welcome[k]) * mul)
    }
    if (Number(old.welcome.imageChance) >= 0) wc.imageChance = Math.round(Number(old.welcome.imageChance) * 100)
    if (Object.keys(wc).length) pluginConfig['group-welcome'] = wc
  }

  cfg.pluginConfig = pluginConfig
  return cfg
}

/** 是否是老格式（含 bridge 段且没有 version 2 标记）。 */
export function isLegacyShape(raw) {
  return isPlainObject(raw) && raw.version !== CONFIG_VERSION && isPlainObject(raw.bridge)
}

/** 校验（返回错误数组；空数组 = 通过）。 */
export function validateConfig(cfg) {
  const errors = []
  const adminQq = Number(cfg?.adminQq)
  if (!Number.isInteger(adminQq) || adminQq <= 0) {
    errors.push('adminQq 未配置：请在实例配置里填主人 QQ（必填项，无默认）')
  }
  if (!cfg?.onebot || !String(cfg.onebot.wsUrl || '').trim()) errors.push('onebot.wsUrl 未配置（OneBot v11 正向 WS 地址）')
  if (!cfg?.onebot || !String(cfg.onebot.httpUrl || '').trim()) errors.push('onebot.httpUrl 未配置（OneBot HTTP API 地址）')
  for (const [label, value] of [
    ['dsh.sessionsFile', cfg?.dsh?.sessionsFile],
    ['dsh.qqWorkspacePath', cfg?.dsh?.qqWorkspacePath],
    ['archive.dir', cfg?.archive?.dir],
  ]) {
    if (typeof value !== 'string' || !value.trim()) errors.push(`${label} 必须是字符串路径`)
  }
  const protocol = String(cfg?.credentials?.gptImage?.protocol || '').trim()
  if (protocol && !['openai-images', 'openai-chat'].includes(protocol)) {
    errors.push(`credentials.gptImage.protocol 不支持：${protocol}（可用 openai-images / openai-chat）`)
  }
  return errors
}

/** 递归解析路径字段（相对 dataDir）：键名以 dir/file/path 结尾，或 whitelist/roots 数组。 */
export function resolveRuntimePaths(cfg, dataDir) {
  const walk = (node, key = '') => {
    if (Array.isArray(node)) {
      const isPathList = /(whitelist|roots|dirs|paths)$/i.test(key)
      return node.map((v) => (isPathList && typeof v === 'string' ? resolveDataPath(v, dataDir) : walk(v, key)))
    }
    if (isPlainObject(node)) {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k)
      return out
    }
    if (typeof node === 'string' && /(dir|file|path)$/i.test(key) && node.trim()) {
      if (/^https?:\/\//i.test(node)) return node
      return resolveDataPath(node, dataDir)
    }
    return node
  }
  return walk(cfg)
}

/** 环境变量覆盖凭据（值不进配置文件时使用）。 */
export function applyCredentialEnv(cfg, env = process.env) {
  const out = structuredClone(cfg) // 深拷贝：绝不污染调用方传入的配置对象
  out.credentials ||= { gptImage: { baseUrl: '', apiKey: '', model: 'gpt-image-2' } }
  out.credentials.gptImage ||= { protocol: 'openai-images', baseUrl: '', apiKey: '', model: 'gpt-image-2' }
  const map = {
    QQ_IMAGEGEN_API_KEY: 'apiKey',
    QQ_IMAGEGEN_BASE_URL: 'baseUrl',
    QQ_IMAGEGEN_MODEL: 'model',
    QQ_IMAGEGEN_PROTOCOL: 'protocol',
  }
  for (const [envKey, field] of Object.entries(map)) {
    const v = String(env[envKey] || '').trim()
    if (v) out.credentials.gptImage[field] = v
  }
  return out
}

/**
 * 旧配置键兼容：2026-10-27 之前这段叫 `napcat`，之后统一叫 `onebot`。
 * 新键优先，旧键只补新键缺的字段 —— 老 `config.json` 一个字不改也能直接跑。
 * ⚠️ 字面量 `'napcat'` 是历史键名，不能删（删了线上配置读不到）。
 */
export function applyOneBotLegacyKey(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.napcat)) return raw
  const legacy = raw.napcat
  const cur = isPlainObject(raw.onebot) ? raw.onebot : {}
  const mergedOneBot = { ...cur }
  for (const k of Object.keys(legacy)) {
    if (mergedOneBot[k] === undefined) mergedOneBot[k] = legacy[k]
  }
  return { ...raw, onebot: mergedOneBot }
}

/**
 * 加载实例配置。
 * @returns {{dataDir:string, configPath:string, raw:object, runtime:object, migrated:boolean, created:boolean}}
 */
export function loadConfig({ dataDir: configuredDataDir = '', configPath = '', env = process.env, createIfMissing = true } = {}) {
  // 数据目录优先级：bundle Config > 环境变量 DSH_QQ_DATA_DIR > $DSH_HOME/dsh-onebot-qq
  const dataDir = resolveDataDir(configuredDataDir || env.DSH_QQ_DATA_DIR, env)
  const file = configPath ? path.resolve(configPath) : path.join(dataDir, 'config.json')
  let created = false
  let raw
  if (!fs.existsSync(file)) {
    raw = defaultConfig()
    if (createIfMissing) {
      writeJsonFileSync(file, raw, { mode: 0o600 })
      created = true
    }
  } else {
    raw = readJsonFile(file)
  }
  // 旧键兼容（`napcat.*` → `onebot.*`）：v2 与 legacy 两种形状都要过一遍
  raw = applyOneBotLegacyKey(raw)
  const migrated = isLegacyShape(raw)
  const merged = migrated ? migrateLegacyConfig(raw) : deepMerge(defaultConfig(), raw)
  merged.version = CONFIG_VERSION
  // 迁移态落盘：否则控制台读的是旧结构、写回后又被迁移逻辑覆盖（用户会误以为"改了不生效"）
  if (migrated && createIfMissing) {
    try {
      backupFileSync(file, 'bak-legacy')
      writeJsonFileSync(file, merged, { mode: 0o600 })
    } catch { /* 只读目录等：保持内存迁移，不阻塞启动 */ }
  }
  const runtime = applyCredentialEnv(resolveRuntimePaths(merged, dataDir), env)
  return { dataDir, configPath: file, raw: merged, runtime, migrated, created }
}

/** 写实例配置：备份（ASCII 后缀）→ 原子写 → 返回备份文件名。 */
export function saveConfig(configPath, raw, { backup = true } = {}) {
  const file = path.resolve(String(configPath))
  const backupFile = backup ? backupFileSync(file, 'bak-console') : ''
  atomicWriteFileSync(file, `${JSON.stringify(raw, null, 4)}\n`, { mode: 0o600 })
  return { ok: true, file, backup: backupFile ? path.basename(backupFile) : '' }
}

/** 生成示例配置（init 用；adminQq=0 表示待填）。 */
export function exampleConfig() {
  return defaultConfig()
}
