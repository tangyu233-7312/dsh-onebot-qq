
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
    async deliver(to, text) { delivered.push({ to, text }) },
    registerTool(name, def) { tools[name] = def },
    onDispose(fn) { shared.__dispose = fn },
    on() {},
  }

  plugin.setup(bot)
  const restore = () => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }) }
  return { bot, tools, delivered, shared, prompts, cfg, restore, dir, triggerTurnEnd: () => turnEndCb?.() }
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
  assert.equal(keys.length, 23, '配置项数量变了要顺手看文档：' + keys.join(','))
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
