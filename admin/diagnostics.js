/**
 * admin/diagnostics.js — **一键诊断 / 运维报告**（脱敏 Markdown + 给 DSH 的修复提示词）。
 *
 * 用户流程（契约 §0）：
 *   控制台 运维 → 「🩺 一键诊断 / 导出运维报告」
 *   → 跑检查（OneBot 连接检查 5s 超时）→ 写 `<dataDir>/reports/diagnose-YYYYMMDD-HHmmss.md`
 *   → 前端弹窗展示摘要 / 报告路径 / 正文 / 复制按钮；可直接把路径交给 DSH 本体修复。
 *
 * 纪律（契约 §2.3，**必须**）：
 *   · token / apiKey / password 原值**永不出现**，只输出「已配置/未配置」；
 *   · QQ 号 / selfId 掩码（前 2 + **** + 后 2，长度 <5 全 *）；
 *   · URL 去掉 userinfo，敏感 query 值替换成 ***，保留 scheme/host/port/path；
 *   · 报告里不输出昵称/群名等用户可控文本（防注入）。
 *
 * 本模块不 spawn 任何命令、不读包外私有路径；写盘走 platform/atomic.js（失败不 throw）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { validateConfig } from '../kernel/config-store.js'
import { atomicWriteFileSync } from '../platform/atomic.js'
import { ensureDir } from '../platform/paths.js'

const requirePkg = createRequire(import.meta.url)

/** 包版本兜底（优先 kernel.version）。 */
const PKG_VERSION = (() => {
  try { return String(requirePkg('../package.json').version || '') } catch { return '' }
})()

/** 必须注册的两个原生工具（带前缀后比对；工具面坏了回话/撤回就不通）。 */
const REQUIRED_TOOLS = ['send_message', 'recall']

/** URL query 里这些键的值要打码。 */
const SENSITIVE_QUERY_KEY = /^(key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|pwd|auth|authorization|sign|signature|sig|credential|credentials)$/i

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const toStr = (v) => (v == null ? '' : String(v)).trim()

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

async function safeAsync(fn, fallback = null) {
  try { return await fn() } catch { return fallback }
}

// ── 脱敏工具（导出便于自检/测试）──────────────────────────────

/** QQ 号 / selfId 掩码：前 2 + `****` + 后 2；长度 <5 时全部 `*`。 */
export function maskQq(value) {
  const raw = toStr(value)
  if (!raw) return '（空）'
  if (raw.length < 5) return '*'.repeat(raw.length)
  return `${raw.slice(0, 2)}****${raw.slice(-2)}`
}

/**
 * URL 脱敏：去掉 userinfo（`://***@`），敏感 query 值替换成 `***`。
 * 非法 URL 返回 `<非法 URL>`（不回显原文，避免把带 token 的坏串写进报告）。
 */
export function sanitizeUrl(value) {
  const raw = toStr(value)
  if (!raw) return ''
  let url
  try { url = new URL(raw) } catch { return '<非法 URL>' }
  if (url.username || url.password) {
    url.username = '***'
    url.password = ''
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '***')
  }
  return url.toString().replace(/\/$/, '')
}

