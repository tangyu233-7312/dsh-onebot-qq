
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/video-wander/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 假侧车：返回一个真 JPEG 帧 */
function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-'))
  const frame = path.join(dir, 'f0.jpg')
  fs.writeFileSync(frame, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))

  const cfg = {
    enabled: true,
    autoEnabled: false,
    everyHours: 4,
    maxPerDay: 6,
    regions: ['全站'],
    masterQq: '',
    thoughtMaxChars: 300,
    candidatesLimit: 30,
    maxPickTries: 3,
    // 测试把「说完话后宽限」压到 1 秒：默认 20 秒会让「模型没交感想」那几条各等 20 秒，
    // 整包在 CI（job 上限 6 分钟）上会被 cancel 掉
    reportGraceSec: 1,
    excludeDays: 14,
    frames: 8,
    maxSide: 1024,
    maxMinutes: 15,
    sidecarUrl: 'http://127.0.0.1:3972',
    sidecarTimeoutSec: 300,
    turnTimeoutMinutes: 8,
    retryMinutes: 30,
    quietEnabled: true,
    quietStart: 1,
    quietEnd: 8,
    sendLink: true,
    sendTitle: true,
    ...(over.cfg || {}),
  }

  const tools = {}
  const delivered = []
  const pluginDelivered = []
  const selfLogRows = []
  const shared = {}
  const prompts = []
  let turnEndCb = null
  const rankItems = over.rankItems || [
    { bvid: 'BV1GJ411x7h7', title: '测试视频甲', duration: 212, owner: { name: 'UP甲' }, tname: '音乐', stat: { view: 12345 }, desc: '简介甲' },
    { bvid: 'BV1aa411c7dd', title: '测试视频乙', duration: 90, owner: { name: 'UP乙' }, tname: '知识', stat: { view: 99 }, desc: '' },
  ]

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('api.bilibili.com')) {
      if (over.rankFails) return { ok: false, status: 412, async json() { return {} } }
      // 模拟风控：ranking/v2 一律 -352，popular / 旧版排行正常
      if (over.blockV2 && u.includes('ranking/v2')) {
        return { ok: true, async json() { return { code: -352, message: '-352' } } }
      }
      if (over.allRisked) {
        return { ok: true, async json() { return { code: -352, message: '-352' } } }
      }
      return { ok: true, async json() { return { code: 0, data: { list: rankItems } } } }
    }
    if (u.includes('/read')) {
      const body = JSON.parse(opts?.body || '{}')
      const failList = over.sidecarFailBvids || []
      const hitFail = typeof body.url === 'string' && failList.some((b) => body.url.includes(b))
      if (over.sidecarFails || hitFail) return { ok: true, async json() { return { ok: false, code: 'download_failed', error: 'x' } } }
      return { ok: true, async json() { return { ok: true, platform: 'bilibili', title: '测试视频甲', durationSec: 212, frames: [{ path: frame, sec: 35 }] } } }
    }
    throw new Error('unexpected fetch ' + u)
  }

  const bot = {
    cfg,
    log: quiet,
    core: { dataDir: dir, adminQq: 10001, markScope: (sid, label, allowed) => { shared.__scope = { sid, label, allowed } } },
    shared,
    dsh: {
      async ensureSession(key, title) { shared.__session = { key, title }; return 'sess-wander' },
      async rename() {},
      onTurnEnd(sid, fn) { turnEndCb = fn; return () => { turnEndCb = null } },
      async prompt(sid, text, imageParts) {
        prompts.push({ sid, text, imageParts })
        if (over.twoPhase) {
          // 真实线上行为：先回一句话（turn 结束），过一会儿才调工具
          setTimeout(() => turnEndCb?.(), 5)
          setTimeout(() => {
            if (over.skipReason) tools.skip_watching.execute({ reason: over.skipReason })
            else tools.report_watched.execute({ thought: over.thought || '这片子挺有意思的，画面里是街道。' })
          }, 60)
          return
        }
        setTimeout(() => {
          if (over.noReport) { turnEndCb?.(); return }
          if (over.skipReason) tools.skip_watching.execute({ reason: over.skipReason })
          else tools.report_watched.execute({ thought: over.thought || '这片子挺有意思的，画面里是街道。' })
          turnEndCb?.()
        }, 5)
      },
    },
    // 2026-10-30：投递改成走插件自己的 bot.deliver（内核会按 target 找回它那一轮，
    // 只出站不插话）。这里两个名字都记，测试断言要看全。
    async deliver(to, text) { delivered.push({ to, text }); pluginDelivered.push({ to, text }) },
    // 2026-10-30：watch_video 现在按 _wakeKind 区分「自己起的念头(self)」和「主人叫的(master)」。
    // 默认给 null = 主人叫的（不占额度）；要测 self 通道就在 over.turnCtx 里传 { _wakeKind: 'proactive' }
    currentTurn() { return over.turnCtx || null },
    registerTool(name, def) { tools[name] = def },
    selfLog: {
      append: (e) => selfLogRows.push({ ...e, ts: e.ts || Date.now(), at: e.at || '12:00' }),
      // 假的流水账：watch_read 用它按天读（真实现按天分文件，测试只关心过滤逻辑）
      readSinceDays: () => selfLogRows,
    },
    onDispose(fn) { shared.__dispose = fn },
    on() {},
  }

  plugin.setup(bot)
  const restore = () => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }) }
  return { bot, tools, delivered, pluginDelivered, selfLogRows, shared, prompts, cfg, restore, dir, triggerTurnEnd: () => turnEndCb?.() }
}

