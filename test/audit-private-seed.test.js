/**
 * test/audit-private-seed.test.js — 开机时必须给私聊播种基线（2026-10-30）
 *
 * 线上症状：重启后它永远不主动私聊我，工作区里也没有主动接话记录。
 * 根因：seedProactiveBaseline 只遍历群，private 会话的 ChatState 是空的
 * （lastInboundAt=0）→ tickPrivateSilence 的冷场判据直接 continue。
 * 必须等用户先发一条消息才会恢复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootKernel, tmpDir } from './helpers.mjs'

const root = path.join(import.meta.dirname, '..')

test('源码里必须有私聊播种（不只播种群）', () => {
  const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  assert.match(src, /私聊播种/, '要有私聊播种这一段')
  assert.match(src, /allowedPrivateQqs/, '要遍历允许主动接话的私聊')
  assert.match(src, /播种 private:/, '要有能看出播没播的日志')
})

test('开机后 private 会话的 lastInboundAt 不是 0（否则永远判不出冷场）', async () => {
  const dataDir = tmpDir('privseed')
  const arch = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(arch, { recursive: true })
  const fiveHoursAgo = Date.now() - 5 * 3600 * 1000
  fs.writeFileSync(path.join(arch, 'private_10001.jsonl'), JSON.stringify({
    dir: 'in', ts: fiveHoursAgo, sender: { qq: 10001, name: 'master' }, text: 'hi',
  }) + '\n')

  const env = await bootKernel({
    dataDir,
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { reply: { enabled: true, privateEnabled: true, privateQqs: ['10001'], silenceEnabled: false } },
    },
  })
  try {
    const st = env.kernel.state.get('private:10001')
    assert.ok(Number(st.lastInboundAt) > 0, 'private 会话必须被播种')
    const ageMin = (Date.now() - Number(st.lastInboundAt)) / 60000
    assert.ok(ageMin > 240, '应取留档里的时间约 300 分钟前，实际 ' + Math.round(ageMin) + ' 分钟')
  } finally { env.dispose() }
})

test('没有任何历史时按开机起算，不会一开机就冒出来', async () => {
  const dataDir = tmpDir('privseed2')
  const env = await bootKernel({
    dataDir,
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { reply: { enabled: true, privateEnabled: true, privateQqs: ['10002'], silenceEnabled: false } },
    },
  })
  try {
    const st = env.kernel.state.get('private:10002')
    assert.ok(Number(st.lastInboundAt) > 0, '也要播种')
    const ageMin = (Date.now() - Number(st.lastInboundAt)) / 60000
    assert.ok(ageMin < 2, '没有历史时应按现在起算，实际 ' + Math.round(ageMin) + ' 分钟')
  } finally { env.dispose() }
})
