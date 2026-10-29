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

// ── 提示词可配置（2026-10-29）──────────────────────────────
test('提示词文案不写死在代码里：默认值在 REPLY_DEFAULTS.prompts，控制台有 6 个可改项', async () => {
  const { REPLY_DEFAULTS } = await import('../kernel/pacing.js')
  const { CORE_CONTROLS } = await import('../admin/schema.js')
  const keys = ['private', 'privateContinuation', 'group', 'groupContinuation', 'tailPrivate', 'tailGroup']
  for (const k of keys) {
    assert.equal(typeof REPLY_DEFAULTS.prompts[k], 'string', '默认值缺 ' + k)
    assert.ok(REPLY_DEFAULTS.prompts[k].length > 5, k + ' 太短，像是占位没填')
  }
  const exposed = CORE_CONTROLS.filter((c) => c.key.startsWith('pacing.reply.prompts.'))
  assert.equal(exposed.length, 6, '控制台应暴露 6 个提示词项，实际 ' + exposed.length)
  for (const c of exposed) assert.equal(c.type, 'text', c.key + ' 应该是多行文本控件')
})

test('私聊默认文案里没有多余的说教句（用户明确不想要）', async () => {
  const { REPLY_DEFAULTS } = await import('../kernel/pacing.js')
  const p = REPLY_DEFAULTS.prompts
  assert.equal(p.private.includes('别问「你怎么不理我」'), false)
  assert.equal(p.private.includes('别像客服'), false)
  assert.equal(p.tailPrivate.includes('不用解释'), true, '收尾那句保留「不用解释」')
})

test('收尾句可被调用方覆盖（ev._tail）', () => {
  const t = buildPromptText(ev({ chatKey: 'private:1', isGroup: false, groupId: null, _tail: '[提醒: 爱说不说]' }))
  assert.match(t, /\[提醒: 爱说不说\]/)
  // 不带方括号的也认，会自动补前缀
  const t2 = buildPromptText(ev({ chatKey: 'private:1', isGroup: false, groupId: null, _tail: '爱说不说' }))
  assert.match(t2, /\[提醒: 爱说不说\]/)
})

test('群聊续聊的 {n} 占位符能替换', () => {
  const t = buildPromptText(ev({ wake: { kind: 'continuation' }, hint: ['你刚回过话，之后群里又有 7 条新消息'] , _tail: '[提醒: x]' }))
  assert.match(t, /7 条新消息/)
})

test('控制台那 6 个提示词框一进来就带默认文案（不是空的）', async () => {
  // 用户没改过配置时，面板不该显示空 —— 否则会以为「提示词是空的」或不知道怎么写。
  const { CORE_CONTROLS, readValue } = await import('../admin/schema.js')
  const { REPLY_DEFAULTS } = await import('../kernel/pacing.js')
  const keyMap = {
    'pacing.reply.prompts.private': 'private',
    'pacing.reply.prompts.privateContinuation': 'privateContinuation',
    'pacing.reply.prompts.group': 'group',
    'pacing.reply.prompts.groupContinuation': 'groupContinuation',
    'pacing.reply.prompts.tailPrivate': 'tailPrivate',
    'pacing.reply.prompts.tailGroup': 'tailGroup',
  }
  // 空配置：模拟「用户一个都没改」
  const fakeKernel = { pluginConfig: {} }
  for (const [key, field] of Object.entries(keyMap)) {
    const entry = CORE_CONTROLS.find((c) => c.key === key)
    assert.ok(entry, '缺配置项 ' + key)
    assert.equal(entry.default, REPLY_DEFAULTS.prompts[field], key + ' 的 default 应等于默认文案')
    assert.ok(String(entry.default).length > 10, key + ' 的默认值太短')
    const shown = readValue(fakeKernel, key, {})
    assert.equal(shown, REPLY_DEFAULTS.prompts[field], key + ' 在空配置下应回落到默认文案')
    assert.ok(String(shown).trim().length > 10, key + ' 面板显示为空了')
  }
})

test('用户改过就显示用户的值，不再回落到默认', async () => {
  const { readValue } = await import('../admin/schema.js')
  const fakeKernel = { pluginConfig: {} }
  const raw = { pacing: { reply: { prompts: { private: '我自己写的一句' } } } }
  assert.equal(readValue(fakeKernel, 'pacing.reply.prompts.private', raw), '我自己写的一句')
})
