import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../plugins/device-time/index.js'
import { bootKernel, emitRaw, privateEvent } from './helpers.mjs'

test('设备时间工具在北京时间跨日边界返回一致日期、星期、时区和时间戳，关闭后明确报状态', async (t) => {
  const tools = {}, shared = {}, cfg = { enabled: true }
  plugin.setup({ cfg, shared, registerTool(name, def) { tools[name] = def } })
  for (const [iso, date, weekday] of [
    ['2026-11-20T15:59:59.000Z', '2026-11-20 23:59:59', '星期五'],
    ['2026-11-20T16:00:00.000Z', '2026-11-21 00:00:00', '星期六'],
  ]) {
    const stamp = Date.parse(iso)
    t.mock.method(Date, 'now', () => stamp)
    const r = await tools.get_current_time.execute({})
    assert.equal(r.unixMs, stamp); assert.equal(r.utc, iso)
    assert.equal(r.beijingTime, date + ' +08:00'); assert.equal(r.weekday, weekday)
    assert.equal(r.timeZone, 'Asia/Shanghai'); assert.equal(r.utcOffset, '+08:00')
    assert.ok(r.deviceTimeZone); assert.ok(r.deviceTime)
    t.mock.restoreAll()
  }
  cfg.enabled = false
  assert.equal((await tools.get_current_time.execute({})).ok, false)
})

test('内核注册可调用的时间工具，普通聊天材料保留消息时间', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  assert.ok(h.ctx._registeredTools.has('mcp__qq__get_current_time'))
  await emitRaw(h.kernel, privateEvent({ text: '几点了', messageId: 191 }))
  assert.match(h.ctx._prompts[0].content[0].text, /本条消息时间.*\+08:00/)
  assert.match(h.ctx._prompts[0].content[0].text, /get_current_time/)
  const tool = h.ctx._registeredTools.get('mcp__qq__get_current_time')
  assert.equal((await tool.execute({})).ok, true)
})
