#!/usr/bin/env node
/**
 * bin/dsh-onebot-qq.mjs — dsh-onebot-qq 跨平台 CLI（Windows / Linux / macOS 通用，纯 ESM，无第三方依赖）。
 *
 * 子命令：
 *   init           建数据目录 + 写实例配置 + 复制示例模板（不改已有文件，--force 只覆盖 config.json）
 *   doctor         环境/配置/端口自检（✅/⚠️/❌ 清单；有 ❌ 退出码 1）
 *   import-legacy  旧版 config.json → v2 实例配置（自动备份已有文件）
 *   persona        人设列表 / 切换（symlink 不行时自动 copy 降级）
 *
 * 约定：
 *   · 所有路径经 `platform/` 与 `kernel/config-store.js` 解析，不写死任何绝对路径；
 *   · `--data-dir` 缺省时用 $DSH_HOME/dsh-onebot-qq（再缺省 ~/.dsh/dsh-onebot-qq）；
 *   · 输出中文，退出码：0 成功 / 1 失败。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDataDir, resolveDshHome, resolveTmpDir, ensureDir } from '../platform/paths.js'
import { readJsonFile, writeJsonFileSync, backupFileSync } from '../platform/atomic.js'
import {
  defaultConfig,
  loadConfig,
  migrateLegacyConfig,
  isLegacyShape,
  validateConfig,
  saveConfig,
} from '../kernel/config-store.js'
import {
  canSymlink,
  listPersonas,
  activePersona,
  switchPersona,
} from '../platform/persona-ref.js'
import { DEFAULT_PERSONA_NAME, ensureDefaultPersona as seedDefaultPersona } from '../platform/persona-seed.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLES = path.join(PKG_ROOT, 'examples')
const MIN_NODE_MAJOR = 22
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 数据目录标准子目录（新用户默认布局；相对路径配置都相对 dataDir）。 */
const DATA_SUBDIRS = [
  'workspace', // qq-lines 工作区（AGENTS.md / CLAUDE.local.md / 人设投递文件）
  'personas', // 人设库：<名字>.md / .lines.txt / .wake.txt + _default.lines.txt
  'qq-stickers', // 表情包库（索引 + 图片）
  'long-memory', // 长期记忆库（memories.jsonl 事件流 + 快照 + .revisions）
  'qq-welcome-images', // 入群欢迎图片池
  'qq_uploads', // 入站文件
  'qq-refs', // 生图参考图
  'qq_avatars', // 头像缓存（插件 imagegen 默认目录）
  'logs/qq_chat', // 聊天留档
  'state', // sessions.json 等运行时状态
]

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/** 极简参数解析：`--k v` / `--flag` / 位置参数。 */
function parseArgs(argv) {
  const flags = new Map()
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i += 1
    } else {
      flags.set(key, true)
    }
  }
  return { flags, positional }
}

function flagString(flags, name) {
  const v = flags.get(name)
  return typeof v === 'string' ? v : ''
}

function resolveDataDirFromFlags(flags) {
  // 与内核一致：--data-dir > DSH_QQ_DATA_DIR > $DSH_HOME/dsh-onebot-qq
  return resolveDataDir(flagString(flags, 'data-dir') || String(process.env.DSH_QQ_DATA_DIR || ''), process.env)
}

function printHelp() {
  console.log(`dsh-onebot-qq v${VERSION} — QQ 机器人插件 CLI

用法：
  dsh-onebot-qq <命令> [选项]

命令：
  init            建立数据目录、写实例配置、复制示例模板并投递默认人设
                    --data-dir <dir>   数据目录（默认 $DSH_QQ_DATA_DIR 或 $DSH_HOME/dsh-onebot-qq）
                    --force            覆盖已存在的 config.json（先备份）
  doctor          环境与配置自检（✅/⚠️/❌；有 ❌ 时退出码 1）
                    --data-dir <dir>
                    --no-net           跳过 OneBot 协议端端口探测
  import-legacy   旧版 config.json → v2 实例配置
                    <旧配置路径>       （必填）
                    --out <file>       输出路径（默认 <dataDir>/config.json）
                    --data-dir <dir>
  persona         人设管理
                    list               列出人设与当前生效的人设
                    use <名字>          切换人设（自动 symlink → copy 降级）
                    --data-dir <dir>

通用：
  --help, -h      显示帮助
  --version, -V   显示版本

示例：
  node bin/dsh-onebot-qq.mjs init
  node bin/dsh-onebot-qq.mjs doctor --data-dir ~/.dsh/dsh-onebot-qq
  node bin/dsh-onebot-qq.mjs import-legacy ./old-config.json --out ~/.dsh/dsh-onebot-qq/config.json
  node bin/dsh-onebot-qq.mjs persona use 蓝色大肥鱼
`)
}

