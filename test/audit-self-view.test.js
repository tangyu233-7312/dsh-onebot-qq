/**
 * test/audit-self-view.test.js — 「翻翻群 / 看自己」两个只读工具（2026-10-30）
 *
 * 口径：回家（私聊）想知道群里什么样 → 给**摘要**，不给原文。
 * 原文只给写空间用（material.js），私聊里塞原文会把家变成第二个群。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import plugin from '../plugins/self-view/index.js'
import { createSelfLog } from '../kernel/self-log.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'))
  const arch = path.join(dir, 'logs', 'qq_chat')
  fs.mkdirSync(arch, { recursive: true })
  const now = Date.now()
  const rows = [
    { dir: 'in', ts: now - 3600 * 1000, sender: { qq: 1001, name: '小司' }, text: '今天龙放出来了' },
    { dir: 'in', ts: now - 3000 * 1000, sender: { qq: 1002, name: '镜华' }, text: '晚上八点打' },
    { dir: 'out', ts: now - 2000 * 1000, text: '好耶' },
    { dir: 'in', ts: now - 60 * 1000, sender: { qq: 1001, name: '小司' }, text: '走了走了' },
  ]
  if (opts.rows !== false) {
    fs.writeFileSync(path.join(arch, 'group_573144674.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  // 很久以前的一条：不该被算进 6 小时窗口
  fs.writeFileSync(path.join(arch, 'group_999999999.jsonl'), JSON.stringify({ dir: 'in', ts: now - 48 * 3600 * 1000, sender: { qq: 1, name: '老人' }, text: '老消息' }) + '\n')

  const tools = {}
  const cfg = { enabled: true, lookbackHours: 6, maxGroups: 8, maxLines: 2, ...(opts.cfg || {}) }
  const selfLog = createSelfLog({ dataDir: dir, log: quiet })
  const bot = {
    cfg,
    log: quiet,
    core: { dataDir: dir, archive: { dir: 'logs/qq_chat' } },
    onebot: { groupList: async () => (opts.noGroupList ? [] : [{ id: 573144674, name: '摸鱼群' }]) },
    selfLog,
    registerTool(name, def) { tools[name] = def },
    shared: {},
  }
  plugin.setup(bot)
  return { dir, tools, selfLog, restore: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('browse_groups：给摘要（条数/人/最近几句），不给整段原文', async () => {
  const s = setup()
  try {
    const r = await s.tools.browse_groups.execute({})
    assert.equal(r.ok, true)
    assert.equal(r.groups.length, 1)
    const g = r.groups[0]
    assert.equal(g.name, '摸鱼群')
    assert.equal(g.messages, 4)
    assert.equal(g.humans, 3)
    assert.equal(g.mine, 1, '要能看出「我说过话」')
    assert.ok(g.people.includes('小司'))
    assert.ok(g.tail.length <= 2, 'maxLines=2 只给两条')
    assert.ok(g.tail[0].text.length <= 40, '每条必须截断 —— 这是摘要不是原文')
  } finally { s.restore() }
})

test('browse_groups：超出时间窗口的老群不列', async () => {
  const s = setup()
  try {
    const r = await s.tools.browse_groups.execute({ hours: 6 })
    const ids = r.groups.map((g) => g.group)
    assert.equal(ids.includes('999999999'), false, '48 小时前的消息不该算进来')
  } finally { s.restore() }
})

test('browse_groups：协议端取不到群列表时退化成读留档', async () => {
  const s = setup({ noGroupList: true })
  try {
    const r = await s.tools.browse_groups.execute({})
    assert.equal(r.ok, true)
    assert.equal(r.groups.length, 1)
    assert.equal(r.groups[0].group, '573144674')
  } finally { s.restore() }
})

test('browse_groups：没人说话时说清楚，不报错', async () => {
  const s = setup({ rows: false })
  try {
    const r = await s.tools.browse_groups.execute({ hours: 1 })
    assert.equal(r.ok, true)
    assert.equal(r.groups.length, 0)
    assert.match(r.note, /没人说话/)
  } finally { s.restore() }
})

test('self_log：读得到流水账和「今天那行」', async () => {
  const s = setup()
  try {
    s.selfLog.append({ kind: 'watch', what: '看了个视频', where: '私聊' })
    const r = await s.tools.self_log.execute({ limit: 5 })
    assert.equal(r.ok, true)
    assert.match(r.today, /看了个视频/)
    assert.equal(r.rows.length, 1)
  } finally { s.restore() }
})

test('关掉插件：两个工具都拒绝', async () => {
  const s = setup({ cfg: { enabled: false } })
  try {
    assert.equal((await s.tools.browse_groups.execute({})).ok, false)
    assert.equal((await s.tools.self_log.execute({})).ok, false)
  } finally { s.restore() }
})
