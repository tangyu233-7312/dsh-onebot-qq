import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createMediaCache } from '../kernel/media-cache.js'

const quiet = { warn() {} }
const sample = Buffer.from('原件完整内容，不按扩展名或首帧判断')

test('原件按会话关联，合并并发下载，重启后仍命中，帧缓存按处理参数区分', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cache-'))
  let requests = 0
  const server = http.createServer((_req, res) => { requests++; res.end(sample) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const image = { url: 'http://127.0.0.1:' + server.address().port + '/picture' }
  const loader = async () => Buffer.from(await (await fetch(image.url)).arrayBuffer())
  let cache = createMediaCache({ dir, log: quiet })
  t.after(() => { cache.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  for (const chatKey of ['group:20001', 'private:10001']) {
    const ev = { chatKey, messageId: 10, time: Date.now(), sender: { qq: 10001 } }
    const copies = await Promise.all([cache.load(ev, image, 0, loader), cache.load(ev, image, 0, loader)])
    assert.deepEqual(copies[0].bytes, sample); assert.deepEqual(copies[1].bytes, sample)
    await cache.load({ ...ev, messageId: 11 }, image, 0, loader)
  }
  assert.equal(requests, 2, '各会话首次下载，随后并发/跨轮均复用')
  assert.equal(cache.stats().objects, 1, '原件按内容哈希只保存一份')
  const ev = { chatKey: 'group:20001', messageId: 12, time: Date.now() }
  const original = await cache.load(ev, image, 0, loader)
  const params = { frames: 2, maxSide: 1024 }
  cache.saveFrames(ev.chatKey, original.hash, params, [{ mediaType: 'image/jpeg', data: sample.toString('base64'), sec: 0.2 }])
  assert.equal(cache.getFrames(ev.chatKey, original.hash, params).length, 1)
  assert.equal(cache.getFrames(ev.chatKey, original.hash, { ...params, frames: 6 }), null)
  assert.equal(cache.getFrames(ev.chatKey, original.hash, { ...params, maxSide: 512 }), null)
  assert.equal(cache.getFrames('private:10003', original.hash, params), null)
  const foreign = cache.recent('group:20001', 1, 0)[0]
  await assert.rejects(cache.load({ ...ev, chatKey: 'private:10003' }, foreign, 0, async () => { throw Error('无本会话原件') }))
  cache.close(); cache = createMediaCache({ dir, log: quiet })
  assert.deepEqual((await cache.load(ev, image, 0, loader)).bytes, sample)
  assert.equal(requests, 2, '重启读回不重新下载')
  fs.writeFileSync(original.file, '损坏原件')
  assert.deepEqual((await cache.load(ev, image, 0, loader)).bytes, sample)
  assert.deepEqual(fs.readFileSync(original.file), sample, '下载成功同时修复磁盘原件')
  await cache.load(ev, image, 0, loader)
  assert.equal(requests, 3, '修复后继续复用，不能每次重新下载')
})

test('24小时期限由再次发送刷新而非读取刷新，容量不足不提前删除有效图', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cache-ttl-'))
  let now = 1800000000000
  const cfg = { cacheHours: 24, cacheMaxMb: 1 }
  const cache = createMediaCache({ dir, config: () => cfg, now: () => now, log: quiet })
  t.after(() => { cache.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const ev = { chatKey: 'group:20001', messageId: 1, time: now }
  const image = { url: 'https://example.invalid/one' }
  const data = Buffer.alloc(700000, 7)
  await cache.load(ev, image, 0, async () => data)
  const overflow = await cache.load({ ...ev, messageId: 2 }, { url: 'https://example.invalid/two' }, 0, async () => Buffer.alloc(700000, 8))
  assert.equal(overflow.cached, false)
  assert.equal(cache.stats().objects, 1)
  assert.match(cache.stats().lastError, /容量不足/)
  now += 23 * 3600000
  assert.equal((await cache.load(ev, image, 0, async () => { throw Error('不应下载') })).cached, true)
  now += 2 * 3600000; cache.sweep()
  assert.equal(cache.stats().objects, 0, '读取没有延长期限，25小时后过期')
  const next = { ...ev, messageId: 3, time: now }
  await cache.load(next, image, 0, async () => data)
  now += 23 * 3600000
  await cache.load({ ...next, messageId: 4, time: now }, image, 0, async () => { throw Error('重发可复用原图') })
  now += 2 * 3600000; cache.sweep()
  assert.equal(cache.stats().objects, 1, '用户重新发送刷新保留期')
  now += 23 * 3600000; cache.sweep()
  assert.equal(cache.stats().objects, 0)
})

test('每日23:50才批量清过期原件和帧，收图与重启不扫描，修改时间后按新时刻执行', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cache-daily-'))
  let now = Date.parse('2026-11-20T23:49:00+08:00')
  const cfg = { cacheHours: 24, cacheCleanupTime: '23:50' }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const open = () => createMediaCache({ dir, config: () => cfg, now: () => now, log: quiet })
  let cache = open()
  t.after(() => { cache.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const advance = (ms) => { now += ms; t.mock.timers.tick(ms) }
  const ev = { chatKey: 'private:10001', messageId: 1, time: now }
  const original = await cache.load(ev, { url: 'https://example.invalid/old' }, 0, async () => sample)
  cache.saveFrames(ev.chatKey, original.hash, { frames: 2 }, [{ mediaType: 'image/jpeg', data: sample.toString('base64'), sec: 0.2 }])
  advance(60000)
  assert.equal(cache.stats().objects, 1, '首日23:50未满24小时，不能删除')
  advance(24 * 3600000 - 60000)
  cache.close(); cache = open()
  assert.ok(fs.existsSync(original.file), '次日23:49虽已满24小时，重启也不提前扫描')
  const fresh = Buffer.from('新收到的图片')
  await cache.load({ ...ev, messageId: 2, time: now }, { url: 'https://example.invalid/new' }, 0, async () => fresh)
  assert.equal(cache.stats().objects, 2, '收图不触发过期清理')
  advance(59000)
  assert.ok(fs.existsSync(original.file), '23:50之前仍未删除')
  advance(1000)
  assert.equal(fs.existsSync(original.file), false, '到23:50清掉过期原件')
  assert.equal(cache.stats().bytes, fresh.length, '旧帧随原件清理，未过期新图保留')
  cfg.cacheCleanupTime = '23:49'; cache.scheduleCleanup()
  advance(24 * 3600000 - 120000)
  assert.equal(cache.stats().objects, 1, '配置更新后等待新时刻')
  advance(60000)
  assert.equal(cache.stats().objects, 0, '下一天按更新后的23:49清理')
})
