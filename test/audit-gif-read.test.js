import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { bootKernel, emitRaw, groupAtEvent, tapInbound, waitFor } from './helpers.mjs'

const mergeOff = { pacing: { merge: { enabled: false } }, outbound: { groupContextCount: 0 } }
const STILL_GIF = Buffer.from('47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b', 'hex')
const ANIMATED_GIF = Buffer.concat([STILL_GIF.subarray(0, -1), STILL_GIF.subarray(19)])

async function startSidecar(reply) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(typeof reply === 'function' ? reply(requests.at(-1)) : reply))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function writeBytes(dir, name, bytes) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.from(bytes))
  return file
}

function imageEvent(images, text = '看看这个 GIF') {
  const ev = groupAtEvent({ text, messageId: 6201 })
  ev.message.push(...images.map((file) => ({ type: 'image', data: { file } })))
  return ev
}

test('GIF 抽帧按控制台帧数送入 DSH，并保留同消息的普通图片', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gif-read-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const gif = writeBytes(dir, 'motion.jpg', ANIMATED_GIF)
  const png = writeBytes(dir, 'still.png', [0x89, 0x50, 0x4e, 0x47, 0x00])
  const frames = [0, 1, 2].map((n) => writeBytes(dir, 'frame-' + n + '.jpg', [0xff, 0xd8, 0xff, n]))
  const sidecar = await startSidecar(() => ({
    ok: true,
    durationSec: 3,
    frames: frames.map((file, index) => ({ path: file, sec: index })),
  }))
  t.after(() => sidecar.close())

  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'gif-read': { sidecarUrl: sidecar.url, frames: 3 } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  // 复现 QQ 把真实 GIF 命名为 .jpg；识别不能依赖消息文件名。
  await emitRaw(h.kernel, imageEvent([gif, png]))
  await waitFor(() => h.ctx._prompts.length === 1, { label: 'GIF 进入 DSH' })

  const ev = tap.last()
  assert.equal(sidecar.requests.length, 1)
  assert.equal(sidecar.requests[0].url, '/read')
  assert.deepEqual(fs.readFileSync(sidecar.requests[0].body.url), ANIMATED_GIF)
  assert.equal(sidecar.requests[0].body.frames, 3, '控制台帧数设置应传给侧车')
  assert.equal(sidecar.requests[0].body.framesLong, 3, '短长时长分支均使用 GIF 设置帧数')
  assert.equal(ev.imageParts.length, 4, '三张 GIF 帧加一张普通图片')
  assert.deepEqual(ev.imageParts.slice(0, 3).map((image) => image.name), [
    'gif-1-frame-1@0s', 'gif-1-frame-2@1s', 'gif-1-frame-3@2s',
  ])
  assert.equal(ev.imageParts[3].mediaType, 'image/png')
  assert.match(ev.hint.join('\n'), /按时间顺序抽取 3 个不同画面/)
  assert.equal(h.ctx._prompts[0].content.filter((part) => part.type === 'image').length, 4)

  // CDN URL 没有扩展名也能识别，且一次下载即可提供原图和抽帧。
  const sourceServer = http.createServer((_req, res) => { downloads++; res.end(ANIMATED_GIF) })
  let downloads = 0
  await new Promise((resolve) => sourceServer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => sourceServer.close(resolve)))
  const sourceUrl = 'http://127.0.0.1:' + sourceServer.address().port + '/download?appid=fixture'
  for (const reply of [false, true]) {
    const raw = groupAtEvent({ text: '看看动作变化', messageId: reply ? 6203 : 6202, replyTo: reply ? 6199 : null })
    const image = { type: 'image', data: { file: 'fixture.jpg', url: sourceUrl, summary: '[动画表情]', sub_type: 1 } }
    if (reply) h.kernel.onebot.msgById = async () => ({ message: [image] })
    else raw.message.push(image)
    await emitRaw(h.kernel, raw)
    await waitFor(() => h.ctx._prompts.length === (reply ? 3 : 2))
    assert.equal(tap.last().imageParts.length, 3, '直发和被引 GIF 均应展开')
    assert.deepEqual(fs.readFileSync(tap.last().imagePaths[0]), ANIMATED_GIF, '图生图仍保留原始 GIF')
  }
  assert.equal(downloads, 1, '重复引用的原件从24小时缓存读取')
  assert.equal(sidecar.requests.length, 1, '相同帧数画质的同图跨轮复用抽帧，但每轮仍提交图片')
})

test('GIF 抽帧失败时保留原始图片并提示模型不能推断动作', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gif-fail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const gif = writeBytes(dir, 'motion.gif', ANIMATED_GIF)
  const sidecar = await startSidecar({ ok: false, code: 'no_frames', error: 'fixture' })
  t.after(() => sidecar.close())

  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'gif-read': { sidecarUrl: sidecar.url } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, imageEvent([gif]))
  await waitFor(() => h.ctx._prompts.length === 1, { label: 'GIF 失败后照常进入 DSH' })

  const ev = tap.last()
  assert.equal(sidecar.requests.length, 1)
  assert.equal(ev.imageParts.length, 1)
  assert.equal(ev.imageParts[0].mediaType, 'image/gif')
  assert.match(ev.hint.join('\n'), /动图后续帧未获取/)
})

test('静态图片不抽帧；静态 GIF 的重复抽样会退回单张原图', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gif-still-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const png = writeBytes(dir, 'still.png', [0x89, 0x50, 0x4e, 0x47, 0x00])
  const mislabeled = writeBytes(dir, 'wrong.gif', [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])
  const gif = writeBytes(dir, 'still.gif', STILL_GIF)
  const animated = writeBytes(dir, 'same-frames.gif', ANIMATED_GIF)
  const jpeg = writeBytes(dir, 'still.jpg', [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
  const oneFrame = writeBytes(dir, 'same-frame.jpg', [0xff, 0xd8, 0xff, 0x01])
  const sidecar = await startSidecar({
    ok: true,
    frames: [0, 1, 2].map((sec) => ({ path: oneFrame, sec })),
  })
  t.after(() => sidecar.close())

  const h = await bootKernel({
    config: { ...mergeOff, pluginConfig: { 'gif-read': { sidecarUrl: sidecar.url, frames: 3 } } },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)

  let count = 0
  for (const [file, type] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [mislabeled, 'image/png'], [gif, 'image/gif']]) {
    const raw = imageEvent([file], '看看图片' + count)
    raw.message_id = 6300 + count
    await emitRaw(h.kernel, raw)
    count += 1
    await waitFor(() => h.ctx._prompts.length === count, { label: '静态图片进入 DSH' })
    assert.equal(sidecar.requests.length, 0, '静态图片和单帧 GIF 均不请求侧车')
    assert.equal(tap.last().imageParts.length, 1)
    assert.equal(tap.last().imageParts[0].mediaType, type)
  }
  await emitRaw(h.kernel, imageEvent([animated], '检查重复采样'))
  await waitFor(() => h.ctx._prompts.length === 5, { label: '重复采样按静态 GIF 处理' })
  assert.equal(sidecar.requests.length, 1)
  assert.equal(tap.last().imageParts.length, 1, '相同抽样帧不能重复送入模型')
  assert.equal(tap.last().imageParts[0].mediaType, 'image/gif', '静态 GIF 保留原始图片')
  assert.match(tap.last().hint.join('\n'), /只发现一个不同画面/)
})
