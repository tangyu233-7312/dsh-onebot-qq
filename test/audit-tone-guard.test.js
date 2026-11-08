/**
 * test/audit-tone-guard.test.js — 语气守卫（tone-guard）的定向测试。
 *
 * 覆盖的是"行为"，不是实现细节：
 *   · 没填判定接口 → 整功能不启用（不调模型、不改语气）—— 降级是本插件的默认姿态
 *   · 辱骂三次升级：前两次 hint 一个字符都不加，第三次进攻击态；攻击态内说正常话照样怼
 *   · 垃圾消息：第一次不回；连续第二次 → 屏蔽；中间说了别的就重新数；屏蔽期 0 token
 *   · 主人豁免、主动接话轮不算、判定失败 fail-open、计数窗口过期清零
 *   · 判定走「你填的接口」时：地址/模型/Key 真的发出去，返回能解析（本地起个假中转站）
 *   · /tone status|test|clear 都回人话
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'

import {
  bootKernel, emitRaw, tapInbound, waitFor,
  ADMIN_QQ, MEMBER_QQ, GROUP_ID, groupAtEvent, privateEvent,
} from './helpers.mjs'
import { parseVerdict, fillTemplate } from '../plugins/tone-guard/index.js'

const mergeOff = { pacing: { merge: { enabled: false } } }
const INS = '{"intent":"insult","target":"bot","confidence":0.92,"reason":"脏话骂它"}'
const TEASE = '{"intent":"tease","target":"bot","confidence":0.9,"reason":"叫绰号"}'
const SPAM = '{"intent":"spam","target":"other","confidence":0.95,"reason":"拉群广告"}'
const FENCE = String.fromCharCode(96, 96, 96)

/** 假的一次性文本补全（真内核从宿主 ctx.llm 取；夹具里直接换掉内核能力对象）。 */
function fakeLlm(impl) {
  const calls = []
  return {
    calls,
    available: () => true,
    route: async () => ({ provider: 'p', model: 'm', source: 'test' }),
    complete: async (opts) => {
      calls.push(opts)
      if (typeof impl === 'function') return impl(opts, calls.length)
      return { ok: true, text: impl || TEASE, reason: '', provider: 'p', model: 'm', ms: 1 }
    },
  }
}

/** 起一个 OpenAI 兼容的假中转站（只回一句话）。 */
async function startRelay(reply) {
  const requests = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: b })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () => new Promise((r) => server.close(r)),
  }
}

/** 起内核（默认判定走宿主默认模型 + 假 llm；要测"你填的接口"时传 creds）。 */
async function boot(t, { llm = TEASE, toneGuard = {}, creds = null } = {}) {
  const h = await bootKernel({
    config: {
      ...mergeOff,
      ...(creds ? { credentials: { toneGuard: creds } } : {}),
      pluginConfig: { 'tone-guard': creds ? { ...toneGuard } : { judgeSource: 'host', ...toneGuard } },
    },
  })
  const fake = llm && llm.complete ? llm : fakeLlm(llm)
  h.kernel.textCompletion = fake
  t.after(() => h.dispose())
  return { h, llm: fake, guard: h.kernel.shared.toneGuard }
}

const hintText = (ev) => (ev && Array.isArray(ev.hint) ? ev.hint : []).join(' ')

/** 直接拿某个插件挂的管线钩子（要精确控制 wake.kind 时用它，真管线给不了 proactive）。 */
function hooksOf(kernel, pluginId) {
  const out = { 'pre-gate': [], 'passive-tap': [], wake: [], 'before-turn': [] }
  for (const stage of Object.keys(out)) {
    const list = kernel.pipeline.stages.get(stage) || []
    out[stage] = list.filter((s) => s.pluginId === pluginId).map((s) => s.fn)
  }
  return out
}

function fakeEv(over) {
  return {
    chatKey: 'group:' + GROUP_ID, isGroup: true, groupId: GROUP_ID, messageId: 1,
    sender: { qq: MEMBER_QQ, name: '群友', card: '', isMaster: false },
    text: '你个傻逼', mentionedSelf: true, replyToId: null,
    hint: [], wake: { kind: 'at' }, stopped: false, stopReason: '', turnCtx: null,
    _scratch: Object.create(null), historyBlock: '', imagePaths: [],
    ...over,
  }
}

