/**
 * audit-video-recent — 「视频和 @ 分两条消息发」也要能看
 *
 * 背景（2026-10-29 线上）：QQ 客户端没法把视频和 @ 放进同一条消息，
 * 用户只能「先发视频」→「再单独发一条 @它 看看这个」。
 * 而 video-read 只在**当前这条**消息里找视频段，于是第二条消息找不到视频，
 * 静默返回，模型只能说「没抽到画面」。
 *
 * 三条来路都要能看：
 *   ① 同一条消息里带视频 + @
 *   ② 引用一条视频（先发视频，再引用它说话）
 *   ③ 上一条消息刚发过视频（本文件测的就是它）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import plugin from '../plugins/video-read/index.js'

function setup(cfgOver = {}) {
  const handlers = {}
  const states = new Map()
  const warns = []
  const delivered = []
  const bot = {
    cfg: {
      enabled: true,
      sidecarUrl: 'http://127.0.0.1:3972',
      onlyWhenAddressed: true,
      recentVideoSec: 120,
      frames: 2,
      maxSide: 256,
      maxSeconds: 600,
      ...cfgOver,
    },
    log: { warn: (m) => warns.push(m), info() {}, debug() {}, error() {} },
    core: { dataDir: '/tmp/qq-test', adminQq: 10001 },
    state: {
      get(k) {
        if (!states.has(k)) states.set(k, { _scratch: Object.create(null) })
        return states.get(k)
      },
    },
    on: (name, fn) => { handlers[name] = fn },
    deliver: async (to, text) => { delivered.push({ to, text }) },
    onebot: {},
  }
  plugin.setup(bot)
  return { bot, handlers, states, warns, delivered }
}

const videoEv = (over = {}) => ({
  chatKey: 'group:20001',
  isGroup: true,
  messageId: 100,
  sender: { qq: 10001, name: '测试', isMaster: true },
  text: '',
  rawSegments: [{ type: 'video', data: { file: 'abc.mp4', url: 'https://multimedia.nt.qq.com.cn/x.mp4' } }],
  wake: null,
  _scratch: Object.create(null),
  hint: [],
  imageParts: [],
  ...over,
})

const atEv = (over = {}) => ({
  chatKey: 'group:20001',
  isGroup: true,
  messageId: 101,
  sender: { qq: 10001, name: '测试', isMaster: true },
  text: '看看这个',
  rawSegments: [],
  wake: { kind: 'at' },
  replyToId: null,
  _scratch: Object.create(null),
  hint: [],
  imageParts: [],
  ...over,
})

/** 打桩 fetch：返回两帧假图（避免真连侧车） */
function stubFetch(t) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body })
    return new Response(JSON.stringify({ ok: true, durationSec: 30, title: '短视频', platform: 'qq',
      frames: [{ path: '/tmp/f1.jpg', sec: 0 }, { path: '/tmp/f2.jpg', sec: 10 }] }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = orig })
  return calls
}

test('先发视频、再单独 @它：第二条消息能接住第一条的视频', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup()
  // 第一条：只有视频，没人叫它（不进模型，但 passive-tap 会记下来）
  await handlers['passive-tap'](videoEv())
  // 第二条：只有 @ 和文字，没有视频段
  const ev2 = atEv()
  await handlers['before-turn'](ev2)
  assert.equal(calls.length, 1, '应该真的去问侧车了（说明接住了上一条的视频）')
  assert.match(String(calls[0].body), /multimedia\.nt\.qq\.com\.cn/, '请求里应带上那条视频的地址')
})

test('接住一次就用掉：再 @ 一次不会又翻出同一个视频', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup()
  await handlers['passive-tap'](videoEv())
  await handlers['before-turn'](atEv())
  assert.equal(calls.length, 1)
  await handlers['before-turn'](atEv({ messageId: 102 }))
  assert.equal(calls.length, 1, '第二次不该再用同一个视频')
})

test('超过 recentVideoSec 就不认了（窗口可配）', async (t) => {
  const calls = stubFetch(t)
  const s2 = setup({ recentVideoSec: 1 })
  await s2.handlers['passive-tap'](videoEv())
  const sc = s2.bot.state.get('group:20001')._scratch
  sc['video-read:lastSeg'].at = Date.now() - 5000   // 拨到 5 秒前，超过 1 秒窗口
  await s2.handlers['before-turn'](atEv())
  assert.equal(calls.length, 0, '过期就不该用')
})

test('recentVideoSec=0：关掉这条来路，回到「只认同一条消息 / 引用」', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup({ recentVideoSec: 0 })
  await handlers['passive-tap'](videoEv())
  await handlers['before-turn'](atEv())
  assert.equal(calls.length, 0, '关掉后不该接住上一条的视频')
})

test('同一条消息里带视频 + @：照旧能看（不受影响）', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup()
  const ev = videoEv({ wake: { kind: 'at' }, text: '看看这个' })
  await handlers['passive-tap'](ev)
  await handlers['before-turn'](ev)
  assert.equal(calls.length, 1)
})

test('file 段里发的视频也认（带视频扩展名）', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup()
  const ev = videoEv({
    wake: { kind: 'at' },
    rawSegments: [{ type: 'file', data: { file: '录像.mp4', url: 'https://example.cn/download?appid=1' } }],
  })
  await handlers['passive-tap'](ev)
  await handlers['before-turn'](ev)
  assert.equal(calls.length, 1, 'file 段的 mp4 应该被当成视频')
})

test('file 段但不是视频（比如 .zip）：不认，别去抽帧', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup()
  const ev = videoEv({
    wake: { kind: 'at' },
    rawSegments: [{ type: 'file', data: { file: '资料.zip', url: 'https://example.cn/dl.zip' } }],
  })
  await handlers['passive-tap'](ev)
  await handlers['before-turn'](ev)
  assert.equal(calls.length, 0)
})

test('内核反查引用时留下的原始段：优先用它（不再自己打 msgById）', async (t) => {
  const calls = stubFetch(t)
  const { handlers } = setup()
  // 模拟内核已经反查过被引消息，把原始段放在 ev._scratch.replyRawSegments
  const ev = atEv({
    replyToId: 999,
    _scratch: {
      replyRawSegments: [{ type: 'video', data: { file: 'x.mp4', url: 'https://multimedia.nt.qq.com.cn/y.mp4' } }],
    },
  })
  // 故意让 bot.onebot.msgById 不可用 —— 走内核那条路就该完全不需要它
  await handlers['before-turn'](ev)
  assert.equal(calls.length, 1, '应该用内核留的段去请求侧车')
})

test('内核没留原始段、也没有 msgById：不炸，只是看不到', async (t) => {
  const calls = stubFetch(t)
  const { handlers, warns } = setup()
  const ev = atEv({ replyToId: 1000 })   // chatKey 上没有 recent 记录
  await handlers['before-turn'](ev)
  assert.equal(calls.length, 0)
})
