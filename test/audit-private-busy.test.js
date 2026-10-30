/**
 * test/audit-private-busy.test.js — 「主动接话永远不触发」的两个防线（2026-10-30）
 *
 * 线上：15:17 主动说过一次，之后三个多小时一声不响；群里照常接话。
 * 两道防线都曾经缺：
 *   ① pendingTurns 没有超时清理 —— prompt 提交了但 turn/start 没来就永久占住这条线，
 *      hasPendingTurn 永远 true → isBusy 永远 true → 主动接话再也起不来。
 *   ② 每个 continue 都静默 —— 只能靠翻 stats / 猜 / 手工调 NapCat 接口查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

test('hasPendingTurn 必须带超时（否则永久占线）', () => {
  const src = read('index.js')
  const i = src.indexOf('const hasPendingTurn')
  assert.ok(i > 0, '要有 hasPendingTurn')
  const body = src.slice(i, i + 1200)
  assert.match(body, /startedAt/, '要按 startedAt 判年龄')
  assert.match(body, /ACTIVE_TURN_TTL_MS/, '复用同一个 TTL')
  assert.match(body, /清理/, '清理时要有日志，别静默')
})

test('私聊每一步 continue 都要能说出原因', () => {
  const src = read('kernel/pacing.js')
  const i = src.indexOf('function tickPrivateSilence')
  const body = src.slice(i, i + 1800)
  for (const reason of ['还没冷场', '这条线正忙', '没有对话基线']) {
    assert.ok(body.includes(reason), '缺诊断原因：' + reason)
  }
  // 配额那道闸要**说出是哪一种**（2026-10-30：三个原因混成一句「配额或间隔未到」，
  // 线上分不清是每小时上限、每天上限还是最小间隔）
  assert.match(body, /quotaBlocked/, '配额要单独算出具体原因')
  const quota = src.slice(src.indexOf('function privateQuotaBlocked'), src.indexOf('function privateQuotaBlocked') + 1800)
  for (const why of ['每小时上限', '每天上限', '距上次主动开口还差']) {
    assert.ok(quota.includes(why), '配额原因要具体：' + why)
  }
  assert.match(body, /logPrivateSkip/, '要走节流日志')
  assert.match(body, /code = 'warming'|code = 'busy'/, '要有原因代码（节流按代码）')
})

test('诊断日志是节流 info，不会每 30 秒刷屏', () => {
  const src = read('kernel/pacing.js')
  assert.match(src, /function logPrivateSkip/, '要有节流函数')
  assert.match(src, /10 \* 60000/, '10 分钟窗口')
  assert.match(src, /prev\.code === code/, '节流按代码判，不按文案（文案带数字会失效）')
  assert.ok(src.includes("log.info('[主动接话] '"), '用 info（debug 默认看不到）')
})
