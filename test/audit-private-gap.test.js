import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupPacing, flushPacing, MIN, localAt } from './pacing-fixture.mjs'

test('私聊间隔只按当前毫秒配置生效；旧小时字段不会额外阻挡', async t => {
  const { p, fired, advance } = setupPacing(t, {
    now: localAt(12), seed: { 'private:10001': { lastInboundAt: localAt(8) } },
    reply: { privateMinGapMs: 30 * MIN, privateMinHourGap: 24, privateColdSilenceMs: MIN, privateHourlyMax: 10 },
  })
  p.tickNow(); await flushPacing()
  advance(30 * MIN - 1); p.tickNow(); await flushPacing()
  assert.equal(fired.length, 1, '间隔未满不重复起话')
  advance(1); p.tickNow(); await flushPacing()
  assert.equal(fired.length, 2, '到达毫秒边界立即放行，旧字段不叠加')
})
