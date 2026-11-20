import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationWindow } from '../kernel/conversation-window.js'
import { createPacing } from '../kernel/pacing.js'
import { bootKernel, emitRaw, groupAtEvent, GROUP_ID, ADMIN_QQ, MEMBER_QQ } from './helpers.mjs'

const chat = `group:${GROUP_ID}`
const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const event = (qq = ADMIN_QQ, over = {}) => ({
  chatKey: chat, isGroup: true, sender: { qq }, images: [], _scratch: {}, ...over,
})
function setup() {
  let now = 100000
  const config = { groupFollowUpMs: 10000, followUpDebounceMs: 1000 }
  const w = createConversationWindow({ config: () => config, clock: () => now, log: quiet })
  return { w, config, advance(ms) { now += ms } }
}
test('窗口按群和用户隔离；没有新消息不启动模型；严格按到期时间关闭', () => {
  const { w, advance } = setup()
  w.open(chat, ADMIN_QQ); w.open(chat, MEMBER_QQ)
  assert.equal(w.capture(event()), true)
  assert.equal(w.capture(event(MEMBER_QQ)), true)
  assert.equal(w.capture(event(50001)), false)
  assert.equal(w.capture(event(ADMIN_QQ, { chatKey: 'group:20002' })), false)
  advance(9999); assert.equal(w.capture(event()), true)
  advance(1); assert.equal(w.capture(event()), false)
  assert.equal(w.hasOpen(chat), false)
  w.stop()
})
test('普通消息和不发不续期；真正发出的回复续期，主动消息不打开窗口', () => {
  const { w, advance } = setup()
  const turnCtx = { isGroup: true, wakeKind: 'at', participants: [String(ADMIN_QQ)] }
  w.noteReply({ target: chat, conversationReply: true, turnCtx })
  advance(9000); assert.equal(w.capture(event()), true)
  advance(1000); assert.equal(w.capture(event()), false)
  w.noteReply({ target: chat, conversationReply: true, turnCtx: { ...turnCtx, wakeKind: 'proactive' } })
  assert.equal(w.hasOpen(chat), false)
  w.noteReply({ target: chat, conversationReply: true, turnCtx: { ...turnCtx, wakeKind: 'followup' } })
  assert.equal(w.capture(event()), true)
  w.stop()
})
test('入窗资格以收到时为准；重置使已收集候选失效；关闭/卸载不会冲出旧消息', async () => {
  const { w, advance, config } = setup()
  w.open(chat, ADMIN_QQ)
  const ev = event(); w.capture(ev)
  advance(10000)
  assert.equal(w.current(ev), true, '材料处理慢不丢掉已接收的消息')
  let calls = 0
  w.submit(ev, () => { calls++ })
  w.clear(chat); await w.flush(chat, ADMIN_QQ)
  assert.equal(w.current(ev), false); assert.equal(calls, 0)
  w.open(chat, ADMIN_QQ); config.groupFollowUpMs = 0
  assert.equal(w.capture(event()), false)
  config.groupFollowUpMs = 10000
  const next = event(); w.capture(next); w.submit(next, () => { calls++ })
  w.stop(); await w.flush(chat, ADMIN_QQ); assert.equal(calls, 0)
})
test('同人连发合成一批；不同人互不覆盖；保留各自图片/引用', async () => {
  const { w } = setup(); const batches = []
  w.open(chat, ADMIN_QQ, { images: [{ file: 'one.png' }], replyToId: 42 })
  w.open(chat, MEMBER_QQ)
  const a = event(), b = event(), c = event(MEMBER_QQ)
  for (const ev of [a, b, c]) { w.capture(ev); w.submit(ev, (evs) => batches.push(evs)) }
  await w.flush(chat, ADMIN_QQ); await w.flush(chat, MEMBER_QQ)
  assert.deepEqual(batches.map((b) => b.length), [2, 1])
  assert.equal(a.replyToId, 42); assert.equal(a.images[0].file, 'one.png')
  assert.equal(b.images.length, 0, '只把挂起附件交给首条补充')
  w.stop()
})

