import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { bootKernel, emitRaw, groupAtEvent, privateEvent, waitFor, GROUP_ID } from './helpers.mjs'

const STILL = Buffer.from('47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b', 'hex')
const GIF = Buffer.concat([STILL.subarray(0, -1), STILL.subarray(19)])
const OTHER_GIF = Buffer.from(GIF); OTHER_GIF[15] = 55
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=', 'base64')

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-image-'))
  const frames = [0, 1, 2, 3, 4, 5].map((i) => {
    const file = path.join(dir, 'frame' + i + '.jpg')
    fs.writeFileSync(file, Buffer.from([255, 216, 255, i])); return file
  })
  const calls = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.end(req.url.includes('other') ? OTHER_GIF : req.url.includes('still') ? PNG : GIF); return }
    let text = ''
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => {
      const body = JSON.parse(text); calls.push(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, frames: frames.slice(0, body.frames).map((file, i) => ({ path: file, sec: i / 10 })) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { url: 'http://127.0.0.1:' + server.address().port, calls }
}

test('群聊与主动接话均读取历史GIF并保留发送者，同图多发送者去重，受2媒体/4画面预算约束', async (t) => {
  const f = await fixture(t)
  for (const proactive of [false, true]) {
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const h = await bootKernel({ config: {
      pacing: { merge: { enabled: false }, reply: { enabled: proactive, silenceEnabled: true,
        quietEnabled: false, groups: [GROUP_ID],
        minGapMs: 60000, coldSilenceMs: 60000 } },
      pluginConfig: { 'gif-read': { sidecarUrl: f.url, frames: 6 } },
    } })
    const requests = f.calls.length
    const msg = (id, who, qq, url) => ({ message_id: id, time: Math.floor(now / 1000) - 90 + id - 600,
      sender: { user_id: qq, nickname: who }, message: [{ type: 'image', data: { url } }] })
    h.kernel.onebot.groupHistory = async () => [
      msg(601, '甲', 10002, f.url + '/still'), msg(602, '乙', 10003, f.url + '/same'),
      msg(603, '丙', 10004, f.url + '/same-again'), msg(604, '丁', 10005, f.url + '/other'),
    ]
    try {
      if (proactive) {
        h.kernel.state.get('group:' + GROUP_ID).lastInboundAt = now - 120000
        h.kernel.pacing.tickNow(); now += 11 * 60000
        h.kernel.pacing.tickNow()
      } else await emitRaw(h.kernel, groupAtEvent({ text: '看看大家在发什么', messageId: 700 }))
      await new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          if (h.ctx._prompts.length === 1) { clearInterval(poll); clearTimeout(timer); resolve() }
        }, 10)
        const timer = setTimeout(() => { clearInterval(poll); reject(Error('等候模型输入超时')) }, 4000)
      })
      const content = h.ctx._prompts[0].content, text = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      assert.equal(content.filter((p) => p.type === 'image').length, 4)
      for (const who of ['乙', '丙', '丁']) assert.ok(text.includes(who), '发送者应保留：' + who)
      assert.match(text, /消息60[234]/); assert.match(text, /同一文件/)
      assert.match(text, /已附 2 个不同媒体\/4 张画面/)
      assert.ok(f.calls.slice(requests).every((call) => call.frames === 2), '历史使用2帧，不继承当前图6帧')
      if (!proactive) {
        await emitRaw(h.kernel, groupAtEvent({ text: '再看看这几个表情', messageId: 701 }))
        assert.equal(h.ctx._prompts[1].content.filter((p) => p.type === 'image').length, 4, '文字水位推进后历史图仍重新附上')
        assert.equal(f.calls.length - requests, 2, '跨轮复用两个GIF的抽帧')
      }
    } finally { h.dispose(); t.mock.restoreAll() }
  }
})

test('当前图片优先，关闭历史开关不附图；未唤醒群图后台缓存，群聊和私聊重发仍送模型', async (t) => {
  const f = await fixture(t)
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } }, pluginConfig: {
    'gif-read': { sidecarUrl: f.url, frames: 6 }, 'media-context': { turnMaxFrames: 6 },
  } } })
  t.after(() => h.dispose())
  const image = { type: 'image', data: { url: f.url + '/same', summary: '[动画表情]' } }
  const background = groupAtEvent({ text: '', at: false, messageId: 800 }); background.message.push(image)
  await emitRaw(h.kernel, background)
  await h.kernel.shared.mediaCache.idle()
  assert.equal(h.ctx._prompts.length, 0, '缓存不调用模型')
  h.kernel.onebot.groupHistory = async () => [{ message_id: 800, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10001, nickname: '原发送者' }, message: [image] }]
  const current = groupAtEvent({ text: '看我现在发的动图', messageId: 801 }); current.message.push(image)
  await emitRaw(h.kernel, current)
  assert.equal(h.ctx._prompts[0].content.filter((p) => p.type === 'image').length, 6, '当前GIF6帧优先，历史不能挤占')
  assert.match(h.ctx._prompts[0].content[0].text, /未附历史原图/)
  const next = structuredClone(h.kernel.runtime)
  next.pluginConfig['media-context'] = { ...next.pluginConfig['media-context'], groupEnabled: false }
  await h.kernel.applyRuntimeConfig(next)
  await emitRaw(h.kernel, groupAtEvent({ text: '这次不看历史', messageId: 802 }))
  assert.equal(h.ctx._prompts[1].content.filter((p) => p.type === 'image').length, 0)
  for (const id of [803, 804]) {
    const raw = privateEvent({ text: '再发一遍', messageId: id }); raw.message.push(image)
    await emitRaw(h.kernel, raw)
    assert.equal(h.ctx._prompts.at(-1).content.filter((p) => p.type === 'image').length, 6)
  }
  assert.equal(f.calls.length, 1, '同一完整文件的预处理结果可复用，私聊仍须有自己的原图关联并每轮送6张图')
})
