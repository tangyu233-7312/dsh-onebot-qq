/**
 * test/audit-plugin-additions.test.js — PR #1 新增 4 个子插件的行为测试。
 *
 * 覆盖：
 *   · anti-repeat：指纹归一化 + 同句超限 → 甩一句 + 冷却（冷却期静默）
 *   · private-friend-gate：好友放行 / 陌生人拦下 / 主人永远放行
 *   · video-read：假侧车返回帧 → 进 imageParts；侧车不在 → 降级并如实提示
 *   · video-link-read：B 站链接 → 帧进 imageParts、不 stop；无关链接完全不碰
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  bootKernel, emitRaw, tapInbound, waitFor,
  ADMIN_QQ, MEMBER_QQ, groupAtEvent, privateEvent,
} from './helpers.mjs'
import { fingerprint } from '../plugins/anti-repeat/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mergeOff = { pacing: { merge: { enabled: false } } }

/** 起一个只回 JSON 的假侧车；返回 { url, close, requests } */
async function startSidecar(payload) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ url: req.url, body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) }
}

/** 造两张小 JPEG（文件头合法即可，测试不解码） */
function writeJpeg(dir, name) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]))
  return file
}

function withVideo(ev, file, fields = {}) {
  ev.message.push({ type: 'video', data: { file: 'clip.mp4', path: file, ...fields } })
  return ev
}

// ── anti-repeat ────────────────────────────────────────────────
test('ANTI-REPEAT 指纹归一化：空白/标点/全角/连续重复字都算同一句', () => {
  assert.equal(fingerprint('好好好！！！'), fingerprint('好'))
  assert.equal(fingerprint('在吗？'), fingerprint('在吗'))
  assert.equal(fingerprint('  ＡＢＣ  '), fingerprint('abc'))
  assert.equal(fingerprint('哈哈哈 哈哈哈'), fingerprint('哈'))
  assert.equal(fingerprint('🎉🎉'), '')
})

test('ANTI-REPEAT 同句超限 → 甩一句 + 整条线冷却；冷却期静默', async (t) => {
  const h = await bootKernel({
    config: {
      ...mergeOff,
      pluginConfig: { 'anti-repeat': { repeatLimit: 2, cooldownMin: 1, notice: '别刷了' } },
    },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  const send = (id) => emitRaw(h.kernel, groupAtEvent({ text: '在吗在吗', messageId: id }))

  await send(1)
  await waitFor(() => h.ctx._prompts.length === 1, { label: '第 1 次进模型' })
  await send(2)
  await waitFor(() => h.ctx._prompts.length === 2, { label: '第 2 次进模型' })
  await send(3) // 第 3 次 > limit(2) → 甩句子 + 冷却
  await waitFor(() => h.sent.some((s) => String(s.wire).includes('别刷了')), { label: '甩句子' })
  assert.equal(tap.last().stopReason, 'anti-repeat:flood')
  assert.equal(h.ctx._prompts.length, 2, '命中后不再进模型')

  await send(4) // 冷却期：静默拦下
  await sleep(60)
  assert.equal(tap.last().stopReason, 'anti-repeat:cooldown')
  assert.equal(h.ctx._prompts.length, 2)
  assert.equal(h.sent.filter((s) => String(s.wire).includes('别刷了')).length, 1, '同窗口只甩一次')
})

// ── private-friend-gate ───────────────────────────────────────
test('PRIVATE-GATE 好友放行；陌生人拦下且不进模型', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  // 好友列表：只有非主人 MEMBER_QQ（主人本来就永远放行，这里单独验证"好友"通道）
  h.kernel.onebot.friendList = async () => [{ user_id: MEMBER_QQ }]

  // 第 1 条触发 passive-tap 刷新缓存（pre-gate 此时还不知道 → failOpen 放行）
  await emitRaw(h.kernel, privateEvent({ text: '你好', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '好友第 1 条进模型' })
  await sleep(120) // 等缓存刷新

  await emitRaw(h.kernel, privateEvent({ text: '再来一句', messageId: 2, userId: 10002 }))
  await waitFor(() => h.ctx._prompts.length === 2, { label: '好友第 2 条进模型' })

  // 换一个不在好友列表里的陌生人
  await emitRaw(h.kernel, privateEvent({ text: '陌生人', messageId: 3, userId: 10003 }))
  await sleep(80)
  assert.equal(tap.last().stopReason, 'private-friend-gate:not-friend')
  assert.equal(h.ctx._prompts.length, 2, '陌生人不应进模型')
})

test('PRIVATE-GATE 主人永远放行（即使好友列表里没有）', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  h.kernel.onebot.friendList = async () => [{ user_id: MEMBER_QQ }]
  await emitRaw(h.kernel, privateEvent({ text: '主人', messageId: 1, userId: ADMIN_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '主人私聊进模型' })
})

// ── video-read ────────────────────────────────────────────────
test('VIDEO-READ 侧车返回帧 → 塞进 imageParts 和 hint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-'))
  const frames = [writeJpeg(dir, 'f0.jpg'), writeJpeg(dir, 'f6.jpg')]
  const sidecar = await startSidecar({
    ok: true, platform: 'file', durationSec: 12, title: '测试视频',
    frames: [{ path: frames[0], sec: 0 }, { path: frames[1], sec: 6 }],
  })
  t.after(() => sidecar.close())
  const video = path.join(dir, 'clip.mp4')
  fs.writeFileSync(video, 'fake-video-bytes')

  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'video-read': { sidecarUrl: sidecar.url } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, withVideo(groupAtEvent({ text: '看看这个视频', messageId: 11 }), video))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '视频进模型' })

  const ev = tap.last()
  assert.equal(ev.imageParts.length, 2, '两帧都应塞进 imageParts')
  assert.equal(ev.imageParts[0].mediaType, 'image/jpeg')
  assert.ok(ev.hint.join('\n').includes('已抽 2 帧'), 'hint 应告诉模型抽了几帧')
  const prompt = h.ctx._prompts[0]
  assert.equal(prompt.content.filter((c) => c.type === 'image').length, 2, 'prompt 里应有两个图片块')
  assert.equal(sidecar.requests.length, 1, '只应请求一次侧车')
})