// ─────────────────────────────────────────────────────────────────────────────
// init
// ─────────────────────────────────────────────────────────────────────────────

function copyTemplates(dataDir, { log }) {
  const copies = []
  const copyFileIfMissing = (src, dst) => {
    if (!fs.existsSync(src)) return
    if (fs.existsSync(dst)) return
    ensureDir(path.dirname(dst))
    fs.copyFileSync(src, dst)
    copies.push(path.relative(dataDir, dst))
  }
  const copyDirFiles = (srcDir, dstDir, skip = () => false) => {
    if (!fs.existsSync(srcDir)) return
    for (const name of fs.readdirSync(srcDir)) {
      if (skip(name)) continue
      const src = path.join(srcDir, name)
      if (!fs.statSync(src).isFile()) continue
      copyFileIfMissing(src, path.join(dstDir, name))
    }
  }
  copyDirFiles(path.join(EXAMPLES, 'qq-lines'), path.join(dataDir, 'workspace'))
  copyDirFiles(path.join(EXAMPLES, 'personas'), path.join(dataDir, 'personas'))
  if (copies.length) log(`已复制示例模板 ${copies.length} 个（不覆盖已有文件）`)
  return copies
}

function chmodBestEffort(file, mode) {
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* Windows / 无权限文件系统：尽力而为 */
  }
}

/**
 * 投递内置默认人设（幂等：已有投递/已配置人设就跳过，绝不覆盖用户文件）。
 * @returns {{ok?:boolean, skipped?:boolean, name?:string, mode?:string, error?:string}}
 */
function ensureDefaultPersona(dataDir, configPath) {
  const cfg0 = (() => { try { return readJsonFile(configPath) } catch { return null } })()
  const configured = String(cfg0?.pluginConfig?.['persona-voice']?.activePersona || '')
  const seeded = seedDefaultPersona({ dataDir, examplesDir: path.join(EXAMPLES, 'personas'), configured })
  if (seeded.skipped) {
    console.log(`ℹ️  人设已存在${seeded.name ? `（当前：${seeded.name}）` : ''}，跳过默认人设投递（不覆盖已有文件）`)
    return seeded
  }
  if (!seeded.ok) {
    console.log(`⚠️  默认人设投递失败：${seeded.error}（可稍后运行 node bin/dsh-onebot-qq.mjs persona use ${DEFAULT_PERSONA_NAME}）`)
    return seeded
  }

  // 把 activePersona 写进实例配置（存在才写；只改这一个字段，保留其它配置）
  let configUpdated = false
  const cfg = (() => { try { return readJsonFile(configPath) } catch { return null } })()
  if (cfg && typeof cfg === 'object') {
    cfg.pluginConfig = cfg.pluginConfig && typeof cfg.pluginConfig === 'object' ? cfg.pluginConfig : {}
    const pv = cfg.pluginConfig['persona-voice'] && typeof cfg.pluginConfig['persona-voice'] === 'object'
      ? cfg.pluginConfig['persona-voice'] : {}
    pv.activePersona = DEFAULT_PERSONA_NAME
    cfg.pluginConfig['persona-voice'] = pv
    writeJsonFileSync(configPath, cfg)
    chmodBestEffort(configPath, 0o600)
    configUpdated = true
  }
  console.log(
    `✅ 已投递默认人设「${DEFAULT_PERSONA_NAME}」`
    + `（${seeded.mode === 'symlink' ? '软链' : '复制'}模式；新复制 ${seeded.copied} 个文件`
    + `${configUpdated ? '，已写入 config 的 pluginConfig.persona-voice.activePersona' : ''}）`,
  )
  if (seeded.missing?.length) console.log(`⚠️  人设缺文件（对应能力保持默认）：${seeded.missing.join(', ')}`)
  return { ...seeded, configUpdated }
}

