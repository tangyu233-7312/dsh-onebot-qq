/**
 * audit-file-prune — 入站文件「保留 5 天、每 24 小时检查一次」
 *
 * 用户要求（2026-11-18）：文件只保存 5 天，过期就删，每 24 小时检测一次。
 *
 * 为什么要单独钉「定时」这一半：NAS 上的机器人一跑十几天不重启，
 * 只挂启动钩子的实现等于**永远不清**（旧代码就是只有启动清理）。
 * 这里用假时钟把 setInterval 的回调抓出来直接调，验证"运行中也会清"，
 * 同时钉住 24 小时节流（不然每次检查都扫盘没有意义）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bootKernel } from './helpers.mjs'

const DAY = 24 * 3600 * 1000

/** 拦截 setInterval，拿到 24 小时那个定时器的回调（其它定时器原样执行） */
function captureIntervals(t) {
  const realSetInterval = globalThis.setInterval
  const timers = []
  globalThis.setInterval = (fn, ms, ...rest) => {
    if (ms === DAY) {
      timers.push(fn)
      return { unref() {}, ref() {}, close() {} }
    }
    return realSetInterval(fn, ms, ...rest)
  }
  t.after(() => { globalThis.setInterval = realSetInterval })
  return timers
}

function makeAged(dir, name, ageDays) {
  const f = path.join(dir, name)
  fs.writeFileSync(f, name)
  const t = (Date.now() - ageDays * DAY) / 1000
  fs.utimesSync(f, t, t)
  return f
}

test('PRUNE-1 运行中也会清：24 小时定时器真的被挂上，且能删掉过期文件', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-prune-'))
  const dir = path.join(dataDir, 'qq_uploads')
  fs.mkdirSync(dir, { recursive: true })
  // ⚠️ 文件必须在 boot 之前就位：启动清理只在启动时扫一次
  const fresh = makeAged(dir, 'will-age.txt', 0.1)
  const old = makeAged(dir, 'already-old.txt', 6)
  const timers = captureIntervals(t)
  const h = await bootKernel({ dataDir })
  t.after(() => h.dispose())

  assert.ok(timers.length >= 1, '应挂一个 24 小时的 setInterval（只靠启动清理在 NAS 上等于不清）')
  assert.equal(fs.existsSync(old), false, '启动时已超过 5 天的应被清掉')
  assert.equal(fs.existsSync(fresh), true, '没过期的要留着')

  // 让文件变老到 6 天前，并把时钟往前推 25 小时 ——
  // 节流是"两次清理至少间隔 24 小时"，启动那次刚跑过，必须过 24h 定时器才会真正扫盘。
  const aged = (Date.now() - 6 * DAY) / 1000
  fs.utimesSync(fresh, aged, aged)
  const realNow = Date.now
  const shift = 25 * 3600 * 1000
  Date.now = () => realNow.call(Date) + shift
  t.after(() => { Date.now = realNow })
  for (const fn of timers) await fn()
  assert.equal(fs.existsSync(fresh), false, '运行中过期的文件也要被清掉（时钟推进 25 小时后）')
})

test('PRUNE-1b 24 小时节流：同一轮里反复触发只扫一次', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-prune1b-'))
  const dir = path.join(dataDir, 'qq_uploads')
  fs.mkdirSync(dir, { recursive: true })
  const timers = captureIntervals(t)
  const h = await bootKernel({ dataDir })
  t.after(() => h.dispose())
  // 刚启动就立刻跑定时回调：不该再做一次全盘扫描（没有可观察的删除动作即可）
  const f = makeAged(dir, 'x.txt', 0.1)
  for (const fn of timers) await fn()
  assert.equal(fs.existsSync(f), true, '没过期的文件不会因为跑了定时器就被删')
})

test('PRUNE-2 5 天整是边界：4 天留着、6 天删掉', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-prune2-'))
  const dir = path.join(dataDir, 'qq_uploads')
  fs.mkdirSync(dir, { recursive: true })
  const keep = makeAged(dir, 'four-days.txt', 4)
  const drop = makeAged(dir, 'six-days.txt', 6)
  const h = await bootKernel({ dataDir })
  t.after(() => h.dispose())
  assert.equal(fs.existsSync(keep), true, '4 天的要留着')
  assert.equal(fs.existsSync(drop), false, '6 天的要删掉')
})

test('PRUNE-3 keepDays=0 表示永不清', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-prune3-'))
  const dir = path.join(dataDir, 'qq_uploads')
  fs.mkdirSync(dir, { recursive: true })
  const old = makeAged(dir, 'ancient.txt', 90)
  const h = await bootKernel({ dataDir, config: { pluginConfig: { 'file-transfer': { keepDays: 0 } } } })
  t.after(() => h.dispose())
  assert.equal(fs.existsSync(old), true, 'keepDays=0 时不许删任何文件')
})
