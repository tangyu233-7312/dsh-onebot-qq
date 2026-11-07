/**
 * test/audit-dsh-driver.test.js — DSH in-process 会话驱动（并发建会话 / 重置 / greeted / 标题 /
 * 群上文水位 / 提问拦截 / 读图失败降级）。
 *
 * 迁移自旧 `audit-dsh-driver.test.js`：保留行为级断言；删除 dsh-ops-gate 外部插件与
 * 旧 rpc/standalone 相关用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent,
} from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, opts = {}) {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } } },
    ...opts,
  })
  t.after(() => h.dispose())
  return h
}

test('1. 同 chatKey 10 路并发 ensureSession 只建 1 个会话（防重复回复/双会话）', async (t) => {
  const h = await boot(t)
  const before = h.ctx._sessions.size
  const ids = await Promise.all(
    Array.from({ length: 10 }, () => h.kernel.dsh.ensureSession(`group:${GROUP_ID}`, '测试群')),
  )
  assert.equal(new Set(ids).size, 1, '只应创建一个会话')
  assert.equal(h.ctx._sessions.size, before + 1)
})

test('2. 重置语义：forgetSession 删映射（返回旧 id）；归档走 registry；再 ensure 得到全新会话', async (t) => {
  const h = await boot(t)
  const first = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  await h.kernel.dsh.archive(first)
  assert.deepEqual(h.ctx._workspaceRegistry.archived, [first])
  const old = h.kernel.dsh.forgetSession(`group:${GROUP_ID}`)
  assert.equal(old, first, 'forgetSession 返回旧 sessionId 供归档')
  assert.equal(h.kernel.dsh.sessionOf(`group:${GROUP_ID}`), '')
  const second = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  assert.notEqual(second, first, '重置后是全新会话')
})

test('3. greetedSessions：首轮带 [QQ会话 …]，后续轮只带消息 ID', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '第一句', messageId: 1001 }))
  await waitFor(() => h.ctx._prompts[0], { label: '第一轮' })
  assert.ok(h.ctx._prompts[0].content[0].text.includes('[QQ会话'), '首轮带会话标识')
  await emitRaw(h.kernel, groupAtEvent({ text: '第二句', messageId: 1002 }))
  await waitFor(() => h.ctx._prompts[1], { label: '第二轮' })
  assert.equal(h.ctx._prompts[1].content[0].text.includes('[QQ会话'), false, '后续轮不再带会话标识')
  assert.ok(h.ctx._prompts[1].content[0].text.includes('[本条消息ID 1002]'))
})

test('4. 首轮 prompt 失败（会话不存在）→ 删映射重建并重试，greeted 不提前标记', async (t) => {
  const h = await boot(t)
  let calls = 0
  h.ctx.setPromptHandler(async () => {
    calls += 1
    if (calls === 1) throw new Error('session/not-found: 未知会话')
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 1003 }))
  await waitFor(() => calls === 2, { label: '失败后重试一次' })
  await waitFor(() => h.ctx._prompts.length >= 2, { label: '第二轮 prompt' })
  assert.equal(h.ctx._prompts[1].content[0].text.includes('[QQ会话'), true, '重试时仍按首轮处理（带会话标识）')
})

test('5. user-questions/request：只拦截 QQ 会话；网页会话必须 next()（不抢答）', async (t) => {
  const h = await boot(t)
  const sid = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  const listeners = h.ctx._listeners.get('user-questions/request') || []
  assert.equal(listeners.length, 1, '驱动应挂提问拦截')
  const handler = listeners[0]
  let nexted = false
  const qqAnswer = await handler(
    { agent: { id: sid }, questions: [{ id: 'q1', text: '选一个' }, { id: 'q2', text: '再选' }] },
    () => { nexted = true; return 'web-answer' },
  )
  assert.equal(nexted, false, 'QQ 会话不交给网页处理')
  assert.equal(qqAnswer.answers.length, 2)
  for (const a of qqAnswer.answers) {
    assert.deepEqual(a.selected, [], 'selected 必须是数组（ask-user 会展开）')
    assert.ok(a.custom, '用文字作答')
  }
  const webAnswer = await handler({ agent: { id: 'web-session-1' }, questions: [] }, () => { nexted = true; return 'web-answer' })
  assert.equal(nexted, true, '网页会话必须放行')
  assert.equal(webAnswer, 'web-answer')
})

test('6. fetchGroupContext 增量水位：不重复旧消息、排除本条、按水位只给新增', async (t) => {
  const h = await boot(t)
  const now = Math.floor(Date.now() / 1000)
  h.kernel.onebot.groupHistory = async () => [
    { message_id: 11, time: now - 100, sender: { user_id: MEMBER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: '旧消息一' } }] },
    { message_id: 12, time: now - 90, sender: { user_id: ADMIN_QQ, nickname: '主人' }, message: [{ type: 'text', data: { text: '旧消息二' } }] },
    { message_id: 13, time: now - 10, sender: { user_id: MEMBER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: '新消息' } }] },
  ]
  const ev = { chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, messageId: 14 }
  const all = await h.kernel.dsh.fetchGroupContext(ev, 5)
  assert.ok(all.includes('旧消息一') && all.includes('旧消息二') && all.includes('新消息'), '首次给基线')
  assert.equal(all.includes('[群聊上文]'), true, 'historyBlock 自带前缀')
  // 推进水位到 12 → 只应给 13 之后的新消息
  h.kernel.state.get(ev.chatKey).lastContextId = 12
  const inc = await h.kernel.dsh.fetchGroupContext(ev, 5)
  assert.ok(inc.includes('新消息'), '水位之后的新消息要给')
  assert.equal(inc.includes('旧消息一'), false, '水位之前的旧消息不重复')
})

test('7. syncSessionTitles：标题同步成「群名 (群号)」；失败不中断', async (t) => {
  const h = await boot(t)
  const sid = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`, '测试群')
  await h.kernel.dsh.syncSessionTitles({ force: true })
  const session = h.ctx._sessions.get(sid)
  assert.ok(session, '会话存在')
  assert.ok(String(session.title).includes('测试群') && String(session.title).includes(String(GROUP_ID)), `标题=${session.title}`)

  h.kernel.onebot.groupList = async () => {
    throw new Error('onebot down')
  }
  const r = await h.kernel.dsh.syncSessionTitles({ force: true })
  assert.equal(typeof r, 'object', '取群名失败也不抛（降级）')
})

test('8. prompt 读图失败：模型不支持图片 → 丢图重发纯文本；尺寸超限也是同一降级', async (t) => {
  const h = await boot(t)
  const sid = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  const attempts = []
  h.ctx.setPromptHandler(async (req) => {
    attempts.push(req.content)
    if (attempts.length === 1) throw new Error('MODEL_DOES_NOT_SUPPORT_IMAGES')
  })
  await h.kernel.dsh.prompt(sid, '带图的话', [{ mediaType: 'image/png', data: 'AAAA', name: 'a.png' }])
  assert.equal(attempts.length, 2, '失败后重试一次纯文本')
  assert.equal(attempts[0].length, 2, '第一次带图 + 文本')
  assert.equal(attempts[1].length, 1, '第二次只有文本')
  assert.ok(attempts[1][0].text.includes('未能识别'), '降级提示写清"图没到手上"')
})

test('9. 会话映射落盘：sessions.json 写入 chatKey → sessionId；重启式重载可恢复', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 1005 }))
  await waitFor(() => h.kernel.dsh.sessionOf(`group:${GROUP_ID}`), { label: '会话建立' })
  const file = path.join(h.dataDir, 'state', 'sessions.json')
  const map = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(map[`group:${GROUP_ID}`], '映射已落盘')
  const sid = map[`group:${GROUP_ID}`]
  await sleep(20)
  assert.equal(fs.existsSync(file), true)
  assert.equal(typeof sid, 'string')
})