/** 按真管线顺序跑一遍某个插件的钩子。 */
async function drive(hooks, ev) {
  for (const fn of hooks['pre-gate']) await fn(ev)
  if (ev.stopped) return ev
  for (const fn of hooks['passive-tap']) await fn(ev)
  for (const fn of hooks.wake) await fn(ev)
  for (const fn of hooks['before-turn']) await fn(ev)
  return ev
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

// ── 解析（模型输出脏也要能判） ──────────────────────────────────
test('TONE-GUARD 解析：代码围栏 / 思考碎片取最后一个 / 中文 intent / 解析不出 → null', () => {
  const fenced = parseVerdict(FENCE + 'json\n{"intent":"insult","target":"bot","confidence":0.9}\n' + FENCE)
  assert.equal(fenced.intent, 'insult')
  assert.equal(fenced.target, 'bot')
  // 推理模型的思考里常先吐一个示例 JSON：必须取**最后**那个
  const thinking = '先看格式：{"intent":"tease"} 不对。结论：{"intent":"insult","target":"bot","confidence":0.81,"reason":"脏话"}'
  const v = parseVerdict(thinking)
  assert.equal(v.intent, 'insult')
  assert.equal(v.confidence, 0.81)
  assert.equal(parseVerdict('{"intent":"辱骂","target":"机器人","confidence":0.75}').intent, 'insult')
  assert.equal(parseVerdict('{"intent":"垃圾","target":"other"}').intent, 'spam')
  assert.equal(parseVerdict('{"intent":"随便写写"}'), null, '不认识的 intent 不算结论')
  assert.equal(parseVerdict(''), null)
  assert.equal(parseVerdict('这事不好说'), null)
  // 只回一句话 → 低把握（默认阈值 0.7 下不计账）
  const loose = parseVerdict('这是辱骂')
  assert.equal(loose.intent, 'insult')
  assert.ok(loose.confidence < 0.7)
})

test('TONE-GUARD 文案占位符：{name}/{qq} 被替换，未知占位符原样留着', () => {
  const out = fillTemplate('怼 {name}(QQ:{qq}) 第 {count} 次 {nope}', { name: '三胖', qq: 10002, count: 3 })
  assert.equal(out, '怼 三胖(QQ:10002) 第 3 次 {nope}')
})

// ── 降级：没填接口 = 不启用 ────────────────────────────────────
test('TONE-GUARD 没填判定接口 → 完全不判（不调模型、不动语气）', async (t) => {
  const h = await bootKernel({ config: { ...mergeOff } })
  t.after(() => h.dispose())
  const llm = fakeLlm(INS)
  h.kernel.textCompletion = llm
  const guard = h.kernel.shared.toneGuard
  assert.equal(guard.judgeInfo().ready, false, '没填地址/模型 → 未就绪')
  assert.deepEqual(guard.judgeInfo().missing, ['API 地址', '模型'])

  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '你个傻逼', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '照常进模型' })
  assert.equal(llm.calls.length, 0, '未配置时一次都不该调用模型')
  assert.equal(hintText(tap.last()).includes('语气覆盖'), false, '不该往 prompt 里加任何东西')
  assert.equal(tap.last().stopped, false, '照常回话')
  assert.equal(guard.rows('').length, 0, '不记账')
})

// ── 辱骂：三次升级 ───────────────────────────────────────────
test('TONE-GUARD 辱骂：第 1、2 次只记账（hint 为空），第 3 次进攻击态并点名怼', async (t) => {
  const { h, guard } = await boot(t, { llm: INS })
  const tap = tapInbound(h.kernel)
  const send = (id, text) => emitRaw(h.kernel, groupAtEvent({ text, messageId: id, userId: MEMBER_QQ }))

  await send(1, '你个傻逼')
  await waitFor(() => h.ctx._prompts.length === 1, { label: '第 1 次进模型' })
  assert.equal(hintText(tap.last()).includes('语气覆盖'), false, '第 1 次：hint 里一个字都不加')
  assert.match(guard.rows('')[0].label, /辱骂 1\/3/)

  await send(2, '傻逼玩意')
  await waitFor(() => h.ctx._prompts.length === 2, { label: '第 2 次进模型' })
  assert.equal(hintText(tap.last()).includes('语气覆盖'), false, '第 2 次：仍然不加')
  assert.match(guard.rows('')[0].label, /辱骂 2\/3/)

  await send(3, '有病吧你')
  await waitFor(() => h.ctx._prompts.length === 3, { label: '第 3 次进模型' })
  const hint = hintText(tap.last())
  assert.ok(hint.includes('语气覆盖'), '第 3 次必须压入攻击指令')
  assert.ok(hint.includes('QQ:' + MEMBER_QQ), '指令里要点名对象，别骂错人')
  assert.ok(hint.includes('其他人'), '指令里要写明其他人照常')
  assert.match(guard.rows('')[0].label, /攻击态到/)

  // 攻击态里他说了句正常话 → 仍然在怼（这是状态，不是"这一条"）
  await send(4, '今天天气不错')
  await waitFor(() => h.ctx._prompts.length === 4, { label: '第 4 次进模型' })
  assert.ok(hintText(tap.last()).includes('语气覆盖'), '攻击态内正常消息也照样怼')
})

