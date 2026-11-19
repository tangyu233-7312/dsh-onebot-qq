import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEvent } from '../contracts.js'
import { ChatState } from '../kernel/state-pipeline.js'
import { collectForwardMaterial, appendForwardContext } from '../kernel/forward-context.js'
import { loadIncomingImages } from '../kernel/incoming-images.js'
import { bootKernel, emitRaw, groupAtEvent, waitFor } from './helpers.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=', 'base64')
const txt = (text) => ({ type: 'text', data: { text } })
const img = (url = 'https://example.com/image.png', file = '') => ({ type: 'image', data: { url, file } })
const entry = (...message) => ({ sender: { user_id: 10001, nickname: '群友A' }, message })
const card = (content, id = 'forward-a') => ({ id, content })
const seg = (value) => ({ type: 'forward', data: value })
const onebot = (overrides = {}) => ({ selfId: 999999, msgById: async () => null, getForwardMsg: async () => null, ...overrides })
const event = (overrides = {}) => {
  const ev = createEvent({ chatKey: 'group:20001', isGroup: true, groupId: 20001,
    sender: { qq: 10001 }, messageId: 101, text: '看这个转发', ...overrides })
  ev.wake = { kind: 'at' }
  return ev
}
const quiet = { warn() {} }
function tempSink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-forward-'))
  let n = 0
  return { file: (_tag, ext) => path.join(dir, `image-${++n}${ext}`) }
}
async function prepare(contents, opts = {}) {
  const ev = event()
  ev._scratch.forwards = [card(contents)]
  await appendForwardContext(ev, { onebot: onebot(), ...opts })
  return ev
}

test('转发图保留原地址、发送者和条目归属，内联内容不调用回退接口', async () => {
  let calls = 0
  const m = await collectForwardMaterial([card([entry(txt('RGVEDA'), img())])], {
    sourceId: 101, onebot: onebot({ getForwardMsg: async () => { calls++; throw Error('不应调用') } }),
  })
  assert.equal(calls, 0)
  assert.match(m.text, /群友A\(QQ:10001\).*RGVEDA/)
  assert.equal(m.images[0].url, 'https://example.com/image.png')
  assert.deepEqual(m.images[0]._forwardLabels, ['消息101/转发1/第1条/图1'])
})

test('只有 id 时通过 get_forward_msg 回退，文字和图片都被保留', async () => {
  const m = await collectForwardMaterial([{ id: 'only-id' }], {
    onebot: onebot({ getForwardMsg: async (id) => {
      assert.equal(id, 'only-id'); return { messages: [entry(txt('AMU'), img())] }
    } }),
  })
  assert.match(m.text, /AMU/); assert.equal(m.images.length, 1)
})

test('内层 message 为空时解析 raw_message 中的 CQ 图片，而非仅保留原始字符串', async () => {
  const m = await collectForwardMaterial([card([{ message: [], raw_message: '说明[CQ:image,file=cache.png]' }])])
  assert.equal(m.images[0].file, 'cache.png')
  assert.match(m.text, /说明\[图片\]/)
})

test('同图去重但保留所有所属条目；截断文字不丢图片', async () => {
  const m = await collectForwardMaterial([card([entry(txt('x'.repeat(100)), img()), entry(img())])], {
    limits: { totalChars: 20, perItemChars: 8 },
  })
  assert.equal(m.images.length, 1); assert.equal(m.images[0]._forwardLabels.length, 2)
  assert.equal(m.stats.clipped, true); assert.equal(m.stats.images, 1)
})

test('转发条数、图片数、嵌套层数与接口次数都有上限', async () => {
  const deep = card([entry(txt('最内层'))], 'deep')
  const nested = card([entry(img('https://example.com/b.png'), seg(deep))], 'nested')
  const m = await collectForwardMaterial([card([entry(img(), seg(nested)), entry(txt('第三条')), entry(txt('第四条'))])], {
    limits: { maxItems: 2, maxImages: 1 },
  })
  assert.equal(m.stats.items, 2); assert.equal(m.stats.omittedItems, 2)
  assert.equal(m.stats.depthLimited, 1); assert.equal(m.stats.omittedImages, 1)
  let calls = 0
  const capped = await collectForwardMaterial([card([entry(seg({ id: 'a' }), seg({ id: 'b' }), seg({ id: 'c' }))])], {
    onebot: onebot({ getForwardMsg: async () => { calls++; return null } }), limits: { maxRequests: 1 },
  })
  assert.equal(calls, 1); assert.equal(capped.stats.unavailable, 3)
})

