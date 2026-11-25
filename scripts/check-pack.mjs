#!/usr/bin/env node
/**
 * scripts/check-pack.mjs — npm 包内容守卫。
 *
 * 用 `npm pack --dry-run --json --ignore-scripts` 拿到真实打包清单，断言：
 *   · 不含备份（*.bak-*）、旧实现（standalone.js / *_v1.js / _reference / qq-mcp.js / admin-api.js）；
 *   · 不含实例配置/会话/数据（config.json、sessions*.json、data/、ops.local.mjs）；
 *   · 不含 test/、node_modules/、.env、tgz；
 *   · 必含入口/许可/locale/icon/patch/文档关键文件。
 * 同时打印清单摘要（文件数、总大小、各顶层目录分布、>256KiB 的大文件）。
 *
 * 注意：`--ignore-scripts` 是必须的 —— 否则 `prepack` 会再次调用本脚本造成递归。
 * 退出码：0 = 清单合规；1 = 违规或 npm pack 失败。
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'

/** 禁止出现的路径（正则，对 package 内相对 posix 路径匹配）。 */
const FORBIDDEN = [
  { re: /(^|\/)\.bak-|\.bak-[^/]*$/, why: '备份文件（*.bak-*）' },
  { re: /(^|\/)standalone\.js$/, why: '旧 standalone 入口（v2 不再提供）' },
  { re: /(^|\/)qq-mcp\.js$/, why: '旧 MCP server（工具改为内核原生注册）' },
  { re: /(^|\/)admin-api\.js$/, why: '旧 admin-api（控制面已并入 admin/）' },
  { re: /\.v1\.js$/, why: '旧版本源码副本（_reference）' },
  { re: /(^|\/)_reference(\/|$)/, why: '旧实现只读参考目录' },
  { re: /(^|\/)test(\/|$)/, why: '测试目录不进包' },
  { re: /(^|\/)data(\/|$)/, why: '运行数据目录不进包' },
  { re: /(^|\/)node_modules(\/|$)/, why: 'node_modules 不进包' },
  { re: /(^|\/)ops\.local\.mjs$/, why: '站点私有运维实现（ops.local.mjs）' },
  { re: /(^|\/)\.env(\..*)?$/, why: '环境/凭据文件' },
  { re: /\.tgz$|\.tar\.gz$/, why: '打包产物不应嵌套' },
  { re: /(^|\/)sessions[^/]*\.json$/, why: '会话映射（含 chatKey/sessionId）' },
  // 2026-11-25 起 sidecar 随包发布；进包的是**模板**（token/路径全空），不是站点私有配置。
  // 必须排在下面的 config.json 规则**之前**：命中 allow 就先 break 掉，否则会被误杀。
  { re: /^sidecar\/sidecar\.config\.json$/, why: '', allow: true },
  { re: /(^|\/)config\.json$/, why: '实例配置（含 QQ/token），只允许 examples/config.example.json' },
  { re: /(^|\/)\.github(\/|$)/, why: 'CI 配置不进包' },
]

/** 必含文件。 */
const REQUIRED = [
  'package.json',
  'index.js',
  'contracts.js',
  'bin/dsh-onebot-qq.mjs',
  'kernel/config-store.js',
  'platform/paths.js',
  'admin/schema.js',
  'ops/provider.js',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/README.md',
  'docs/使用说明书.md',
  'docs/开发指南.md',
  'docs/安装与卸载.md',
  'docs/配置参考.md',
  'docs/Windows安装.md',
  'docs/排错.md',
  'docs/运维接口.md',
  'examples/config.example.json',
  'examples/cordis.patch.yml',
  'examples/presets/qq-chat.patch.yml',
  'examples/windows/setup.ps1',
  // 2026-11-25：侧车随包发布（零 npm 依赖的独立 HTTP 服务）
  'sidecar/server.mjs',
  'sidecar/subtitle.mjs',
  'sidecar/sidecar.config.json',
  'sidecar/README.md',
  'sidecar/start.bat',
  'sidecar/stop.bat',
]

const npmCmd = IS_WIN ? 'npm.cmd' : 'npm'
const run = spawnSync(npmCmd, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: IS_WIN,
  env: { ...process.env, npm_config_loglevel: 'error' },
})

if (run.error) {
  console.error(`[check-pack] 无法执行 npm pack：${run.error.message}`)
  process.exit(1)
}
if (run.status !== 0) {
  console.error('[check-pack] npm pack --dry-run 失败：')
  console.error(String(run.stderr || '').trim())
  process.exit(1)
}

/** npm 的 JSON 输出可能夹日志行；从第一个 `[` 起解析。 */
function parsePackJson(stdout) {
  const text = String(stdout || '')
  const start = text.indexOf('[')
  if (start === -1) throw new Error('npm pack 输出里没有 JSON')
  return JSON.parse(text.slice(start))
}

let result
try {
  result = parsePackJson(run.stdout)
} catch (e) {
  console.error(`[check-pack] 解析 npm pack JSON 失败：${e.message}`)
  console.error(String(run.stdout || '').slice(0, 2000))
  process.exit(1)
}

const info = Array.isArray(result) ? result[0] : result
const files = Array.isArray(info?.files) ? info.files : []
if (files.length === 0) {
  console.error('[check-pack] npm pack 清单为空')
  process.exit(1)
}

const paths = files.map((f) => String(f.path).split(path.sep).join('/')).sort()

const violations = []
for (const p of paths) {
  for (const rule of FORBIDDEN) {
    if (!rule.re.test(p)) continue
    if (rule.allow) break // 规则带 allow：命中即放行，且不再看后面的规则
    if (p === 'examples/config.example.json') continue // 示例配置是有意为之
    violations.push({ path: p, why: rule.why })
    break
  }
}
for (const required of REQUIRED) {
  if (!paths.includes(required)) violations.push({ path: required, why: '缺少必需文件' })
}

/** 摘要：顶层分布 + 大文件。 */
const buckets = new Map()
let totalBytes = 0
const big = []
for (const f of files) {
  const p = String(f.path).split(path.sep).join('/')
  const size = Number(f.size) || 0
  totalBytes += size
  const top = p.includes('/') ? p.split('/')[0] : '(root)'
  buckets.set(top, (buckets.get(top) || 0) + 1)
  if (size > 256 * 1024) big.push({ path: p, size })
}

console.error('[check-pack] 清单摘要：')
console.error(`  文件数 ${files.length}，解包大小 ${(totalBytes / 1024).toFixed(1)} KiB，tgz ${info.size ?? '?'} bytes`)
const bucketLine = [...buckets.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([name, count]) => `${name}:${count}`)
  .join('  ')
console.error(`  顶层分布 ${bucketLine}`)
if (big.length) {
  console.error('  大文件：')
  for (const b of big.sort((a, b) => b.size - a.size)) console.error(`    ${(b.size / 1024).toFixed(0)} KiB  ${b.path}`)
}

if (violations.length) {
  console.error(`\n[check-pack] FAIL ${violations.length} 处清单违规：`)
  for (const v of violations) console.error(`  ${v.path}  —  ${v.why}`)
  process.exit(1)
}

console.error('[check-pack] OK 打包清单合规（无备份/旧实现/配置/数据/测试）')