test('TONE-GUARD 攻击态只针对那个人：同一群别人说话不挂指令', async (t) => {
  const { h } = await boot(t, { llm: INS })
  const tap = tapInbound(h.kernel)
  for (let i = 1; i <= 3; i += 1) {
    await emitRaw(h.kernel, groupAtEvent({ text: '傻逼', messageId: i, userId: MEMBER_QQ }))
    await waitFor(() => h.ctx._prompts.length === i, { label: '第 ' + i + ' 次' })
  }
  await emitRaw(h.kernel, groupAtEvent({ text: '你们聊什么呢', messageId: 9, userId: 10003 }))
  await waitFor(() => h.ctx._prompts.length === 4, { label: '别人说话也进模型' })
  assert.equal(hintText(tap.last()).includes('语气覆盖'), false, '别人不该被怼')
})

test('TONE-GUARD 中间插一条广告不清零辱骂次数（不然"骂两句发条广告"就洗掉了）', async (t) => {
  // 1=辱骂 2=辱骂 3=垃圾(被拦不回) 4=辱骂 → 第 4 条应正好是第 3 次辱骂
  const seq = [INS, INS, SPAM, INS]
  const { h } = await boot(t, { llm: (opts, n) => ({ ok: true, text: seq[n - 1] || TEASE, reason: '' }) })
  const tap = tapInbound(h.kernel)
  const send = (id, text) => emitRaw(h.kernel, groupAtEvent({ text, messageId: id, userId: MEMBER_QQ }))

  await send(1, '你个傻逼')
  await waitFor(() => h.ctx._prompts.length === 1, { label: '第 1 次' })
  await send(2, '傻逼玩意')
  await waitFor(() => h.ctx._prompts.length === 2, { label: '第 2 次' })
  await send(3, '加群领资料')
  await waitFor(() => tap.last() && tap.last().stopReason === 'tone-guard:spam', { label: '广告被拦' })
  await send(4, '有病吧你')
  await waitFor(() => h.ctx._prompts.length === 3, { label: '第 3 次辱骂仍进模型' })
  assert.ok(hintText(tap.last()).includes('语气覆盖'), '广告不该把辱骂次数清零，第 3 次辱骂照样开怼')
})

// ── 垃圾消息：连续两次才屏蔽 ─────────────────────────────────
test('TONE-GUARD 垃圾消息：第一次不回，连续第二次才屏蔽，屏蔽期 0 token', async (t) => {
  const { h, guard, llm } = await boot(t, { llm: SPAM })
  const tap = tapInbound(h.kernel)

  await emitRaw(h.kernel, groupAtEvent({ text: '加微信群领资料', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => tap.last() && tap.last().stopReason === 'tone-guard:spam', { label: '第 1 条被拦' })
  assert.equal(tap.last().stopped, true, '垃圾消息第一次就不回')
  assert.equal(h.ctx._prompts.length, 0, '不回 = 不进模型')
  assert.match(guard.rows('')[0].label, /垃圾消息 1 条/)

  await emitRaw(h.kernel, groupAtEvent({ text: '加微信 xxx 免费送', messageId: 2, userId: MEMBER_QQ }))
  await waitFor(() => guard.rows('').some((r) => /屏蔽到/.test(r.label)), { label: '第二次 → 屏蔽' })
  const callsAfter = llm.calls.length

  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 3, userId: MEMBER_QQ }))
  await settle(60)
  assert.equal(tap.last().stopReason, 'tone-guard:mute', '屏蔽期连正常消息也拦')
  assert.equal(llm.calls.length, callsAfter, '屏蔽期一次判定都不该有')
  assert.equal(h.ctx._prompts.length, 0)
})