test('默认：插件启用但自动看关', () => {
  const s = setup()
  try {
    assert.equal(s.cfg.enabled, true, '插件默认启用')
    assert.equal(s.cfg.autoEnabled, false, '自动看默认关')
    assert.equal(typeof s.shared.videoWanderRunNow, 'function')
    assert.equal(typeof s.shared.videoWanderStatus, 'function')
  } finally { s.restore() }
})

test('配置项都是控制台可调：20 项且都有默认值', () => {
  const schema = plugin.configSchema
  const keys = Object.keys(schema)
  assert.equal(keys.length, 27, '配置项数量变了要顺手看文档：' + keys.join(','))
  for (const k of keys) assert.ok(schema[k].default !== undefined, k + ' 必须有默认值')
  // 关键数字项都得有 min/max，不能让用户填出界
  for (const k of ['everyHours', 'maxPerDay', 'thoughtMaxChars', 'frames', 'maxMinutes', 'retryMinutes', 'excludeDays']) {
    assert.ok(schema[k].min !== undefined && schema[k].max !== undefined, k + ' 需要 min/max')
  }
})

test('跑一次：挑视频 → 抽帧 → 交感想 → 发给主人私聊', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '10001' } })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, true)
    assert.equal(r.to, 'private:10001')
    assert.equal(s.delivered.length, 1)
    assert.equal(s.delivered[0].to, 'private:10001')
    assert.ok(s.delivered[0].text.includes('看了：'), '应带标题行')
    assert.ok(s.delivered[0].text.includes('https://www.bilibili.com/video/'), '应带链接')
    assert.ok(s.delivered[0].text.includes('街道'), '应带感想正文')
  } finally { s.restore() }
})

test('masterQq 留空：回落到 adminQq', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '' } })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.to, 'private:10001')
  } finally { s.restore() }
})

test('关掉「带标题」和「带链接」：消息只剩感想', async () => {
  const s = setup({ cfg: { autoEnabled: true, sendTitle: false, sendLink: false } })
  try {
    await s.shared.videoWanderRunNow('测试')
    const text = s.delivered[0].text
    assert.equal(text.includes('看了：'), false)
    assert.equal(text.includes('bilibili.com'), false)
    assert.ok(text.includes('街道'))
  } finally { s.restore() }
})

test('感想超字数上限：截断并加省略号', async () => {
  const s = setup({ cfg: { enabled: true, thoughtMaxChars: 30 }, thought: '啊'.repeat(200) })
  try {
    await s.shared.videoWanderRunNow('测试')
    const body = s.delivered[0].text.split('\n\n')[1]
    assert.ok(body.length <= 31, '截断后不该超过上限：' + body.length)
    assert.ok(body.endsWith('…'))
  } finally { s.restore() }
})

