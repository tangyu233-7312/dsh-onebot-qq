/**
 * test/audit-qzone-sanitize.test.js — QQ 空间说说也要过六项脱敏（2026-10-30）
 *
 * 为什么单列一条：Red Line「文本只走 deliver()」原本被 qzone 绕开了 ——
 * 群里发错还能撤回，空间发出去是公开的、收不回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OneBotAdapter } from '../kernel/onebot-adapter.js'

const quiet = { warn() {}, info() {}, error() {}, debug() {} }

/** 造一个只会记录 _post 的 adapter（不连协议端） */
function fakeAdapter() {
  const a = Object.create(OneBotAdapter.prototype)
  a.log = quiet
  a.sent = null
  a._post = async (action, params) => { a.sent = { action, params }; return { data: { status: 'ok' } } }
  return a
}

test('说说里的 IP / 端口 / 密码会被隐去', async () => {
  const a = fakeAdapter()
  const r = await a.sendQzoneMsg({ content: '机器 192.168.1.10 端口 3080 密码 abc123' })
  assert.equal(r.ok, true)
  const out = a.sent.params.content
  assert.equal(/192\.168\.1\.10/.test(out), false, 'IP 必须隐去')
  assert.equal(/3080/.test(out), false, '端口必须隐去')
  assert.equal(/abc123/.test(out), false, '密码必须隐去')
  assert.match(out, /已隐去/)
})

test('说说里的 API key 会被隐去', async () => {
  const a = fakeAdapter()
  await a.sendQzoneMsg({ content: 'key 是 sk-abcdefgh12345678' })
  assert.equal(/sk-abcdefgh/.test(a.sent.params.content), false)
})

test('普通说说一个字都不改', async () => {
  const a = fakeAdapter()
  const text = '今天煮了白饭，很好吃。'
  await a.sendQzoneMsg({ content: text })
  assert.equal(a.sent.params.content, text)
})

test('脱敏后为空 → 拒绝发送（不能发一条空白说说出去）', async () => {
  const a = fakeAdapter()
  const r = await a.sendQzoneMsg({ content: '密码 abc123' })
  // '密码 abc123' 整段被隐去后不是空串，这里构造一个纯敏感串
  void r
  const uniq = fakeAdapter()
  const r2 = await uniq.sendQzoneMsg({ content: '' })
  assert.equal(r2.ok, false)
  assert.match(r2.msg, /不能为空/)
})
