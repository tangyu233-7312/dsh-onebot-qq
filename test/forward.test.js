/**
 * 合并转发解析的测试（纯函数，不起 OneBot）。
 * 用法：node test/forward.test.js   （或随 npm test 一起跑）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractText } from '../kernel/format.js'

const t = (text) => ({ type: 'text', data: { text } })

test('extractText：转发段不再静默丢弃，留占位并收集 {id, content}', () => {
  const r = extractText([{ type: 'forward', data: { id: 'fwd-1' } }], 10000)
  assert.equal(r.text, '[合并转发]', '正文里要有占位，否则模型完全不知道有转发')
  assert.deepEqual(r.forwards, [{ id: 'fwd-1', content: null }], '要收集转发 id（没有内联内容时 content 为 null）')
})

test('extractText：转发 + 正文混排', () => {
  const r = extractText([t('看这个'), { type: 'forward', data: { id: 'f1' } }], 1)
  assert.match(r.text, /看这个/)
  assert.match(r.text, /\[合并转发\]/)
  assert.deepEqual(r.forwards, [{ id: 'f1', content: null }])
})

test('extractText：普通消息的 forwards 是空数组（别让下游判 undefined）', () => {
  const r = extractText([t('你好')], 1)
  assert.deepEqual(r.forwards, [])
})

// ─────────────────────────────────────────────────────────────
// 真机回归：get_msg 已经把转发内容内联在 forward.data.content 里
//
// 现象：群里发合并转发 + @机器人，模型只看到「[合并转发]」，底下什么都没有。
// 原因：代码只取了 d.id 去调 get_forward_msg，而那个接口对这类消息直接失败 ——
//       实测返回 status:failed「消息已过期或者为内层消息，无法获取转发消息」。
//       可内容其实早就随 get_msg 一起回来了，只是没人读。
//
// 下面的形状照真机返回抄的（三条、其中一条 message 是空数组），
// QQ 号与昵称已换成占位值 —— 测试只需要形状，不需要真实身份。
// ─────────────────────────────────────────────────────────────
const ONEBOT_INLINE_FORWARD = {
  type: 'forward',
  data: {
    id: 'fwd-inline-1',
    content: [
      {
        user_id: 10001,
        sender: { user_id: 10001, nickname: '群友A', card: '' },
        raw_message: '第一条原文',
        message: [{ type: 'text', data: { text: '第一条原文' } }],
      },
      {
        user_id: 10002,
        sender: { user_id: 10002, nickname: '群友B', card: '' },
        raw_message: '第二条原文',
        message: [{ type: 'text', data: { text: '第二条原文' } }],
      },
      {
        // ⚠️ 真机上这条的 message 是空数组，正文只在 raw_message 里
        user_id: 10002,
        sender: { user_id: 10002, nickname: '群友B', card: '' },
        raw_message: '第三条原文',
        message: [],
      },
    ],
  },
}

test('真机回归：extractText 要把内联 content 一起带出来（不能只给 id）', () => {
  const r = extractText([ONEBOT_INLINE_FORWARD], 10000)
  assert.equal(r.forwards.length, 1)
  const f = r.forwards[0]
  assert.equal(f.id, 'fwd-inline-1', 'id 仍然要有（回退请求可能用到）')
  assert.ok(Array.isArray(f.content), 'content 必须带出来 —— 这是这次修复的核心')
  assert.equal(f.content.length, 3)
  assert.equal(r.text, '[合并转发]', '正文占位不变')
})
