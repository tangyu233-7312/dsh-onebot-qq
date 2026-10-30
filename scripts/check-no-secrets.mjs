#!/usr/bin/env node
/**
 * scripts/check-no-secrets.mjs — 打包前隐私/凭据守卫。
 *
 * 扫描范围 = `package.json` 的 `files` 白名单展开（运行文件 + docs + README + examples + locale…）
 *            + `test/`（不发布但会进 git，同样不能带真实号）。
 * 规则：
 *   1. 私有绝对路径：`/opt/…`、`/root/…`、`/var/log/…`、`C:\Users\<真名>`；
 *   2. QQ 号：QQ 字段上下文里的 5–12 位数字 + 裸 10/11 位号码；占位值放过。
 *   3. 凭据：`sk-…`、`apiKey/token/secret/password` 后跟长字面量（占位符放过）。
 *   4. 私有名词（可选）：环境变量 `QQ_BOT_PRIVATE_NAMES=名字1,名字2` 时一并扫描（站点 CI 用，不进仓库）。
 *
 * 退出码：0 = 干净；1 = 命中。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** --with-tests：把 test/ 也纳入扫描（测试会进 git，同样不能带真实号）。 */
const WITH_TESTS = process.argv.includes('--with-tests')
const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.svg',
  '.ps1', '.sh', '.example', '.html', '.css',
])
const SKIP_DIRS = new Set(['node_modules', '.git', '_reference', 'coverage', 'data', 'dist'])

/** 允许出现"旧路径说明"的文件（当前为空：历史迁移文档已移除）。 */
const LEGACY_PATH_WHITELIST = new Set()

/** 合成占位 QQ（文档/示例/测试统一用这些值；真实号码一律不放过）。 */
const SAFE_QQ = new Set([
  '10000', '10001', '10002', '20001', '20002', '30001',
  '12345', '123456', '1234567', '12345678', '123456789', '1234567890',
  '99999', '999999', '9999999',
])

/**
 * 测试夹具用的**合成**号码/凭据（2026-10-30）。
 * 给测试目录一个可审计的白名单，而不是在规则里写一堆特例：
 * 只有这几个值算"明显是假的"，其它一律照常报。
 */
const TEST_FIXTURE_LITERALS = new Set([
  '1122334455', '2233445566', // 群记忆积累测试里的两个群
  '888888', '555555', '987654321', '5e5' // @ / 群号 用例
  , '50001', '50002'          // 普通群友
  , '3505422215'              // bot_offline 用例的 user_id
  , '1700000000'              // 秒级时间戳（被当成 10 位号码）
  , '198.51.100.42', '8444'   // RFC 5737 文档专用 IP
  , 'super-secret-api-key', 'SUPER_SECRET_TOKEN_123'
  , 'sk-proj-abcdefgh1234', 'sk-abcdefgh12345678'
])

/** 明显不是 QQ 的常见文档数字常量。 */
const SAFE_NUMBERS = new Set([
  '104857600', '1073741824', '2147483647', '4294967295', '4294967296',
  // 数字输入框的上界（QQ 号/群号 max 之类的 schema 常量，不是真实号码）
  '9999999999', '99999999999', '999999999999',
])

/** 占位符判定：文档里写 `YOUR_TOKEN` / `<token>` / `REPLACE_ME` 这类不算泄露。 */
const PLACEHOLDER_RE =
  /^(?:<[^>]*>|YOUR[_A-Z-]*|EXAMPLE|PLACEHOLDER|CHANGE[_-]?ME|REPLACE[_-]?ME|REDACTED|TODO|xxx+|\*+|\.{3}|…)/i

function isPlaceholder(value) {
  const v = String(value ?? '').trim()
  if (!v) return true
  if (PLACEHOLDER_RE.test(v)) return true
  if (new Set(v).size <= 2) return true
  return false
}

/** 从 package.json 的 files 白名单展开待扫描文件（文件不存在则忽略）。 */
function collectFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const entries = Array.isArray(pkg.files) ? pkg.files : []
  const out = new Set()
  const addFile = (abs) => {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return
    if (!TEXT_EXTS.has(path.extname(abs).toLowerCase()) && path.basename(abs) !== 'LICENSE') return
    out.add(abs)
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        addFile(path.join(dir, entry.name))
      }
    }
  }
  for (const entry of entries) {
    const abs = path.join(ROOT, entry)
    if (!fs.existsSync(abs)) continue
    if (fs.statSync(abs).isDirectory()) walk(abs)
    else addFile(abs)
  }
  // README/LICENSE/CHANGELOG 已在 files 里；这里兜底再扫一次顶层说明文件。
  for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE']) addFile(path.join(ROOT, name))
  // test/ 不发布，但它会进 git（2026-10-30：测试里写了真实 QQ 号，差点提交）。
  // 默认走 package.json 白名单（与打包一致）；加 --with-tests 才把测试也算进来。
  // CI 里建议两个都跑：打包卫生 + 仓库卫生。
  if (WITH_TESTS) {
    const testDir = path.join(ROOT, 'test')
    if (fs.existsSync(testDir)) walk(testDir)
  }
  return [...out].sort()
}

function* iterLines(text) {
  let start = 0
  let lineNo = 1
  while (start <= text.length) {
    const idx = text.indexOf('\n', start)
    const end = idx === -1 ? text.length : idx
    yield { lineNo, line: text.slice(start, end) }
    if (idx === -1) break
    start = idx + 1
    lineNo += 1
  }
}

