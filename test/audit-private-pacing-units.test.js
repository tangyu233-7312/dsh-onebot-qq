import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setupPacing, flushPacing, MIN, localAt } from './pacing-fixture.mjs'

test('冷场阈值按毫秒解释：边界前不触发，到点触发', async t => {
  const { p, fired, advance } = setupPacing(t, {
    now: localAt(12), seed: { 'private:10001': { lastInboundAt: localAt(12) } },
    reply: { privateColdSilenceMs: 45 * MIN },
  })
  advance(45 * MIN - 1); p.tickNow(); await flushPacing()
  assert.equal(fired.length, 0)
  advance(1); p.tickNow(); await flushPacing()
  assert.equal(fired.length, 1)
})

for (const [day, at, expected] of [
  ['昨天记录', new Date(2026, 9, 28, 23, 55).getTime(), 1],
  ['今天记录', localAt(8), 0],
]) test('落盘每日配额按自然日恢复：' + day, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-day-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'private-pacing-state.json'), JSON.stringify({ version: 1, rings: { 10001: [at] } }))
  const { p, fired } = setupPacing(t, {
    dataDir: dir, now: localAt(12), seed: { 'private:10001': { lastInboundAt: localAt(8) } },
    reply: { privateMaxPerDay: 1, privateMinGapMs: MIN, privateColdSilenceMs: MIN },
  })
  p.tickNow(); await flushPacing()
  assert.equal(fired.length, expected)
})