test('它选择不写（skip_watching）：不发消息', async () => {
  const s = setup({ cfg: { autoEnabled: true }, skipReason: '这视频没什么可说的' })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.skipped, true)
    assert.equal(s.delivered.length, 0)
  } finally { s.restore() }
})

test('模型没交感想：不发消息（不打扰主人）', async () => {
  const s = setup({ cfg: { autoEnabled: true }, noReport: true })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no_report')
    assert.equal(s.delivered.length, 0)
  } finally { s.restore() }
})

test('侧车挂了：不发消息，等 retryMinutes 后再试', async () => {
  const s = setup({ cfg: { autoEnabled: true }, sidecarFails: true })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, false)
    assert.equal(s.delivered.length, 0)
    const st = s.shared.videoWanderStatus()
    assert.ok(st.lastRunAt > 0)
  } finally { s.restore() }
})

test('排行榜 412：不发消息', async () => {
  const s = setup({ cfg: { autoEnabled: true }, rankFails: true })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no_candidate')
    assert.equal(s.delivered.length, 0)
  } finally { s.restore() }
})

test('时长超过上限的视频不会被挑中', async () => {
  const s = setup({
    cfg: { autoEnabled: true, maxMinutes: 1 },
    rankItems: [{ bvid: 'BV1GJ411x7h7', title: '超长视频', duration: 3600, owner: { name: 'U' }, tname: 'x', stat: {}, desc: '' }],
  })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.reason, 'no_candidate')
  } finally { s.restore() }
})

test('最近看过的不会被再挑中（excludeDays）', async () => {
  const s = setup({
    cfg: { autoEnabled: true, excludeDays: 14 },
    rankItems: [{ bvid: 'BV1GJ411x7h7', title: '唯一候选', duration: 100, owner: { name: 'U' }, tname: 'x', stat: {}, desc: '' }],
  })
  try {
    await s.shared.videoWanderRunNow('第一次')
    assert.equal(s.delivered.length, 1)
    // 第二次：唯一候选已看过 → 挑不到
    const r2 = await s.shared.videoWanderRunNow('第二次')
    assert.equal(r2.reason, 'no_candidate')
    assert.equal(s.delivered.length, 1)
  } finally { s.restore() }
})

test('第一个候选下不动：换下一个（maxPickTries）', async () => {
  const s = setup({
    cfg: { autoEnabled: true, maxPickTries: 3 },
    rankItems: [
      { bvid: 'BV1GJ411x7h7', title: '下不动的', duration: 100, owner: { name: 'U' }, tname: 'x', stat: {}, desc: '' },
      { bvid: 'BV1aa411c7dd', title: '能下的', duration: 100, owner: { name: 'U' }, tname: 'x', stat: {}, desc: '' },
    ],
    sidecarFailBvids: ['BV1GJ411x7h7'],
  })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, true, '应该换到能下的那个')
    assert.equal(r.bvid, 'BV1aa411c7dd')
    assert.equal(s.delivered.length, 1)
  } finally { s.restore() }
})

test('全都下不动：不发消息', async () => {
  const s = setup({
    cfg: { autoEnabled: true, maxPickTries: 2 },
    rankItems: [{ bvid: 'BV1GJ411x7h7', title: '下不动', duration: 100, owner: { name: 'U' }, tname: 'x', stat: {}, desc: '' }],
    sidecarFails: true,
  })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, false)
    assert.equal(s.delivered.length, 0)
  } finally { s.restore() }
})

test('ranking/v2 被风控（-352）时自动走别的接口', async () => {
  const s = setup({ cfg: { autoEnabled: true }, blockV2: true })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, true, '应该从 popular / 旧版排行拿到候选')
    assert.equal(s.delivered.length, 1)
  } finally { s.restore() }
})

test('所有接口都被风控：不发消息，记日志', async () => {
  const s = setup({ cfg: { autoEnabled: true }, allRisked: true })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no_candidate')
    assert.equal(s.delivered.length, 0)
  } finally { s.restore() }
})

