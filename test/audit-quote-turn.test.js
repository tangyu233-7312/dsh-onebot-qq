/**
 * 回归：引用目标必须绑定到「真正在跑的那一轮 DSH 回合」。
 *
 * 历史 bug：A 聊完一轮后 B/C 唤醒机器人，回复却引用了 A。
 * 根因是锚在 prompt admission 时就被 pop，出站只能回退 activeTurns / 最后一个提交的回合。
 * 现在锚从 turn/start 活到 turn/end：出站取队首＝正在回的那轮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ChatState } from '../kernel/state-pipeline.js'
import { bootKernel, emitRaw, groupAtEvent, waitFor, ADMIN_QQ, GROUP_ID } from './helpers.mjs'

const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function emitTurn(ctx, sessionId, type) {
  ctx.emit('session/event', { id: sessionId }, { type })
  if (type === 'turn/start') {
    const request = ctx._prompts.find((r) => r.sessionId === sessionId && !r._testConsumed)
    request._testConsumed = true
    ctx.emit('session/event', { id: sessionId }, { type: 'user/message', data: { source: { rpcId: request.requestId } } })
  }
}

async function boot(t) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      outbound: { quoteAfterMsgs: 1 },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

test('ChatState.consumeTurnAnchor：按 turn/end 消费队首，不误删下一轮', () => {
  const s = new ChatState({ log: quiet })
  s.markTurnAnchor('group:1', 100)
  s.markTurnAnchor('group:1', 200)
  s.countArrival('group:1', 300)

  assert.equal(s.quoteNeed('group:1', 1).triggerId, 100, '队首 = 正在回的那轮')
  s.consumeTurnAnchor('group:1', 100)
  assert.equal(s.quoteNeed('group:1', 1).triggerId, 200, '消费后下一轮成为队首')
  assert.equal(s.quoteNeed('group:1', 1).arrived, 1, '插话计数不串轮')
  s.consumeTurnAnchor('group:1', 200)
  assert.equal(s.quoteNeed('group:1', 1).triggerId, null)
})

test('出站引用跟随 turn/start：A 生成中 B/C 已提交，A 仍引 A；轮末才换人', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  const prompts = []
  h.ctx.setPromptHandler(async (req) => {
    prompts.push({ sid: req.sessionId, text: req.content[0].text })
  })

  // A 唤醒并 admission（注意：不触发 turn/start —— 模拟 DSH 还没开始跑）
  await emitRaw(h.kernel, groupAtEvent({ text: 'A', messageId: 1001 }))
  await waitFor(() => prompts.length >= 1, { label: 'A prompt' })
  const sid = prompts[0].sid

  // A 还没开始跑时，B/C 也提交了（旧实现会把映射覆盖成 C）
  await emitRaw(h.kernel, groupAtEvent({ text: 'B', messageId: 1002 }))
  await emitRaw(h.kernel, groupAtEvent({ text: 'C', messageId: 1003 }))
  await waitFor(() => prompts.length >= 3, { label: 'B/C prompt' })

  // A 的回合真正开始 → 工具执行应认 A
  emitTurn(h.ctx, sid, 'turn/start')
  await send.execute({ target: `group:${GROUP_ID}`, text: 'reply-A' }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=1001]'), `A 回复应引 A：${h.sent.at(-1).wire}`)

  // A 轮结束 → 消费 A 锚；B 开始 → B 回复引 B
  emitTurn(h.ctx, sid, 'turn/end')
  emitTurn(h.ctx, sid, 'turn/start')
  await send.execute({ target: `group:${GROUP_ID}`, text: 'reply-B' }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=1002]'), `B 回复应引 B：${h.sent.at(-1).wire}`)

  // B 轮结束；C 开始，先来一条 D 插话再回
  emitTurn(h.ctx, sid, 'turn/end')
  emitTurn(h.ctx, sid, 'turn/start')
  await emitRaw(h.kernel, groupAtEvent({ text: 'D', messageId: 1004, at: false }))
  await sleep(20)
  await send.execute({ target: `group:${GROUP_ID}`, text: 'reply-C' }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=1003]'), `C 回复应引 C：${h.sent.at(-1).wire}`)

  // C 轮结束；之后普通命令/出站没有回合上下文 → 不许再挂旧引用
  emitTurn(h.ctx, sid, 'turn/end')
  await emitRaw(h.kernel, groupAtEvent({ text: '/help', messageId: 1005, at: false }))
  await waitFor(() => h.sent.length >= 4, { label: '/help 回复' })
  assert.equal(h.sent.at(-1).wire.includes('[CQ:reply'), false, `/help 不应引用上一轮：${h.sent.at(-1).wire}`)
})

test('未到 turn/start 就失败：不留下永久锚', async (t) => {
  const h = await boot(t)
  h.kernel.onebot.msgById = h.kernel.onebot.msgById || (async () => null)
  // 让 prompt 直接失败（非 session-gone），这一轮不会发生
  h.ctx.setPromptHandler(async () => { throw new Error('boom') })
  await emitRaw(h.kernel, groupAtEvent({ text: '失败', messageId: 2001 }))
  await waitFor(() => h.sent.length >= 1, { label: '错误兜底出站' })
  const q = h.kernel.state.get(`group:${GROUP_ID}`).turnQueue
  assert.equal(q.length, 0, '失败的轮次不应留下锚')
  assert.equal(h.kernel.pendingTurns.size, 0, '失败的轮次不应留在待启动队列')
})