test('TONE-GUARD 垃圾消息被打断 → 重新数（不算连续）', async (t) => {
  // 第 1 次判 spam，第 2 次判"正常"，之后又 spam
  const { h, guard } = await boot(t, { llm: (opts, n) => ({ ok: true, text: n === 2 ? TEASE : SPAM, reason: '' }) })
  const send = (id, text) => emitRaw(h.kernel, groupAtEvent({ text, messageId: id, userId: MEMBER_QQ }))

  await send(1, '加群领资料')
  await waitFor(() => guard.rows('').length === 1, { label: '第一次记账' })
  await send(2, '哈哈哈哈')
  await waitFor(() => h.ctx._prompts.length >= 1, { label: '正常话进模型' })
  await send(3, '加群领资料')
  await settle()
  const row = guard.rows('')[0]
  assert.match(row.label, /垃圾消息 1 条/, '被打断后重新数')
  assert.equal(/屏蔽到/.test(row.label), false, '不该屏蔽')
})

// ── 判定失败 fail-open / 主动接话不算 / 主人豁免 / 窗口过期 ──────
test('TONE-GUARD 判定失败 → fail-open：不记账、照常回话', async (t) => {
  const { h, guard } = await boot(t, { llm: () => ({ ok: false, text: '', reason: '超时 6 秒' }) })
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '你个傻逼', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '失败也照常进模型' })
  assert.equal(tap.last().stopped, false)
  assert.equal(guard.rows('').length, 0, '判不出来就不记账')
  assert.equal(guard.judgeInfo().calls.fail >= 1, true, '控制台能看到失败次数')
})

test('TONE-GUARD 主动接话 / 续聊检查 / 入群欢迎轮一律不判', async (t) => {
  const { h, llm } = await boot(t, { llm: INS })
  const hooks = hooksOf(h.kernel, 'tone-guard')
  for (const kind of ['proactive', 'continuation', 'welcome']) {
    await drive(hooks, fakeEv({ wake: { kind }, messageId: 100 }))
  }
  assert.equal(llm.calls.length, 0, '这三种唤醒是它自己起念，不是别人骂它')
  await drive(hooks, fakeEv({ wake: { kind: 'at' }, messageId: 101 }))
  assert.equal(llm.calls.length, 1, '被 @ 才判')
})

test('TONE-GUARD 主人豁免：骂它也不判定、不记账', async (t) => {
  const { h, guard, llm } = await boot(t, { llm: INS })
  await emitRaw(h.kernel, groupAtEvent({ text: '你个傻逼', messageId: 1, userId: ADMIN_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '主人消息进模型' })
  assert.equal(llm.calls.length, 0)
  assert.equal(guard.rows('').length, 0)
})

test('TONE-GUARD 豁免群：完全不判', async (t) => {
  const { h, llm } = await boot(t, { llm: INS, toneGuard: { exemptGroups: [String(GROUP_ID)] } })
  await emitRaw(h.kernel, groupAtEvent({ text: '你个傻逼', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '照常进模型' })
  assert.equal(llm.calls.length, 0, '豁免群不判定')
})

test('TONE-GUARD 计数窗口过期：上次记的 2 次不算数，从头开始数', async (t) => {
  const { h, guard } = await boot(t, { llm: INS })
  // 插件是懒加载状态文件：第一条消息之前把它写进去就生效（顺带验证落盘格式与读取）
  const file = guard.judgeInfo().statePath
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    records: {
      ['group:' + GROUP_ID + '|' + MEMBER_QQ]: {
        chat: 'group:' + GROUP_ID, qq: MEMBER_QQ, name: '群友',
        seen: 0, count: 2, firstAt: Date.now() - 61 * 60000, lastAt: Date.now() - 61 * 60000,
        attackUntil: 0, spamStreak: 0, lastSpamSeq: null, lastSpamAt: 0, muteUntil: 0, lastSeenAt: Date.now(),
      },
    },
  }, null, 2))
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '你个傻逼', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '进模型' })
  assert.equal(hintText(tap.last()).includes('语气覆盖'), false, '窗口过期 → 不算第 3 次')
  assert.match(guard.rows('')[0].label, /辱骂 1\/3/)
})

// ── 走「你填的接口」：真发 HTTP ──────────────────────────────
test('TONE-GUARD 填了自己的接口 → 带 Bearer 发到 /chat/completions，返回能解析', async (t) => {
  const relay = await startRelay('{"intent":"insult","target":"bot","confidence":0.88,"reason":"脏话"}')
  t.after(() => relay.close())
  const { h, guard } = await boot(t, {
    creds: { baseUrl: relay.url + '/v1', model: 'judge-mini', apiKey: 'sk-test-1234' },
  })
  assert.equal(guard.judgeInfo().ready, true)

  const ev = await drive(hooksOf(h.kernel, 'tone-guard'), fakeEv({ text: '你个傻逼', messageId: 1 }))
  assert.equal(relay.requests.length, 1, '应真的打一次中转站')
  const req = relay.requests[0]
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.headers.authorization, 'Bearer sk-test-1234')
  const body = JSON.parse(req.body)
  assert.equal(body.model, 'judge-mini')
  assert.equal(body.stream, false)
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 512)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.ok(String(body.messages[1].content).includes('你个傻逼'), '待判正文要进 prompt')
  assert.match(guard.rows('')[0].label, /辱骂 1\/3/)
  assert.equal(hintText(ev).includes('语气覆盖'), false, '第 1 次不加指令')
})