test('两段式提交：先回话、后调工具，也能收到（线上真实行为）', async () => {
  const s = setup({ cfg: { autoEnabled: true, reportGraceSec: 5 }, twoPhase: true })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, true, 'turn 结束后才调的工具也要能收到')
    assert.equal(s.delivered.length, 1)
    assert.ok(s.delivered[0].text.includes('街道'))
  } finally { s.restore() }
})

test('watch_video：对话里能自己触发一次观看，立刻返回', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    assert.equal(typeof s.tools.watch_video?.execute, 'function', '应注册 watch_video 工具')
    const r = await s.tools.watch_video.execute({}, { agent: { session: { id: 'session-normal' } } })
    assert.equal(r.ok, true, '应该接受这次请求：' + JSON.stringify(r))
    await new Promise((res) => setTimeout(res, 1800))
    assert.equal(s.delivered.length, 1, '看完应该发一条')
  } finally { s.restore() }
})

test('watch_video：在看视频的会话里拒绝（防递归）', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    s.bot.core.scopeOf = (sid) => (sid === 'sess-wander' ? { label: '看视频的地方' } : null)
    const r = await s.tools.watch_video.execute({}, { agent: { session: { id: 'sess-wander' } } })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不能再触发/)
  } finally { s.restore() }
})

test('两条路的配额互不占用：定时器刚看过，对话里照样能看', async () => {
  // 关键回归：原来共用 lastRunAt，定时器跑完 → 主人叫它看 → 它说「刚看过，N 分钟后再来」
  // 用户体感是「根本不是我要它看，是插件硬塞的」。
  const s = setup({ cfg: { autoEnabled: true, everyHours: 4, maxPerDay: 6 } })
  try {
    // 先让定时器跑一次（shared 入口等价于「到点自己看」，走 timer 那条计数）
    await s.shared.videoWanderRunNow('到点自己看')
    await new Promise((res) => setTimeout(res, 1800))
    const afterTimer = s.delivered.length
    assert.ok(afterTimer >= 1, '定时器那次应该发出去了')
    // 紧接着对话里再让它看：不该被定时器的冷却挡住
    const r = await s.tools.watch_video.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, true, '对话里不该被定时器的配额挡住：' + JSON.stringify(r))
  } finally { s.restore() }
})

test('对话那条路有自己的冷却（chatCooldownMin），不看定时器的', async () => {
  // 2026-10-30：额度只对「它自己起的念头」生效，所以这里要模拟 proactive 轮
  const s = setup({ turnCtx: { _wakeKind: 'proactive' }, cfg: { autoEnabled: true, chatCooldownMin: 30 } })
  try {
    const r1 = await s.tools.watch_video.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r1.ok, true)
    await new Promise((res) => setTimeout(res, 1800))
    const r2 = await s.tools.watch_video.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r2.ok, false)
    assert.match(r2.reason, /刚看过一个/)
  } finally { s.restore() }
})

test('对话那条路有自己的每日上限（chatMaxPerDay）', async () => {
  const s = setup({ turnCtx: { _wakeKind: 'proactive' }, cfg: { autoEnabled: true, chatCooldownMin: 0, chatMaxPerDay: 1 } })
  try {
    const r1 = await s.tools.watch_video.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r1.ok, true)
    await new Promise((res) => setTimeout(res, 1800))
    const r2 = await s.tools.watch_video.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r2.ok, false)
    assert.match(r2.reason, /今天这样看已经 1 次/)
  } finally { s.restore() }
})

test('chatMaxPerDay=0：对话里完全不允许，定时器不受影响', async () => {
  const s = setup({ turnCtx: { _wakeKind: 'proactive' }, cfg: { autoEnabled: true, chatMaxPerDay: 0 } })
  try {
    const r = await s.tools.watch_video.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, false)
    assert.match(r.reason, /设成 0/)
  } finally { s.restore() }
})

test('watch_video：自动看没开也能手动触发（用户点了就是想看）', async () => {
  const s = setup({ cfg: { autoEnabled: false } })
  try {
    const r = await s.tools.watch_video.execute({}, { agent: { session: { id: 'sx' } } })
    assert.equal(r.ok, true, 'autoEnabled=false 只挡定时器，不该挡对话里主动看')
  } finally { s.restore() }
})