test('嵌套转发的图片进入材料，循环引用安全停止', async () => {
  const root = card([], 'root')
  root.content.push(entry(seg(card([entry(txt('内层'), img(), seg(root))], 'child'))))
  const m = await collectForwardMaterial([root], { limits: { maxDepth: 6 } })
  assert.equal(m.images.length, 1); assert.equal(m.stats.depthLimited, 1)
  assert.match(m.images[0]._forwardLabels[0], /第1条\/嵌套1\/第1条\/图1/)
})

test('同一条目含多份嵌套转发时图片标签仍唯一', async () => {
  const m = await collectForwardMaterial([card([entry(
    seg(card([entry(img())], 'child-a')),
    seg(card([entry(img('https://example.com/other.png'))], 'child-b')),
  )])])
  assert.equal(new Set(m.images.map((im) => im._forwardLabels[0])).size, 2)
})

test('被引转发优先复用已经反查的结果；不会重复请求 get_msg', async () => {
  const ev = event({ replyToId: 99 })
  ev._scratch.replyForwards = [card([entry(img())])]
  const bot = onebot({ msgById: async () => { throw Error('重复请求') } })
  await appendForwardContext(ev, { onebot: bot })
  assert.equal(ev.images.length, 1); assert.match(ev.images[0]._forwardLabels[0], /消息99/)
})

test('追问只关联同群同人、五分钟内明确读过的转发；不保存全文', async () => {
  const state = new ChatState(), bot = onebot({ msgById: async () => ({ message: [seg(card([entry(img())]))] }) })
  await prepare([entry(img())], { state, onebot: bot, now: () => 1000 })
  const follow = event({ messageId: 102, text: '那张图看不见嘛' })
  await appendForwardContext(follow, { state, onebot: bot, now: () => 2000 })
  assert.equal(follow.images.length, 1); assert.match(follow.hint.join(''), /转发追问/)
  const records = [...state.get(follow.chatKey)._scratch['kernel:recent-forwards'].values()].flat()
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'ids', 'messageId'])
  for (const other of [event({ sender: { qq: 10002 } }), event({ chatKey: 'group:20002', groupId: 20002 })]) {
    await appendForwardContext(other, { state, onebot: bot, now: () => 2000 })
    assert.equal(other.images.length, 0)
  }
  const expired = event()
  await appendForwardContext(expired, { state, onebot: bot, now: () => 302000 })
  assert.equal(expired.images.length, 0)
})

test('多份候选不猜；明确引用优先，普通聊天及合成轮不会重新下载转发图', async () => {
  const state = new ChatState(), bot = onebot({ msgById: async () => ({ message: [seg(card([entry(img())]))] }) })
  for (const id of [101, 102]) {
    const ev = event({ messageId: id }); ev._scratch.forwards = [card([entry(img())], `f-${id}`)]
    await appendForwardContext(ev, { state, onebot: bot })
  }
  const ambiguous = event({ text: '那张图' })
  await appendForwardContext(ambiguous, { state, onebot: bot })
  assert.equal(ambiguous.images.length, 0); assert.match(ambiguous.hint.join(''), /来源不明确/)
  const explicit = event({ replyToId: 101 })
  await appendForwardContext(explicit, { state, onebot: bot }); assert.equal(explicit.images.length, 1)
  for (const ev of [event({ text: '晚饭吃什么' }), event({ replyToId: 999 })]) {
    if (ev.replyToId) ev._scratch.replyForwards = []
    await appendForwardContext(ev, { state, onebot: bot }); assert.equal(ev.images.length, 0)
  }
  const synth = event(); synth.wake.kind = 'continuation'; synth._scratch.forwards = [card([entry(img())])]
  await appendForwardContext(synth, { state, onebot: bot }); assert.equal(synth.images.length, 0)
})

test('转发图片真正生成 base64 多模态块及参考路径，状态在下载成功后才标记', async () => {
  const ev = await prepare([entry(img())])
  await loadIncomingImages(ev, { onebot: onebot(), tmp: tempSink(), log: quiet, fetchImpl: async () => new Response(PNG) })
  assert.equal(ev.imageParts.length, 1); assert.equal(ev.imageParts[0].mediaType, 'image/png')
  assert.deepEqual(Buffer.from(ev.imageParts[0].data, 'base64'), PNG)
  assert.ok(fs.existsSync(ev.imagePaths[0])); assert.match(ev.hint.join(''), /本轮成功加载1张/)
  assert.match(ev.imageParts[0].name, /^qq-forward:消息101/)
})

test('协议端路径不可用时使用容器直链；get_file 抛错仍能回退事件图片 URL', async () => {
  for (const throws of [false, true]) {
    const ev = await prepare([entry(img('https://example.com/direct.png', 'cache.png'))])
    const seen = []
    const bot = onebot({
      getFile: async () => { if (throws) throw Error('接口失败'); return { file: '/missing/container.png' } },
      getFileUrl: async () => { if (throws) throw Error('接口失败'); return 'https://example.com/container.png' },
    })
    await loadIncomingImages(ev, { onebot: bot, tmp: tempSink(), log: quiet,
      fetchImpl: async (url) => { seen.push(url); return new Response(PNG) } })
    assert.equal(ev.imageParts.length, 1)
    assert.match(seen[0], throws ? /direct/ : /container/)
  }
})