/** 本地时间字符串：`YYYY-MM-DD HH:mm:ss`（报告给人看，别用 UTC）。 */
export function formatTime(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** 报告文件名用的本地时间戳：`YYYYMMDD-HHmmss`。 */
function fileStamp(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

/** 环境变量覆盖标记（生图凭据）。 */
function envOverrides(env = process.env) {
  const set = (name) => toStr(env?.[name]) !== ''
  return {
    protocol: set('QQ_IMAGEGEN_PROTOCOL'),
    baseUrl: set('QQ_IMAGEGEN_BASE_URL'),
    model: set('QQ_IMAGEGEN_MODEL'),
    apiKey: set('QQ_IMAGEGEN_API_KEY'),
  }
}

function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 写一个探针文件（目录可写检查）。成功返回 ''，失败返回原因。 */
function probeWritable(dir) {
  const d = toStr(dir)
  if (!d) return '目录路径为空'
  try {
    ensureDir(d)
    const file = path.join(d, '.diagnose-tmp')
    fs.writeFileSync(file, 'ok')
    fs.unlinkSync(file)
    return ''
  } catch (e) {
    return toStr(e?.message) || '写入失败'
  }
}

// ── 各检查项 ──────────────────────────────────────────────────

function makeCheck(id, label, required, ok, detail, advice = '') {
  return { id, label, required: required !== false, ok: Boolean(ok), detail: toStr(detail), advice: toStr(advice) }
}

function checkConfig(store) {
  let raw
  let configPath = ''
  try {
    configPath = toStr(store?.configPath)
    if (!store || typeof store.read !== 'function') {
      return { raw: {}, check: makeCheck('config', '配置校验', true, false, '没有配置存储句柄（控制台未初始化）', '重启 dsh-web；若仍无控制台，检查插件是否加载成功') }
    }
    raw = store.read()
  } catch (e) {
    return { raw: {}, check: makeCheck('config', '配置校验', true, false, `配置文件读取/解析失败：${toStr(e?.message)}`, '按提示修 config.json（先备份）；或在控制台重新保存一次配置') }
  }
  if (!isPlainObject(raw)) {
    return { raw: {}, check: makeCheck('config', '配置校验', true, false, '配置文件内容不是 JSON 对象', '用示例配置重新生成 config.json（先备份旧文件）') }
  }
  const errors = safe(() => validateConfig(raw), null) || []
  if (errors.length === 0) {
    return { raw, check: makeCheck('config', '配置校验', true, true, '配置可解析且校验通过', '') }
  }
  // 待配置模式：只缺 adminQq 属于 ⚠️（不算 ❌）
  if (errors.length === 1 && /^adminQq 未配置/.test(String(errors[0]))) {
    return {
      raw,
      check: makeCheck('config', '配置校验', false, false, '待配置模式：只缺「主人 QQ」，其余配置有效',
        '在控制台「群聊」页顶部填写主人 QQ 并保存；填完会自动连接 OneBot 协议端'),
    }
  }
  return {
    raw,
    check: makeCheck('config', '配置校验', true, false, `校验未通过：${errors.join('；')}`,
      '按提示改 config.json 或控制台对应页；改前先备份'),
  }
}

function checkAdminQq(raw) {
  const qq = Number(raw?.adminQq)
  if (Number.isInteger(qq) && qq > 0) {
    return makeCheck('adminQq', '主人 QQ', true, true, `已配置（${maskQq(qq)}）`, '')
  }
  return makeCheck('adminQq', '主人 QQ', true, false, '未配置', '在控制台「群聊」页顶部填写主人 QQ（只用于判定主人/脱敏豁免）')
}

function checkDsh(kernel) {
  const health = safe(() => (typeof kernel?.dsh?.health === 'function' ? kernel.dsh.health() : null), null)
  if (!health) {
    return makeCheck('dsh', '宿主会话驱动', true, false, '拿不到 kernel.dsh.health()（内核装配异常）', '重启 dsh-web 并查看日志里内核装配是否成功')
  }
  const linked = Boolean(health.linked ?? true)
  return makeCheck(
    'dsh', '宿主会话驱动', true, linked,
    linked ? `in-process 会话驱动正常（${toStr(health.mode) || 'in-process'}，映射 ${Number(health.sessions ?? health.follows ?? 0)} 条）`
      : '会话驱动未连接（DSH 侧 sessionController 不可用）',
    linked ? '' : '确认 dsh-web 正常运行；重启后看日志是否有 sessionController 相关错误',
  )
}

async function checkAgentPreset(kernel, runtime) {
  const configured = toStr(runtime?.dsh?.agentPreset)
  if (typeof kernel?.checkAgentPreset !== 'function') {
    // 老内核：只展示配置值，无法校验存在性 → 仍算通过（降级）；空值仍提示工具面风险
    return makeCheck(
      'agentPreset', 'Agent 预设', true, Boolean(configured),
      configured ? `已配置 "${configured}"（内核未提供校验能力，未验证存在性）` : '未指定 preset：QQ 线会继承 DSH profile 默认工具面',
      configured ? '' : '建议安装 qq-chat 示例 preset 并在控制台填写（或确认默认工具面可接受）',
    )
  }
  const r = await safeAsync(() => kernel.checkAgentPreset(), null)
  if (!r || typeof r !== 'object') {
    return makeCheck('agentPreset', 'Agent 预设', true, false, 'preset 校验调用失败（内核异常）', '重启 dsh-web；或在控制台把 QQ 线 Agent 预设清空用 DSH 默认')
  }
  if (r.mode === 'default' || !toStr(r.name)) {
    // 空 preset ≠ 安全默认：QQ 线会继承 DSH profile 默认工具面（可能含 bash/文件写入）
    return makeCheck(
      'agentPreset', 'Agent 预设', true, false,
      '未指定 preset：QQ 线将继承 DSH profile 的默认工具面（可能包含 bash/文件写入等）',
      '建议在 profile 里安装 qq-chat 示例 preset（examples/presets/qq-chat.patch.yml），'
        + '然后在控制台「DSH 连接」页把 QQ 线 Agent 预设填成它；只自用且信任群成员时可忽略',
    )
  }
  const name = toStr(r.name)
  if (r.exists === null) {
    return makeCheck('agentPreset', 'Agent 预设', true, true, `已配置 "${name}"（宿主未提供 agentPresets 服务，无法校验存在性）`, '')
  }
  if (r.exists === true) {
    return makeCheck('agentPreset', 'Agent 预设', true, true, `preset "${name}" 存在`, '')
  }
  const presets = Array.isArray(r.presets) ? r.presets.slice(0, 10) : []
  return makeCheck(
    'agentPreset', 'Agent 预设', true, false,
    `preset "${name}" 不存在${presets.length ? `（可用：${presets.join('、')}）` : ''}`,
    '在控制台「DSH 连接」页把 QQ 线 Agent 预设改成存在的 preset（或清空用 DSH 默认）',
  )
}

function checkTools(kernel, runtime) {
  const prefix = toStr(runtime?.toolPrefix) || 'mcp__qq__'
  let names = []
  const status = safe(() => (typeof kernel?.status === 'function' ? kernel.status() : null), null)
  if (status && Array.isArray(status.tools)) names = status.tools.map(String)
  else if (kernel?.toolDefs instanceof Map) names = [...kernel.toolDefs.keys()].map((k) => `${prefix}${k}`)
  else if (Array.isArray(kernel?.tools)) names = kernel.tools.map(String)
  const missing = REQUIRED_TOOLS.filter((t) => !names.includes(`${prefix}${t}`))
  if (names.length < 4) {
    return makeCheck(
      'tools', '原生工具注册', true, false,
      `只注册了 ${names.length} 个工具${missing.length ? `，缺：${missing.join('、')}` : ''}`,
      '重启 dsh-web 并查看日志「已注册 N 个原生工具」；确认插件加载成功（工具注册在 apply 阶段）',
    )
  }
  return makeCheck(
    'tools', '原生工具注册', true, missing.length === 0,
    `已注册 ${names.length} 个工具${missing.length ? `；缺：${missing.join('、')}` : `（${prefix}send_message / recall 等）`}`,
    missing.length ? `缺 ${missing.join('/')}：确认没有插件把工具注册覆盖/停用；重启 dsh-web` : '',
  )
}

async function checkOneBot(kernel, runtime) {
  const wsUrl = sanitizeUrl(runtime?.onebot?.wsUrl)
  const httpUrl = sanitizeUrl(runtime?.onebot?.httpUrl)
  const where = [wsUrl ? `WS ${wsUrl}` : '', httpUrl ? `HTTP ${httpUrl}` : ''].filter(Boolean).join('；')
  let r = null
  if (typeof kernel?.checkOneBot === 'function') {
    r = await safeAsync(() => withTimeout(kernel.checkOneBot(), 5000), null)
  }
  if (!r) {
    // 老内核 / 超时兜底：只看 health
    const health = safe(() => (typeof kernel?.onebot?.health === 'function' ? kernel.onebot.health() : null), null) || {}
    r = health.linked
      ? { ok: true, linked: true, selfId: health.selfId, stale: Boolean(health.stale), latencyMs: null }
      : { ok: false, linked: false, stale: Boolean(health.stale), error: 'OneBot 未连接' }
  }
  const ok = r.ok !== false && r.linked !== false
  const selfId = r.selfId != null ? maskQq(r.selfId) : '（未知）'
  const latency = Number.isFinite(Number(r.latencyMs)) ? `，${Number(r.latencyMs)}ms` : ''
  const detail = ok
    ? `已连接（selfId ${selfId}${latency}）${where ? `；${where}` : ''}`
    : `未连接：${toStr(r.error) || 'OneBot 未连接'}${where ? `；${where}` : ''}`
  return makeCheck(
    'onebot', 'OneBot 连接', true, ok, detail,
    ok ? '' : '确认 OneBot 协议端已启动并开启 OneBot v11 HTTP（常见默认 3000）/ 正向 WS（常见默认 3001）；在控制台「OneBot 连接」页核对地址/token 后点「测试 OneBot 连接」',
  )
}

function checkPersona(kernel) {
  const paths = safe(() => kernel?.paths, null) || {}
  const workspaceDir = toStr(paths.workspaceDir)
  const personaDir = toStr(paths.personaDir)
  const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  const files = ['AGENTS.local.md', 'lines.txt']
  const missing = workspaceDir ? files.filter((f) => !exists(path.join(workspaceDir, f))) : files
  let personaList = null
  if (personaDir) {
    personaList = safe(() => fs.readdirSync(personaDir).filter((n) => /\.md$/i.test(n)), null)
  }
  if (!workspaceDir) {
    return makeCheck('persona', '人设就绪', true, false, '拿不到 QQ 线工作区路径（kernel.paths.workspaceDir 不可用）', '检查实例配置 dsh.qqWorkspacePath；默认人设会在插件启动时自动投递（重启插件即可）')
  }
  if (missing.length) {
    return makeCheck(
      'persona', '人设就绪', true, false,
      `QQ 线工作区缺投递文件：${missing.join('、')}`,
      '重启插件会自动投递内置默认人设；也可以按安装说明在人设库里自己放一套',
    )
  }
  const dirInfo = personaDir
    ? (personaList ? `人设库 ${personaList.length} 套` : '人设目录不可读')
    : '人设目录未配置'
  return makeCheck('persona', '人设就绪', true, true, `投递文件齐全（${files.join(' + ')}）；${dirInfo}`, '')
}

function checkDirs(kernel) {
  const paths = safe(() => kernel?.paths, null) || {}
  const runtime = safe(() => kernel?.runtime, null) || {}
  const dataDir = toStr(paths.dataDir) || toStr(kernel?.dataDir)
  const workspaceDir = toStr(paths.workspaceDir)
  // 运行配置里的一般已是绝对路径；万一给的是相对路径就按 dataDir 解析（绝不写进程 cwd 下的随机目录）
  const absDir = (p) => {
    const s = toStr(p)
    if (!s) return ''
    if (path.isAbsolute(s)) return s
    return dataDir ? path.resolve(dataDir, s) : ''
  }
  const sessionsFile = toStr(runtime?.dsh?.sessionsFile)
  const archiveDir = absDir(runtime?.archive?.dir)
  const dirs = [
    ['数据目录', dataDir],
    ['QQ 线工作区', workspaceDir],
    ['会话映射目录', sessionsFile ? path.dirname(absDir(sessionsFile)) : ''],
    ['聊天留档目录', archiveDir],
  ].filter(([, d]) => d)
  if (!dirs.length) {
    return makeCheck('dirs', '目录可写', true, false, '拿不到任何数据目录路径', '检查 kernel.paths / 实例配置')
  }
  const failures = []
  for (const [label, dir] of dirs) {
    const err = probeWritable(dir)
    if (err) failures.push(`${label}不可写（${toStr(dir)}）：${err}`)
  }
  if (failures.length) {
    return makeCheck('dirs', '目录可写', true, false, failures.join('；'), '检查目录权限/磁盘空间；Windows 可用 icacls 授权，Linux 看 owner/mode；或把 dataDir 换到可写目录')
  }
  return makeCheck('dirs', '目录可写', true, true, `已探测 ${dirs.length} 个目录（写入 .diagnose-tmp 后已删除）`, '')
}

/** 取某插件**已加载**的生效 cfg（内核 buildPluginCfg 的产物）；拿不到返回 {}。 */
function pluginCfgOf(kernel, id) {
  const list = Array.isArray(kernel?.plugins) ? kernel.plugins : []
  const hit = list.find((p) => String(p?.id || p?.plugin?.id || '') === id)
  return hit?.cfg && typeof hit.cfg === 'object' ? hit.cfg : {}
}

function checkImagegen(kernel) {
  const runtime = safe(() => kernel?.runtime, null) || {}
  const cred = isPlainObject(runtime?.credentials?.gptImage) ? runtime.credentials.gptImage : {}
  const env = envOverrides()
  const protocol = toStr(cred.protocol) || 'openai-images'
  const baseUrl = toStr(cred.baseUrl)
  const model = toStr(cred.model)
  const keySet = toStr(cred.apiKey) !== ''
  // 本机 ComfyUI 优先：开着就算"能出图"，不要求中转站 Key
  const ic = safe(() => pluginCfgOf(kernel, 'imagegen'), {}) || {}
  const localOn = ic.localFirst === true
  // 不写死端口/模型：没填就说没填，诊断只反映真实配置
  const localUrl = toStr(ic.localUrl)
  const localAdapter = toStr(ic.localAdapter) === 'simple-api' ? '简易接口' : '官方 ComfyUI'
  // 备用接口（第 3/4 级）：每级一个 BaseUrl 字段，填了才算配
  const fbLevels = [1, 2].filter((n) => toStr(ic['fallback' + n + 'BaseUrl']) !== '')
  const remoteOk = Boolean(baseUrl && keySet)
  const ok = localOn || remoteOk || fbLevels.length > 0
  const localPart = localOn ? `本机 ${localAdapter} 优先（${localUrl ? sanitizeUrl(localUrl) : '地址未填'}；没起来自动回落中转站）` : ''
  const fallbackPart = fbLevels.length ? `备用接口第 ${fbLevels.map((n) => n + 2).join(' / ')} 级（主站失败才用）` : ''
  const remotePart = remoteOk
    ? `中转站已配置（协议 ${protocol}，模型 ${model || '未指定'}，地址 ${sanitizeUrl(baseUrl)}，API Key 已配置${env.apiKey ? '（环境变量覆盖）' : ''}）`
    : `中转站未配置（协议 ${protocol}，模型 ${model || '未指定'}${baseUrl ? `，地址 ${sanitizeUrl(baseUrl)}` : '，地址未填'}，API Key ${keySet ? '已配置' : '未配置'}）`
  const detail = [localPart, remotePart, fallbackPart].filter(Boolean).join('；')
  return makeCheck(
    'imagegen', '生图配置（可选）', false, ok, detail,
    ok ? '' : '可选能力：控制台「生图」页填协议/地址/模型/API Key（或打开「优先用本机 ComfyUI」）后点「检查生图配置」；不配不影响文字聊天',
  )
}

function checkLinkParser(kernel) {
  const plugin = Array.isArray(kernel?.plugins)
    ? kernel.plugins.find((p) => String(p?.id || p?.plugin?.id || '') === 'link-parser')
    : null
  const cfg = isPlainObject(plugin?.cfg) ? plugin.cfg : null
  const rtCfg = isPlainObject(kernel?.runtime?.pluginConfig?.['link-parser']) ? kernel.runtime.pluginConfig['link-parser'] : null
  const merged = { ...(rtCfg || {}), ...(cfg || {}) }
  const enabled = merged.enabled !== false
  const parserUrl = toStr(merged.parserUrl)
  if (!enabled) {
    return makeCheck('linkParser', '链接解析（可选）', false, true, '未启用（可选能力）', '')
  }
  if (!parserUrl) {
    return makeCheck(
      'linkParser', '链接解析（可选）', false, false,
      '已启用但未配置解析侧车地址',
      '在控制台「链接解析」页填侧车地址；不需要就在「子插件」页停用 link-parser',
    )
  }
  return makeCheck(
    'linkParser', '链接解析（可选）', false, false,
    `已启用，依赖外部解析侧车（地址 ${sanitizeUrl(parserUrl)}）；侧车不在本插件包内`,
    '确认本机解析侧车在运行并监听该地址；不需要可在「子插件」页停用 link-parser',
  )
}

function checkRuntime(kernel, runtime) {
  const paths = safe(() => kernel?.paths, null) || {}
  const version = toStr(kernel?.version) || PKG_VERSION || '?'
  const detail = [
    `版本 ${version}`,
    `${toStr(process.platform)} ${toStr(process.arch)}`,
    `Node ${toStr(process.version)}`,
    `数据目录 ${toStr(paths.dataDir) || toStr(kernel?.dataDir) || '?'}`,
    `配置 ${toStr(kernel?.configPath) || '?'}`,
  ].join(' · ')
  return makeCheck('runtime', '运行信息', false, true, detail, '')
}

// ── 报告渲染 ──────────────────────────────────────────────────

function badgeOf(check) {
  if (check.ok) return '✅'
  return check.required ? '❌' : '⚠️'
}

function renderReport({ checks, summary, generatedAt, version, reportPath, writeError, dataDir, configPath }) {
  const lines = []
  lines.push('# dsh-onebot-qq 运维诊断报告', '')
  lines.push(`- 生成时间：${generatedAt}`)
  lines.push(`- 插件版本：${version || '?'}`)
  lines.push(`- 运行环境：${toStr(process.platform)} ${toStr(process.arch)} · Node ${toStr(process.version)}`)
  if (dataDir) lines.push(`- 数据目录：${dataDir}`)
  if (configPath) lines.push(`- 配置文件：${configPath}`)
  if (writeError) lines.push('- ⚠️ 报告落盘失败：' + writeError)
  lines.push('')
  lines.push(`- 结论：${summary.text}`)
  lines.push('')
  lines.push('## 检查结果')
  lines.push('')
  lines.push('| 项 | 结果 | 说明 |')
  lines.push('| --- | --- | --- |')
  for (const c of checks) {
    const detail = String(c.detail || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    lines.push(`| ${c.label} | ${badgeOf(c)} | ${detail} |`)
  }
  lines.push('')
  lines.push('## 建议（按顺序处理）')
  lines.push('')
  const actionable = checks.filter((c) => !c.ok)
  if (!actionable.length) {
    lines.push('无需处理：本次诊断未发现需要修复的问题。')
  } else {
    actionable.forEach((c, i) => {
      const advice = c.advice || c.detail || '按检查结果处理'
      lines.push(`${i + 1}. [${c.label}] ${advice}`)
    })
  }
  lines.push('')
  lines.push('## 交给 DSH 本体修复')
  lines.push('')
  lines.push('把下面这段连同报告路径一起发给 DSH：')
  lines.push('')
  const target = reportPath ? `\`${reportPath}\`` : '（报告未落盘：请让用户把本文件正文贴给 DSH）'
  lines.push('> 请阅读 ' + target + '，按「建议」逐项修复 dsh-onebot-qq 的配置/环境；')
  lines.push('> 需要改配置文件时先备份；不要把 token/API Key 回显到聊天里；改完按报告末尾的复检命令再跑一次诊断。')
  lines.push('')
  lines.push('## 复检')
  lines.push('')
  lines.push('- 控制台：运维 → 🩺 一键诊断 / 导出运维报告')
  lines.push('- CLI：`node bin/dsh-onebot-qq.mjs doctor`')
  lines.push('- 本机测试：`node --test test/e2e.test.js`')
  lines.push('')
  lines.push('## 隐私')
  lines.push('')
  lines.push('本报告已脱敏：不含 WS/HTTP token、API Key 原值；QQ 号/selfId 已打码。')
  lines.push('仍含本机路径与内网地址，公开前请自行检查。')
  lines.push('')
  return lines.join('\n')
}

// ── 主入口 ────────────────────────────────────────────────────

/**
 * 跑一次完整诊断并生成脱敏报告。
 *
 * @param {object} opts
 * @param {object} opts.kernel 内核对象（检查/回调都从这拿，全部可选降级）
 * @param {object} opts.store  admin/store.js 的 store（用 read()/configPath）
 * @param {object} [opts.log]
 * @param {number|Date} [opts.now] 固定时间（测试用）
 * @returns {Promise<{ok:true, generatedAt:string, checks:object[], summary:{pass:number,fail:number,warn:number,text:string}, report:string, reportPath:string, fixPrompt:string}>}
 */
export async function runDiagnostics({ kernel = {}, store = null, log = console, now = Date.now() } = {}) {
  const ms = now instanceof Date ? now.getTime() : (Number(now) || Date.now())
  const generatedAt = formatTime(ms)
  const runtime = safe(() => kernel?.runtime, null) || {}
  const version = toStr(kernel?.version) || PKG_VERSION || '?'
  const checks = []

  try {
    // ① 配置 / 主人 QQ（config 检查顺带把 raw 带出来给后续用）
    const configResult = checkConfig(store)
    const raw = configResult.raw || {}
    checks.push(configResult.check)
    checks.push(checkAdminQq(raw))
    // ② DSH / preset / 工具
    checks.push(checkDsh(kernel))
    checks.push(await checkAgentPreset(kernel, runtime))
    checks.push(checkTools(kernel, runtime))
    // ③ OneBot 连接 / 人设 / 目录
    checks.push(await checkOneBot(kernel, runtime))
    checks.push(checkPersona(kernel))
    checks.push(checkDirs(kernel))
    // ④ 可选能力 + 运行信息
    checks.push(checkImagegen(kernel))
    checks.push(checkLinkParser(kernel))
    checks.push(checkRuntime(kernel, runtime))
  } catch (e) {
    // 任何单项意外都不影响整体诊断：兜底成一条 ❌
    checks.push(makeCheck('runtime', '运行信息', false, false, `诊断过程异常：${toStr(e?.message)}`, '重启 dsh-web 后重试；若持续失败把本条贴给 DSH'))
  }

  const fails = checks.filter((c) => !c.ok && c.required)
  const warns = checks.filter((c) => !c.ok && !c.required)
  const pass = checks.filter((c) => c.ok).length
  const textParts = []
  if (fails.length) textParts.push(`${fails.length} 项需处理：${fails.map((c) => c.label).join('、')}`)
  else textParts.push('必填项全部通过')
  if (warns.length) textParts.push(`${warns.length} 项提示（${warns.map((c) => c.label).join('、')}）`)
  const summary = { pass, fail: fails.length, warn: warns.length, text: textParts.join('；') }

  // 报告路径（先算好，写进「交给 DSH」段）
  const paths = safe(() => kernel?.paths, null) || {}
  const dataDir = toStr(paths.dataDir) || toStr(kernel?.dataDir) || toStr(safe(() => path.dirname(toStr(store?.configPath)), ''))
  const configPath = toStr(kernel?.configPath) || toStr(safe(() => store?.configPath, ''))
  const reportsDir = dataDir ? path.join(dataDir, 'reports') : ''
  let reportPath = reportsDir ? path.join(reportsDir, `diagnose-${fileStamp(ms)}.md`) : ''
  let writeError = ''

  let report = renderReport({ checks, summary, generatedAt, version, reportPath, writeError, dataDir, configPath })
  if (reportPath) {
    try {
      ensureDir(reportsDir)
      atomicWriteFileSync(reportPath, report)
    } catch (e) {
      writeError = toStr(e?.message) || '写入失败'
      reportPath = ''
      report = renderReport({ checks, summary, generatedAt, version, reportPath: '', writeError, dataDir, configPath })
      try { log?.warn?.(`[诊断] 报告落盘失败：${writeError}`) } catch { /* ignore */ }
    }
  } else {
    writeError = '数据目录路径不可用'
    report = renderReport({ checks, summary, generatedAt, version, reportPath: '', writeError, dataDir, configPath })
  }

  const fixPrompt = reportPath
    ? `请阅读 \`${reportPath}\`，按「建议」逐项修复 dsh-onebot-qq 的配置/环境；需要改配置文件时先备份；不要把 token/API Key 回显到聊天里；改完按报告末尾的复检命令再跑一次诊断。`
    : '（报告未能落盘）请让控制台重新执行「🩺 一键诊断 / 导出运维报告」，然后把报告正文贴给 DSH，让它按「建议」逐项修复 dsh-onebot-qq 的配置/环境；改前先备份，不要把 token/API Key 回显到聊天里。'

  try { log?.info?.(`[诊断] ${summary.text}${reportPath ? `；报告：${reportPath}` : '；报告落盘失败'}`) } catch { /* ignore */ }

  return { ok: true, generatedAt, checks, summary, report, reportPath, fixPrompt }
}
