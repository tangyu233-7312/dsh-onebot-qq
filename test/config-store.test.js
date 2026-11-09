/**
 * test/config-store.test.js — 实例配置唯一真源（kernel/config-store.js）的行为测试。
 *
 * 覆盖：默认配置（零私有值）、深合并、旧格式迁移（字段/单位换算）、校验、路径解析、
 * 环境变量凭据覆盖、load/save（BOM、自动创建、备份）、examples/config.example.json 合规。
 * 全部 fixture 在 os.tmpdir()，不依赖任何站点路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONFIG_VERSION,
  defaultConfig,
  deepMerge,
  migrateLegacyConfig,
  isLegacyShape,
  validateConfig,
  resolveRuntimePaths,
  applyCredentialEnv,
  loadConfig,
  saveConfig,
  exampleConfig,
} from '../kernel/config-store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tmpDir(tag = 'config') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-${tag}-`))
}

test('defaultConfig：v2 结构、adminQq=0、不含私有路径/真实号码', () => {
  const cfg = defaultConfig()
  assert.equal(cfg.version, CONFIG_VERSION)
  assert.equal(cfg.version, 2)
  assert.equal(cfg.adminQq, 0, '没有默认主人 QQ（必须显式配置）')
  assert.equal(cfg.credentials.gptImage.protocol, 'openai-images', '生图默认协议 openai-images')
  assert.equal(cfg.onebot.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(cfg.onebot.httpUrl, 'http://127.0.0.1:3000')
  assert.equal(cfg.dsh.qqWorkspacePath, 'workspace', '工作区是相对 dataDir 的路径')
  assert.equal(cfg.dsh.sessionsFile, 'state/sessions.json')
  assert.equal(cfg.archive.dir, 'logs/qq_chat')
  assert.equal(cfg.toolPrefix, 'mcp__qq__')
  assert.deepEqual(cfg.plugins, {})
  assert.deepEqual(cfg.pluginConfig, {})

  // 递归扫描：默认配置里不允许出现站点私有绝对路径
  const bad = []
  const walk = (node, key = '') => {
    if (typeof node === 'string') {
      if (/^\/(opt|root|var|tmp)(\/|$)/i.test(node)) bad.push(`${key}=${node}`)
      return
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${key}[${i}]`))
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, key ? `${key}.${k}` : k)
  }
  walk(cfg)
  assert.deepEqual(bad, [], `默认配置不应含私有路径：${bad.join(', ')}`)
})

test('deepMerge：对象深合并、数组/标量整体覆盖', () => {
  const merged = deepMerge(
    { a: { b: 1, c: 2 }, list: [1, 2], s: 'x', keep: true },
    { a: { c: 3 }, list: [9], s: 'y' },
  )
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9], s: 'y', keep: true })
})

test('migrateLegacyConfig：旧 bridge 段 → v2（字段名与单位换算）', () => {
  const legacy = {
    bridge: {
      admins: [10001],
      sessionsFile: 'state/sessions.json',
      replyMaxLength: 2500,
      quoteAfterMsgs: 2,
      longForward: { threshold: 500, chunkSize: 900 },
      groupKeywords: { '*': ['小助手'], 20001: ['机器人'] },
      ignoreGroups: [20002],
      groupAtRequired: false,
      groupUserBlocklist: '20001:30001',
      chatArchive: { enabled: true, dir: 'logs/qq_chat' },
      pacing: { reply: { enabled: true, hourlyMax: 4 } },
      reply: { style: { splitEnabled: false, splitProbability: 0.3, splitMinLen: 20, splitDelayMs: 1500, stickerProbability: 0.8 } },
      stickers: { enabled: true, dir: 'qq-stickers', maxItems: 100, offerCooldownMs: 30000 },
      groupMemory: { enabled: true, dir: 'qq-memory' },
      avatarDir: 'qq_avatars',
      avatarCacheHours: 12,
    },
    onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' },
    imagegen: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2', cooldownMs: 90000 },
    parser: { enabled: true, serviceUrl: 'http://127.0.0.1:3972' },
    welcome: { enabled: true, delayMs: 3000, imageChance: 0.5, cooldownMs: 600000 },
    unknownKey: 'drop me',
  }
  assert.equal(isLegacyShape(legacy), true)

  const cfg = migrateLegacyConfig(legacy)
  assert.equal(cfg.version, 2)
  assert.equal(cfg.adminQq, 10001)
  assert.equal(cfg.dsh.sessionsFile, 'state/sessions.json')
  assert.equal(cfg.outbound.replyMaxLength, 2500)
  assert.equal(cfg.outbound.quoteAfterMsgs, 2)
  assert.equal(cfg.outbound.longForwardThreshold, 500)
  assert.equal(cfg.outbound.longForwardChunkSize, 900)
  assert.equal(cfg.archive.dir, 'logs/qq_chat')
  assert.equal(cfg.pacing.reply.enabled, true)
  assert.equal(cfg.pacing.reply.hourlyMax, 4)

  const gw = cfg.pluginConfig['gate-wake']
  assert.ok(gw && typeof gw.keywords === 'string', 'groupKeywords 迁移为 keywords 文本')
  assert.match(gw.keywords, /\*: 小助手/)
  assert.match(gw.keywords, /20001: 机器人/)
  assert.deepEqual(gw.ignoreGroups, [20002])
  assert.equal(gw.groupAtRequired, false)
  assert.equal(gw.groupUserBlocklist, '20001:30001')

  const pv = cfg.pluginConfig['persona-voice']
  assert.equal(pv.splitReplyEnabled, false)
  assert.equal(pv.splitReplyProbability, 30, '0.3 → 30%')
  assert.equal(pv.splitReplyMinLen, 20)

  const st = cfg.pluginConfig.stickers
  assert.equal(st.dir, 'qq-stickers')
  assert.equal(st.max, 100, 'maxItems → max')
  assert.equal(st.offerCooldownMs, 30, '毫秒 → 秒')
  assert.equal(st.offerPercent, 80, 'style.stickerProbability 默认 0.8 → 80%')

  // 2026-11-09：旧 group-memory 已下线，迁移桥不再写回这一节（老配置里留着也不报错）
  assert.equal(cfg.pluginConfig['group-memory'], undefined)
  assert.equal(cfg.pluginConfig.imagegen.avatarDir, 'qq_avatars')
  assert.equal(cfg.pluginConfig.imagegen.avatarCacheHours, 12)
  assert.equal(cfg.pluginConfig.imagegen.cooldownMs, 90, '毫秒 → 秒')
  assert.equal(cfg.credentials.gptImage.apiKey, 'REPLACE_ME')
  assert.equal(cfg.credentials.gptImage.protocol, 'openai-images', '旧配置没有 protocol 时补默认值')

  // 旧配置显式写了 protocol → 保留（openai-chat 中转站场景）
  const migratedChat = migrateLegacyConfig({
    bridge: { admins: [10001] },
    imagegen: { protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' },
  })
  assert.equal(migratedChat.credentials.gptImage.protocol, 'openai-chat')
  assert.equal(cfg.pluginConfig['link-parser'].parserUrl, 'http://127.0.0.1:3972')
  assert.equal(cfg.pluginConfig['group-welcome'].delayMs, 3, '毫秒 → 秒')
  assert.equal(cfg.pluginConfig['group-welcome'].imageChance, 50, '0.5 → 50%')
  assert.equal(cfg.pluginConfig['group-welcome'].cooldownMs, 10, '毫秒 → 分钟')

  // 未知键丢弃
  assert.equal(cfg.unknownKey, undefined)
})

test('isLegacyShape / validateConfig', () => {
  assert.equal(isLegacyShape({ version: 2, adminQq: 1 }), false)
  assert.equal(isLegacyShape({ bridge: {} }), true)
  assert.equal(isLegacyShape(null), false)

  const base = defaultConfig()
  let errors = validateConfig(base)
  assert.ok(errors.some((e) => e.includes('adminQq')), 'adminQq=0 必须报错')

  const good = deepMerge(base, { adminQq: 10001 })
  assert.deepEqual(validateConfig(good), [])

  const noUrls = deepMerge(good, { onebot: { wsUrl: '', httpUrl: '' } })
  errors = validateConfig(noUrls)
  assert.equal(errors.length, 2)
  assert.ok(errors.some((e) => e.includes('wsUrl')))
  assert.ok(errors.some((e) => e.includes('httpUrl')))

  // 生图协议：只允许 openai-images / openai-chat
  const badProtocol = deepMerge(good, { credentials: { gptImage: { protocol: 'openai-nope' } } })
  errors = validateConfig(badProtocol)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /protocol.*openai-nope/)
  for (const protocol of ['openai-images', 'openai-chat']) {
    assert.deepEqual(validateConfig(deepMerge(good, { credentials: { gptImage: { protocol } } })), [], `${protocol} 应是合法值`)
  }
})

test('resolveRuntimePaths：相对路径按 dataDir 解析、绝对路径原样、URL 不动', () => {
  const dataDir = path.join(os.tmpdir(), 'qqbot-data-root')
  const resolved = resolveRuntimePaths(
    {
      dsh: { qqWorkspacePath: 'workspace', sessionsFile: 'state/sessions.json', agentPreset: '' },
      archive: { enabled: true, dir: 'logs/qq_chat' },
      pluginConfig: {
        stickers: { dir: 'qq-stickers' },
        'file-transfer': { uploadDir: 'qq_uploads', imageWhitelist: ['qq_uploads', 'C:/abs-on-win', '/abs-on-posix'] },
        'link-parser': { parserUrl: 'http://127.0.0.1:3972', platforms: ['bilibili'] },
      },
      onebot: { wsUrl: 'ws://127.0.0.1:3001' },
    },
    dataDir,
  )
  assert.equal(resolved.dsh.qqWorkspacePath, path.resolve(dataDir, 'workspace'))
  assert.equal(resolved.dsh.sessionsFile, path.resolve(dataDir, 'state/sessions.json'))
  assert.equal(resolved.dsh.agentPreset, '', '非路径字符串不动')
  assert.equal(resolved.archive.dir, path.resolve(dataDir, 'logs/qq_chat'))
  assert.equal(resolved.pluginConfig.stickers.dir, path.resolve(dataDir, 'qq-stickers'))
  assert.equal(resolved.pluginConfig['file-transfer'].uploadDir, path.resolve(dataDir, 'qq_uploads'))
  assert.equal(resolved.onebot.wsUrl, 'ws://127.0.0.1:3001', 'URL 不当路径解析')
  assert.equal(resolved.pluginConfig['link-parser'].parserUrl, 'http://127.0.0.1:3972')
  assert.deepEqual(resolved.pluginConfig['link-parser'].platforms, ['bilibili'], '非路径数组不解析')
  const whitelist = resolved.pluginConfig['file-transfer'].imageWhitelist
  assert.equal(whitelist[0], path.resolve(dataDir, 'qq_uploads'))
  // Windows 盘符路径只在 Windows 上被视为完整绝对路径
  if (process.platform === 'win32') assert.equal(whitelist[1], path.normalize('C:/abs-on-win'))
  else assert.equal(whitelist[1], path.resolve(dataDir, 'C:/abs-on-win'))
})

test('applyCredentialEnv：环境变量覆盖 credentials.gptImage', () => {
  const cfg = defaultConfig()
  const out = applyCredentialEnv(cfg, {
    QQ_IMAGEGEN_API_KEY: 'REPLACE_ME',
    QQ_IMAGEGEN_BASE_URL: 'https://example.invalid/v1',
    QQ_IMAGEGEN_MODEL: 'gpt-image-2',
  })
  assert.equal(out.credentials.gptImage.apiKey, 'REPLACE_ME')
  assert.equal(out.credentials.gptImage.baseUrl, 'https://example.invalid/v1')
  assert.equal(out.credentials.gptImage.model, 'gpt-image-2')
  assert.equal(out.credentials.gptImage.protocol, 'openai-images', '没设环境变量时用原值')

  const withProtocol = applyCredentialEnv(defaultConfig(), { QQ_IMAGEGEN_PROTOCOL: 'openai-chat' })
  assert.equal(withProtocol.credentials.gptImage.protocol, 'openai-chat', 'QQ_IMAGEGEN_PROTOCOL 覆盖协议')
  // 控制台/配置写别的协议时，空环境变量不会把它冲掉
  const configured = defaultConfig()
  configured.credentials.gptImage.protocol = 'openai-chat'
  assert.equal(applyCredentialEnv(configured, {}).credentials.gptImage.protocol, 'openai-chat')

  // 不污染原对象
  assert.equal(cfg.credentials.gptImage.apiKey, '')
})

test('loadConfig：文件不存在自动创建默认配置（created=true），runtime 路径已绝对化', () => {
  const dataDir = tmpDir('load')
  const res = loadConfig({ dataDir, env: {} })
  assert.equal(res.created, true)
  assert.equal(res.migrated, false)
  assert.ok(fs.existsSync(res.configPath))
  const written = JSON.parse(fs.readFileSync(res.configPath, 'utf8'))
  assert.equal(written.adminQq, 0)
  assert.equal(res.runtime.dsh.qqWorkspacePath, path.resolve(dataDir, 'workspace'))
  // 校验必然失败（adminQq=0），这是刻意的
  assert.ok(validateConfig(res.runtime).length > 0)
})

test('loadConfig：正常配置 + UTF-8 BOM 也能读；migrated 标记旧格式', () => {
  const dataDir = tmpDir('bom')
  const cfg = deepMerge(defaultConfig(), {
    adminQq: 10001,
    pluginConfig: { stickers: { dir: 'qq-stickers' } },
  })
  const file = path.join(dataDir, 'config.json')
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(cfg, null, 2)}\n`)
  const res = loadConfig({ dataDir, env: {} })
  assert.equal(res.created, false)
  assert.equal(res.migrated, false)
  assert.equal(res.raw.adminQq, 10001)
  assert.equal(res.runtime.pluginConfig.stickers.dir, path.resolve(dataDir, 'qq-stickers'))

  // 旧格式落盘 → 内存迁移
  const legacyFile = path.join(dataDir, 'legacy.json')
  fs.writeFileSync(legacyFile, JSON.stringify({ bridge: { admins: [10001] }, onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' } }))
  const legacyRes = loadConfig({ dataDir, configPath: legacyFile, env: {}, createIfMissing: false })
  assert.equal(legacyRes.migrated, true)
  assert.equal(legacyRes.raw.adminQq, 10001)
  assert.equal(legacyRes.raw.version, 2)
})

test('saveConfig：先备份（ASCII 后缀）再原子写，返回备份名', () => {
  const dataDir = tmpDir('save')
  const file = path.join(dataDir, 'config.json')
  fs.writeFileSync(file, JSON.stringify(deepMerge(defaultConfig(), { adminQq: 10001 })))
  const next = deepMerge(defaultConfig(), { adminQq: 10002 })
  const res = saveConfig(file, next)
  assert.equal(res.ok, true)
  assert.match(res.backup, /^config\.json\.bak-console-\d+$/, '备份后缀 ASCII 且带时间戳')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.adminQq, 10002)
  // 备份内容是旧值
  const backup = JSON.parse(fs.readFileSync(path.join(dataDir, res.backup), 'utf8'))
  assert.equal(backup.adminQq, 10001)
})

test('examples/config.example.json：合法、能通过校验、无私有值', () => {
  const file = path.join(ROOT, 'examples', 'config.example.json')
  assert.ok(fs.existsSync(file), '示例配置必须存在（打包清单里）')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const merged = deepMerge(defaultConfig(), raw)
  assert.equal(merged.adminQq, 10001, '示例用占位 QQ')
  assert.deepEqual(validateConfig(merged), [], '示例配置填完占位值后应能通过校验')
  assert.equal(merged.credentials.gptImage.protocol, 'openai-images', '示例配置应带生图协议字段')
  assert.equal(exampleConfig().version, CONFIG_VERSION)
})

// ─────────────────────────────────────────────────────────────────────────────
// 旧配置键兼容：2026-10-27 起这段从 napcat 改名为 onebot，老 config.json 必须照旧能跑
// ─────────────────────────────────────────────────────────────────────────────

test('旧键兼容：config.json 只写 napcat.* 时，运行时能读到 onebot.*（老部署不用改文件）', () => {
  const dataDir = tmpDir('legacy-key')
  const file = path.join(dataDir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({
    version: CONFIG_VERSION,
    adminQq: 10001,
    napcat: {
      wsUrl: 'ws://127.0.0.1:4599',
      wsToken: 'ws-token-old',
      httpUrl: 'http://127.0.0.1:4598',
      httpToken: 'http-token-old',
      mediaSendTimeoutMs: 300000,
      mediaSendRetries: 2,
    },
  }))
  const r = loadConfig({ dataDir })
  assert.equal(r.runtime.onebot.wsUrl, 'ws://127.0.0.1:4599', '旧键的 WS 地址要能读到')
  assert.equal(r.runtime.onebot.wsToken, 'ws-token-old', '旧键的 token 要能读到')
  assert.equal(r.runtime.onebot.httpUrl, 'http://127.0.0.1:4598')
  assert.equal(r.runtime.onebot.httpToken, 'http-token-old')
  assert.equal(r.runtime.onebot.mediaSendTimeoutMs, 300000, '旧键里的非默认字段也不能丢')
  assert.equal(r.runtime.onebot.mediaSendRetries, 2)
  assert.deepEqual(validateConfig(r.raw), [], '兼容后应直接通过校验')
})

test('旧键兼容：onebot 与 napcat 同时存在时，onebot 优先、napcat 只补缺', () => {
  const dataDir = tmpDir('both-keys')
  const file = path.join(dataDir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({
    version: CONFIG_VERSION,
    adminQq: 10001,
    onebot: { wsUrl: 'ws://127.0.0.1:4799' },              // 新键：只有地址
    napcat: { wsUrl: 'ws://127.0.0.1:3001', wsToken: 'from-old' }, // 旧键：地址该被新键覆盖，token 该补上
  }))
  const r = loadConfig({ dataDir })
  assert.equal(r.runtime.onebot.wsUrl, 'ws://127.0.0.1:4799', '新键优先')
  assert.equal(r.runtime.onebot.wsToken, 'from-old', '旧键补缺字段')
})