test('VIDEO-READ 侧车不在 → 不抛错、如实提示、照常进模型', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-'))
  const video = path.join(dir, 'clip.mp4')
  fs.writeFileSync(video, 'fake-video-bytes')
  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'video-read': { sidecarUrl: 'http://127.0.0.1:1' } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, withVideo(groupAtEvent({ text: '看看这个视频', messageId: 12 }), video))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '侧车挂了也进模型' })
  const ev = tap.last()
  assert.equal(ev.imageParts.length, 0)
  assert.match(ev.hint.join('\n'), /服务没起来|看不了/, '应如实告诉模型没看到')
})

// ── video-link-read ───────────────────────────────────────────
test('VIDEO-LINK 被叫到 + B 站链接 → 帧进 imageParts，且不吞消息', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vlink-'))
  const frames = [writeJpeg(dir, 'l0.jpg'), writeJpeg(dir, 'l8.jpg')]
  const sidecar = await startSidecar({
    ok: true, platform: 'bilibili', durationSec: 30, title: 'B 站测试视频',
    frames: [{ path: frames[0], sec: 0 }, { path: frames[1], sec: 8 }],
  })
  t.after(() => sidecar.close())
  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'video-link-read': { sidecarUrl: sidecar.url } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({
    text: '看看 https://www.bilibili.com/video/BV1xx411c7mD 这个', messageId: 13,
  }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '链接进模型' })
  const ev = tap.last()
  assert.equal(ev.stopped, false, '不应 stop（link-parser 已在 intercept 处理）')
  assert.equal(ev.imageParts.length, 2)
  assert.match(ev.hint.join('\n'), /B 站视频/)
})

test('VIDEO-LINK 无关平台链接 → 完全不请求侧车', async (t) => {
  const sidecar = await startSidecar({ ok: true, frames: [] })
  t.after(() => sidecar.close())
  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'video-link-read': { sidecarUrl: sidecar.url } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '看看 https://example.com/abc 这个', messageId: 14 }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '普通链接照常进模型' })
  assert.equal(sidecar.requests.length, 0, '不支持的平台不应打侧车')
  assert.equal(tap.last().imageParts.length, 0)
})
