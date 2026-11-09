/**
 * test/bin.test.js — 跨平台 CLI（bin/dsh-onebot-qq.mjs）的行为测试。
 *
 * 全部在 os.tmpdir() 的临时数据目录里跑，用 spawnSync 调 node（不依赖 shell / bash / chmod）。
 * 覆盖：init（目录/配置/模板、幂等、--force）、doctor（配置校验/退出码/--no-net）、
 * import-legacy（旧格式迁移 + 备份）、persona list/use、--help/--version、错误参数退出码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'dsh-onebot-qq.mjs')

function tmpDir(tag = 'bin') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-${tag}-`))
}

/** 跑 CLI；返回 { status, stdout, stderr }。用参数数组，跨平台不经过 shell。 */
function runCli(args, { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

function readConfig(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
}

function writeValidConfig(dataDir) {
  const file = path.join(dataDir, 'config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.adminQq = 10001
  raw.onebot = { wsUrl: 'ws://127.0.0.1:3001', wsToken: '', httpUrl: 'http://127.0.0.1:3000', httpToken: '' }
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 4)}\n`)
}

test('init：建数据目录 + 默认配置（adminQq=0）+ 复制模板；可重复运行不覆盖', () => {
  const base = tmpDir('init')
  const dataDir = path.join(base, 'qq bot data') // 含空格，验证路径处理
  const r = runCli(['init', '--data-dir', dataDir], { env: { DSH_HOME: path.join(base, 'dsh-home') } })
  assert.equal(r.status, 0, r.stderr)

  // 子目录
  for (const sub of [
    'workspace', 'personas', 'qq-stickers', 'long-memory', 'qq-welcome-images',
    'qq_uploads', 'qq-refs', 'logs/qq_chat', 'state',
  ]) {
    assert.ok(fs.existsSync(path.join(dataDir, sub)), `应创建子目录 ${sub}`)
  }
  // 实例配置：v2、adminQq 占位 0、OneBot 有默认地址
  const cfg = readConfig(dataDir)
  assert.equal(cfg.version, 2)
  assert.equal(cfg.adminQq, 0)
  assert.equal(cfg.onebot.wsUrl, 'ws://127.0.0.1:3001')
  // 模板文件
  assert.ok(fs.existsSync(path.join(dataDir, 'workspace', 'AGENTS.md')), 'workspace 应有 AGENTS.md 模板')
  assert.ok(fs.existsSync(path.join(dataDir, 'workspace', 'CLAUDE.local.md')))
  assert.ok(fs.existsSync(path.join(dataDir, 'workspace', 'lines.default.txt')))
  assert.ok(fs.existsSync(path.join(dataDir, 'personas', '_default.lines.txt')))

  // 默认人设：文件就位 + 已投递到 workspace + config 里 activePersona 已写
  for (const name of ['蓝色大肥鱼.md', '蓝色大肥鱼.lines.txt', '蓝色大肥鱼.wake.txt']) {
    assert.ok(fs.existsSync(path.join(dataDir, 'personas', name)), `应复制默认人设 ${name}`)
  }
  for (const name of ['AGENTS.local.md', 'lines.txt', 'wake.txt']) {
    assert.ok(fs.existsSync(path.join(dataDir, 'workspace', name)), `默认人设应投递 ${name}`)
  }
  assert.equal(
    readConfig(dataDir).pluginConfig?.['persona-voice']?.activePersona,
    '蓝色大肥鱼',
    'init 应把 activePersona 写为「蓝色大肥鱼」',
  )

  // 幂等：用户改过的文件与配置不因再次 init 而被覆盖
  const agents = path.join(dataDir, 'workspace', 'AGENTS.md')
  fs.writeFileSync(agents, '# 我自己的规则\n')
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ...cfg, adminQq: 10001 }, null, 2))
  const personaLines = path.join(dataDir, 'personas', '蓝色大肥鱼.lines.txt')
  fs.writeFileSync(personaLines, '## poke\n我改过的句子\n')
  const r2 = runCli(['init', '--data-dir', dataDir])
  assert.equal(r2.status, 0)
  assert.equal(fs.readFileSync(agents, 'utf8'), '# 我自己的规则\n', '再次 init 不覆盖已有模板')
  assert.equal(readConfig(dataDir).adminQq, 10001, '再次 init 不覆盖已有配置')
  assert.equal(fs.readFileSync(personaLines, 'utf8'), '## poke\n我改过的句子\n', '再次 init 不覆盖用户改过的人设')
  assert.match(r2.stdout, /人设已存在/, '人设已投递时再次 init 应提示跳过')

  // --force：覆盖配置（先备份），模板仍不覆盖
  const r3 = runCli(['init', '--data-dir', dataDir, '--force'])
  assert.equal(r3.status, 0)
  assert.equal(readConfig(dataDir).adminQq, 0, '--force 重置配置')
  const backups = fs.readdirSync(dataDir).filter((n) => n.startsWith('config.json.bak-init-'))
  assert.ok(backups.length >= 1, '覆盖前应备份旧配置')
  assert.equal(fs.readFileSync(agents, 'utf8'), '# 我自己的规则\n', '--force 也不覆盖模板')
})

test('doctor：缺必填项 → 退出码 1；填好后 → 退出码 0（--no-net 不探测端口）', () => {
  const base = tmpDir('doctor')
  const dataDir = path.join(base, 'data')

  // 未 init：配置不存在
  const missing = runCli(['doctor', '--data-dir', dataDir, '--no-net'], { env: { DSH_HOME: path.join(base, 'home') } })
  assert.equal(missing.status, 1, '没有配置必须退出码 1')
  assert.match(missing.stdout, /❌/)

  // init 后 adminQq=0 → 仍失败，且明确报 adminQq
  assert.equal(runCli(['init', '--data-dir', dataDir]).status, 0)
  const bad = runCli(['doctor', '--data-dir', dataDir, '--no-net'])
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /adminQq/)
  assert.match(bad.stdout, /❌/)

  // 填好必填项 → 通过（--no-net 跳过 OneBot 端口探测）
  writeValidConfig(dataDir)
  const good = runCli(['doctor', '--data-dir', dataDir, '--no-net'])
  assert.equal(good.status, 0, good.stdout + good.stderr)
  assert.doesNotMatch(good.stdout, /❌/, '通过时不应有 ❌')
  assert.match(good.stdout, /Node/)
  assert.match(good.stdout, /数据目录可写/)
  assert.match(good.stdout, /人设 — 蓝色大肥鱼/, 'doctor 应显示当前人设与投递文件')

  // 投递文件缺失 → 人设项降级为 ⚠️（不改变退出码）
  for (const name of ['AGENTS.local.md', 'lines.txt', 'wake.txt']) fs.rmSync(path.join(dataDir, 'workspace', name), { force: true })
  fs.rmSync(path.join(dataDir, 'workspace', '.persona.json'), { force: true })
  const noDelivery = runCli(['doctor', '--data-dir', dataDir, '--no-net'])
  assert.equal(noDelivery.status, 0, '人设缺失只是警告，不影响通过')
  assert.match(noDelivery.stdout, /人设投递/)
})

test('persona：list 列出默认人设；use 投递文件并同步 config.json', () => {
  const base = tmpDir('persona')
  const dataDir = path.join(base, 'data')
  assert.equal(runCli(['init', '--data-dir', dataDir]).status, 0)

  const listBefore = runCli(['persona', 'list', '--data-dir', dataDir])
  assert.equal(listBefore.status, 0)
  assert.match(listBefore.stdout, /蓝色大肥鱼/, 'init 已投递内置默认人设')

  // 另写一套人设，验证切换（默认人设只随包提供，不再附带 example 模板）
  const personaDir = path.join(dataDir, 'personas')
  fs.writeFileSync(path.join(personaDir, '测试人设.md'), '# 测试人设\n')
  fs.writeFileSync(path.join(personaDir, '测试人设.lines.txt'), '## poke\n戳\n')

  const use = runCli(['persona', 'use', '测试人设', '--data-dir', dataDir])
  assert.equal(use.status, 0, use.stderr)
  assert.match(use.stdout, /已切换人设/)
  const ws = path.join(dataDir, 'workspace')
  for (const name of ['AGENTS.local.md', 'lines.txt', 'wake.txt']) {
    assert.ok(fs.existsSync(path.join(ws, name)), `应投递 ${name}`)
  }
  assert.ok(fs.existsSync(path.join(ws, '.persona.json')), '应写人设指针')
  assert.equal(readConfig(dataDir).pluginConfig['persona-voice'].activePersona, '测试人设', '应同步 activePersona')

  const listAfter = runCli(['persona', 'list', '--data-dir', dataDir])
  assert.match(listAfter.stdout, /\* 测试人设/)

  // 不存在的人设：失败退出
  const nope = runCli(['persona', 'use', 'nobody', '--data-dir', dataDir])
  assert.equal(nope.status, 1)
})

test('import-legacy：旧 bridge 配置 → v2；覆盖时备份；参数缺失退出码 1', () => {
  const base = tmpDir('legacy')
  const dataDir = path.join(base, 'data')
  assert.equal(runCli(['init', '--data-dir', dataDir]).status, 0)

  const legacyFile = path.join(base, 'legacy.json')
  fs.writeFileSync(
    legacyFile,
    JSON.stringify(
      {
        bridge: {
          admins: [10001],
          replyMaxLength: 2500,
          groupKeywords: { '*': ['小助手'] },
          chatArchive: { enabled: true, dir: 'logs/qq_chat' },
        },
        onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' },
        imagegen: { apiKey: 'REPLACE_ME', baseUrl: 'https://example.invalid/v1' },
      },
      null,
      2,
    ),
  )

  const r = runCli(['import-legacy', legacyFile, '--data-dir', dataDir])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /已写入 v2 配置/)
  const cfg = readConfig(dataDir)
  assert.equal(cfg.version, 2)
  assert.equal(cfg.adminQq, 10001)
  assert.equal(cfg.outbound.replyMaxLength, 2500)
  assert.equal(cfg.credentials.gptImage.apiKey, 'REPLACE_ME')
  assert.ok(cfg.pluginConfig['gate-wake'].keywords.includes('小助手'))
  // 覆盖前有备份
  const backups = fs.readdirSync(dataDir).filter((n) => n.startsWith('config.json.bak-import-'))
  assert.ok(backups.length >= 1, '覆盖已有配置应备份')

  // --out 指定输出
  const out = path.join(base, 'custom-config.json')
  const r2 = runCli(['import-legacy', legacyFile, '--out', out])
  assert.equal(r2.status, 0)
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).adminQq, 10001)

  // 参数缺失 / 文件不存在 → 退出码 1
  assert.equal(runCli(['import-legacy']).status, 1)
  assert.equal(runCli(['import-legacy', path.join(base, 'nope.json'), '--data-dir', dataDir]).status, 1)
})

test('CLI 基础：--help / --version / 未知命令的退出码', () => {
  const help = runCli(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /init/)
  assert.match(help.stdout, /doctor/)
  assert.match(help.stdout, /import-legacy/)
  assert.match(help.stdout, /persona/)

  const version = runCli(['--version'])
  assert.equal(version.status, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/)

  const unknown = runCli(['nope-command'])
  assert.equal(unknown.status, 1)
})