function cmdInit(flags) {
  const dataDir = resolveDataDirFromFlags(flags)
  console.log(`数据目录：${dataDir}`)
  ensureDir(dataDir)
  chmodBestEffort(dataDir, 0o700)

  for (const sub of DATA_SUBDIRS) ensureDir(path.join(dataDir, sub))
  console.log(`✅ 已建立 ${DATA_SUBDIRS.length} 个子目录`)

  const configPath = path.join(dataDir, 'config.json')
  const exists = fs.existsSync(configPath)
  if (exists && !flags.get('force')) {
    console.log('ℹ️  config.json 已存在，保留原文件（加 --force 覆盖，会先备份）')
  } else {
    if (exists) {
      const bak = backupFileSync(configPath, 'bak-init')
      console.log(`ℹ️  原配置已备份：${path.basename(bak)}`)
    }
    writeJsonFileSync(configPath, defaultConfig())
    chmodBestEffort(configPath, 0o600)
    console.log(`✅ 已写入 ${configPath}（adminQq = 0，待配置：可在控制台新手向导里填写）`)
  }

  copyTemplates(dataDir, { log: (m) => console.log(`✅ ${m}`) })
  ensureDefaultPersona(dataDir, configPath)

  console.log(`
下一步（推荐：控制台新手向导，不用手改 JSON）：
  1) 安装/启动插件：DSH 插件管理器安装本包（或 dsh plugin --profile web add <tgz|目录|git URL>），
     然后启动/重启 dsh web。
  2) 打开 设置 → QQ 控制台 →「新手向导」：填主人 QQ + OneBot 协议端地址，
     点「测试 OneBot 连接」→ 保存后自动连接（无需重启）。
  3) 也可以手改实例配置：${configPath}
     （adminQq / onebot.wsUrl / onebot.httpUrl；缺 adminQq 时插件进入「待配置模式」，控制台仍可打开）
  4) 自检：
       node ${path.relative(process.cwd(), path.join(PKG_ROOT, 'bin/dsh-onebot-qq.mjs')) || 'bin/dsh-onebot-qq.mjs'} doctor --data-dir "${dataDir}"
  5) 人设：已自动投递「${DEFAULT_PERSONA_NAME}」；换人设：
       node bin/dsh-onebot-qq.mjs persona use <名字> --data-dir "${dataDir}"

安全：config.json 可能含 token/API Key。Linux/macOS 已尝试 chmod 600；
Windows 可用 icacls 收紧到当前用户（见 docs/安装与卸载.md）。
`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor
// ─────────────────────────────────────────────────────────────────────────────

function checkWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { ok: true }
  } catch (e) {
    try {
      fs.unlinkSync(probe)
    } catch {
      /* ignore */
    }
    return { ok: false, error: e.message }
  }
}

function probeEndpoint(rawUrl, defaultPort) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return { ok: false, detail: `地址不合法：${rawUrl}` }
  }
  const host = url.hostname
  const port = Number(url.port) || defaultPort
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok, detail) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve({ ok, detail: detail || `${host}:${port}` })
    }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true, `${host}:${port} 可连接`))
    socket.once('timeout', () => done(false, `${host}:${port} 连接超时`))
    socket.once('error', (e) => done(false, `${host}:${port} 连接失败（${e.code || e.message}）`))
  })
}