async function boot(t, config = {}) {
  const h = await bootKernel({ config: {
    pacing: { merge: { enabled: false }, reply: { enabled: false } },
    outbound: { quoteAfterMsgs: 1 },
    pluginConfig: {
      'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
      'gate-wake': { keywords: '*: 小鱼', followUpDebounceMs: 1000 },
      'link-parser': { enabled: false },
    }, ...config,
  } })
  t.after(() => h.dispose()); return h
}
function start(h, request) {
  h.ctx.emit('session/event', { id: request.sessionId }, { type: 'turn/start' })
  consumed(h, request)
}
function consumed(h, request) {
  h.ctx.emit('session/event', { id: request.sessionId }, { type: 'user/message', data: { source: { rpcId: request.requestId } } })
}
function end(h, request) {
  h.ctx.emit('session/event', { id: request.sessionId }, { type: 'turn/end' })
}
function send(h, request, text) {
  return h.ctx._registeredTools.get('mcp__qq__send_message').execute(
    { target: chat, text }, { agent: { session: { id: request.sessionId } } },
  )
}
test('回复后才开启免唤醒；主动总开关关闭也可接话；陌生群友仅留作背景', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '问题', messageId: 101 }))
  const first = h.ctx._prompts[0]; start(h, first)
  await emitRaw(h.kernel, groupAtEvent({ text: '还没有回复时', at: false, messageId: 102 }))
  assert.equal(h.ctx._prompts.length, 1)
  await send(h, first, '第一句回答'); end(h, first)
  await emitRaw(h.kernel, groupAtEvent({ text: '陌生人的闲聊', userId: MEMBER_QQ, at: false, messageId: 103 }))
  await emitRaw(h.kernel, groupAtEvent({ text: '那第二种情况呢', at: false, messageId: 104 }))
  await h.kernel.conversation.flush(chat, ADMIN_QQ)
  assert.equal(h.ctx._prompts.length, 2)
  const second = h.ctx._prompts[1]
  assert.match(second.content[0].text, /候选接话/)
  assert.match(second.content[0].text, /那第二种情况呢/)
  assert.doesNotMatch(second.content[0].text, /陌生人的闲聊/)
  start(h, second); end(h, second) // model chooses [不发]: no send tool
  assert.equal(h.sent.length, 1, '内部不发不泄漏到 QQ')
})
test('多人纯呼名固定应答不调用模型，双方补正文都能进入自己的窗口', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '', messageId: 201 }))
  await emitRaw(h.kernel, groupAtEvent({ text: '小鱼', at: false, userId: MEMBER_QQ, messageId: 202 }))
  assert.equal(h.ctx._prompts.length, 0); assert.equal(h.sent.length, 2)
  for (const [qq, id] of [[ADMIN_QQ, 203], [MEMBER_QQ, 204]]) {
    await emitRaw(h.kernel, groupAtEvent({ text: `补充${id}`, at: false, userId: qq, messageId: id }))
    await h.kernel.conversation.flush(chat, qq)
  }
  assert.equal(h.ctx._prompts.length, 2)
  assert.match(h.ctx._prompts[0].content[0].text, /补充203/)
  assert.match(h.ctx._prompts[1].content[0].text, /补充204/)
})
test('显式呼名不会降级为候选；接话窗口内同人再次呼名不被关键词冷却吞掉', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '小鱼第一问', at: false, messageId: 301 }))
  const first = h.ctx._prompts[0]; start(h, first); await send(h, first, '回答'); end(h, first)
  await emitRaw(h.kernel, groupAtEvent({ text: '小鱼第二问', at: false, messageId: 302 }))
  assert.equal(h.ctx._prompts.length, 2)
  assert.match(h.ctx._prompts[1].content[0].text, /关键词:/)
  assert.doesNotMatch(h.ctx._prompts[1].content[0].text, /候选接话/)
})
test('忙时插话：被读取前仍引用原人，读取后绑定新人；同回合结束清理全部状态', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: 'A的问题', messageId: 401 }))
  const a = h.ctx._prompts[0]; start(h, a)
  await emitRaw(h.kernel, groupAtEvent({ text: 'B的问题', userId: MEMBER_QQ, messageId: 402 }))
  const b = h.ctx._prompts[1]; assert.equal(b.mode, 'steer')
  await send(h, a, '回答A'); assert.match(h.sent.at(-1).wire, /reply,id=401/)
  consumed(h, b) // no second turn/start
  await send(h, b, '回答B'); assert.match(h.sent.at(-1).wire, /reply,id=402/)
  assert.equal(h.kernel.pendingTurns.size, 0)
  assert.equal(h.kernel.turnBySession.get(a.sessionId)._triggeredBy, 'other', '混合身份不借主人权限')
  end(h, a)
  assert.equal(h.kernel.activeTurns.size, 0); assert.equal(h.kernel.turnBySession.size, 0)
  assert.equal(h.kernel.state.get(chat).turnQueue.length, 0)
})
test('忙时候选接话插入当前回合；拒绝发送不覆盖之前明确提问', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '明确的问题', messageId: 501 }))
  const a = h.ctx._prompts[0]; start(h, a); await send(h, a, '先说一句')
  await emitRaw(h.kernel, groupAtEvent({ text: '我跟乙说点别的', at: false, messageId: 502 }))
  await h.kernel.conversation.flush(chat, ADMIN_QQ)
  const b = h.ctx._prompts[1]; assert.equal(b.mode, 'steer')
  consumed(h, b)
  assert.equal(h.kernel.turnBySession.get(a.sessionId).wakeKind, 'at')
  assert.match(b.content[0].text, /其他明确唤醒的问题仍须处理/)
  assert.equal(h.sent.length, 1)
  end(h, a); assert.equal(h.kernel.pendingTurns.size, 0)
})
test('插话赶上上一回合结束：下一回合开始时照常绑定，不丢消息', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: 'A', messageId: 601 }))
  const a = h.ctx._prompts[0]; start(h, a)
  await emitRaw(h.kernel, groupAtEvent({ text: 'B', userId: MEMBER_QQ, messageId: 602 }))
  const b = h.ctx._prompts[1]; end(h, a); start(h, b)
  assert.equal(h.kernel.turnBySession.get(b.sessionId).triggerMsgId, 602)
  assert.equal(h.kernel.pendingTurns.size, 0); end(h, b)
})
test('旧定时续聊已移除：旧配置不会再调度补话，也不在控制台暴露', async () => {
  const p = createPacing({ log: quiet, state: { get: () => ({}) } })
  p.apply({ reply: { enabled: false, continuation: { enabled: true, delayMs: 1 } } })
  assert.equal(p.config.reply.continuation, undefined)
  assert.equal(p.noteWake, undefined); assert.equal(p.noteReplySent, undefined)
  const { CORE_CONTROLS } = await import('../admin/schema.js')
  assert.equal(CORE_CONTROLS.some((c) => c.key.includes('continuation') || c.key.includes('Continuation')), false)
  p.stop()
})

