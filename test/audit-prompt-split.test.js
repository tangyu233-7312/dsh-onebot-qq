/**
 * audit-prompt-split — 合成轮（主动开口 / 续聊）的提示词按群聊 / 私聊分流
 *
 * 背景：原来 format.js 的 wakeMark 与尾部提醒都写死了群聊口径，
 * 私聊主动接话时模型会看到「群里正聊着」「发到群里必须调 send_message」——
 * 在只有两个人的私聊里完全是错位的（线上真实出现：它说「本鱼自己醒了」）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPromptText } from '../kernel/format.js'

const ev = (over = {}) => ({
  chatKey: 'group:1', isGroup: true, groupId: '1', messageId: 1,
  sender: { qq: 0, name: '', card: null, isMaster: false },
  text: '', hint: [], imageParts: [], imagePaths: [], cards: [],
  wake: { kind: 'proactive' },
  ...over,
})

test('群聊主动开口：保留「不发也要写一行 [不发] 原因」的强约束', () => {
  const t = buildPromptText(ev())
  assert.match(t, /\[主动开口轮\]/)
  assert.match(t, /发到群里必须调 send_message/)
  assert.match(t, /写一行 \[不发\] 原因/)
})

test('私聊主动开口：不再出现「群里」字样，也不逼它解释为什么不发', () => {
  const t = buildPromptText(ev({ chatKey: 'private:10001', isGroup: false, groupId: null }))
  assert.equal(t.includes('群里'), false, '私聊提示词里不该出现「群里」')
  assert.equal(t.includes('发到群里必须调'), false)
  assert.equal(t.includes('[不发] 原因'), false, '私聊不该逼它写 [不发] 原因')
  assert.match(t, /想说话就调 send_message/)
  assert.match(t, /不想说就不发/)
})

test('群聊续聊：同样按群聊口径', () => {
  const t = buildPromptText(ev({ wake: { kind: 'continuation' } }))
  assert.match(t, /\[续聊检查\]/)
  assert.match(t, /发到群里必须调 send_message/)
})

test('私聊续聊：放宽，不逼表态', () => {
  const t = buildPromptText(ev({ chatKey: 'private:10001', isGroup: false, groupId: null, wake: { kind: 'continuation' } }))
  assert.match(t, /\[续聊检查\]/)
  assert.equal(t.includes('群里'), false)
  assert.equal(t.includes('[不发] 原因'), false)
})

test('普通回话（非合成轮）：尾部还是原来那句通用的', () => {
  const t = buildPromptText(ev({ wake: { kind: 'at' }, text: '在吗' }))
  assert.match(t, /\[提醒:只写正文收不到\]/)
  assert.equal(t.includes('发到群里必须调'), false)
  assert.equal(t.includes('想说话就调'), false)
})

test('唤醒标记只有极简标签，不再重复写场景说明', () => {
  const t = buildPromptText(ev())
  // 旧写法会把「主动接话候选:没人叫你,群里正聊着;想接就调 send_message…」整句塞进标记里
  assert.equal(/主动接话候选:没人叫你/.test(t), false, '标记里不该再带整句说明（细节归 hint）')
})
