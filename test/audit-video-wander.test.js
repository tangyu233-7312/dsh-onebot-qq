
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
    core: { dataDir: dir, adminQq: 1274673798, markScope: (sid, label, allowed) => { shared.__scope = { sid, label, allowed } } },
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
    selfLog: { append: (e) => selfLogRows.push(e) },
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
  const s = setup({ cfg: { autoEnabled: true, masterQq: '1274673798' } })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.ok, true)
    assert.equal(r.to, 'private:1274673798')
    assert.equal(s.delivered.length, 1)
    assert.equal(s.delivered[0].to, 'private:1274673798')
    assert.ok(s.delivered[0].text.includes('看了：'), '应带标题行')
    assert.ok(s.delivered[0].text.includes('https://www.bilibili.com/video/'), '应带链接')
    assert.ok(s.delivered[0].text.includes('街道'), '应带感想正文')
  } finally { s.restore() }
})

test('masterQq 留空：回落到 adminQq', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '' } })
  try {
    const r = await s.shared.videoWanderRunNow('测试')
    assert.equal(r.to, 'private:1274673798')
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
  const s = setup({ cfg: { autoEnabled: true, masterQq: '1274673798' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    assert.equal(s.pluginDelivered.length, 1, '结果要走 bot.deliver，不能走裸 deliver')
    assert.match(s.pluginDelivered[0].text, /街道/, '感想正文要在里面')
  } finally { s.restore() }
})

test('回归：看完后流水账里要有「看到了什么」，不能只有标题', async () => {
  const s = setup({ cfg: { autoEnabled: true, masterQq: '1274673798' } })
  try {
    await s.shared.videoWanderRunNow('测试')
    const done = s.selfLogRows.find((r) => r.delivered === true)
    assert.ok(done, '投递成功后要记一行 delivered')
    assert.match(done.what, /看完了/, '要说明看完了')
    assert.match(done.what, /街道/, '要带上它自己的感想，否则下一轮只剩标题')
  } finally { s.restore() }
})
