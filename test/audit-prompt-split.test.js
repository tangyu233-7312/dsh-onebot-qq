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

test('候选接话：保留说话人并允许内部不发，明确唤醒仍须处理', () => {
  const t = buildPromptText(ev({ sender: { qq: 10002, name: '甲' }, text: '那这个呢', wake: { kind: 'followup' } }))
  assert.match(t, /甲\(QQ:10002\)/)
  assert.match(t, /候选接话/)
  assert.match(t, /\[不发\] 原因/)
  assert.match(t, /其他明确唤醒的问题仍须处理/)
})

test('普通回话（非合成轮）：尾部还是原来那句通用的', () => {
  const t = buildPromptText(ev({ wake: { kind: 'at' }, text: '在吗' }))
  assert.match(t, /\[提醒:只写正文收不到\]/)
  assert.equal(t.includes('发到群里必须调'), false)
  assert.equal(t.includes('想说话就调'), false)
})

// ── 提示词可配置（2026-10-29）──────────────────────────────
test('收尾句可被调用方覆盖（ev._tail）', () => {
  const t = buildPromptText(ev({ chatKey: 'private:1', isGroup: false, groupId: null, _tail: '[提醒: 爱说不说]' }))
  assert.match(t, /\[提醒: 爱说不说\]/)
  // 不带方括号的也认，会自动补前缀
  const t2 = buildPromptText(ev({ chatKey: 'private:1', isGroup: false, groupId: null, _tail: '爱说不说' }))
  assert.match(t2, /\[提醒: 爱说不说\]/)
})