test('看画面的提示可在控制台改（watchPrompt），默认带「跟主人说一句」', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    await s.shared.videoWanderRunNow('测试')
    const p = (s.prompts[s.prompts.length - 1] || {}).text || ''
    assert.match(p, /只看你看得见的/, '默认提示应该在 prompt 里')
    assert.match(p, /附带一句想对主人说的话/, '默认值应包含这句（用户明确要的）')
  } finally { s.restore() }
})

test('改了 watchPrompt 就按改的来，不再用默认那段', async () => {
  const s = setup({ cfg: { autoEnabled: true, watchPrompt: '这是我自定义的看片要求。' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    const p = (s.prompts[s.prompts.length - 1] || {}).text || ''
    assert.match(p, /这是我自定义的看片要求/)
    assert.equal(p.includes('只看你看得见的'), false, '不该再出现默认那段')
  } finally { s.restore() }
})

test('watchPrompt 被清空：回落到默认，不是「没有任何要求」', async () => {
  const s = setup({ cfg: { autoEnabled: true, watchPrompt: '' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    const p = (s.prompts[s.prompts.length - 1] || {}).text || ''
    assert.match(p, /只看你看得见的/, '清空应回落默认')
  } finally { s.restore() }
})

test('会话登记了工具白名单：只有三个工具能用', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    await s.shared.videoWanderRunNow('测试')
    assert.equal(s.shared.__session.key, 'desk:video-wander')
    assert.deepEqual(s.shared.__scope.allowed, ['report_watched', 'skip_watching', 'watch_status'])
  } finally { s.restore() }
})

test('帧真的塞进了 prompt（imageParts 非空）', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    await s.shared.videoWanderRunNow('测试')
    assert.equal(s.prompts.length, 1)
    assert.ok(s.prompts[0].imageParts.length >= 1)
    assert.match(s.prompts[0].imageParts[0].mediaType, /^image\//)
    assert.ok(s.prompts[0].text.includes('report_watched'))
  } finally { s.restore() }
})

test('状态落盘：seen 里记下 BV 号，runs 有记录', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    await s.shared.videoWanderRunNow('测试')
    const file = path.join(s.dir, 'video-wander-state.json')
    assert.ok(fs.existsSync(file))
    const st = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 挑哪条是随机的（两个候选里随机一个），只断言"有一条被记住"
    const seenIds = Object.keys(st.seen)
    assert.equal(seenIds.length, 1, '应正好记住一条：' + seenIds.join(','))
    assert.match(seenIds[0], /^BV[0-9A-Za-z]{10}$/)
    assert.ok(st.seen[seenIds[0]] > 0)
    assert.equal(st.runs.length, 1)
    assert.equal(st.runs[0].reason, 'sent')
  } finally { s.restore() }
})

test('静默时段内 tick 不启动（手动触发仍可）', () => {
  const s = setup({ cfg: { autoEnabled: true, quietEnabled: true, quietStart: 0, quietEnd: 24 } })
  try {
    const st = s.shared.videoWanderStatus()
    assert.equal(st.quiet.enabled, true)
    assert.equal(st.quiet.active, true, '0-24 应为全天静默')
  } finally { s.restore() }
})

test('maxPerDay = 0 等于自动关掉', () => {
  const s = setup({ cfg: { autoEnabled: true, maxPerDay: 0 } })
  try {
    assert.equal(s.shared.videoWanderStatus().autoEnabled, false)
  } finally { s.restore() }
})

