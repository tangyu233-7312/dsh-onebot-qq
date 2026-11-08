/**
 * test/audit-kernel-outbound.test.js — 内核出站 / 文本格式 / 五阶段管线 / 会话状态 / 兼容网关。
 *
 * 迁移自旧 `audit-kernel-outbound.test.js`：保留行为级断言；删除旧实现源码内容 / 站点 selfcheck
 * 对照 / 已标 todo 的已知缺口用例。全部纯本地：动态端口、临时目录、无真实 QQ / 网络。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import {
  sanitizeSensitive,
  extractAtMarkers,
  clipChars,
  splitLongText,
  normalizeEvent,
  buildPromptText,
  toWellFormedText,
  escapeCq,
  parseWire,
} from '../kernel/format.js'
import { ChatState, Pipeline, createDeliver, currentTurn } from '../kernel/state-pipeline.js'
import { createEvent, SENSITIVE_KINDS } from '../contracts.js'
import { startCompatServer } from '../kernel/compat-server.js'
import { cqImage } from '../platform/cq-file.js'
import { tmpDir, ADMIN_QQ, GROUP_ID, MEMBER_QQ, bootKernel } from './helpers.mjs'

const quietLog = () => ({ info() {}, warn() {}, error() {}, debug() {} })

// ─────────────────────────────────────────────────────────────────────────────
// 一、六项出口脱敏
// ─────────────────────────────────────────────────────────────────────────────

test('脱敏：9~11 位裸 QQ 命中，≤8 位普通数字不误伤', () => {
  const r = sanitizeSensitive('他的QQ是123456789，房间号12345，等级99')
  assert.ok(r.text.includes('[已隐去]'))
  assert.ok(!r.text.includes('123456789'))
  assert.ok(r.text.includes('12345'), '5 位普通数字不误伤')
  assert.ok(r.text.includes('99'))
  assert.ok(r.hits.includes('qq'))
})

test('脱敏：带 QQ/群 标签的短号码也命中', () => {
  const r = sanitizeSensitive('群号 123456，QQ: 654321')
  assert.ok(!r.text.includes('123456'))
  assert.ok(!r.text.includes('654321'))
  assert.ok(r.hits.includes('qq'))
})

test('脱敏：IPv4 与 IP:端口 命中（端口尾巴一起清）', () => {
  const r = sanitizeSensitive('服务器 198.51.100.42:8444 挂了')
  assert.ok(!r.text.includes('198.51.100.42'))
  assert.ok(!r.text.includes('8444'))
  assert.ok(r.hits.includes('ip'))
})

test('脱敏：端口四种形态命中，但 10:30 这类时间不误伤', () => {
  const r = sanitizeSensitive('端口 3080；port 9000；127.0.0.1:3971；8080 端口；时间 10:30')
  assert.ok(!r.text.includes('3080'), `端口形态1: ${r.text}`)
  assert.ok(!r.text.includes('9000'), '端口形态2')
  assert.ok(!r.text.includes('3971'), 'host:port')
  assert.ok(!r.text.includes('8080'), '端口形态4')
  assert.ok(r.text.includes('10:30'), '时间不误伤')
})

test('脱敏：root 凭据 / 密码 / API key / Bearer 分别命中', () => {
  const root = sanitizeSensitive('root 密码是 hunter2')
  assert.ok(!root.text.includes('hunter2'))
  assert.ok(root.hits.includes('rootCred'))
  const pwd = sanitizeSensitive('密码：abc12345')
  assert.ok(!pwd.text.includes('abc12345'))
  assert.ok(pwd.hits.includes('password'))
  const key = sanitizeSensitive('api_key=sk-proj-abcdefgh1234')
  assert.ok(!key.text.includes('sk-proj-abcdefgh1234'))
  assert.ok(key.hits.includes('apiKey'))
  const bearer = sanitizeSensitive('Authorization: Bearer abcdef')
  assert.ok(!bearer.text.includes('Bearer abcdef'))
  assert.ok(bearer.hits.includes('apiKey'))
})

test('脱敏（2026-11-08 收窄）：只是提到「密码」不算，明确给了值才拦', () => {
  const hit = (s) => sanitizeSensitive(s).hits.includes('password')
  // 提到词、没给值 → 原样保留（这几条以前会被整段吃掉，群里看着就是莫名其妙的 [已隐去]）
  for (const s of ['忘记密码怎么办', '你是不是忘了密码是多少', '密码', '密码 怎么办']) {
    assert.equal(hit(s), false, s + ' 不该命中')
    assert.equal(sanitizeSensitive(s).text, s, s + ' 应原样保留')
  }
  // 明确给了值 → 照旧拦（四种问法都算）
  for (const s of ['我主人的密码是123456', '密码：hunter2', 'password is hunter2', 'Password: abc123', '密码 abc123']) {
    assert.equal(hit(s), true, s + ' 应该命中')
    assert.ok(sanitizeSensitive(s).text.includes('[已隐去]'), s + ' 应被隐去')
  }
})

test('脱敏：hits 名与契约 SENSITIVE_KINDS 对齐；exempt 只跳过过滤不删字段', () => {
  const r = sanitizeSensitive('QQ是123456789，IP 198.51.100.42', { exempt: false })
  assert.ok(r.hits.every((h) => SENSITIVE_KINDS.includes(h)), `hits=${r.hits}`)
  const ex = sanitizeSensitive('QQ是123456789，IP 198.51.100.42', { exempt: true })
  assert.equal(ex.text, 'QQ是123456789，IP 198.51.100.42')
  assert.deepEqual(ex.hits, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、[AT:] / CQ / 码点安全
// ─────────────────────────────────────────────────────────────────────────────

test('[AT:] 提取：qq= 与名字两种标记都抽出，正文不留标记', () => {
  const r = extractAtMarkers('[AT:qq=123456] [AT:奶茶] 你好呀')
  assert.deepEqual(r.qq, [123456])
  assert.deepEqual(r.names, ['奶茶'])
  assert.equal(r.text.trim(), '你好呀')
})

test('[AT:] 先于脱敏：@ 标记里的号码不被脱敏吃掉，正文里的号码照杀', async () => {
  const sent = []
  const onebot = {
    selfId: 999999,
    resolveMemberByName: async () => null,
    sendMessage: async (target, wire) => {
      sent.push({ target, wire })
      return 1
    },
  }
  const deliver = createDeliver({ onebot, log: quietLog(), adminQq: ADMIN_QQ })
  const r = await deliver(`group:${GROUP_ID}`, '[AT:qq=888888] 群号 987654321')
  assert.deepEqual(r.ats, [888888])
  assert.ok(sent.at(-1).wire.includes('[CQ:at,qq=888888]'), 'CQ at 已拼进消息')
  assert.ok(!r.text.includes('987654321'), '正文号码被脱敏')
})

test('escapeCq 文本只转义 & [ ]；本地路径（参数）里的逗号才会转成 &#44;', () => {
  // 正文里的逗号是普通字符：转义成 &#44; 可能被协议端原样显示
  assert.equal(escapeCq('a&b[c],d'), 'a&amp;b&#91;c&#93;,d')
  const withComma = path.join(tmpDir('cq'), 'a,b.png')
  const cq = cqImage(withComma)
  assert.ok(cq.startsWith('[CQ:image,file='), cq)
  assert.ok(cq.includes('&#44;'), `路径里的逗号必须转义成 &#44;：${cq}`)
  assert.ok(cq.includes(',file='), 'CQ 参数分隔符本身保留')
  assert.equal(cq.split('&#44;').length - 1, 1, '只有路径里的那个逗号被转义')
  if (process.platform === 'win32') {
    assert.equal(cqImage('C:/data/a,b.png'), '[CQ:image,file=C:/data/a&#44;b.png]')
  }
})

test('clipChars / splitLongText：任意长度都不切开代理对，也不引入孤立代理', () => {
  const s = '🌕'.repeat(50) + '文字'
  for (const n of [0, 1, 2, 3, 17, 51]) {
    const clipped = clipChars(s, n)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped), `clipChars(${n}) 不能有孤立代理`)
    assert.ok(clipped.length <= s.length)
  }
  for (const max of [5, 10, 21, 50]) {
    const parts = splitLongText(s, { max })
    assert.equal(parts.join(''), s, 'splitLongText 拼回原文')
    for (const p of parts) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p), 'split 不切代理对')
  }
})

test('toWellFormedText：坏代理被修复，buildPromptText 出口再兜一道', () => {
  assert.equal(toWellFormedText('a\uD800b'), 'a\uFFFDb')
  const ev = createEvent({ chatKey: `private:${MEMBER_QQ}`, text: 'a\uD800b', sender: { qq: MEMBER_QQ, name: '网友' } })
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(buildPromptText(ev)))
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、入站归一 / prompt 拼装
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeEvent：自己发的消息过滤；@ 本机被剥并标记；quote/images/files/cards 归一', () => {
  assert.equal(normalizeEvent({ post_type: 'message', user_id: 999999 }, 999999), null, '自己发的丢弃')
  const ev = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: GROUP_ID,
      user_id: MEMBER_QQ,
      message_id: 42,
      time: 1700000000,
      sender: { nickname: '群友' },
      message: [
        { type: 'reply', data: { id: '41' } },
        { type: 'at', data: { qq: '999999' } },
        { type: 'text', data: { text: '看看图 ' } },
        { type: 'image', data: { url: 'https://example.invalid/a.png', summary: '[动画表情]', emoji_id: '1', sub_type: 1 } },
        { type: 'file', data: { file_id: 'f1', name: 'a.txt', file_size: 12, url: 'https://example.invalid/a.txt' } },
        { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://b23.tv/abc' } } }) } },
      ],
    },
    999999,
    ADMIN_QQ,
  )
  assert.equal(ev.chatKey, `group:${GROUP_ID}`)
  assert.equal(ev.mentionedSelf, true)
  assert.equal(ev.text.includes('@999999'), false, '@本机 不应留在正文')
  assert.equal(ev.replyToId, '41')
  assert.equal(ev.sender.isMaster, false)
  assert.equal(ev.images.length, 1)
  assert.equal(ev.images[0].isSticker, true)
  assert.ok(ev.text.includes('[表情'), '表情图在正文里有占位')
  assert.equal(ev.files[0].fileId, 'f1')
  assert.deepEqual(ev.cards, ['https://b23.tv/abc'])
  assert.equal(ev.time, 1700000000000)
})

test('normalizeEvent：notice（入群）也归一，带 _scratch.notice', () => {
  const ev = normalizeEvent(
    { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: GROUP_ID, user_id: MEMBER_QQ, target_id: MEMBER_QQ, time: 1700000000 },
    999999,
    ADMIN_QQ,
  )
  assert.ok(ev)
  assert.equal(ev.isGroup, true)
  assert.equal(ev._scratch.notice.type, 'group_increase')
  assert.equal(ev._scratch.notice.userId, MEMBER_QQ)
})

test('buildPromptText：首轮带 [QQ会话…]、后续轮只带消息 ID；群消息带说话人（含 QQ 号）', () => {
  const ev = createEvent({
    chatKey: `group:${GROUP_ID}`,
    isGroup: true,
    groupId: GROUP_ID,
    messageId: 77,
    sender: { qq: MEMBER_QQ, name: '群友', isMaster: false },
    text: '晚上吃什么',
  })
  ev.wake = { kind: 'at' }
  const first = buildPromptText(ev, { greeted: false })
  assert.ok(first.includes(`[QQ会话 group:${GROUP_ID}｜本条消息ID 77]`))
  assert.ok(first.includes(`[群友(QQ:${MEMBER_QQ})]: 晚上吃什么`), `群消息说话人必须带 QQ 号：${first}`)
  const later = buildPromptText(ev, { greeted: true })
  assert.ok(later.includes('[本条消息ID 77]'))
  assert.equal(later.includes('[QQ会话'), false, '已 greeted 的会话不再带会话标识')
  const proactive = createEvent({ chatKey: `group:${GROUP_ID}`, isGroup: true, messageId: 78, text: '随口接一句' })
  proactive.wake = { kind: 'proactive' }
  const proactiveText = buildPromptText(proactive)
  assert.equal(proactiveText.includes(']: 随口接一句'), false, '主动接话轮不挂说话人前缀')
  assert.equal(proactiveText.includes('(QQ:'), false, '主动接话轮不挂 QQ 前缀')
})

// ─────────────────────────────────────────────────────────────────────────────
// 四、五阶段管线
// ─────────────────────────────────────────────────────────────────────────────

function makeEv(init = {}) {
  return createEvent({ chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID, messageId: 1, text: '你好', sender: { qq: MEMBER_QQ, name: '群友' }, ...init })
}

test('管线：pre-gate 抛错 = fail-closed（后续阶段与 terminal 都不跑）', async () => {
  const pipeline = new Pipeline({ log: quietLog() })
  let tapped = false
  let terminaled = false
  pipeline.use('pre-gate', () => {
    throw new Error('boom')
  })
  pipeline.use('passive-tap', () => {
    tapped = true
  })
  const ev = makeEv()
  await pipeline.run(ev, async () => {
    terminaled = true
  })
  assert.equal(ev.stopped, true)
  assert.match(ev.stopReason, /pre-gate/)
  assert.equal(tapped, false)
  assert.equal(terminaled, false)
})

test('管线：passive-tap / intercept 抛错 = fail-open，后续照跑；terminal 有 ALS TurnContext', async () => {
  const pipeline = new Pipeline({ log: quietLog() })
  const errored = []
  pipeline.onPluginError((_e, info) => errored.push(info.stage))
  let woken = false
  pipeline.use('passive-tap', () => {
    throw new Error('tap')
  })
  pipeline.use('intercept', async () => {
    throw new Error('intercept')
  })
  pipeline.use('wake', (ev) => {
    woken = true
    ev.wake = { kind: 'at' }
  })
  pipeline.use('before-turn', (ev) => {
    ev.hint.push('[x]')
  })
  const ev = makeEv()
  let terminaled = false
  await pipeline.run(ev, async (e) => {
    terminaled = true
    assert.ok(e.turnCtx, 'terminal 前已挂 TurnContext')
    assert.equal(currentTurn(), e.turnCtx, 'terminal 在 ALS 里')
  })
  assert.equal(woken, true)
  assert.equal(terminaled, true)
  assert.ok(errored.includes('intercept'))
})

test('管线：插件 stop 后后续阶段跳过；order 小的先跑；use 返回取消函数；非法阶段名当场抛', async () => {
  const pipeline = new Pipeline({ log: quietLog() })
  const order = []
  pipeline.use('intercept', () => order.push('b'), { order: 20 })
  const cancel = pipeline.use('intercept', () => order.push('a'), { order: 10 })
  pipeline.use('intercept', (ev) => {
    order.push('stop')
    ev.stopped = true
  }, { order: 30 })
  pipeline.use('wake', () => order.push('wake'), { order: 10 })
  await pipeline.run(makeEv(), async () => {})
  assert.deepEqual(order, ['a', 'b', 'stop'])
  assert.throws(() => pipeline.use('not-a-stage', () => {}), /未知阶段/)
  assert.equal(typeof cancel, 'function')
})

test('管线：没 wake 不进 terminal', async () => {
  const pipeline = new Pipeline({ log: quietLog() })
  let terminaled = false
  await pipeline.run(makeEv(), async () => {
    terminaled = true
  })
  assert.equal(terminaled, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 五、ChatState
// ─────────────────────────────────────────────────────────────────────────────

test('ChatState.serialize：同 chatKey 严格串行，不同 chatKey 并行，reject 不阻塞后续', async () => {
  const state = new ChatState({ log: quietLog() })
  const seq = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await Promise.all([
    state.serialize(`group:${GROUP_ID}`, async () => { seq.push('a1'); await sleep(30); seq.push('a2') }),
    state.serialize(`group:${GROUP_ID}`, async () => { seq.push('b1'); await sleep(1); seq.push('b2') }),
  ])
  assert.deepEqual(seq, ['a1', 'a2', 'b1', 'b2'], '同线严格串行')
  const start = Date.now()
  await Promise.all([
    state.serialize(`group:${GROUP_ID}`, () => sleep(40)),
    state.serialize(`private:${ADMIN_QQ}`, () => sleep(40)),
  ])
  assert.ok(Date.now() - start < 75, '不同线并行')
  await assert.rejects(() => state.serialize(`group:${GROUP_ID}`, async () => { throw new Error('x') }))
  assert.equal(await state.serialize(`group:${GROUP_ID}`, async () => 'ok'), 'ok', '前一轮 reject 不阻塞下一轮')
})

test('ChatState：引用锚队列 / countArrival 跳过唤醒自己 / quoteNeed need=0', () => {
  const state = new ChatState({ log: quietLog(), turnAnchorTtlMs: 5000 })
  state.markTurnAnchor(`group:${GROUP_ID}`, 10)
  state.countArrival(`group:${GROUP_ID}`, 10) // 唤醒那条自己，不计
  state.countArrival(`group:${GROUP_ID}`, 11)
  const need = state.quoteNeed(`group:${GROUP_ID}`, 1)
  assert.deepEqual({ allow: need.allow, arrived: need.arrived, triggerId: need.triggerId }, { allow: true, arrived: 1, triggerId: 10 })
  assert.equal(state.quoteNeed(`group:${GROUP_ID}`, 0).allow, false, 'need=0 永不自动挂')
  assert.equal(state.quoteNeed(`group:${GROUP_ID}`, 2).allow, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 六、deliver（唯一出站口）
// ─────────────────────────────────────────────────────────────────────────────

function makeDeliver(opts = {}) {
  const sent = []
  const onebot = {
    selfId: 999999,
    resolveMemberByName: async (_gid, name) => (name === '奶茶' ? 123456789 : null),
    sendMessage: async (target, wire) => { sent.push({ kind: 'msg', target, wire }); return sent.length },
    sendForward: async (target, nodes) => { sent.push({ kind: 'forward', target, nodes }); return sent.length },
    sendMedia: async (target, wire) => { sent.push({ kind: 'media', target, wire }); return sent.length },
  }
  const recs = []
  const deliver = createDeliver({
    onebot,
    log: quietLog(),
    adminQq: ADMIN_QQ,
    longForward: { threshold: 100, chunkSize: 50, enabled: true },
    replyMaxLength: 3000,
    onAfterSend: (rec) => recs.push(rec),
    ...opts,
  })
  return { deliver, sent, recs, onebot }
}

test('deliver：target/空正文校验；@ 名字反查；显式 replyTo 与 0 语义', async () => {
  const { deliver, sent } = makeDeliver()
  await assert.rejects(() => deliver('bad-target', 'x'), /target 格式错误/)
  await assert.rejects(() => deliver(`group:${GROUP_ID}`, '   '), /text 不能为空/)
  const r = await deliver(`group:${GROUP_ID}`, '[AT:奶茶] 你好', { replyTo: 77 })
  assert.deepEqual(r.ats, [123456789])
  assert.equal(r.replyTo, 77)
  assert.equal(r.mode, 'reply')
  assert.ok(sent.at(-1).wire.startsWith('[CQ:reply,id=77]'))
  assert.ok(sent.at(-1).wire.includes('[CQ:at,qq=123456789]'))
  const r0 = await deliver(`group:${GROUP_ID}`, '不引用', { replyTo: 0 })
  assert.equal(r0.replyTo, null)
  assert.equal(r0.mode, 'plain')
  assert.equal(sent.at(-1).wire.includes('[CQ:reply'), false)

  // 负 message_id 必须照挂：SnowLuma 的 message_id 是有符号 int32 哈希（经常为负），
  // 只有 0 才表示"不挂引用"（2026-10-27 SnowLuma 兼容）
  const rn = await deliver(`group:${GROUP_ID}`, '引用一条负 id 的消息', { replyTo: -123456 })
  assert.equal(rn.replyTo, -123456)
  assert.equal(rn.mode, 'reply')
  assert.ok(sent.at(-1).wire.startsWith('[CQ:reply,id=-123456]'))
  assert.equal(parseWire(sent.at(-1).wire).replyTo, -123456, '留档/回报解析也要认负 id')
})

test('deliver：超长且无 @/引用 → 合并转发卡片；卡片失败自动降级普通发送，不吞话', async () => {
  const { deliver, sent } = makeDeliver()
  const long = '这是一段测试长文，用来验证超过阈值时自动打包为合并转发卡片。'.repeat(10)
  const r1 = await deliver(`group:${GROUP_ID}`, long)
  assert.equal(r1.mode, 'forward')
  assert.equal(sent.at(-1).kind, 'forward')

  const { deliver: d2, sent: s2, onebot } = makeDeliver()
  onebot.sendForward = async () => {
    throw new Error('forward fail')
  }
  const r2 = await d2(`group:${GROUP_ID}`, long)
  assert.equal(r2.mode, 'forward-fallback')
  assert.ok(s2.find((s) => s.kind === 'msg'), '降级后用普通消息发出')
})

test('deliver：带 @/引用不套卡片；显式超上限报错（提示精简）', async () => {
  const { deliver, sent } = makeDeliver()
  const long = '长文'.repeat(200)
  const r = await deliver(`group:${GROUP_ID}`, long, { replyTo: 5 })
  assert.equal(r.mode, 'reply')
  assert.equal(sent.at(-1).kind, 'msg')
  const { deliver: d2 } = makeDeliver({ replyMaxLength: 20 })
  await assert.rejects(() => d2(`private:${ADMIN_QQ}`, '这条消息的长度明显超过二十个字的上限设定，所以应该被拒绝发送'), /超过上限/)
})

test('deliver：decorate 可改 replyTo；钩子抛错不吞消息；onAfterSend 失败不影响发送', async () => {
  const { deliver, sent } = makeDeliver({ onAfterSend: () => { throw new Error('archive fail') } })
  deliver.onDecorate((out) => {
    out.replyTo = 88
  })
  deliver.onDecorate(() => {
    throw new Error('hook boom')
  })
  const r = await deliver(`group:${GROUP_ID}`, '你好')
  assert.equal(r.replyTo, 88)
  assert.ok(sent.at(-1).wire.includes('[CQ:reply,id=88]'))
})

test('deliver：主人私聊豁免脱敏；群聊里主人触发的消息仍然脱敏', async () => {
  const { deliver } = makeDeliver()
  const priv = await deliver(`private:${ADMIN_QQ}`, 'IP 198.51.100.42 端口 8444')
  assert.ok(priv.text.includes('198.51.100.42'))
  assert.ok(priv.text.includes('8444'))
  assert.deepEqual(priv.hits, [])
  const group = await deliver(`group:${GROUP_ID}`, 'IP 198.51.100.42 端口 8444')
  assert.ok(!group.text.includes('198.51.100.42'))
  assert.ok(group.hits.includes('ip'))
})

test('deliver.media：caption 强制脱敏、CQ 媒体码原样保留；非 CQ 串被拒', async () => {
  const { deliver, sent } = makeDeliver()
  const cq = cqImage('/data/qq test/a,b.png')
  const r = await deliver.media(`group:${GROUP_ID}`, cq, '看这张 198.51.100.42:8444')
  assert.equal(r.mode, 'media')
  assert.ok(sent.at(-1).wire.includes(cq), 'CQ 码原样保留（含逗号转义）')
  assert.ok(!sent.at(-1).wire.includes('198.51.100.42'), 'caption 被脱敏')
  await assert.rejects(() => deliver.media(`group:${GROUP_ID}`, '纯文本不是 CQ'), /必须是 CQ 码串/)
})

// ─────────────────────────────────────────────────────────────────────────────
// 七、兼容网关（默认关；开则与内核共用同一份 deliver）
// ─────────────────────────────────────────────────────────────────────────────

async function freePort() {
  const srv = net.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

const cleanups = []
after(async () => {
  for (const fn of cleanups) {
    try {
      await fn()
    } catch {
      /* ignore */
    }
  }
})