test('计时收集遵守静默间隔和三秒上限，只有到点才提交', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { w, advance } = setup(); const batches = []
  w.open(chat, ADMIN_QQ)
  const submit = () => { const ev = event(); w.capture(ev); w.submit(ev, (xs) => batches.push(xs)) }
  submit()
  for (let i = 0; i < 3; i++) { advance(900); t.mock.timers.tick(900); submit() }
  assert.equal(batches.length, 0)
  advance(299); t.mock.timers.tick(299); assert.equal(batches.length, 0)
  advance(1); t.mock.timers.tick(1); assert.equal(batches[0].length, 4)
  submit(); advance(999); t.mock.timers.tick(999); assert.equal(batches.length, 1)
  advance(1); t.mock.timers.tick(1); assert.equal(batches.length, 2)
  w.stop()
})

test('重载让已过期、已离开缓冲但仍准备中的候选失效；系统出站不续期', () => {
  const { w, advance } = setup()
  w.open(chat, ADMIN_QQ)
  const ev = event(); w.capture(ev)
  advance(10000); w.hasOpen(chat) // prune the original window
  assert.equal(w.current(ev), true)
  w.clear(); assert.equal(w.current(ev), false)
  const turnCtx = { isGroup: true, wakeKind: 'at', participants: [ADMIN_QQ] }
  w.noteReply({ target: chat, turnCtx })
  assert.equal(w.hasOpen(chat), false, '命令或系统提示不能开窗')
  w.noteReply({ target: chat, turnCtx: { ...turnCtx, _submissionFailed: true }, conversationReply: true })
  assert.equal(w.hasOpen(chat), false)
  w.stop()
})

test('材料准备期间重置，候选不得在准备结束后交模型', async (t) => {
  const h = await boot(t)
  h.kernel.conversation.open(chat, ADMIN_QQ)
  h.kernel.pipeline.use('before-turn', () => h.kernel.conversation.clear(chat), { pluginId: 'test-reset', order: 999 })
  await emitRaw(h.kernel, groupAtEvent({ text: '稍等我发个附件', at: false, messageId: 701 }))
  await h.kernel.conversation.flush(chat, ADMIN_QQ)
  assert.equal(h.ctx._prompts.length, 0)
})

test('候选真正回复后仍可追问；不发没有额外出站；发送失败不打开窗口', async (t) => {
  const h = await boot(t)
  h.kernel.conversation.open(chat, ADMIN_QQ)
  await emitRaw(h.kernel, groupAtEvent({ text: '第二种呢', at: false, messageId: 711 }))
  await h.kernel.conversation.flush(chat, ADMIN_QQ)
  const a = h.ctx._prompts[0]; start(h, a)
  h.kernel.conversation.clear(chat)
  await send(h, a, '第二种可以这样'); end(h, a)
  assert.equal(h.kernel.conversation.hasOpen(chat), true)
  await emitRaw(h.kernel, groupAtEvent({ text: '第三种呢', at: false, messageId: 712 }))
  await h.kernel.conversation.flush(chat, ADMIN_QQ)
  const b = h.ctx._prompts[1]; start(h, b)
  h.kernel.conversation.clear(chat)
  h.kernel.onebot.sendMessage = async () => { throw new Error('发送失败') }
  await assert.rejects(() => send(h, b, '这条未送达'), /发送失败/)
  assert.equal(h.kernel.conversation.hasOpen(chat), false); end(h, b)
})

