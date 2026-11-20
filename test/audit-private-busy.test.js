import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootKernel, emitRaw, privateEvent } from './helpers.mjs'
import { setupPacing, flushPacing, MIN, localAt } from './pacing-fixture.mjs'

test('未被宿主读取的请求超时后不再永久阻挡私聊主动接话', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const h = await bootKernel({ config: {
    pacing: { merge: { enabled: false }, reply: {
      enabled: true, quietEnabled: false, silenceEnabled: false, privateEnabled: true,
      privateFriendsOnly: false, privateQqs: [10001], privateColdSilenceMs: MIN,
    } },
  } })
  t.after(() => h.dispose())
  await emitRaw(h.kernel, privateEvent({ text: '尚未读取的问题', messageId: 1 }))
  assert.equal(h.ctx._prompts.length, 1)
  now += 2 * MIN
  h.kernel.pacing.tickNow(); await flushPacing()
  assert.equal(h.ctx._prompts.length, 1, '仍忙时不可另外起话')
  now += 4 * MIN
  h.kernel.pacing.tickNow(); await flushPacing()
  assert.equal(h.ctx._prompts.length, 2, '等待超过五分钟后恢复主动起话')
})

test('私聊阻挡原因变更立即记日志，同一原因在十分钟内不刷屏', async t => {
  const messages = []
  let busy = false
  const { p, advance } = setupPacing(t, {
    now: localAt(12), seed: { 'private:10001': { lastInboundAt: localAt(12) } },
    reply: { privateColdSilenceMs: 2 * MIN }, isBusy: () => busy,
    log: { info: s => messages.push(s), warn() {}, error() {}, debug() {} },
  })
  const skipped = () => messages.filter(s => s.includes('暂不开口'))
  p.tickNow(); await flushPacing()
  assert.equal(skipped().length, 1)
  advance(MIN); p.tickNow(); await flushPacing()
  assert.equal(skipped().length, 1, '文案里的分钟变化不应绕过节流')
  busy = true; advance(MIN); p.tickNow(); await flushPacing()
  assert.equal(skipped().length, 2)
  assert.match(skipped().at(-1), /忙/)
  advance(10 * MIN); p.tickNow(); await flushPacing()
  assert.equal(skipped().length, 3)
})