test('过大响应按头部和流式累计拒绝；失败、缺地址、截断都会明确报告', async () => {
  for (const headers of [{ 'content-length': '999' }, {}]) {
    const ev = await prepare([entry(txt('x'.repeat(100)), img()), entry({ type: 'image', data: {} })])
    await loadIncomingImages(ev, { onebot: onebot(), tmp: tempSink(), log: quiet, limits: { perImageBytes: 8 },
      fetchImpl: async () => new Response(PNG, { headers }) })
    assert.equal(ev.imageParts.length, 0)
    assert.match(ev.hint.join(''), /体积超限/); assert.match(ev.hint.join(''), /缺少图片地址/)
    assert.match(ev.hint.join(''), /文字已截断/); assert.match(ev.hint.join(''), /本轮成功加载0张/)
  }
})

test('总字节预算及处理时限生效；下载失败不会被说成模型不支持', async () => {
  const ev = await prepare([entry(img()), entry(img('https://example.com/second.png'))])
  await loadIncomingImages(ev, { onebot: onebot(), tmp: tempSink(), log: quiet, limits: { totalBytes: PNG.length },
    fetchImpl: async () => new Response(PNG) })
  assert.equal(ev.imageParts.length, 1); assert.match(ev.hint.join(''), /图片总量超限/)
  const timed = await prepare([entry(img())]); let n = 0
  await loadIncomingImages(timed, { onebot: onebot(), tmp: tempSink(), log: quiet, now: () => (++n === 1 ? 0 : 50000),
    fetchImpl: async () => { throw Error('不应下载') } })
  assert.match(timed.hint.join(''), /图片处理超时/)
  const failed = await prepare([entry(img())])
  await loadIncomingImages(failed, { onebot: onebot(), tmp: tempSink(), log: quiet,
    fetchImpl: async () => new Response('expired', { status: 403 }) })
  assert.match(failed.hint.join(''), /图片下载失败/)
  assert.doesNotMatch(failed.hint.join(''), /模型不支持/)
})

test('视频插件已提供帧时仍附加转发图；普通直发图片维持原路径', async () => {
  const ev = await prepare([entry(img())]); ev.imageParts.push({ mediaType: 'image/png', data: 'video-frame' })
  await loadIncomingImages(ev, { onebot: onebot(), tmp: tempSink(), log: quiet, fetchImpl: async () => new Response(PNG) })
  assert.equal(ev.imageParts.length, 2)
  const normal = event({ images: [{ url: 'https://example.com/plain.png' }] })
  await loadIncomingImages(normal, { onebot: onebot(), tmp: tempSink(), log: quiet, fetchImpl: async () => new Response(PNG) })
  assert.equal(normal.imageParts[0].name, 'qq-image')
})

test('集成：引用合并转发→实际内核上下文→mock 模型输入包含标记和图片块，引用仅反查一次', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-forward-source-'))
  const local = path.join(dir, 'source.png'); fs.writeFileSync(local, PNG)
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } },
    pluginConfig: { 'persona-voice': { splitReplyEnabled: false }, 'video-wander': { enabled: false } } } })
  t.after(() => h.dispose())
  let reads = 0
  h.kernel.onebot.msgById = async () => { reads++; return { sender: { user_id: 10001 },
    message: [seg(card([entry(txt('RGVEDA'), img('', local))]))] } }
  const hook = h.kernel.pipeline.stages.get('before-turn').find((x) => x.pluginId === 'kernel:context')
  const ev = event({ replyToId: 99 })
  await hook.fn(ev)
  assert.equal(reads, 1); assert.equal(ev.imageParts.length, 1)
  const sid = await h.kernel.dsh.ensureSession(ev.chatKey)
  await h.kernel.dsh.prompt(sid, ev.hint.join('\n'), ev.imageParts)
  const content = h.ctx._prompts[0].content
  assert.match(content[0].text, /RGVEDA/); assert.match(content[1].text, /消息99\/转发1\/第1条\/图1/)
  assert.equal(content[2].type, 'image'); assert.deepEqual(Buffer.from(content[2].data, 'base64'), PNG)
  // 再走真实入站管线，验证不是只在独立函数里生成了图片。
  await emitRaw(h.kernel, groupAtEvent({ replyTo: 99, text: '请看转发图片', messageId: 103 }))
  await waitFor(() => h.ctx._prompts.length === 2)
  assert.ok(h.ctx._prompts[1].content.some((c) => c.type === 'image' && c.data === PNG.toString('base64')))
})
