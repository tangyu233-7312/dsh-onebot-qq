/**
 * test/audit-qzone-desk.test.js — 「空间工作区」当日回顾（2026-10-28 重写后的主路径）
 *
 * 覆盖四件事：
 *   · 素材装配：当天**所有会话**（群 + 私聊）都能进素材，格式人可读，落地一份 md
 *   · 回顾流程：到点推一条回顾 → 它调 post_qzone(target='desk') → 发出去、状态落盘
 *   · 不写也行：调 skip_qzone(target='desk') → 一个字都不发，但记下理由
 *   · 工作区会话只放行空间三件套（别的工具在入口就被拒）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootKernel, tmpDir, GROUP_ID, ADMIN_QQ } from './helpers.mjs'
import { buildDailyMaterial, dayRange, localDateOf } from '../plugins/qzone/material.js'

const DAY = localDateOf(Date.now())

function writeArchive(dataDir, chatKey, rows) {
  const dir = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, chatKey.replace(':', '_') + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

const msg = (qq, name, text, dir = 'in') => ({ dir, ts: Date.now(), sender: { qq, name, card: name }, text })

function seedDay(dataDir) {
  writeArchive(dataDir, 'group:573144674', [
    msg(1001, '小司', '今天龙放出来了'),
    msg(1002, '镜华', '晚上八点打'),
    msg(0, '', '我也是这么想的', 'out'),
  ])
  writeArchive(dataDir, 'group:767612072', [msg(1003, '枳缘', '明天上班了')])
  writeArchive(dataDir, 'private:' + ADMIN_QQ, [msg(ADMIN_QQ, '主人', '早点睡')])
}

const qzoneCfg = (extra = {}) => ({
  archive: { enabled: true, dir: 'logs/qq_chat' },
  pluginConfig: { qzone: { enabled: true, dailyLimit: 1, nudgeHour: 0, ...extra } },
})

test('素材装配：当天所有会话（群 + 私聊）都在，且落地一份 md', () => {
  const dataDir = tmpDir('qzone-mat')
  seedDay(dataDir)
  const r = buildDailyMaterial({
    archiveDir: path.join(dataDir, 'logs', 'qq_chat'),
    memoryDir: path.join(dataDir, 'qq-memory'),
    workspaceDir: path.join(dataDir, 'workspace'),
    date: DAY,
  })
  assert.equal(r.stats.chats, 3, '两个群 + 一个私聊')
  assert.equal(r.stats.messages, 5)
  assert.match(r.text, /群 573144674/)
  assert.match(r.text, /今天龙放出来了/)
  assert.match(r.text, /私聊 /, '私聊也要进素材')
  assert.match(r.text, /→\[\d{2}:\d{2}\] 你：/, '机器人自己说的话要能区分')
  assert.ok(fs.existsSync(r.file), '素材要落地成文件，人能直接看')
})

test('素材装配：只取当天，前一天的不进素材', () => {
  const dataDir = tmpDir('qzone-mat2')
  const { start } = dayRange(DAY)
  const dir = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'group_573144674.jsonl'), [
    JSON.stringify({ dir: 'in', ts: start - 3600 * 1000, sender: { qq: 1, name: '昨天的人' }, text: '昨天的话' }),
    JSON.stringify({ dir: 'in', ts: start + 60000, sender: { qq: 2, name: '今天的人' }, text: '今天的话' }),
  ].join('\n'))
  const r = buildDailyMaterial({ archiveDir: dir, memoryDir: path.join(dataDir, 'qq-memory'), workspaceDir: path.join(dataDir, 'workspace'), date: DAY })
  assert.match(r.text, /今天的话/)
  assert.doesNotMatch(r.text, /昨天的话/)
})

test('当日回顾：它读了全天的素材，然后写一条', async () => {
  const dataDir = tmpDir('qzone-run')
  seedDay(dataDir)
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  const calls = []
  env.kernel.onebot.sendQzoneMsg = async (p) => { calls.push(p); return { ok: true } }
  const tool = (n) => env.ctx._registeredTools.get(`mcp__qq__${n}`)
  let promptText = ''
  let deskSessionId = ''
  env.ctx.setPromptHandler(async (req) => {
    promptText = req.content[0].text
    deskSessionId = req.sessionId
    await tool('post_qzone').execute({ target: 'desk', content: '今天龙放出来了，大家都挺高兴。' })
    env.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end', reason: 'done' })
  })
  try {
    const r = await env.kernel.shared.qzoneDesk.runNow('测试')
    assert.equal(r.ok, true)
    assert.match(promptText, /【(今天|最近 \d+ 天)的经历】/)
    assert.match(promptText, /今天龙放出来了/)
    assert.match(promptText, /今天上班了|明天上班了/)
    assert.match(promptText, /skip_qzone/, '要告诉它不写也是一条路')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content, '今天龙放出来了，大家都挺高兴。')

    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'qzone-state.json'), 'utf8'))
    assert.equal(st.days[DAY].posted, 1)
    assert.match(st.days[DAY].text, /龙放出来了/)
    assert.equal(st.days[DAY].sessionId, deskSessionId, '要记下是哪次回顾')
    assert.ok(env.ctx._sessions.get(deskSessionId), '工作区会话应存在')
    assert.equal(env.ctx._sessions.get(deskSessionId).title, '空间工作区')
  } finally {
    env.dispose()
  }
})

test('当日回顾：今天不写的时候一个字都不发，但理由要记下来', async () => {
  const dataDir = tmpDir('qzone-skip')
  seedDay(dataDir)
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  const calls = []
  env.kernel.onebot.sendQzoneMsg = async (p) => { calls.push(p); return { ok: true } }
  const tool = (n) => env.ctx._registeredTools.get(`mcp__qq__${n}`)
  env.ctx.setPromptHandler(async (req) => {
    await tool('skip_qzone').execute({ target: 'desk', reason: '今天都是些琐事，没什么想记的' })
    env.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end', reason: 'done' })
  })
  try {
    await env.kernel.shared.qzoneDesk.runNow('测试')
    assert.equal(calls.length, 0, '不写就绝不该调用协议端')
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'qzone-state.json'), 'utf8'))
    assert.equal(st.days[DAY].skipped, true)
    assert.match(st.days[DAY].skipReason, /琐事/)
  } finally {
    env.dispose()
  }
})

test('当日回顾：今天没人说话就不浪费模型调用，直接记「没写」', async () => {
  const dataDir = tmpDir('qzone-empty')
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  let prompted = 0
  env.ctx.setPromptHandler(async () => { prompted += 1 })
  try {
    const r = await env.kernel.shared.qzoneDesk.runNow('测试')
    assert.equal(r.skipped, 'empty')
    assert.equal(prompted, 0, '没素材就别起模型')
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'qzone-state.json'), 'utf8'))
    assert.equal(st.days[DAY].skipped, true)
    assert.match(st.days[DAY].skipReason, /没有任何人说话/)
  } finally {
    env.dispose()
  }
})

test('素材装配：days=2 会把昨天也带上，并标日期', () => {
  const dataDir = tmpDir('qzone-2d')
  const dir = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(dir, { recursive: true })
  const { start } = dayRange(DAY)
  fs.writeFileSync(path.join(dir, 'group_573144674.jsonl'), [
    JSON.stringify({ dir: 'in', ts: start - 3 * 3600 * 1000, sender: { qq: 1, name: '昨天的' }, text: '昨天夜里的话' }),
    JSON.stringify({ dir: 'in', ts: start - 5 * 24 * 3600 * 1000, sender: { qq: 2, name: '五天前的' }, text: '五天前的话' }),
    JSON.stringify({ dir: 'in', ts: start + 60000, sender: { qq: 3, name: '今天的' }, text: '今天的话' }),
  ].join('\n'))
  const r = buildDailyMaterial({
    archiveDir: dir, memoryDir: path.join(dataDir, 'qq-memory'), workspaceDir: path.join(dataDir, 'workspace'),
    date: DAY, days: 2,
  })
  assert.match(r.text, /最近 2 天的经历/)
  assert.match(r.text, /昨天夜里的话/)
  assert.match(r.text, /今天的话/)
  assert.doesNotMatch(r.text, /五天前的话/, '天数以外的旧消息不能进来')
  assert.match(r.text, /\[\d{2}-\d{2} \d{2}:\d{2}\]/, '跨天要给每条带日期，否则分不清是哪天')
})

test('素材装配：过旧的群记忆不会被当成本次经历', () => {
  const dataDir = tmpDir('qzone-oldmem')
  seedDay(dataDir)
  const memDir = path.join(dataDir, 'qq-memory')
  fs.mkdirSync(memDir, { recursive: true })
  const memFile = path.join(memDir, '573144674.md')
  fs.writeFileSync(memFile, '# 群 573144674 · 对话记忆\n\n> 最后更新：很久以前\n- 十天前的旧事\n')
  const old = new Date(Date.now() - 6 * 24 * 3600 * 1000)
  fs.utimesSync(memFile, old, old)
  const r = buildDailyMaterial({
    archiveDir: path.join(dataDir, 'logs', 'qq_chat'), memoryDir: memDir,
    workspaceDir: path.join(dataDir, 'workspace'), date: DAY, days: 2,
  })
  assert.doesNotMatch(r.text, /十天前的旧事/, '旧记忆不能冒充今天的经历')
  assert.match(r.text, /太旧，已略过/)
})

test('素材装配：onlyChatKey 只取一个群（/空间 群聊 用）', () => {
  const dataDir = tmpDir('qzone-scope')
  seedDay(dataDir)
  const r = buildDailyMaterial({
    archiveDir: path.join(dataDir, 'logs', 'qq_chat'),
    memoryDir: path.join(dataDir, 'qq-memory'),
    workspaceDir: path.join(dataDir, 'workspace'),
    date: DAY,
    onlyChatKey: 'group:573144674',
  })
  assert.equal(r.stats.chats, 1)
  assert.match(r.text, /今天龙放出来了/)
  assert.doesNotMatch(r.text, /明天上班了/, '别的群不该进素材')
  assert.doesNotMatch(r.text, /私聊 /, '私聊也不该进')
  assert.match(r.text, /只看 group:573144674/)
})

test('命令：/空间 群聊 只按本群的事回顾', async () => {
  const dataDir = tmpDir('qzone-cmd')
  seedDay(dataDir)
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  env.kernel.onebot.sendQzoneMsg = async () => ({ ok: true })
  let promptText = ''
  env.ctx.setPromptHandler(async (req) => {
    promptText = req.content[0].text
    const skip = env.ctx._registeredTools.get('mcp__qq__skip_qzone')
    await skip.execute({ target: 'desk', reason: '测试' })
    env.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end', reason: 'done' })
  })
  try {
    const cmd = env.kernel.commands.get('空间')
    assert.ok(cmd, '应注册 /空间 命令')
    await cmd.handler(
      { chatKey: 'group:767612072', sender: { isMaster: true }, messageId: 1, isGroup: true },
      ['群聊'],
    )
    await new Promise((r) => setTimeout(r, 400))
    assert.match(promptText, /只看 group:767612072/)
    assert.match(promptText, /明天上班了/)
    assert.doesNotMatch(promptText, /今天龙放出来了/, '没点名的群不该进素材')
  } finally {
    env.dispose()
  }
})

test('命令：私聊里发 /空间 群聊 会被挡下', async () => {
  const dataDir = tmpDir('qzone-cmd2')
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  let prompted = 0
  env.ctx.setPromptHandler(async () => { prompted += 1 })
  try {
    const cmd = env.kernel.commands.get('空间')
    await cmd.handler({ chatKey: 'private:' + ADMIN_QQ, sender: { isMaster: true }, messageId: 2 }, ['群聊'])
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(prompted, 0, '私聊里不该起回顾')
  } finally {
    env.dispose()
  }
})

test('控制台重置：清掉今天的已发/已跳过，额度回到 0', async () => {
  const dataDir = tmpDir('qzone-reset')
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  const calls = []
  env.kernel.onebot.sendQzoneMsg = async (p) => { calls.push(p); return { ok: true } }
  const tool = (n) => env.ctx._registeredTools.get(`mcp__qq__${n}`)
  try {
    assert.equal((await tool('post_qzone').execute({ target: 'desk', content: '测试用的一条' })).ok, true)
    assert.equal((await tool('qzone_status').execute({})).remaining, 0)

    // 预演：只报影响面，不动状态
    const preview = env.kernel.shared.qzoneResetToday({ preview: true })
    assert.equal(preview.ok, true)
    assert.ok(preview.previewLines.some((l) => /已发：1/.test(l)))
    assert.equal((await tool('qzone_status').execute({})).used, 1, '预演不该改状态')

    const r = env.kernel.shared.qzoneResetToday({})
    assert.equal(r.ok, true)
    const st = await tool('qzone_status').execute({})
    assert.equal(st.used, 0)
    assert.equal(st.decided, false)
    assert.equal(st.skippedToday, false)
    // 重置之后还能再发一条
    assert.equal((await tool('post_qzone').execute({ target: 'desk', content: '重置后的新一条' })).ok, true)
    assert.equal(calls.length, 2)
  } finally {
    env.dispose()
  }
})

test('控制台「立刻回顾」：异步起一轮，不阻塞', async () => {
  const dataDir = tmpDir('qzone-now')
  seedDay(dataDir)
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  env.kernel.onebot.sendQzoneMsg = async () => ({ ok: true })
  const tool = (n) => env.ctx._registeredTools.get(`mcp__qq__${n}`)
  env.ctx.setPromptHandler(async (req) => {
    await tool('skip_qzone').execute({ target: 'desk', reason: '手动触发测试' })
    env.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end', reason: 'done' })
  })
  try {
    const r = env.kernel.shared.qzoneRunNow('测试')
    assert.equal(r.ok, true, '应该立刻返回')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const st = await tool('qzone_status').execute({})
    assert.equal(st.skippedToday, true, '异步跑完应该已经记下不写')
  } finally {
    env.dispose()
  }
})

test('工作区会话里调别的工具会被入口拒掉', async () => {
  const dataDir = tmpDir('qzone-gate')
  seedDay(dataDir)
  const env = await bootKernel({ dataDir, config: qzoneCfg() })
  env.kernel.onebot.sendQzoneMsg = async () => ({ ok: true })
  const tool = (n) => env.ctx._registeredTools.get(`mcp__qq__${n}`)
  let deskSessionId = ''
  env.ctx.setPromptHandler(async (req) => {
    deskSessionId = req.sessionId
    await tool('skip_qzone').execute({ target: 'desk', reason: '测试' })
    env.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end', reason: 'done' })
  })
  try {
    await env.kernel.shared.qzoneDesk.runNow('测试')
    // 通用受限会话：qzone 用 core.markScope 登记（2026-10-29 合并掉原来的 deskSessionIds 专用槽）
    assert.ok(env.kernel.scopedSessions.has(deskSessionId), '工作区会话应已登记为受限会话')
    const sc = env.kernel.scopedSessions.get(deskSessionId)
    assert.equal(sc.label, '空间工作区')
    assert.deepEqual([...sc.tools].sort(), ['post_qzone', 'qzone_status', 'skip_qzone'])
    const send = tool('send_message')
    assert.ok(send, '内核应有 send_message 工具')
    await assert.rejects(
      () => send.execute({ target: 'group:' + GROUP_ID, text: '不该发出去' }, { agent: { session: { id: deskSessionId } } }),
      /「空间工作区」只允许调用/,
    )
    // 空间三件套仍然放行
    const status = await tool('qzone_status').execute({}, { agent: { session: { id: deskSessionId } } })
    assert.equal(status.ok, true)
  } finally {
    env.dispose()
  }
})