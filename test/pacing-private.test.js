import test from 'node:test'
import assert from 'node:assert/strict'


import { setupPacing, flushPacing as flush, localAt } from './pacing-fixture.mjs'
const setup = opts => setupPacing(null, opts)

const T0900 = Date.parse('2026-10-29T09:00:00+08:00')

test('私聊主动接话：对方安静够久 → 起一轮（isGroup=false）', async () => {
  const { p, fired, advance } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].chatKey, 'private:10001')
  assert.equal(fired[0].isGroup, false)
  assert.equal(fired[0].reason, 'private-silence')
})

test('私聊主动接话：白名单写死了 → 只对名单里的人开口', async () => {
  const { p, fired, advance } = setup({
    reply: { privateQqs: ['10002'] },
    seed: { 'private:10001': { lastInboundAt: T0900 }, 'private:10002': { lastInboundAt: T0900 } },
  })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].chatKey, 'private:10002')
})

test('私聊主动接话：每小时最多 1 次（同一小时内第二次 tick 不再开口）', async () => {
  const { p, fired, advance } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
})

test('私聊主动接话：每天最多 3 次（按自然日，0 点重置）', async () => {
  // 2026-11-01 改：每日额度从「滚动 24 小时」改成「本地自然日」——
  // 文案一直写「明天 0 点重置」，但原来的实现是等昨晚第一条满 24 小时才松口。
  const T0 = Date.parse('2026-10-29T12:00:00+08:00')
  const { p, fired, advance, state } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  const perDay = new Map()
  const dayOf = (ms) => {
    const d = new Date(ms)
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }
  for (let i = 0; i < 8; i += 1) {
    advance(4 * 3600000)
    state.get('private:10001').lastSendAt = T0900 + (i + 1) * 4 * 3600000
    const before = fired.length
    p.tickNow()
    await flush()
    if (fired.length > before) {
      const day = dayOf(T0 + (i + 1) * 4 * 3600000)
      perDay.set(day, (perDay.get(day) || 0) + 1)
    }
  }
  for (const [day, n] of perDay) {
    assert.ok(n <= 3, day + ' 开了 ' + n + ' 次，一天不该超过 3 次')
  }
  assert.ok(fired.length > 3, '跨过 0 点应该重新有额度（实际总共 ' + fired.length + ' 次）')
})

test('privateAllowed 可单独查（控制台/调试用）', async () => {
  const { p } = setup({ friends: [10001] })
  assert.equal(await p.privateAllowed('10001'), true)
  assert.equal(await p.privateAllowed('99999'), false)
  assert.equal(await p.privateAllowed('abc'), false)
})
test('静默时段：到点也不主动开口（回流自 NAS）', async () => {
  const { p, fired, setNow } = setup({
    reply: { quietEnabled: true, quietStart: 0, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: localAt(0, 30) } },
  })
  setNow(localAt(3))          // 凌晨 3 点，落在 0~7 静默区间
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0, '静默时段内不该开口')
})

test('回归 2026-11-03：静默时段反复 tick，配额一笔都不扣（原来先记账再 fire，一晚白扣 14 次）', async () => {
  const { p, fired, setNow, now } = setup({
    reply: {
      quietEnabled: true, quietStart: 0, quietEnd: 7,
      privateMaxPerDay: 3, privateMinGapMs: 30 * 60000, privateHourlyMax: 5,
      privateColdSilenceMs: 30 * 60000,
    },
    seed: { 'private:10001': { lastInboundAt: localAt(0, 30) } },
  })
  // 从 0:40 到 6:50，每 30 分钟 tick 一次（复刻线上静默期的节拍；额度若被扣早就爆 3 了）
  setNow(localAt(0, 40))
  for (let i = 0; i < 13; i += 1) {
    p.tickNow()
    await flush()
    setNow(now() + 30 * 60000)
  }
  assert.equal(fired.length, 0, '静默期不该起念，更不该扣额度')
  // 7 点静默一结束：额度仍是满的，按 30 分钟节拍能连开 3 次（每天上限）
  setNow(localAt(7, 5))
  for (let i = 0; i < 4; i += 1) {
    p.tickNow()
    await flush()
    setNow(now() + 31 * 60000)
  }
  assert.equal(fired.length, 3, `静默没扣额度：醒后应能开满 3 次（实际 ${fired.length}）`)
})