test('compat：/health 字段兼容旧探针；/send 走真实 deliver（脱敏 + [AT:] + reply_to 贯通）', async () => {
  const { kernel, dispose, sent } = await bootKernel({ config: { pluginConfig: { 'link-parser': { enabled: false } } } })
  cleanups.push(dispose)
  const port = await freePort()
  const compat = startCompatServer({ port, kernel, log: quietLog(), imageRoots: [tmpDir('compat-img')] })
  cleanups.push(() => compat.close())

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())
  for (const f of ['ok', 'dshLinked', 'onebotLinked', 'onebotLastFrameAgoMs', 'sessions']) {
    assert.ok(f in health, `health 应有字段 ${f}`)
  }

  const sendRes = await fetch(`http://127.0.0.1:${port}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: `group:${GROUP_ID}`, text: '[AT:qq=888888] 服务器 198.51.100.42:8444', reply_to: 12 }),
  }).then((r) => r.json())
  assert.equal(sendRes.ok, true)
  assert.ok(sendRes.redacted.includes('ip'), `应命中 ip：${sendRes.redacted}`)
  const wire = sent.at(-1).wire
  assert.ok(wire.includes('[CQ:at,qq=888888]'))
  assert.ok(wire.includes('[CQ:reply,id=12]'))
})

test('compat：/send 非法 JSON 回 400；/send-image 缺 file 400；白名单外图片被拒', async () => {
  const { kernel, dispose } = await bootKernel({ config: { pluginConfig: { 'link-parser': { enabled: false } } } })
  cleanups.push(dispose)
  const port = await freePort()
  const imgRoot = tmpDir('compat-root')
  const compat = startCompatServer({ port, kernel, log: quietLog(), imageRoots: [imgRoot] })
  cleanups.push(() => compat.close())

  const bad = await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  assert.equal(bad.status, 400)
  const noFile = await fetch(`http://127.0.0.1:${port}/send-image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(noFile.status, 400)
  const outside = path.join(tmpDir('outside'), 'a.png')
  fs.writeFileSync(outside, 'x')
  const denied = await fetch(`http://127.0.0.1:${port}/send-image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: `group:${GROUP_ID}`, file: outside }) })
  assert.equal(denied.status, 400)
  assert.match((await denied.json()).error, /白名单/)
  const inside = path.join(imgRoot, 'ok.png')
  fs.writeFileSync(inside, 'x')
  const okRes = await fetch(`http://127.0.0.1:${port}/send-image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: `group:${GROUP_ID}`, file: inside, text: '看图' }) })
  assert.equal(okRes.status, 200)
})
