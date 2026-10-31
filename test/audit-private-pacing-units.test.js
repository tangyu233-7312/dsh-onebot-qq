/**
 * test/audit-private-pacing-units.test.js — 私聊接话的单位换算（2026-10-31 踩过的真 bug）
 *
 * 事故：配置 privateMinGapMs 存的是**毫秒**（schema 用 scale:60000 显示成分钟），
 *   但 pacing.js 里写成 `num(cfg.reply.privateMinGapMs, 60) * 60000` —— 又乘了一次，
 *   30 分钟变成 30 分钟 × 60000 = 1800000 分钟（约 3.4 年）。
 *   日志：「距上次主动开口还差 1799698 分钟（间隔 1800000 分钟）」，私聊永远不开口。
 *   群里正常，因为群用 pacing.minGapMs，不走这段。
 *
 * 这条测试守两件事：
 *   ① 配额间隔读的是配置原值（毫秒），不再多乘；
 *   ② 冷场阈值同样不能被多乘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, tmpDir } from './helpers.mjs'

const MIN = 60000

/** 造一个私聊接话已配好的内核，并塞入一条「刚才开口过」的落盘记录。 */
async function bootWithLastFire({ gapMs, coldMs }) {
  const dataDir = tmpDir('units')
  const config = {
    archive: { enabled: false },
    pacing: {
      reply: {
        enabled: true,
        privateEnabled: true,
        privateQqs: [10001],
        privateFriendsOnly: false,
        privateColdSilenceMs: coldMs,
        privateMinGapMs: gapMs,
        privateHourlyMax: 10,
        privateMaxPerDay: 100,
      },
    },
  }
  const fs = await import('node:fs')
  const path = await import('node:path')
  // 先起一次让它建目录、apply 一次
  const e0 = await bootKernel({ dataDir, config })
  e0.dispose()
  // 落盘：1 分钟前开口过一次
  fs.writeFileSync(
    path.join(dataDir, 'private-pacing-state.json'),
    JSON.stringify({ version: 1, rings: { 10001: [Date.now() - MIN] } }),
    'utf8',
  )
  const env = await bootKernel({ dataDir, config })
  return env
}

test('配额间隔按毫秒读，不会多乘 60000（本次事故的回归）', async (t) => {
  // 30 分钟间隔，1 分钟前刚开口过 → 应提示「还差 29 分钟」
  const env = await bootWithLastFire({ gapMs: 30 * MIN, coldMs: 45 * MIN })
  t.after(() => env.dispose())
  const u = env.kernel.pacing.stats().private.usage[0]

  assert.equal(u.todayUsed, 1, '落盘的记录要读回来')
  assert.ok(u.nextAllowedMinutes <= 30, '剩余等待不能超过设定的 30 分钟，实际=' + u.nextAllowedMinutes)
  assert.ok(u.nextAllowedMinutes >= 28, '应约等于 29 分钟，实际=' + u.nextAllowedMinutes)

  // 关键断言：原因里不能出现天文数字
  const blocked = String(u.blockedBy || '')
  assert.ok(blocked.includes('距上次'), '应该卡在间隔上：' + blocked)
  const m = blocked.match(/还差 (\d+) 分钟/)
  assert.ok(m, '要说出还差多少分钟：' + blocked)
  assert.ok(Number(m[1]) < 60, '还差的分钟数必须是个正常值，实际=' + m[1] + '（1800000 说明又乘了 60000）')
})

test('冷场阈值按毫秒读，晚于阈值就放行', async (t) => {
  // 冷场 45 分钟、间隔 30 分钟，但落盘是 1 分钟前 → 卡间隔（说明冷场已过，不算"还没冷场"）
  const env = await bootWithLastFire({ gapMs: 30 * MIN, coldMs: 45 * MIN })
  t.after(() => env.dispose())
  const p = env.kernel.pacing.stats().private
  assert.equal(p.coldSilenceMs, 45 * MIN, '冷场阈值要保持毫秒原值')
  assert.equal(p.minGapMs, 30 * MIN, '间隔要保持毫秒原值')
  // usage 里的剩余等待同样不能是天文数字
  const u = p.usage[0]
  assert.ok(u.nextAllowedMinutes < 60, '剩余等待要正常：' + u.nextAllowedMinutes)
})