async function cmdDoctor(flags) {
  const noNet = Boolean(flags.get('no-net'))
  const dataDir = resolveDataDirFromFlags(flags)
  const configPath = path.join(dataDir, 'config.json')
  const results = []
  const add = (ok, label, detail = '') => results.push({ ok, label, detail })
  const warn = (label, detail = '') => results.push({ ok: true, warn: true, label, detail })

  // 1) Node / 平台
  const major = Number(process.versions.node.split('.')[0])
  add(major >= MIN_NODE_MAJOR, `Node ${process.versions.node}`, major >= MIN_NODE_MAJOR ? `>= ${MIN_NODE_MAJOR}` : `需要 >= ${MIN_NODE_MAJOR}`)
  warn(`平台 ${process.platform}/${process.arch}`, process.platform === 'win32' ? '有 symlink 权限限制时会自动 copy 降级' : '')
  console.log(`DSH_HOME：${resolveDshHome(process.env)}`)
  console.log(`dataDir ：${dataDir}`)
  console.log(`config  ：${configPath}\n`)

  // 2) 配置存在 / 可解析 / 必填
  let loaded = null
  if (!fs.existsSync(configPath)) {
    add(false, '实例配置存在', `未找到 ${configPath}（先运行 init）`)
  } else {
    try {
      loaded = loadConfig({ dataDir, configPath, createIfMissing: false })
      add(true, '实例配置可解析')
      if (loaded.migrated) warn('检测到旧版格式（含 bridge 段）', '建议用 import-legacy 落盘为 v2')
      const errors = validateConfig(loaded.runtime)
      if (errors.length === 0) {
        add(true, '必填项校验', `adminQq=${loaded.raw.adminQq}`)
      } else {
        for (const err of errors) add(false, '必填项校验', err)
      }
    } catch (e) {
      add(false, '实例配置可解析', e.message)
    }
  }

  // 3) 数据目录可写
  let dataDirOk = false
  for (const [label, dir] of [
    ['数据目录可写', dataDir],
    ['人设目录可写', path.join(dataDir, 'personas')],
  ]) {
    ensureDir(dir)
    const w = checkWritable(dir)
    add(w.ok, label, w.ok ? dir : w.error)
    if (dir === dataDir) dataDirOk = w.ok
  }

  // 4) 人设投递能力（symlink / copy）
  const ws = path.join(dataDir, 'workspace')
  const sym = canSymlink(ws)
  if (sym) add(true, '人设投递：symlink 可用')
  else warn('人设投递：symlink 不可用（将自动 copy 降级）', 'Windows 普通用户默认如此，功能不受影响')

  // 5) 人设（人设库目录 + 当前投递文件）
  const personaDir = path.join(dataDir, 'personas')
  const workspaceDir = path.join(dataDir, 'workspace')
  let personas = []
  try {
    personas = listPersonas(personaDir)
  } catch {
    personas = []
  }
  const configuredPersona = String(loaded?.raw?.pluginConfig?.['persona-voice']?.activePersona || '')
  let currentPersona = ''
  try {
    currentPersona = activePersona({ configured: configuredPersona, workspaceDir, personaDir })
  } catch {
    currentPersona = ''
  }
  const deliveredPersonaFiles = ['AGENTS.local.md', 'lines.txt', 'wake.txt']
    .filter((f) => fs.existsSync(path.join(workspaceDir, f)))
  if (!personas.length) {
    warn('人设库', `未找到人设：可运行 init 生成默认人设，或把 <名字>.md 放入 ${personaDir}`)
  } else if (!currentPersona) {
    warn('当前人设', `未指定；可用：${personas.slice(0, 6).join(' / ')}（persona use <名字>）`)
  } else if (!deliveredPersonaFiles.length) {
    warn('人设投递', `当前人设「${currentPersona}」但 workspace 里没有投递文件（persona use ${currentPersona}）`)
  } else {
    add(true, '人设', `${currentPersona}（已投递 ${deliveredPersonaFiles.join('/')}）`)
  }

  // 6) 临时目录
  try {
    const tmp = resolveTmpDir('doctor')
    const w = checkWritable(tmp)
    add(w.ok, '临时目录可写', w.ok ? tmp : w.error)
  } catch (e) {
    add(false, '临时目录可写', e.message)
  }

  // 6) OneBot 协议端端口探测（可选）
  if (loaded && !noNet) {
    const nap = loaded.runtime.onebot || {}
    for (const [label, url, defPort] of [
      ['OneBot WS 端口', nap.wsUrl, 3001],
      ['OneBot HTTP 端口', nap.httpUrl, 3000],
    ]) {
      if (!url) {
        add(false, label, '未配置')
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await probeEndpoint(url, defPort)
      if (r.ok) add(true, label, r.detail)
      else warn(label, `${r.detail}（协议端未启动时正常；启动后重跑）`)
    }
  } else if (!noNet) {
    warn('OneBot 协议端端口探测', '配置不可用，跳过')
  }

  // 输出清单
  console.log('自检结果：')
  let failCount = 0
  for (const r of results) {
    const icon = r.ok ? (r.warn ? '⚠️ ' : '✅') : '❌'
    if (!r.ok) failCount += 1
    console.log(`  ${icon} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
  }
  const warnCount = results.filter((r) => r.warn).length
  console.log(`\n${failCount === 0 ? '通过' : '未通过'}：失败 ${failCount} 项，警告 ${warnCount} 项，共 ${results.length} 项检查`)
  if (failCount > 0) {
    console.log('提示：先修 ❌ 项；⚠️ 项多数是环境限制或无 QQ 环境下的正常提示。')
    return 1
  }
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// import-legacy
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_TOP_KEYS = new Set(['bridge', 'onebot', 'dsh', 'pacing', 'imagegen', 'parser', 'welcome'])

function cmdImportLegacy(flags, positional) {
  const srcArg = positional[0]
  if (!srcArg) {
    console.error('用法：dsh-onebot-qq import-legacy <旧 config.json 路径> [--out <新配置>] [--data-dir <dir>]')
    return 1
  }
  const src = path.resolve(srcArg)
  if (!fs.existsSync(src)) {
    console.error(`❌ 找不到旧配置：${src}`)
    return 1
  }
  let old
  try {
    old = readJsonFile(src)
  } catch (e) {
    console.error(`❌ 旧配置不是合法 JSON（${e.message}）`)
    return 1
  }
  const dataDir = resolveDataDirFromFlags(flags)
  const outArg = flagString(flags, 'out')
  const out = outArg ? path.resolve(outArg) : path.join(dataDir, 'config.json')
  ensureDir(path.dirname(out))

  const legacy = isLegacyShape(old)
  const migrated = isLegacyShape(old) ? migrateLegacyConfig(old) : migrateLegacyConfig(old)
  const backup = fs.existsSync(out) ? backupFileSync(out, 'bak-import') : ''
  saveConfig(out, migrated, { backup: false })
  chmodBestEffort(out, 0o600)

  const oldKeys = Object.keys(old && typeof old === 'object' ? old : {})
  const kept = oldKeys.filter((k) => LEGACY_TOP_KEYS.has(k))
  const dropped = oldKeys.filter((k) => !LEGACY_TOP_KEYS.has(k))

  console.log(`✅ 已写入 v2 配置：${out}`)
  if (backup) console.log(`ℹ️  原文件已备份：${path.basename(backup)}`)
  if (legacy) console.log('ℹ️  识别为旧版格式（含 bridge 段），已按映射表迁移')
  else console.log('ℹ️  未检测到 bridge 段：仍按映射表归一化（未知键丢弃）')
  console.log(`   保留/迁移的顶层键：${kept.length ? kept.join(', ') : '（无）'}`)
  if (dropped.length) console.log(`   丢弃的未知键：${dropped.join(', ')}`)
  console.log(`
请检查迁移结果（重点）：
  · adminQq                = ${migrated.adminQq || '（未迁移到，请手填）'}
  · onebot.wsUrl/httpUrl   = ${migrated.onebot.wsUrl} / ${migrated.onebot.httpUrl}
  · dsh.qqWorkspacePath    = ${migrated.dsh.qqWorkspacePath}（相对 dataDir 或绝对路径）
  · dsh.sessionsFile       = ${migrated.dsh.sessionsFile}
  · archive.dir            = ${migrated.archive.dir}
提示：旧目录不搬家也可以 —— 把这些路径直接改成现有目录的绝对路径即可（零拷贝）。
`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// persona
// ─────────────────────────────────────────────────────────────────────────────

function readPersonaConfig(dataDir) {
  const configPath = path.join(dataDir, 'config.json')
  if (!fs.existsSync(configPath)) return { configPath, raw: null }
  try {
    const loaded = loadConfig({ dataDir, configPath, createIfMissing: false })
    return { configPath, raw: loaded.raw }
  } catch {
    return { configPath, raw: null }
  }
}

function cmdPersona(flags, positional) {
  const dataDir = resolveDataDirFromFlags(flags)
  const personaDir = path.join(dataDir, 'personas')
  const workspaceDir = path.join(dataDir, 'workspace')
  const action = positional[0] || 'list'
  const { configPath, raw } = readPersonaConfig(dataDir)
  const configured = String(raw?.pluginConfig?.['persona-voice']?.activePersona || '')

  if (action === 'list') {
    const personas = listPersonas(personaDir)
    const active = activePersona({ configured, workspaceDir, personaDir })
    console.log(`人设目录：${personaDir}`)
    console.log(`工作区  ：${workspaceDir}`)
    console.log(`当前人设：${active || '（未设置）'}${configured ? '（来自 config.json）' : ''}`)
    if (!personas.length) {
      console.log('\n⚠️  还没有人设。示例：从 examples/personas 复制 <名字>.md/.lines.txt/.wake.txt 进来。')
      return 0
    }
    console.log(`\n可用人设（${personas.length}）：`)
    for (const name of personas) {
      console.log(`  ${name === active ? '*' : ' '} ${name}`)
    }
    console.log('\n切换：node bin/dsh-onebot-qq.mjs persona use <名字> --data-dir "' + dataDir + '"')
    return 0
  }

  if (action === 'use') {
    const name = positional[1]
    if (!name) {
      console.error('用法：dsh-onebot-qq persona use <名字> [--data-dir <dir>]')
      return 1
    }
    let result
    try {
      result = switchPersona({ workspaceDir, personaDir, name, mode: 'auto' })
    } catch (e) {
      console.error(`❌ ${e.message}`)
      return 1
    }
    console.log(`✅ 已切换人设：${result.name}（${result.mode === 'symlink' ? '软链模式' : '复制模式（无 symlink 权限时的降级）'}）`)
    if (result.missing.length) console.log(`⚠️  缺少文件（对应能力保持默认）：${result.missing.join(', ')}`)
    // 同步 config.json 的 activePersona，否则配置优先级会盖过刚投递的文件
    if (raw) {
      raw.pluginConfig = raw.pluginConfig && typeof raw.pluginConfig === 'object' ? raw.pluginConfig : {}
      raw.pluginConfig['persona-voice'] = { ...(raw.pluginConfig['persona-voice'] || {}), activePersona: result.name }
      saveConfig(configPath, raw, { backup: true })
      console.log(`✅ 已同步 ${path.basename(configPath)} 的 pluginConfig.persona-voice.activePersona`)
    } else {
      console.log('ℹ️  config.json 不存在：仅投递文件 + 写 .persona.json 指针（init 后建议再跑一次）')
    }
    console.log('提示：DSH 会把更新的指令文件当作 "Updated instructions" 在下一轮加载；Linux 软链模式下改人设只换链接。')
    return 0
  }

  console.error(`未知子命令：persona ${action}（可用：list / use）`)
  return 1
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const { flags, positional } = parseArgs(argv)
  if (flags.get('help') || flags.get('h')) {
    printHelp()
    return 0
  }
  if (flags.get('version') || flags.get('V')) {
    console.log(VERSION)
    return 0
  }
  const command = positional.shift()
  switch (command) {
    case 'init':
      return cmdInit(flags)
    case 'doctor':
      return await cmdDoctor(flags)
    case 'import-legacy':
      return cmdImportLegacy(flags, positional)
    case 'persona':
      return cmdPersona(flags, positional)
    case undefined:
      printHelp()
      return 1
    default:
      console.error(`未知命令：${command}\n`)
      printHelp()
      return 1
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    console.error(`❌ ${e?.stack || e?.message || e}`)
    process.exitCode = 1
  })