/** 逐行规则表。`allow` = 允许命中该规则的文件（仓库相对路径，posix 分隔符）。 */
const LINE_RULES = [
  {
    name: 'private-path:/opt',
    re: /\/opt\/[A-Za-z0-9._/-]+/g,
    allow: LEGACY_PATH_WHITELIST,
    message: '私有绝对路径（生产部署目录），文档/示例请改用 dataDir 或占位路径',
  },
  {
    name: 'private-path:/root',
    re: /\/root\/[A-Za-z0-9._/-]+/g,
    allow: LEGACY_PATH_WHITELIST,
    message: '私有绝对路径（站点用户主目录），文档/示例请改用 <dataDir> 或相对路径',
  },
  {
    name: 'private-path:/var/log',
    re: /\/var\/log\/[A-Za-z0-9._/-]+/g,
    allow: LEGACY_PATH_WHITELIST,
    message: '私有绝对路径（站点日志目录），请改用配置项或相对路径',
  },
  {
    name: 'private-path:C:\\Users',
    re: /C:\\Users\\(?!(?:<|%|你的|YOUR|USER|user|username|用户名)[^\\\s]*)[A-Za-z0-9._-]+/g,
    allow: LEGACY_PATH_WHITELIST,
    message: '疑似真实 Windows 用户目录，请改用 C:\\... 或 %USERPROFILE% 占位',
  },
  {
    name: 'credential:sk-',
    re: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_-]{9,}/g,
    message: '疑似 API Key（sk- 前缀字面量）',
  },
  {
    name: 'qq:context',
    re: /(?:adminQq|admin_qq|at_qq|group_id|user_id|sender_qq|target_qq|qq_?id|QQ号|群号)[^\d\n]{0,20}(\d{5,12})/gi,
    message: '疑似真实 QQ/群号（请换成 10001 等占位值）',
  },
  {
    name: 'qq:bare-10-11',
    re: /(?:^|[^\d])([1-9]\d{9,10})(?![\d])/g,
    message: '疑似 10/11 位真实 QQ 号（请换成占位值）',
  },
  {
    name: 'credential:assignment',
    re: /\b(?:api[_-]?key|apikey|token|secret|password|passwd|credential)s?\b["']?\s*[:=]\s*["']([^"'\n]{16,})["']/gi,
    message: '疑似凭据字面量（请用空串、环境变量或 YOUR_*_TOKEN 占位）',
  },
]

const hits = []
function addHit(file, lineNo, rule, message, detail) {
  hits.push({ file, lineNo, rule, message, detail })
}

const files = collectFiles()
if (files.length === 0) {
  console.error('[check-secrets] 没找到可扫描文件（检查 package.json files）')
  process.exit(1)
}

const privateNames = String(process.env.QQ_BOT_PRIVATE_NAMES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  const buf = fs.readFileSync(abs)
  if (buf.includes(0)) continue // 二进制（图标等）跳过
  const text = buf.toString('utf8')

  for (const { lineNo, line } of iterLines(text)) {
    for (const rule of LINE_RULES) {
      if (rule.allow?.has(rel)) continue
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(line)) !== null) {
        const captured = m[1] ?? m[0]
        // 测试夹具里的合成值（只在 --with-tests 时生效之外也放过：
        // 这些值出现在文档/示例里同样不该报警）
        if (TEST_FIXTURE_LITERALS.has(String(captured).trim()) || TEST_FIXTURE_LITERALS.has(String(m[0]).trim())) continue
        if (rule.name.startsWith('qq:')) {
          const num = String(captured).replace(/^\D+/, '')
          if (SAFE_QQ.has(num) || SAFE_NUMBERS.has(num)) continue
          if (TEST_FIXTURE_LITERALS.has(num)) continue
        }
        if (rule.name === 'credential:sk-') {
          // m[0] 可能是 'api_key=sk-xxx' 这种整体，把里面的 sk- 片段抽出来比对白名单
          const skPart = (String(m[0]).match(/sk-[A-Za-z0-9_-]+/) || [''])[0]
          if (skPart && TEST_FIXTURE_LITERALS.has(skPart)) continue
        }
        if (rule.name === 'credential:sk-' && /(?:YOUR|EXAMPLE|REPLACE|PLACEHOLDER|xxx|REDACTED)/i.test(m[0])) continue
        if (rule.name === 'credential:assignment' && isPlaceholder(captured)) continue
        addHit(rel, lineNo, rule.name, rule.message, line.trim().slice(0, 120))
        break // 同一行同一规则只报一次
      }
    }
    if (privateNames.length) {
      for (const name of privateNames) {
        if (line.includes(name)) addHit(rel, lineNo, 'private-name', `命中私有名词：${name}`, line.trim().slice(0, 120))
      }
    }
  }
}

if (hits.length) {
  console.error(`[check-secrets] FAIL ${hits.length} 处疑似隐私/凭据（扫描 ${files.length} 个文件）：`)
  const byFile = new Map()
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, [])
    byFile.get(h.file).push(h)
  }
  for (const [file, list] of byFile) {
    console.error(`\n${file}`)
    for (const h of list) console.error(`  ${h.lineNo}: [${h.rule}] ${h.message}\n      ${h.detail}`)
  }
  process.exit(1)
}

console.error(`[check-secrets] OK 扫描 ${files.length} 个文件，未发现私有路径 / QQ 号 / 凭据字面量`)
