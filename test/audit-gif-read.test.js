import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { bootKernel, emitRaw, groupAtEvent, tapInbound, waitFor } from './helpers.mjs'

const mergeOff = { pacing: { merge: { enabled: false } } }

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
  const gif = writeBytes(dir, 'motion.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
  const png = writeBytes(dir, 'still.png', [0x89, 0x50, 0x4e, 0x47, 0x00])
  const frames = [0, 1, 2].map((n) => writeBytes(dir, 'frame-' + n + '.jpg', [0xff, 0xd8, 0xff, n]))
  const sidecar = await startSidecar(({ body }) => ({
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
  await emitRaw(h.kernel, imageEvent([gif, png]))
  await waitFor(() => h.ctx._prompts.length === 1, { label: 'GIF 进入 DSH' })

  const ev = tap.last()
  assert.equal(sidecar.requests.length, 1)
  assert.equal(sidecar.requests[0].url, '/read')
  assert.equal(sidecar.requests[0].body.url, gif)
  assert.equal(sidecar.requests[0].body.frames, 3, '控制台帧数设置应传给侧车')
  assert.equal(sidecar.requests[0].body.framesLong, 3, '短长时长分支均使用 GIF 设置帧数')
  assert.equal(ev.imageParts.length, 4, '三张 GIF 帧加一张普通图片')
  assert.deepEqual(ev.imageParts.slice(0, 3).map((image) => image.name), [
    'gif-frame-1@0s', 'gif-frame-2@1s', 'gif-frame-3@2s',
  ])
  assert.equal(ev.imageParts[3].mediaType, 'image/png')
  assert.match(ev.hint.join('\n'), /按时间顺序抽取 3 个不同画面/)
  assert.equal(h.ctx._prompts[0].content.filter((part) => part.type === 'image').length, 4)
})

test('GIF 抽帧失败时保留原始图片并提示模型不能推断动作', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gif-fail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const gif = writeBytes(dir, 'motion.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
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
  const gif = writeBytes(dir, 'still.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
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

  await emitRaw(h.kernel, imageEvent([png], '看看这张图'))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '普通图片进入 DSH' })
  assert.equal(sidecar.requests.length, 0, 'PNG 不应进入 GIF 抽帧')
  assert.equal(tap.last().imageParts.length, 1)
  assert.equal(tap.last().imageParts[0].mediaType, 'image/png')

  await emitRaw(h.kernel, imageEvent([mislabeled], '看看这个文件'))
  await waitFor(() => h.ctx._prompts.length === 2, { label: '错误扩展名图片进入 DSH' })
  assert.equal(sidecar.requests.length, 0, '内容不是 GIF 的文件不能进入抽帧')
  assert.equal(tap.last().imageParts[0].mediaType, 'image/png')

  await emitRaw(h.kernel, imageEvent([gif], '看看这张 GIF'))
  await waitFor(() => h.ctx._prompts.length === 3, { label: '静态 GIF 进入 DSH' })
  assert.equal(sidecar.requests.length, 1)
  assert.equal(tap.last().imageParts.length, 1, '相同抽样帧不能重复送入模型')
  assert.equal(tap.last().imageParts[0].mediaType, 'image/gif', '静态 GIF 保留原始图片')
  assert.match(tap.last().hint.join('\n'), /只发现一个不同画面/)
})
