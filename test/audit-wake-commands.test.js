/**
 * test/audit-wake-commands.test.js — 门禁 / 唤醒 / 基础命令 / 发图白名单 / 入站文件。
 *
 * 迁移自旧 `audit-wake-commands.test.js`（42 项）：保留行为级断言；删除：
 *   · 站点 config 继承（读生产机配置）与 legacy 回落用例；
 *   · 旧 admin-bridge 写值用例（改由 admin 存储测试覆盖）；
 *   · dsh-ops-gate 外部插件用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  bootKernel, emitRaw, tapInbound, waitFor,
  ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent,
} from './helpers.mjs'

const OTHER_QQ = 30001
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, { gate = {}, overrides = {}, config = {} } = {}) {
  const h = await bootKernel({
    config: {
      ...config,
      archive: config.archive || { enabled: false, dir: 'logs/qq_chat' },
      pacing: { merge: { enabled: false }, ...(config.pacing || {}) },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ, ...gate },
        ...(config.pluginConfig || {}),
      },
      ...overrides,
    },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  return { ...h, tap }
}

function memberGroupEvent(text, { id = 1, qq = OTHER_QQ } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '群友' },
    message: [{ type: 'text', data: { text } }],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 门禁
// ─────────────────────────────────────────────────────────────────────────────

test('GATE-1 四级门禁优先级：黑名单 > 群屏蔽(含 runtimeIgnore) > 群白名单 > 全局白名单；热改立即生效', async (t) => {
  const h = await boot(t, {
    gate: {
      groupUserBlocklist: `${GROUP_ID}:${OTHER_QQ}`,
      ignoreGroups: [GROUP_ID],
      groupUserAllowlist: `${GROUP_ID}:${ADMIN_QQ}`,
      allowedUsers: [ADMIN_QQ],
    },
  })
  const run = async () => {
    await emitRaw(h.kernel, memberGroupEvent('随便聊聊'))
    return h.tap.last()
  }
  const gw = h.kernel.plugins.find((p) => p.id === 'gate-wake').cfg

  let ev = await run()
  assert.equal(ev.stopReason, 'gate-wake:blocklist', '① 黑名单最高优先')
  assert.equal(ev.stopped, true)
  assert.equal(ev.wake, null)

  gw.groupUserBlocklist = ''
  ev = await run()
  assert.equal(ev.stopReason, 'gate-wake:ignore-group', '② 群屏蔽生效')

  gw.ignoreGroups = []
  ev = await run()
  assert.equal(ev.stopReason, 'gate-wake:group-allowlist', '③ 群白名单外被拦')

  gw.groupUserAllowlist = ''
  ev = await run()
  assert.equal(ev.stopReason, 'gate-wake:allowed-users', '④ 全局白名单兜底')

  gw.allowedUsers = []
  ev = await run()
  assert.equal(ev.stopReason, 'gate-wake:not-woken', '都放行 → 只是没被叫（不是被门禁拦）')
})

test('GATE-2 黑名单拦下后 passive-tap 不执行：不写留档、不触发 prompt', async (t) => {
  const archiveDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-arch-')), 'qq_chat')
  const h = await boot(t, {
    gate: { groupUserBlocklist: `${GROUP_ID}:${OTHER_QQ}` },
    config: { archive: { enabled: true, dir: archiveDir } },
  })
  await emitRaw(h.kernel, memberGroupEvent('你好', { id: 7 }))
  await sleep(40)
  assert.equal(fs.existsSync(path.join(archiveDir, `group_${GROUP_ID}.jsonl`)), false, '黑名单消息不写留档')
  assert.equal(h.ctx._prompts.length, 0)
})

test('GATE-3 主人豁免：群/全局白名单外放行；黑名单/屏蔽群照拦', async (t) => {
  const h = await boot(t, { gate: { allowedUsers: [MEMBER_QQ], groupUserAllowlist: `${GROUP_ID}:${MEMBER_QQ}` } })
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', userId: ADMIN_QQ, messageId: 1 }))
  assert.equal(h.tap.last().stopped, false, '主人在白名单外仍放行')
  assert.ok(h.tap.last().wake, '主人 @ 唤醒')

  const h2 = await boot(t, { gate: { groupUserBlocklist: `${GROUP_ID}:${ADMIN_QQ}` } })
  await emitRaw(h2.kernel, groupAtEvent({ text: '你好', userId: ADMIN_QQ, messageId: 2 }))
  assert.equal(h2.tap.last().stopReason, 'gate-wake:blocklist', '主人也在黑名单下被拦')
})

test('GATE-4 runtimeIgnore：运行时屏蔽群立即生效（与兼容网关/控制台共享）', async (t) => {
  const h = await boot(t)
  const runtime = h.kernel.state.runtimeIgnore
  assert.ok(runtime, 'gate-wake 应在共享 state 上挂 runtimeIgnore')
  runtime.add(GROUP_ID)
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 3 }))
  assert.equal(h.tap.last().stopReason, 'gate-wake:ignore-group')
  runtime.remove(GROUP_ID)
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 4 }))
  assert.notEqual(h.tap.last().stopReason, 'gate-wake:ignore-group', '解除后恢复')
})

// ─────────────────────────────────────────────────────────────────────────────
// 唤醒
// ─────────────────────────────────────────────────────────────────────────────

test('WAKE-A @本机+正文 → wake=at，进模型且 prompt 带正文', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '今天天气怎么样', messageId: 10 }))
  assert.equal(h.tap.last().wake.kind, 'at')
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: '进模型' })
  assert.ok(prompt.content[0].text.includes('今天天气怎么样'))
})

test('WAKE-A2/B 纯 @ 无正文 → 罐头话 + 接续窗口；同一人补正文 → [接上条] 进模型', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: 11,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'at', data: { qq: '999999' } }],
  })
  assert.equal(h.ctx._prompts.length, 0, '纯 @ 不进模型（零 token）')
  assert.equal(h.sent.length, 1, '立即回一句罐头话')
  assert.ok(h.sent[0].wire.includes('[CQ:reply,id=11]'), '罐头话引用呼叫消息')

  await emitRaw(h.kernel, memberGroupEvent('今天天气怎么样', { id: 12, qq: MEMBER_QQ }))
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: '接续窗口内补正文进模型' })
  assert.ok(prompt.content[0].text.includes('[接上条]'), '接续窗口唤醒带 [接上条]')
  assert.equal(h.tap.last().wake.kind, 'followup')
})

test('WAKE-C 唤醒词+内容一条发完 → keyword 唤醒，不开窗口', async (t) => {
  const h = await boot(t, { gate: { keywords: '*: 小助手' } })
  await emitRaw(h.kernel, memberGroupEvent('小助手 帮我看看这个', { id: 13 }))
  assert.equal(h.tap.last().wake.kind, 'keyword')
  assert.ok(String(h.tap.last().wake.keyword).includes('小助手'))
  await waitFor(() => h.ctx._prompts[0], { label: 'keyword 唤醒进模型' })
})

test('WAKE-U 人设唤醒词与配置全局词合并生效（默认人设「大肥鱼」+ 配置「小助手」都能唤醒）', async (t) => {
  // keywordCooldownMs=0：两次命中别被关键词冷却挡掉（本用例只验词表合并）
  const h = await boot(t, { gate: { keywords: '*: 小助手', keywordCooldownMs: 0 } })
  // ① 默认人设自带的唤醒词（personas/蓝色大肥鱼.wake.txt → 大肥鱼）仍生效
  await emitRaw(h.kernel, memberGroupEvent('大肥鱼 在吗', { id: 15 }))
  assert.equal(h.tap.last().wake.kind, 'keyword')
  assert.ok(String(h.tap.last().wake.keyword).includes('大肥鱼'))
  // ② 控制台配置的全局词也同时生效（不再被"人设覆盖"吞掉）
  await emitRaw(h.kernel, memberGroupEvent('小助手 看下这个', { id: 16 }))
  assert.equal(h.tap.last().wake.kind, 'keyword')
  assert.ok(String(h.tap.last().wake.keyword).includes('小助手'))
  // ③ 人设文件的词表能被唤醒来源正确报告（合并态）
  const src = h.kernel.shared?.readWakeWords?.source?.()
  assert.ok(src, '应有唤醒词来源快照')
  assert.equal(src.from, 'persona+config', '人设词 + config 词应合并')
  assert.ok(src.effectiveGlobal.includes('大肥鱼') && src.effectiveGlobal.includes('小助手'))
})

test('WAKE-U2 状态快照：唤醒词分列 config / 人设（控制台「填空+添加」据此渲染，可删与只读分开）', async (t) => {
  const h = await boot(t, { gate: { keywords: '*: 小助手' } })
  const src = h.kernel.shared?.readWakeWords?.source?.()
  assert.ok(src, 'status.wake 的来源快照应可用（控制台编辑用）')
  assert.deepEqual(src.cfgGlobal, ['小助手'], 'config 词表可编辑')
  assert.ok(src.persona.includes('大肥鱼'), '人设文件词表只读展示')
  assert.ok(src.effectiveGlobal.includes('小助手') && src.effectiveGlobal.includes('大肥鱼'), '合并后都生效')
})

test('WAKE-S @别人但正文含唤醒词 → 按内容唤醒（不因 @ 别人漏唤醒）', async (t) => {
  const h = await boot(t, { gate: { keywords: '*: 小助手' } })
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: 14,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [
      { type: 'at', data: { qq: String(OTHER_QQ) } },
      { type: 'text', data: { text: '小助手 你觉得呢' } },
    ],
  })
  assert.equal(h.tap.last().wake.kind, 'keyword')
})

test('WAKE-D/E 引用本机消息 → quote 唤醒；引用别人 → 不越界', async (t) => {
  const h = await boot(t)
  h.kernel.onebot.msgById = async (id) => ({ message_id: Number(id), sender: { user_id: 999999, nickname: '测试机器人' }, message: '我上一条' })
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: 15,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'reply', data: { id: '900' } }, { type: 'text', data: { text: '接着说' } }],
  })
  assert.equal(h.tap.last().wake.kind, 'quote')

  const h2 = await boot(t)
  h2.kernel.onebot.msgById = async (id) => ({ message_id: Number(id), sender: { user_id: OTHER_QQ, nickname: '别人' }, message: '别人说的' })
  await emitRaw(h2.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: 16,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'reply', data: { id: '901' } }, { type: 'text', data: { text: '接着说' } }],
  })
  assert.equal(h2.ctx._prompts.length, 0, '引用别人不唤醒')
})

test('WAKE-POKE 被戳：回戳 + 回一句话；戳别人不理会', async (t) => {
  const h = await boot(t)
  const pokes = []
  h.kernel.onebot.poke = async (chatKey, qq) => {
    pokes.push({ chatKey, qq })
    return true
  }
  await emitRaw(h.kernel, {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    target_id: 999999,
  })
  await waitFor(() => pokes.length === 1, { label: '回戳' })
  // 回戳成功**也不能**吞掉那句话：原先 `poke() 成功 → return`，NAS 上回戳一直成功，
  // 人设 `## poke` 句池就永远发不出去（只剩一个看不出内容的小戳）。
  await waitFor(() => h.sent.length === 1, { label: '回戳之外还要回一句' })
  assert.ok(String(h.sent[0].wire).trim().length > 0, '被戳要真的说一句话')
  assert.equal(h.tap.last().stopReason, 'gate-wake:poke')
  const sentBefore = h.sent.length

  await emitRaw(h.kernel, {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    target_id: OTHER_QQ,
  })
  await sleep(30)
  assert.equal(pokes.length, 1, '戳别人不回戳')
  assert.equal(h.sent.length, sentBefore, '戳别人也不回话')
})

test('WAKE-RECALL 引用 + 「撤回」：单条撤回成功即回执，且同一条只试一次', async (t) => {
  const h = await boot(t)
  const recalled = []
  h.kernel.onebot.recall = async (id) => {
    recalled.push(Number(id))
    return { ok: true }
  }
  const recallEvent = (id) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: id,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'reply', data: { id: '777' } }, { type: 'text', data: { text: '撤回这条' } }],
  })
  await emitRaw(h.kernel, recallEvent(20))
  await waitFor(() => recalled.length === 1, { label: '撤回一次' })
  assert.deepEqual(recalled, [777])
  assert.equal(h.tap.last().stopReason, 'gate-wake:recall')
  await emitRaw(h.kernel, recallEvent(21))
  await sleep(40)
  assert.deepEqual(recalled, [777], '同一条只试一次（批量重试会刷爆群）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 命令
// ─────────────────────────────────────────────────────────────────────────────

test('CMD-1 /help：任意人可用，从命令表动态生成，零 token', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, memberGroupEvent('/help', { id: 30 }))
  await waitFor(() => h.sent.length === 1, { label: '/help 回复' })
  const text = h.sent[0].wire
  for (const cmd of ['/status', '/reset', '/cancel', '/history']) assert.ok(text.includes(cmd), `应列出 ${cmd}`)
  assert.equal(h.ctx._prompts.length, 0, '/help 不进模型')
})

test('CMD-2 非主人调用主人命令一律被拒', async (t) => {
  const h = await boot(t)
  for (const cmd of ['/status', '/reset', '/resetall confirm', '/cancel', '/quota']) {
    await emitRaw(h.kernel, memberGroupEvent(cmd, { id: 31 }))
  }
  await waitFor(() => h.sent.length >= 5, { label: '拒绝回执' })
  for (const s of h.sent) assert.ok(s.wire.includes('只有主人'), `应拒绝：${s.wire}`)
  assert.equal(h.ctx._prompts.length, 0)
})

test('CMD-3 /status 主人：显示本线会话', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 32 }))
  await waitFor(() => h.ctx._prompts[0], { label: '先建会话' })
  await emitRaw(h.kernel, groupAtEvent({ text: '/status', messageId: 33 }))
  await waitFor(() => h.sent.length >= 1, { label: '/status 回执' })
  assert.ok(h.sent.at(-1).wire.includes('状态'))
  assert.ok(h.sent.at(-1).wire.includes('群聊'), '显示聊天类型（chatKey 里的号码会被出口脱敏，别断言原串）')
})

test('CMD-4 /reset：归档旧会话 + 删映射；下一条消息开新会话', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 40 }))
  const first = await waitFor(() => h.kernel.dsh.sessions?.get?.(`group:${GROUP_ID}`), { label: '建会话' })
  await emitRaw(h.kernel, groupAtEvent({ text: '/reset', messageId: 41 }))
  await waitFor(() => h.ctx._workspaceRegistry.archived.length > 0, { label: '归档旧会话' })
  assert.deepEqual(h.ctx._workspaceRegistry.archived, [first])
  assert.equal(h.kernel.dsh.sessions?.get?.(`group:${GROUP_ID}`), undefined, '映射已删')
  await emitRaw(h.kernel, groupAtEvent({ text: '新话题', messageId: 42 }))
  const second = await waitFor(() => h.kernel.dsh.sessions?.get?.(`group:${GROUP_ID}`), { label: '新会话' })
  assert.notEqual(second, first, '重新开新会话')
})

test('CMD-5 /resetall：不带 confirm 只提示不动；confirm 后归档并清空', async (t) => {
  const h = await boot(t)
  await emitRaw(h.kernel, groupAtEvent({ text: '你好', messageId: 50 }))
  await waitFor(() => h.kernel.dsh.sessions?.get?.(`group:${GROUP_ID}`), { label: '建会话' })
  await emitRaw(h.kernel, groupAtEvent({ text: '/resetall', messageId: 51 }))
  await waitFor(() => h.sent.length >= 1, { label: '提示' })
  assert.ok(h.sent.at(-1).wire.includes('/resetall confirm'))
  assert.ok(h.kernel.dsh.sessions?.get?.(`group:${GROUP_ID}`), '不带 confirm 不删映射')
  await emitRaw(h.kernel, groupAtEvent({ text: '/resetall confirm', messageId: 52 }))
  await waitFor(() => h.ctx._workspaceRegistry.archived.length > 0, { label: 'confirm 后归档' })
  assert.equal(h.kernel.dsh.sessions?.get?.(`group:${GROUP_ID}`), undefined)
})

test('CMD-7 /history：群历史进 prompt 并放行进模型；命令后正题不被吃掉', async (t) => {
  const h = await boot(t)
  h.kernel.onebot.groupHistory = async () => [
    { message_id: 901, time: Math.floor(Date.now() / 1000) - 60, sender: { user_id: OTHER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: '之前聊到火锅' } }] },
  ]
  await emitRaw(h.kernel, groupAtEvent({ text: '/history 10 你觉得哪家好吃', messageId: 53 }))
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: '/history 进模型' })
  const text = prompt.content[0].text
  assert.ok(text.includes('之前聊到火锅'), '历史进 prompt')
  assert.ok(text.includes('哪家好吃'), '命令后的正题保留')
})

// ─────────────────────────────────────────────────────────────────────────────
// 发图白名单 / 入站文件
// ─────────────────────────────────────────────────────────────────────────────

test('FILE-1 send_image 白名单：外部绝对路径被拒；白名单内文件可发（走唯一媒体出站口）', async (t) => {
  const allowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-allow-'))
  const h = await boot(t, { config: { pluginConfig: { 'file-transfer': { imageWhitelist: [allowDir] } } } })
  const sendImage = h.ctx._registeredTools.get('mcp__qq__send_image')
  assert.ok(sendImage, '应注册 send_image')
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-outside-')), 'a.png')
  fs.writeFileSync(outside, 'x')
  await assert.rejects(() => sendImage.execute({ target: `group:${GROUP_ID}`, file: outside }), /白名单/i)
  const inside = path.join(allowDir, 'ok.png')
  fs.writeFileSync(inside, 'x')
  const before = h.sent.length
  const r = await sendImage.execute({ target: `group:${GROUP_ID}`, file: inside })
  assert.equal(r.ok, true)
  assert.equal(h.sent.length, before + 1, '白名单内图片经唯一出站口发出')
  assert.equal(h.sent.at(-1).kind, 'media')
})

test('FILE-2 QQ 只收不发文件：只注册 send_image，没有发文件工具', async (t) => {
  const h = await boot(t)
  const names = [...h.ctx._registeredTools.keys()]
  assert.ok(names.includes('mcp__qq__send_image'))
  assert.equal(names.some((n) => /send_file|upload_file/.test(n)), false)
})

test('FILE-3 入站文件落盘：文件名带时间戳前缀防覆盖', async (t) => {
  const h = await boot(t)
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  fs.writeFileSync(path.join(uploadDir, 'incoming.txt'), 'hello')
  h.kernel.onebot.getFile = async () => ({ file: path.join(uploadDir, 'incoming.txt') })
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'private',
    user_id: MEMBER_QQ,
    message_id: 60,
    sender: { user_id: MEMBER_QQ, nickname: '网友' },
    message: [{ type: 'file', data: { file_id: 'f1', name: 'a.txt', file_size: 5, url: '' } }],
  })
  await sleep(80)
  const saved = fs.readdirSync(uploadDir).filter((n) => n !== 'incoming.txt')
  assert.ok(saved.length >= 1, `入站文件应落盘：${fs.readdirSync(uploadDir).join(',')}`)
  assert.match(saved[0], /^\d{8,}/, '文件名带时间戳前缀防覆盖')
})

// ── 文件与图片页（file-transfer）新增控制项 ─────────────────────────
function privateFileEvent(files, { id = 61, qq = MEMBER_QQ } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '网友' },
    message: files.map((f) => ({
      type: 'file',
      data: { file_id: f.file_id || 'f', name: f.name, file_size: f.size || 0, url: f.url || '' },
    })),
  }
}

test('FILE-4 单个文件大小上限：超限不下载、不落盘，hint 如实说明', async (t) => {
  const h = await boot(t, { config: { pluginConfig: { 'file-transfer': { maxFileMB: 1 } } } })
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const big = path.join(h.dataDir, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(1200 * 1024))
  await emitRaw(h.kernel, privateFileEvent([{ name: 'big.bin', size: 1200 * 1024, url: big }]))
  await sleep(80)
  const hint = (h.tap.last()?.hint || []).join('\n')
  assert.match(hint, /超过上限/)
  assert.equal(fs.readdirSync(uploadDir).length, 0, '超限文件不应落盘')
})

test('FILE-5 总开关关闭：不收入站文件、send_image 拒绝发图', async (t) => {
  const h = await boot(t, { config: { pluginConfig: { 'file-transfer': { enabled: false } } } })
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const f = path.join(h.dataDir, 'x.txt')
  fs.writeFileSync(f, 'hello')
  h.kernel.onebot.getFile = async () => ({ file: f })
  await emitRaw(h.kernel, privateFileEvent([{ name: 'x.txt', size: 5 }], { id: 62 }))
  await sleep(80)
  assert.equal(fs.readdirSync(uploadDir).length, 0, '开关关闭时不应落盘')
  const tool = h.ctx._registeredTools.get('mcp__qq__send_image')
  assert.ok(tool && typeof tool.execute === 'function', 'send_image 应已注册')
  await assert.rejects(() => tool.execute({ target: 'private:10001', file: f }), /未启用/)
})

test('FILE-6 单条消息文件数上限：只处理前 N 个并提示', async (t) => {
  const h = await boot(t, { config: { pluginConfig: { 'file-transfer': { maxFilesPerMsg: 2 } } } })
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const src = path.join(h.dataDir, 'src.txt')
  fs.writeFileSync(src, 'x')
  h.kernel.onebot.getFile = async () => ({ file: src })
  await emitRaw(h.kernel, privateFileEvent([
    { name: 'a.txt', size: 1, url: src },
    { name: 'b.txt', size: 1, url: src },
    { name: 'c.txt', size: 1, url: src },
  ], { id: 63 }))
  await sleep(120)
  assert.equal(fs.readdirSync(uploadDir).length, 2, `应只落盘 2 个，实际 ${fs.readdirSync(uploadDir).length}`)
  const hint = (h.tap.last()?.hint || []).join('\n')
  assert.match(hint, /只处理前 2 个/)
})

test('FILE-7 启动清理过期入站文件（保留 keepDays 天，默认 7）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-ft-'))
  const uploadDir = path.join(dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const oldFile = path.join(uploadDir, 'old.txt')
  const newFile = path.join(uploadDir, 'new.txt')
  fs.writeFileSync(oldFile, 'old')
  fs.writeFileSync(newFile, 'new')
  const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000
  fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo)
  const h = await bootKernel({ dataDir })
  t.after(() => h.dispose())
  assert.equal(fs.existsSync(oldFile), false, '超过 7 天的入站文件应被清理')
  assert.equal(fs.existsSync(newFile), true, '未过期的文件应保留')
})

// ── 下载策略：默认「被叫才下」 ───────────────────────────────────
function groupFileEvent(files, { at = false, id = 64, qq = MEMBER_QQ } = {}) {
  const message = []
  if (at) message.push({ type: 'at', data: { qq: '999999' } })
  message.push({ type: 'text', data: { text: '看下这个文件' } })
  for (const f of files) {
    message.push({
      type: 'file',
      data: { file_id: f.file_id || 'f', name: f.name, file_size: f.size || 0, url: f.url || '' },
    })
  }
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '群友' },
    message,
  }
}

test('FILE-8 群聊没叫它 → 默认不下载（被叫才下）', async (t) => {
  const h = await boot(t)
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const src = path.join(h.dataDir, 'src.txt')
  fs.writeFileSync(src, 'x')
  h.kernel.onebot.getFile = async () => ({ file: src })
  await emitRaw(h.kernel, groupFileEvent([{ name: 'x.txt', size: 1, url: src }], { at: false }))
  await sleep(120)
  assert.equal(h.tap.last()?.wake, null, '没叫它 = 不唤醒')
  assert.equal(fs.readdirSync(uploadDir).length, 0, '没叫它的群消息不应下载文件')
})

test('FILE-9 群里 @ 它 + 文件 → 落盘并写进 hint', async (t) => {
  const h = await boot(t)
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const src = path.join(h.dataDir, 'src.txt')
  fs.writeFileSync(src, 'x')
  h.kernel.onebot.getFile = async () => ({ file: src })
  await emitRaw(h.kernel, groupFileEvent([{ name: 'y.txt', size: 1, url: src }], { at: true, id: 65 }))
  await sleep(150)
  assert.equal(fs.readdirSync(uploadDir).length, 1, '被 @ 时应下载文件')
  const hint = (h.tap.last()?.hint || []).join('\n')
  assert.match(hint, /\[文件: /, 'hint 应告诉模型文件落盘路径')
})

test('FILE-10 策略改成「过门禁都下」→ 没叫它也落盘（passive-tap）', async (t) => {
  const h = await boot(t, { config: { pluginConfig: { 'file-transfer': { downloadPolicy: 'all' } } } })
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const src = path.join(h.dataDir, 'src.txt')
  fs.writeFileSync(src, 'x')
  h.kernel.onebot.getFile = async () => ({ file: src })
  await emitRaw(h.kernel, groupFileEvent([{ name: 'z.txt', size: 1, url: src }], { at: false, id: 66 }))
  await sleep(150)
  assert.equal(fs.readdirSync(uploadDir).length, 1, '「都下」策略下没叫也会落盘')
})

test('WAKE-RECALL 撤回失败：不把 协议端原始报错回显到群里（2026-10-23 事故回归）', async (t) => {
  const h = await boot(t)
  h.kernel.onebot.recall = async () => ({
    ok: false,
    raw: 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/recallMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n{"result":7,"errMsg":"decode failed!"}',
    msg: '撤回失败: Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/recallMsg EventRet:\n{"result":7,"errMsg":"decode failed!"}',
  })
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: 31,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'reply', data: { id: '778' } }, { type: 'text', data: { text: '撤回这条' } }],
  })
  await waitFor(() => h.sent.length >= 1, { label: '撤回失败回执' })
  const wire = h.sent.at(-1).wire
  assert.ok(wire.includes('撤回没成功'), `应给人话回执：${wire}`)
  for (const bad of ['NTEvent', 'EventRet', 'decode failed', 'recallMsg', 'onMsgInfoListUpdate']) {
    assert.equal(wire.includes(bad), false, `不应回显内部报错：${bad}`)
  }
})

test('CMD-7b /history 上限 500：请求条数被夹到 500，默认仍是 50', async (t) => {
  const h = await boot(t)
  const asked = []
  h.kernel.onebot.groupHistory = async (gid, count) => {
    asked.push(count)
    return [{ message_id: 902, time: Math.floor(Date.now() / 1000) - 60, sender: { user_id: OTHER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: '历史一条' } }] }]
  }
  await emitRaw(h.kernel, groupAtEvent({ text: '/history 9999', messageId: 61 }))
  await waitFor(() => asked.length >= 1, { label: '/history 上限' })
  assert.equal(asked[0], 502, `超过上限应夹到 500（请求 500+2），实际 ${asked[0]}`)

  await emitRaw(h.kernel, groupAtEvent({ text: '/history', messageId: 62 }))
  await waitFor(() => asked.length >= 2, { label: '/history 默认' })
  assert.equal(asked[1], 52, `不带参数应默认 50（请求 50+2），实际 ${asked[1]}`)
})

test('send_message 的 sticker 参数：插件没装/没开 → 如实说被忽略；装了 → 走 shared 钩子发出', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  const turn = { chatKey: `group:${GROUP_ID}` }
  const r1 = await send.execute({ target: `group:${GROUP_ID}`, text: '正文一句', sticker: '无语' }, { agent: { session: { id: 'sid-x' } } })
  assert.equal(r1.ok, true)
  // 默认 boot 里 stickers 插件在但库是空的：sticker 会说没挑到（不是静默吞掉参数）
  assert.equal(r1.sticker?.ok, false, '挑不到表情包时应如实报')
  assert.ok(String(r1.sticker?.reason || '').length > 0, '要给一句原因')

  const sent = []
  h.kernel.shared.stickerSend = async ({ target, query }) => {
    sent.push({ target, query })
    return { ok: true, pick: { id: 1 } }
  }
  const r2 = await send.execute({ target: `group:${GROUP_ID}`, text: '再来一句', sticker: '#1' }, { agent: { session: { id: 'sid-x' } } })
  assert.deepEqual(r2.sticker, { ok: true, pick: { id: 1 } }, '装了就走 shared 钩子')
  assert.deepEqual(sent, [{ target: `group:${GROUP_ID}`, query: '#1' }])
  void turn
})

test('WAKE-NOTICE 无身份 notice（点赞 profile_like / bot_offline）：不建会话、不进模型、不留出站', async (t) => {
  const h = await boot(t)
  // 2026-10-25 13:57 事故原样：OneBot 的点赞通知只有 operator_id，没有 user_id/group_id
  await emitRaw(h.kernel, {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'profile_like',
    operator_id: MEMBER_QQ,
    operator_nick: '群友',
    times: 1,
    time: Math.floor(Date.now() / 1000),
  })
  await emitRaw(h.kernel, { post_type: 'notice', notice_type: 'bot_offline', user_id: 3505422215 })
  await sleep(150)
  assert.equal(h.ctx._prompts.length, 0, 'notice 不进模型')
  assert.equal(h.ctx._sessions.size, 0, '不建 DSH 会话（曾经的 private:undefined）')
  assert.equal(h.sent.length, 0, '不产生出站')
})

test('normalizeEvent：无 user_id/group_id 的 notice 直接丢；正常 poke/入群不受影响', async () => {
  const { normalizeEvent } = await import('../kernel/format.js')
  assert.equal(normalizeEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'profile_like', operator_id: 1 }, 3505422215), null)
  assert.equal(normalizeEvent({ post_type: 'notice', notice_type: 'bot_offline' }, 3505422215), null)
  const poke = normalizeEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: GROUP_ID, user_id: MEMBER_QQ, target_id: 3505422215 }, 3505422215)
  assert.ok(poke, '群戳一戳仍要进管线（intercept 回戳）')
  assert.equal(poke.chatKey, `group:${GROUP_ID}`)
  const inc = normalizeEvent({ post_type: 'notice', notice_type: 'group_increase', group_id: GROUP_ID, user_id: MEMBER_QQ }, 3505422215)
  assert.ok(inc, '入群通知仍要进管线（group-welcome 用）')
})