test('连续读取两次插话：引用跟随最新输入，结束后所有输入锚均清除', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '第一问', messageId: 721 }))
  const a = h.ctx._prompts[0]; start(h, a)
  const original = h.kernel.turnBySession.get(a.sessionId)
  original.stickersSent = 1
  original.stickerNudged = 2
  for (const messageId of [722, 723]) {
    await emitRaw(h.kernel, groupAtEvent({ text: '补充问题', userId: MEMBER_QQ, messageId }))
    consumed(h, h.ctx._prompts.at(-1))
  }
  assert.equal(h.kernel.turnBySession.get(a.sessionId)._inputs.length, 3)
  const latest = h.kernel.turnBySession.get(a.sessionId)
  assert.equal(latest.stickersSent, 1, '插话不重置单轮表情额度')
  assert.equal(latest.stickerNudged, 2, '插话不重置提醒次数')
  original.imagegenUsed++ // async tool finishing after consumption of a steer
  assert.equal(latest.imagegenUsed, 1, '旧工具异步完成仍更新同一回合')
  original.nextImageParts.push({ name: 'frame' })
  assert.deepEqual(latest.nextImageParts, [{ name: 'frame' }])
  await send(h, a, '回答最新补充'); assert.match(h.sent.at(-1).wire, /reply,id=723/)
  end(h, a)
  assert.equal(h.kernel.pendingTurns.size, 0)
  assert.equal(h.kernel.state.get(chat).turnQueue.length, 0)
})

test('turn/start 不提前冒认队首；宿主先读取插话也按 requestId 绑定', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '队列问题', messageId: 731 }))
  const a = h.ctx._prompts[0]
  h.ctx.emit('session/event', { id: a.sessionId }, { type: 'turn/start' })
  assert.equal(h.kernel.turnBySession.has(a.sessionId), false)
  await emitRaw(h.kernel, groupAtEvent({ text: '插话先读', userId: MEMBER_QQ, messageId: 732 }))
  const b = h.ctx._prompts[1]; assert.equal(b.mode, 'steer')
  consumed(h, b)
  assert.equal(h.kernel.turnBySession.get(a.sessionId).triggerMsgId, 732)
  assert.equal(h.kernel.pendingTurns.get(a.sessionId).length, 1)
  consumed(h, a); assert.equal(h.kernel.pendingTurns.size, 0)
  assert.equal(h.kernel.turnBySession.get(a.sessionId)._triggeredBy, 'other')
  end(h, a); assert.equal(h.kernel.state.get(chat).turnQueue.length, 0)
})

test('合批保留两人消息/引用/图片来源，混合身份不借主人权限', async (t) => {
  const h = await boot(t, { pacing: { merge: { enabled: true, windowMs: 2000 } } })
  h.kernel.onebot.msgById = async (id) => ({ message: '被引内容' + id, sender: { user_id: MEMBER_QQ, nickname: '群友' } })
  h.kernel.pipeline.use('before-turn', (ev) => {
    ev.imageParts.push({ data: 'AAAA', mediaType: 'image/png', name: 'qq-forward:转发A-1' })
  }, { pluginId: 'test-images', order: 999 })
  await emitRaw(h.kernel, groupAtEvent({ text: '甲问', messageId: 741, replyTo: 41, userId: MEMBER_QQ }))
  await emitRaw(h.kernel, groupAtEvent({ text: '乙问', messageId: 742, replyTo: 42 }))
  h.kernel.pacing.flush(chat)
  const req = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (h.ctx._prompts.length) return h.ctx._prompts[0]
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('合批未提交')
  })()
  const text = req.content[0].text
  assert.match(text, /甲问/); assert.match(text, /乙问/)
  assert.match(text, /被引内容41/); assert.match(text, /被引内容42/)
  assert.equal(req.content.filter((x) => x.type === 'image').length, 2)
  assert.ok(req.content.some((x) => x.text?.includes('QQ 消息 ID 741')))
  assert.ok(req.content.some((x) => x.text?.includes('QQ 消息 ID 742')))
  start(h, req)
  assert.equal(h.kernel.turnBySession.get(req.sessionId)._triggeredBy, 'other')
  end(h, req)
})
