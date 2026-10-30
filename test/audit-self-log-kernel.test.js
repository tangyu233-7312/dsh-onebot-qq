/**
 * test/audit-self-log-kernel.test.js — 内核把「我今天的经历」注入每轮提示（2026-10-30）
 *
 * 这是本项目的「跨会话自我」：私聊里的它必须知道自己在群里 / 看视频的地方干过什么。
 * 只测两件事：
 *   · 流水账有内容 → 进了 ev.hint（私聊给完整一行，群里只给极简一句）
 *   · 流水账空 → 一个字都不加（别让提示词里出现空的「我今天的经历」）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, tmpDir, tapInbound, emitRaw, groupAtEvent, privateEvent, GROUP_ID } from './helpers.mjs'

const baseCfg = () => ({
  archive: { enabled: false, dir: 'logs/qq_chat' },
  pacing: { reply: { enabled: false } },
})

const findHint = (ev) => (ev?.hint || []).filter((x) => /我今天的经历|我自己的事/.test(x))

test('私聊轮：把今天的经历注入成一行（带场合）', async () => {
  const dataDir = tmpDir('selflog-kernel')
  const env = await bootKernel({ dataDir, config: baseCfg() })
  try {
    env.kernel.selfLog.append({ kind: 'watch', what: '看了个视频', where: '私聊' })
    env.kernel.selfLog.append({ kind: 'qzone', what: '发了条说说', where: '空间工作区' })

    const tap = tapInbound(env.kernel)
    await emitRaw(env.kernel, privateEvent({ text: '今天干嘛了' }))
    const ev = tap.events.find((e) => e.chatKey === `private:10001`)
    assert.ok(ev, '私聊事件要进管线')
    const hints = findHint(ev)
    assert.equal(hints.length, 1, '私聊要且只要一行经历')
    assert.match(hints[0], /我今天的经历/)
    assert.match(hints[0], /看了个视频/)
    assert.match(hints[0], /发了条说说/)
    assert.match(hints[0], /空间工作区/, '要标出在哪干的，否则它会以为都在私聊')
  } finally { env.dispose() }
})

test('群聊轮：只给极简一句，且明确别主动说出来', async () => {
  const dataDir = tmpDir('selflog-kernel-g')
  const env = await bootKernel({ dataDir, config: baseCfg() })
  try {
    env.kernel.selfLog.append({ kind: 'watch', what: '看了个视频', where: '私聊' })
    const tap = tapInbound(env.kernel)
    await emitRaw(env.kernel, groupAtEvent({ text: '在吗' }))
    const ev = tap.events.find((e) => e.chatKey === `group:${GROUP_ID}`)
    assert.ok(ev)
    const hints = findHint(ev)
    assert.equal(hints.length, 1)
    assert.match(hints[0], /我自己的事/)
    assert.match(hints[0], /别主动说出来/, '群里绝不能让它自曝私聊/别处的事')
  } finally { env.dispose() }
})

test('没有流水账：一个字都不加', async () => {
  const dataDir = tmpDir('selflog-kernel-empty')
  const env = await bootKernel({ dataDir, config: baseCfg() })
  try {
    const tap = tapInbound(env.kernel)
    await emitRaw(env.kernel, privateEvent({ text: '你好' }))
    const ev = tap.events.find((e) => e.chatKey === 'private:10001')
    assert.ok(ev)
    assert.equal(findHint(ev).length, 0)
  } finally { env.dispose() }
})
