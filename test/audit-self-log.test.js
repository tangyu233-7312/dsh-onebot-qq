/**
 * test/audit-self-log.test.js — 我自己的流水账（kernel/self-log.js，2026-10-30）
 *
 * 为什么要有它：DSH 的会话是一条 QQ 线一个，它在群里 / 看视频的地方 / 空间工作区
 * 干过什么，私聊里的它一概不知道，于是出现「唉？已经看了吗？」。
 * 这份流水账就是跨会话的唯一真相，坏了 → 撕裂感回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createSelfLog } from '../kernel/self-log.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selflog-'))
}

test('append → readDay：写进去的能原样读出来', () => {
  const dir = tmp()
  const log = createSelfLog({ dataDir: dir, log: quiet })
  assert.equal(log.append({ kind: 'watch', what: '看了个视频', why: '自己想看的', where: '私聊' }), true)
  const rows = log.readDay()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'watch')
  assert.equal(rows[0].what, '看了个视频')
  assert.match(rows[0].at, /^\d{2}:\d{2}$/, '要带人能看的时间')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('append 永远不抛：dataDir 不可写也只返回 false', () => {
  const log = createSelfLog({ dataDir: '/\u0000bad', log: quiet })
  assert.doesNotThrow(() => log.append({ kind: 'watch', what: 'x' }))
  assert.equal(log.append({ kind: 'watch', what: 'x' }), false)
})

test('换行会被压平，不会把 jsonl 撑坏', () => {
  const dir = tmp()
  const log = createSelfLog({ dataDir: dir, log: quiet })
  log.append({ kind: 'watch', what: '第一行\n第二行', why: 'a\r\nb' })
  const rows = log.readDay()
  assert.equal(rows.length, 1, '一条记录仍然是一行')
  assert.equal(rows[0].what.includes('\n'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('countToday / recent：按类型计数、按条数取最近', () => {
  const dir = tmp()
  const log = createSelfLog({ dataDir: dir, log: quiet })
  log.append({ kind: 'watch', what: '视频1' })
  log.append({ kind: 'watch', what: '视频2' })
  log.append({ kind: 'qzone', what: '发了说说' })
  assert.equal(log.countToday('watch'), 2)
  assert.equal(log.countToday('qzone'), 1)
  assert.equal(log.recent(2).length, 2)
  assert.equal(log.recent(2)[1].what, '发了说说', 'recent 要按时间正序取最后几条')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('todayLine：只挑有信息量的几类，且带上时间', () => {
  const dir = tmp()
  const log = createSelfLog({ dataDir: dir, log: quiet })
  log.append({ kind: 'misc', what: '这条不该出现在经历里' })
  log.append({ kind: 'watch', what: '看了个视频', where: '私聊' })
  log.append({ kind: 'qzone', what: '发了条说说', where: '空间工作区' })
  const line = log.todayLine()
  assert.match(line, /看了个视频/)
  assert.match(line, /发了条说说/)
  assert.match(line, /空间工作区/, '不同场合的事要标出来，否则它会以为都在私聊发生')
  assert.equal(line.includes('这条不该出现在经历里'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('没有任何记录时 todayLine 返回空串（别让提示词里出现空的「我今天的经历」）', () => {
  const dir = tmp()
  const log = createSelfLog({ dataDir: dir, log: quiet })
  assert.equal(log.todayLine(), '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('坏行跳过、不抛（用户可能手改过日志）', () => {
  const dir = tmp()
  const log = createSelfLog({ dataDir: dir, log: quiet })
  log.append({ kind: 'watch', what: '好的这条' })
  fs.appendFileSync(log.fileOf(Date.now()), '{这不是JSON}\n', 'utf8')
  const rows = log.readDay()
  assert.equal(rows.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