test('侧车超时按「秒」解释：默认 180 秒，不是 5 秒（2026-10-29 的线上故障）', async () => {
  // 踩过的坑：timeoutMs 是子插件配置，storedOf 不做 scale 换算 →
  // 存的是秒（180）。原代码直接当毫秒：Math.max(5000, 180) = 5 秒，
  // 比侧车实际耗时还短（实测 6.2 秒出帧），于是每次都被判「超时」，
  // 用户看到的是「看视频的服务没起来」—— 但服务一直好好的。
  const fs2 = await import('node:fs')
  for (const [rel, fallback] of [['../plugins/video-read/index.js', 180], ['../plugins/video-link-read/index.js', 240]]) {
    const src = fs2.readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.match(src, /const timeoutMsOf = \(\) =>/, rel + ' 应有超时换算函数')
    assert.match(src, /n >= 1000 \? Math\.round\(n\) : Math\.round\(n \* 1000\)/, rel + ' 应兼容秒/毫秒两种历史值')
    assert.match(src, new RegExp(fallback + ' \\* 1000'), rel + ' 兜底应是 ' + fallback + ' 秒')
    // 不允许再出现「直接当毫秒」的旧写法
    assert.doesNotMatch(src, /Math\.max\(5000, Number\(cfg\(\)\.timeoutMs\)/, rel + ' 不应再有旧写法')
  }
})

test('超时换算：180/240 秒，以及旧的毫秒值也能认', () => {
  const conv = (n) => {
    if (!Number.isFinite(n) || n <= 0) return 180 * 1000
    return n >= 1000 ? Math.round(n) : Math.round(n * 1000)
  }
  assert.equal(conv(180), 180000, '180 秒 → 180000ms')
  assert.equal(conv(240), 240000)
  assert.equal(conv(180000), 180000, '旧的毫秒值原样认')
  assert.equal(conv(undefined), 180000, '缺失 → 默认 180 秒')
  assert.equal(conv(0), 180000)
  assert.equal(conv(30), 30000, '30 秒')
})

// ── 2026-10-30 线上：它点了「去看」，但看完的结果没回到它自己的记录里 ─────
test('回归：看完的感想必须经插件自己的 deliver 投递（内核才能记进它那一轮）', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '10001' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    assert.equal(s.pluginDelivered.length, 1, '结果要走 bot.deliver，不能走裸 deliver')
    assert.match(s.pluginDelivered[0].text, /街道/, '感想正文要在里面')
  } finally { s.restore() }
})

test('回归：看完后流水账里要有「看到了什么」，不能只有标题', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '10001' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    // 2026-10-31 改：投递前先把**完整感想**记进流水账（thought 字段）。
    // 原来只写一条「看了个视频」+ 60 字摘要，私聊里追问时它只剩标题可说。
    const done = s.selfLogRows.find((r) => String(r.thought || '').trim())
    assert.ok(done, '看完要把感想原文记下来，否则下一轮只剩标题')
    assert.match(done.what, /看完了/, '要说明看完了哪个')
    assert.match(done.thought, /街道/, '感想原文要完整进流水账')
  } finally { s.restore() }
})

test('WATCH-READ 翻自己看过的视频：给完整感想，并能带出当时抽的帧', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '10001' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    // ① 帧要留一份自己的（侧车 10 分钟就删）
    const framesRoot = path.join(s.dir, 'state', 'video-wander', 'frames')
    assert.ok(fs.existsSync(framesRoot), '要把帧留在自己这儿，不能只靠侧车的临时目录')
    const days = fs.readdirSync(framesRoot)
    assert.ok(days.length >= 1, '按天分目录')
    // 挑中的是哪条视频不固定（随机），别钉死 bvid
    const watched = s.selfLogRows.find((r) => String(r.thought || '').trim())
    assert.ok(watched?.bvid, '流水账里要记下这次看的是哪条')
    const bvidDir = path.join(framesRoot, days[0], watched.bvid)
    assert.ok(fs.existsSync(bvidDir), '按 bvid 分目录')
    assert.ok(fs.readdirSync(bvidDir).some((f) => /\.jpg$/i.test(f)), '帧文件要真的在')

    // ② watch_read 要把感想原文带出来 + 帧路径
    const r = await s.tools.watch_read.execute({})
    assert.equal(r.ok, true)
    // 跑一次会记两条 watch（「看了」+「看完了」），只有后者带感想；
    // 工具按「有没有感想」把没写的那条也算一次看过，所以按 bvid 找带感想的就行。
    const mine = r.items.filter((it) => it.bvid === watched.bvid && /街道/.test(it.thought))
    assert.equal(mine.length, 1, '刚看的那一条要能查到，且带完整感想原文')
    assert.ok(r.items[0].frames.length >= 1, '带上当时抽的帧')
    assert.ok(r.images.length >= 1, 'images 里给可读的图片路径')
  } finally { s.restore() }
})