test('TONE-GUARD 自己的接口报错 → fail-open（不记账、照常回话）', async (t) => {
  const server = http.createServer((req, res) => { res.statusCode = 500; res.end('boom') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const { h, guard } = await boot(t, {
    creds: { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: '' },
  })
  const ev = await drive(hooksOf(h.kernel, 'tone-guard'), fakeEv({ text: '你个傻逼' }))
  assert.equal(ev.stopped, false)
  assert.equal(guard.rows('').length, 0)
  assert.equal(guard.judgeInfo().calls.fail >= 1, true)
})

// ── /tone 命令 ────────────────────────────────────────────────
test('TONE-GUARD /tone status：没配判定接口时直接说"未启用"', async (t) => {
  const h = await bootKernel({ config: { ...mergeOff, pluginConfig: { 'tone-guard': { judgeSource: 'custom' } } } })
  t.after(() => h.dispose())
  h.kernel.textCompletion = fakeLlm(INS)
  await emitRaw(h.kernel, privateEvent({ text: '/tone status', messageId: 1, userId: ADMIN_QQ }))
  await settle(50)
  const wire = String(((h.sent[h.sent.length - 1] || {}).wire) || '')
  assert.match(wire, /未配置/, '没配要如实说缺什么')
  assert.match(wire, /未启用/, '要说清整功能没启用、机器人行为和以前一样')
})

test('TONE-GUARD /tone test 试判 + /tone clear 清零', async (t) => {
  const { h, guard } = await boot(t, { llm: INS })
  const say = async (text, id) => {
    await emitRaw(h.kernel, privateEvent({ text, messageId: id, userId: ADMIN_QQ }))
    await settle(50)
    return String(((h.sent[h.sent.length - 1] || {}).wire) || '')
  }

  const s2 = await say('/tone test 你个傻逼，有病吧', 2)
  assert.match(s2, /判定：insult/, '试判要走一次判定并回结论')
  assert.match(s2, /会记一次账|第 3 次/, '顺带说明再攒到第 3 次才开怼')

  await emitRaw(h.kernel, groupAtEvent({ text: '你个傻逼', messageId: 3, userId: MEMBER_QQ }))
  await waitFor(() => guard.rows('').length >= 1, { label: '记上账' })
  // clear 的作用域 = 发命令的这条会话（私聊清私聊、群里清本群）；这里在群里清
  await emitRaw(h.kernel, groupAtEvent({ text: '/tone clear', messageId: 4, userId: ADMIN_QQ }))
  await settle(60)
  const s3 = String(((h.sent[h.sent.length - 1] || {}).wire) || '')
  assert.match(s3, /已清掉/, 'clear 要回执')
  assert.equal(guard.rows('').length, 0, '清完就不该还有记录')
})

test('TONE-GUARD /tone test 用控制台配的阈值说话（不许写死 0.7）', async (t) => {
  // 判定给 0.8，把门槛调到 0.85 → 应回「把握不够」而不是「会记一次账」
  const { h } = await boot(t, { llm: '{"intent":"insult","target":"bot","confidence":0.8}', toneGuard: { minConfidence: 0.85 } })
  await emitRaw(h.kernel, privateEvent({ text: '/tone test 你个傻逼', messageId: 1, userId: ADMIN_QQ }))
  await settle(60)
  const wire = String(((h.sent[h.sent.length - 1] || {}).wire) || '')
  assert.match(wire, /把握不够/, '低于阈值要说清楚')
  assert.match(wire, /0\.85/, '把当前阈值报出来')
})

test('TONE-GUARD 非主人用 /tone → 拒绝', async (t) => {
  const { h } = await boot(t, { llm: INS })
  await emitRaw(h.kernel, privateEvent({ text: '/tone clear all', messageId: 1, userId: MEMBER_QQ }))
  await settle(50)
  const wire = String(((h.sent[h.sent.length - 1] || {}).wire) || '')
  assert.match(wire, /只有主人/)
})
