import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startSidecar } from './sidecar-fixture.mjs'

test('HTTP /read 根据实际时长选帧数，遵守阈值和硬上限', async t => {
  const s = await startSidecar(t)
  const rule = { frames: 8, framesLong: 11, framesSplitSec: 600 }
  for (const [seconds, overrides, expected] of [
    [2, { ...rule, frames: 6 }, 6], [30, rule, 8], [600, rule, 8], [601, rule, 11],
    [3600, { ...rule, framesLong: 999 }, 24],
    [100, {}, 12],
  ]) {
    const result = await s.request('/read', { url: s.file(seconds), ...overrides })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.frames.length, expected, 'duration=' + seconds)
    for (const [i, frame] of result.frames.entries()) {
      assert.ok(frame.sec >= 0 && frame.sec < seconds, '采样不能越过片尾')
      assert.ok(Math.abs(frame.sec - seconds * (i + 0.5) / expected) < 0.002, '短媒体也须均匀采样')
    }
  }
  const rejected = await s.request('/read', { url: s.file(601), maxSeconds: 600 })
  assert.equal(rejected.code, 'too_long')
})

test('两个视频插件把配置传至侧车，秒/旧毫秒超时均能用于真实请求', async t => {
  for (const [id, defaultTimeout] of [['video-read', 180000], ['video-link-read', 240000]]) {
    const plugin = (await import('../plugins/' + id + '/index.js')).default
    for (const [timeoutMs, expected] of [[undefined, defaultTimeout], [30, 30000], [180000, 180000]]) {
      const hooks = {}, calls = [], deadlines = []
      const config = Object.fromEntries(Object.entries(plugin.configSchema).map(([k, v]) => [k, v.default]))
      Object.assign(config, { frames: 7, framesLong: 9, framesSplitSec: 500, perUserHour: 0, perGroupHour: 0, extras: false })
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
      const timeout = AbortSignal.timeout
      t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return timeout(ms) })
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push(JSON.parse(options.body))
        return new Response(JSON.stringify({ ok: false, code: 'fixture_unavailable' }))
      })
      plugin.setup({ cfg: config, shared: {}, log: { info() {}, warn() {}, error() {}, debug() {} },
        state: { get: () => ({}) }, onebot: {}, on: (stage, fn) => { hooks[stage] = fn } })
      const ev = { chatKey: 'private:10001', isGroup: false, wake: { kind: 'private' },
        rawText: 'BV1xx411c7mD', text: 'BV1xx411c7mD', cards: [],
        rawSegments: [{ type: 'video', data: { url: 'https://multimedia.nt.qq.com.cn/fixture.mp4' } }],
        sender: { qq: 10001 }, hint: [], imageParts: [], _scratch: {} }
      await hooks['passive-tap']?.(ev)
      await hooks['before-turn'](ev)
      const request = calls.find(c => c.frames)
      assert.ok(request, id + ' 应提交 /read')
      assert.deepEqual([request.frames, request.framesLong, request.framesSplitSec], [7, 9, 500], id)
      assert.ok(deadlines.includes(expected), id + ' timeout=' + timeoutMs)
      t.mock.restoreAll()
    }
  }
})