test('WATCH-READ 只看到保留期内；按 bvid 查单条；没交感想要如实说', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '10001' } })
  try {
    const old = Date.now() - 20 * 86400 * 1000
    s.selfLogRows.push({ kind: 'watch', ts: old, at: '09:00', bvid: 'BVold', what: '看完了「很久以前」', thought: '早忘光了' })
    s.selfLogRows.push({ kind: 'watch', ts: Date.now(), at: '10:00', bvid: 'BVempty', what: '看完了「没交感想的那条」', thought: '' })

    const r = await s.tools.watch_read.execute({})
    assert.equal(r.count, 1, '20 天前那条超出 7 天保留期，不该出现')
    assert.match(r.items[0].thought, /没交感想，只记了标题/, '没感想要说没有，别让它编')

    const one = await s.tools.watch_read.execute({ bvid: 'BVold', days: '30' })
    assert.equal(one.items.length, 1, '按 bvid + 放宽天数能查到')
    assert.equal(one.items[0].bvid, 'BVold')

    const none = await s.tools.watch_read.execute({ bvid: 'BVnotexist' })
    assert.equal(none.items.length, 0)
    assert.match(String(none.note), /没找到/)
  } finally { s.restore() }
})

test('帧清理每天最多一次：第一次扫掉过期的，24 小时内不再扫（2026-10-31 用户要求）', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '10001' } })
  const localDate = (ms) => {
    const d = new Date(ms)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }
  const framesRoot = path.join(s.dir, 'state', 'video-wander', 'frames')
  const oldDay = localDate(Date.now() - 10 * 86400 * 1000)
  const stale = (day) => {
    const d = path.join(framesRoot, day, 'BVstale')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, '00.jpg'), 'x')
    return d
  }
  try {
    // ① 第一次跑：超过 7 天的目录被扫掉
    const first = stale(oldDay)
    await s.shared.videoWanderRunNow('测试')
    assert.equal(fs.existsSync(first), false, '超过保留期的帧目录该删')

    // ② 同一天再跑一次：新造一个过期目录，**不该**被扫（省 CPU）
    const second = stale(oldDay)
    await s.shared.videoWanderRunNow('测试')
    assert.equal(fs.existsSync(second), true, '24 小时内不再扫第二次')

    // ③ 时间戳要落盘（重启后不该立刻又扫）
    const st = JSON.parse(fs.readFileSync(path.join(s.dir, 'video-wander-state.json'), 'utf8'))
    assert.ok(Number(st.framesPrunedAt) > 0, '清理时间要存进状态文件')

    // ④ 间隔必须是「每天一次」——有人把它改回按小时，这条会红
    const status = s.shared.videoWanderStatus()
    assert.equal(status.frames.pruneEveryHours, 24, '帧清理间隔应为 24 小时（宁可多占盘，也别频繁扫）')
    assert.equal(status.frames.keepDays, 7, '帧保留期跟感想一致，7 天')
  } finally { s.restore() }
})

// ── 2026-10-30：watch_now（在当前对话里真的看）───────────────────
test('watch_now：抽到的帧挂到当前这一轮（它自己看得见），不换会话', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    const turnCtx = { _wakeKind: 'at', nextImageParts: [] }
    s.bot.currentTurn = () => turnCtx
    const r = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, true)
    assert.equal(r.frames, 1, '示例侧车只回一帧')
    assert.equal(turnCtx.nextImageParts.length, 1, '帧要进这一轮，下一轮它才看得见')
    assert.ok(r.frames > 0)
    assert.ok(r.url.includes('bilibili'))
    assert.match(r.message, /你现在就把看到的说出来/, '要明确让它自己开口，而不是等转述')
  } finally { s.restore() }
})

test('watch_now：主人在对话里叫它看 → 不占它自己的额度', async () => {
  const s = setup({ cfg: { autoEnabled: true, chatMaxPerDay: 1 } })
  try {
    const turnCtx = { _wakeKind: 'at', nextImageParts: [] }
    s.bot.currentTurn = () => turnCtx
    const r = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, true)
    assert.equal(r.channel, 'master')
    const st = s.shared.videoWanderStatus()
    assert.equal(st.self.todayCount, 0, '主人叫的不该占自己那份额度')
    assert.equal(st.master.todayCount, 1)
  } finally { s.restore() }
})

