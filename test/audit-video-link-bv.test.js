/**
 * audit-video-link-bv — 「贴 B 站链接 / 只发 BV 号就能看视频」的纪律自检
 *
 * 只测插件自己的判定与副作用：不联网、不起侧车（fetch 用桩替换）。
 * 关注四件事：
 *   ① 正文里的 B 站链接 / 分享卡片里的链接 / **裸 BV 号** 都能命中；
 *   ② 私聊里贴链接也看（旧实现 `if (!ev.wake) return` 把私聊整条路堵死了）；
 *   ③ 主动接话轮（proactive/continuation）不下载 —— 那是它自己找的话，不该顺带烧一次多模态；
 *   ④ 没被叫的群消息不下载。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/video-link-read/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个假帧文件（真读一次，走的是插件的 fs.readFile 分支） */
function makeFrame(dir) {
  const f = path.join(dir, 'f0.jpg')
  // 最小 JPEG 头 + 填充：mediaTypeOf 只认文件头
  fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))
  return f
}

/** 装配一个最小 bot：before-turn 钩子 + 假 state + fetch 桩 */
function setup(over = {}) {
  const cfg = {
    enabled: true,
    sidecarUrl: 'http://127.0.0.1:3972',
    onlyWhenAddressed: true,
    allowBvOnly: true,
    platforms: ['bilibili', 'douyin'],
    frames: 3,
    maxSide: 512,
    maxSeconds: 600,
    timeoutMs: 10,
    perUserHour: 0,
    perGroupHour: 0,
    tellOnFail: true,
  }
  Object.assign(cfg, over.cfg || {})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlink-'))
  const frame = makeFrame(dir)
  const calls = []
  const hooks = {}
  const state = new Map()
  const bot = {
    cfg,
    log: quiet,
    state: { get: (k) => { if (!state.has(k)) state.set(k, { lastSendAt: 0, lastInboundAt: 0, _scratch: Object.create(null) }); return state.get(k) } },
    onebot: {},
    on(stage, fn) { hooks[stage] = fn },
  }
  plugin.setup(bot)

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    if (over.fetchImpl) return over.fetchImpl(url, opts)
    return {
      ok: true,
      async json() {
        return {
          ok: true, platform: 'bilibili', title: '测试视频', durationSec: 212,
          frames: [{ path: frame, sec: 35 }],
        }
      },
    }
  }

  const run = async (ev) => {
    const e = {
      chatKey: 'group:1', isGroup: true, groupId: '1', messageId: 1,
      text: '', rawText: '', cards: [], rawSegments: [], imageParts: [], hint: [],
      _scratch: Object.create(null), mentionedSelf: false, wake: null, sender: { qq: 10001 },
      ...ev,
    }
    if (e.rawText === '' && e.text) e.rawText = e.text
    await hooks['before-turn'](e)
    return e
  }
  const restore = () => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }) }
  return { run, calls, restore, cfg }
}

test('正文里的 B 站链接：被叫到时下载并塞帧', async () => {
  const s = setup()
  try {
    const ev = await s.run({ text: '看看 https://www.bilibili.com/video/BV1GJ411x7h7 这个', wake: { kind: 'at' }, mentionedSelf: true })
    assert.equal(s.calls.length, 1)
    assert.match(s.calls[0].body.url, /BV1GJ411x7h7/)
    assert.equal(ev.imageParts.length, 1)
    assert.ok(ev.hint.some((h) => h.includes('测试视频')))
  } finally { s.restore() }
})

test('只发裸 BV 号（没有链接）：也能看', async () => {
  const s = setup()
  try {
    const ev = await s.run({ text: 'BV1GJ411x7h7 这个好康', wake: { kind: 'at' }, mentionedSelf: true })
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0].body.url, 'https://www.bilibili.com/video/BV1GJ411x7h7')
    assert.equal(ev.imageParts.length, 1)
  } finally { s.restore() }
})

test('裸 BV 号：关掉 allowBvOnly 后不再命中', async () => {
  const s = setup({ cfg: { allowBvOnly: false } })
  try {
    await s.run({ text: 'BV1GJ411x7h7', wake: { kind: 'at' }, mentionedSelf: true })
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})

test('裸 BV 号：前后粘着别的字母数字时不算（防误判）', async () => {
  const s = setup()
  try {
    await s.run({ text: 'xBV1GJ411x7h7y 这是乱码不是视频', wake: { kind: 'at' }, mentionedSelf: true })
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})

test('私聊里贴 B 站链接：也看（旧实现被 !ev.wake 挡住了）', async () => {
  const s = setup()
  try {
    const ev = await s.run({
      chatKey: 'private:10001', isGroup: false, groupId: null,
      text: 'https://www.bilibili.com/video/BV1GJ411x7h7', wake: { kind: 'private' },
    })
    assert.equal(s.calls.length, 1)
    assert.equal(ev.imageParts.length, 1)
  } finally { s.restore() }
})

test('分享卡片里的 B 站链接：命中', async () => {
  const s = setup()
  try {
    await s.run({ text: '这个', cards: ['https://www.bilibili.com/video/BV1GJ411x7h7'], wake: { kind: 'at' }, mentionedSelf: true })
    assert.equal(s.calls.length, 1)
  } finally { s.restore() }
})

test('主动接话轮（proactive）：不下载', async () => {
  const s = setup()
  try {
    await s.run({ text: 'BV1GJ411x7h7', wake: { kind: 'proactive' } })
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})

test('没被叫的群消息：不下载', async () => {
  const s = setup()
  try {
    await s.run({ text: 'BV1GJ411x7h7 随手贴的', wake: null })
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})

test('侧车连不上：如实告诉模型没看到画面（别按标题编）', async () => {
  const s = setup({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  try {
    const ev = await s.run({ text: 'BV1GJ411x7h7', wake: { kind: 'at' }, mentionedSelf: true })
    assert.equal(ev.imageParts.length, 0)
    assert.ok(ev.hint.some((h) => h.includes('视频内容未获取')), '应该提示没看到画面')
  } finally { s.restore() }
})

test('这一轮已经看过别的视频（imageParts 非空）：不重复下载', async () => {
  const s = setup()
  try {
    await s.run({
      text: 'BV1GJ411x7h7', wake: { kind: 'at' }, mentionedSelf: true,
      imageParts: [{ mediaType: 'image/jpeg', data: '', name: 'x' }],
    })
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})