test('回归 2026-11-03：起念后模型没发消息，冷场锚点也推进（节拍不再塌缩成 minGap）', async () => {
  const { p, fired, setNow, now, state } = setup({
    reply: { privateColdSilenceMs: 50 * 60000, privateMinGapMs: 30 * 60000, privateMaxPerDay: 20, privateHourlyMax: 5 },
    seed: { 'private:10001': { lastInboundAt: T0900 } },
  })
  setNow(T0900 + 60 * 60000)   // 冷场已满足
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1, '先起一念')
  // 模型没接（lastSendAt 不动）。30 分钟后（minGap 已过、冷场 50 分钟未到）不该再起
  setNow(now() + 30 * 60000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1, `起念但没发 → 冷场锚点要包含起念时间，30 分钟不该再开口（实际 ${fired.length}）`)
  // 50 分钟后冷场重新满足 → 可以再起
  setNow(now() + 21 * 60000)
  state.get('private:10001').lastSendAt = 0  // 保险：不靠出站时间
  p.tickNow()
  await flush()
  assert.equal(fired.length, 2, '冷场 50 分钟到点后恢复起念')
})

test('回归 2026-11-03：resetPrivateQuota 清空配额并立刻恢复可用', async () => {
  const { p, fired, setNow, now } = setup({
    reply: { privateMaxPerDay: 2, privateMinGapMs: 30 * 60000, privateHourlyMax: 5, privateColdSilenceMs: 30 * 60000 },
    seed: { 'private:10001': { lastInboundAt: T0900 } },
  })
  setNow(T0900 + 60 * 60000)
  p.tickNow(); await flush()
  setNow(now() + 60 * 60000)
  p.tickNow(); await flush()
  assert.equal(fired.length, 2, '每天 2 次用满')
  setNow(now() + 60 * 60000)
  p.tickNow(); await flush()
  assert.equal(fired.length, 2, '第 3 次被每天上限挡住')
  const cleared = p.resetPrivateQuota()
  assert.equal(cleared, 2)
  setNow(now() + 60 * 60000)
  p.tickNow(); await flush()
  assert.equal(fired.length, 3, '重置后立刻能再开口')
})

test('静默时段：跨零点区间（23 → 7）也算静默', async () => {
  const { p, fired, setNow } = setup({
    reply: { quietEnabled: true, quietStart: 23, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: localAt(20) } },
  })
  setNow(localAt(23, 30))
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('静默时段：跨零点的另一端（凌晨 1 点）同样静默', async () => {
  const { p, fired, setNow } = setup({
    reply: { quietEnabled: true, quietStart: 23, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: localAt(22) } },
  })
  setNow(localAt(1))
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('静默时段关闭后：凌晨也会主动开口', async () => {
  const { p, fired, setNow } = setup({
    reply: { quietEnabled: false, quietStart: 0, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: localAt(0) } },
  })
  setNow(localAt(3))
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
})

// ── 2026-10-30 回归：两处让「私聊主动接话」静默失效的 bug ─────────────────
// 线上症状：控制台明明勾着「私聊也能主动接话」，但"最近状态"里一条私聊记录都没有，
// 全是群 573144674 的"没接（冷场找话）"。

test('回归：群冷场开着时，私聊冷场仍要跑（原来是 else if，被群吃掉）', async () => {
  // 群冷场开、私聊也开：两边互不依赖，私聊必须照样起念
  const { p, fired, advance } = setup({
    reply: { silenceEnabled: true, groups: { 900001: true }, coldSilenceMs: 300000 },
    seed: { 'private:10001': { lastInboundAt: T0900 } },
  })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  const priv = fired.filter((x) => x.isGroup === false)
  assert.equal(priv.length, 1, '私聊冷场被群冷场挡住了')
  assert.equal(priv[0].chatKey, 'private:10001')
})

for (const enabled of [true, false]) test('后台轮询实际起话：私聊开关=' + enabled, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { fired } = setupPacing(t, {
    timers: true, privateEnabledOn: enabled,
    seed: { 'private:10001': { lastInboundAt: localAt(8) } },
  })
  t.mock.timers.tick(30000)
  await flush()
  assert.equal(fired.length, enabled ? 1 : 0, '验证轮询后的行为，不锁定是否注册某个定时器')
})


for (const [name, options, delay] of [
  ['私聊主动关闭', { privateEnabledOn: false }, 300 * 60000],
  ['尚未冷场', { seed: { 'private:10001': { lastInboundAt: T0900 + 2 * 3600000 } } }, 30 * 60000],
  ['不是好友', { friends: [20002] }, 180 * 60000],
  ['好友服务失败', { friendThrows: true }, 180 * 60000],
]) test('私聊主动门禁：' + name, async t => {
  const { p, fired, advance } = setupPacing(t, {
    seed: { 'private:10001': { lastInboundAt: T0900 } }, ...options,
  })
  advance(delay)
  p.tickNow(); await flush()
  assert.equal(fired.length, 0)
})