test('watch_now：不在任何一轮对话里 → 明确拒绝（它只能聊天里用）', async () => {
  const s = setup({ cfg: { autoEnabled: true } })
  try {
    s.bot.currentTurn = () => null
    const r = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不在任何一轮对话里/)
  } finally { s.restore() }
})

test('watch_now：自己起的念头受 chatMaxPerDay 限制', async () => {
  const s = setup({ cfg: { autoEnabled: true, chatMaxPerDay: 0 } })
  try {
    s.bot.currentTurn = () => ({ _wakeKind: 'proactive', nextImageParts: [] })
    const r = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, false)
    assert.match(r.reason, /每天最多/)
  } finally { s.restore() }
})

// ── 2026-10-30 线上：「看来冷却也管着本鱼自己点的」─────────────────
test('回归：主人说话触发的普通轮 → master 通道，不吃自己的冷却/额度', async () => {
  const s = setup({ cfg: { autoEnabled: true, chatCooldownMin: 30, chatMaxPerDay: 1 } })
  try {
    // 普通轮：_wakeKind 为空（只有合成轮才有），_triggeredBy = master
    const turnCtx = { _triggeredBy: 'master', nextImageParts: [] }
    s.bot.currentTurn = () => turnCtx
    const r1 = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r1.ok, true)
    assert.equal(r1.channel, 'master')
    // 立刻再叫它看一次：同类上限 20 很宽，冷却不该拦
    const turnCtx2 = { _triggeredBy: 'master', nextImageParts: [] }
    s.bot.currentTurn = () => turnCtx2
    const r2 = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r2.ok, true, '主人叫的第二次不该被"刚看过一个"挡住')
    const st = s.shared.videoWanderStatus()
    assert.equal(st.self.todayCount, 0, '一次都不该记进它自己的额度')
    assert.equal(st.master.todayCount, 2)
  } finally { s.restore() }
})

test('回归：主动接话起的轮才是 self（这条才占额度）', async () => {
  const s = setup({ cfg: { autoEnabled: true, chatMaxPerDay: 1 } })
  try {
    s.bot.currentTurn = () => ({ _wakeKind: 'proactive', nextImageParts: [] })
    const r = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(r.ok, true)
    assert.equal(r.channel, 'self')
    const st = s.shared.videoWanderStatus()
    assert.equal(st.self.todayCount, 1)
  } finally { s.restore() }
})

test('重置额度：只清「自己起的念头」的次数与冷却，不动主人叫的', async () => {
  const s = setup({ cfg: { autoEnabled: true, chatCooldownMin: 30, chatMaxPerDay: 1 } })
  try {
    // 自己看一次（占额度）
    s.bot.currentTurn = () => ({ _wakeKind: 'proactive', nextImageParts: [] })
    await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    // 主人叫看一次（不占额度）
    s.bot.currentTurn = () => ({ _triggeredBy: 'master', nextImageParts: [] })
    await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    let st = s.shared.videoWanderStatus()
    assert.equal(st.self.todayCount, 1)
    assert.equal(st.master.todayCount, 1)

    const r = s.shared.videoWanderResetQuota()
    assert.equal(r.ok, true)
    st = s.shared.videoWanderStatus()
    assert.equal(st.self.todayCount, 0, '自己那份要清空')
    assert.equal(st.master.todayCount, 1, '主人叫的不能跟着被清掉')
    assert.equal(st.self.lastAt, null, '冷却时间戳要清（0 会被 stats 渲染成 null）')
  } finally { s.restore() }
})

test('重置后：本来被冷却挡住的自看又能看了', async () => {
  const s = setup({ cfg: { autoEnabled: true, chatCooldownMin: 30 } })
  try {
    s.bot.currentTurn = () => ({ _wakeKind: 'proactive', nextImageParts: [] })
    await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    // 冷却中：再自看会被挡
    const blocked = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason, /刚看过一个/)
    // 重置后放行
    s.shared.videoWanderResetQuota()
    const ok = await s.tools.watch_now.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(ok.ok, true)
  } finally { s.restore() }
})
