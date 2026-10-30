/**
 * test/audit-persona-version.test.js — 人设版本化（plugins/persona-version）
 *
 * 用户定的规矩（2026-10-30）：人设独立放一个文件夹，每版一个文件，文件名带日期，
 * 同一天改多次加编号；**绝不原地改**，只另存新版本再切指针。
 *
 * 为什么「不能原地改」是硬要求：DSH 的 agent-instructions 按**路径 + digest** 缓存，
 * 原地改名不变路径 → 可能不重新注入 → 用户看到「改了没生效」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import plugin, { parseVersionName, nextVersionName } from '../plugins/persona-version/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function mk() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')) }

function setup(opts = {}) {
  const dir = mk()
  const personas = path.join(dir, 'personas')
  fs.mkdirSync(personas, { recursive: true })
  fs.writeFileSync(path.join(personas, '蓝色大肥鱼20261030.md'), '# 人设\n\n自称本鱼。\n', 'utf8')
  if (opts.twoVersions) fs.writeFileSync(path.join(personas, '蓝色大肥鱼20261030-2.md'), '# 人设 v2\n', 'utf8')
  const tools = {}
  const shared = {}
  const logged = []
  const switched = []
  const cfg = { enabled: true, allowInGroup: false, changelog: true, maxChars: 20000, ...(opts.cfg || {}) }
  const bot = {
    cfg,
    log: quiet,
    core: {
      dataDir: dir,
      paths: { personaDir: personas, workspaceDir: path.join(dir, 'workspace') },
      switchPersona: (name) => { switched.push(name); return { ok: true, name } },
    },
    personaLabel: opts.label || '蓝色大肥鱼20261030',
    selfLog: { append: (e) => logged.push(e) },
    currentTurn: () => opts.turn || null,
    registerTool(name, def) { tools[name] = def },
    shared,
  }
  plugin.setup(bot)
  const restore = () => fs.rmSync(dir, { recursive: true, force: true })
  return { dir, personas, tools, shared, logged, switched, cfg, bot, restore }
}

test('parseVersionName / nextVersionName：日期 + 序号，同日自动 -2', () => {
  assert.deepEqual(parseVersionName('蓝色大肥鱼20261030'), { role: '蓝色大肥鱼', date: '20261030', seq: 1 })
  assert.deepEqual(parseVersionName('蓝色大肥鱼20261030-3'), { role: '蓝色大肥鱼', date: '20261030', seq: 3 })
  assert.equal(parseVersionName('没有日期的名字'), null)
  const dir = mk()
  try {
    assert.equal(nextVersionName(dir, '角色', '20261030'), '角色20261030')
    fs.writeFileSync(path.join(dir, '角色20261030.md'), 'x')
    assert.equal(nextVersionName(dir, '角色', '20261030'), '角色20261030-2')
    fs.writeFileSync(path.join(dir, '角色20261030-2.md'), 'x')
    assert.equal(nextVersionName(dir, '角色', '20261030'), '角色20261030-3')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('revise：另存一个新版本文件，不碰旧版', async () => {
  const s = setup()
  try {
    const before = fs.readFileSync(path.join(s.personas, '蓝色大肥鱼20261030.md'), 'utf8')
    const r = await s.tools.persona_revise.execute({ change: '把自嘲改成偶尔' })
    assert.equal(r.ok, true)
    assert.equal(r.from, '蓝色大肥鱼20261030')
    assert.match(r.newVersion, /-2$/)
    const after = fs.readFileSync(path.join(s.personas, '蓝色大肥鱼20261030.md'), 'utf8')
    assert.equal(after, before, '旧版必须一个字都没变')
    const newFile = fs.readFileSync(path.join(s.personas, r.newVersion + '.md'), 'utf8')
    assert.match(newFile, /待改写：把自嘲改成偶尔/)
    assert.match(newFile, /自称本鱼/, '新版本要先继承当前内容')
    assert.equal(s.logged.length, 1, '改人设要留痕（流水账）')
    assert.equal(s.logged[0].kind, 'persona')
  } finally { s.restore() }
})

test('revise：群里默认不许改（必须私聊）', async () => {
  const s = setup({ turn: { isGroup: true } })
  try {
    const r = await s.tools.persona_revise.execute({ change: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /群里不允许/)
  } finally { s.restore() }
})

test('revise：人设名不是版本化格式时给明确提示', async () => {
  const s = setup({ label: '蓝色大肥鱼' })
  try {
    const r = await s.tools.persona_revise.execute({ change: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /版本化格式/)
  } finally { s.restore() }
})

test('write：写完整正文，并自动追加版本记录', async () => {
  const s = setup()
  try {
    const r1 = await s.tools.persona_revise.execute({ change: 'x' })
    const r2 = await s.tools.persona_write.execute({ version: r1.newVersion, content: '# 新人设\n\n不叫本鱼了。\n' })
    assert.equal(r2.ok, true)
    const text = fs.readFileSync(path.join(s.personas, r1.newVersion + '.md'), 'utf8')
    assert.match(text, /不叫本鱼了/)
    assert.match(text, /## 版本记录/, '要留一行改动说明')
  } finally { s.restore() }
})

test('write：不存在的版本拒绝写；超长拒绝', async () => {
  const s = setup({ cfg: { maxChars: 1000 } })
  try {
    const a = await s.tools.persona_write.execute({ version: '蓝色大肥鱼20261030-9', content: 'x' })
    assert.equal(a.ok, false)
    const b = await s.tools.persona_write.execute({ version: '蓝色大肥鱼20261030', content: 'x'.repeat(2000) })
    assert.equal(b.ok, false)
    assert.match(b.reason, /太长/)
  } finally { s.restore() }
})

test('switch：默认切最新版，并回报「现在生效的是哪一版」', async () => {
  const s = setup({ twoVersions: true })
  try {
    const r = await s.tools.persona_switch.execute({})
    assert.equal(r.ok, true)
    assert.equal(r.switchedTo, '蓝色大肥鱼20261030-2')
    assert.equal(s.switched[0], '蓝色大肥鱼20261030-2')
  } finally { s.restore() }
})

test('history：标出哪一版生效', async () => {
  const s = setup({ twoVersions: true })
  try {
    const r = await s.tools.persona_history.execute({})
    assert.equal(r.ok, true)
    assert.equal(r.versions.length, 2)
    assert.equal(r.versions.find((v) => v.active).version, '蓝色大肥鱼20261030')
  } finally { s.restore() }
})

test('控制台状态：能看出「有更新的一版但没生效」', async () => {
  const s = setup({ twoVersions: true })
  try {
    const st = s.shared.personaVersionStatus()
    assert.equal(st.active, '蓝色大肥鱼20261030')
    assert.equal(st.latest, '蓝色大肥鱼20261030-2')
    assert.equal(st.stale, true)
  } finally { s.restore() }
})
