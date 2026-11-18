/**
 * audit-file-fetch — 「群里/私聊直接发的文件收不到」这一条链
 *
 * 现场（2026-11-18）：私聊发 10 个 .md + 1 个 .zip，机器人回"收不到 url"，日志是
 *   `WARN QQ 文件接收失败 (?): 文件段没有可取的地址（缺 url）` ×11
 *
 * 真机 file 段长这样（NapCat，直接查 get_friend_msg_history 拿到的原文）：
 *   {file:'新项目.zip', file_id:'86faf94b...', file_size:'2404350'}
 * —— **文件名在 `file` 里、没有 `name`、没有 `url`**。
 * 而 get_file 回的是**容器内**路径 `/app/.config/QQ/NapCat/temp/新项目.zip`，
 * 宿主机 fs.existsSync 永远 false；它的 url 也是同一个容器路径。
 *
 * 所以这里钉四件事：
 *   ① 事件里 file 段的名字/句柄要按真机字段取出来（不再是 `(?)`）；
 *   ② 带扩展名的 `file` 不能被当成 file_id 去问协议端；
 *   ③ file_id → getFileUrl 换 http 直链这条路要能真的把字节拿回来；
 *   ④ 容器路径读不到时，不许再用"缺 url"这种把人带偏的话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { extractText } from '../kernel/format.js'
import { bootKernel, emitRaw, tapInbound } from './helpers.mjs'

const MEMBER_QQ = 10002
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个只回固定文件的本地 http 服务，充当"协议端给的下载直链" */
async function serveBytes(content) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(content)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/f`, close: () => new Promise((r) => server.close(r)) }
}

// ── ① 真机 file 段解析 ────────────────────────────────────────────
test('FILE-A 真机 file 段：名字取 file、句柄取 file_id、size 是字符串也认', () => {
  const { files } = extractText([
    { type: 'file', data: { file: '新项目.zip', file_id: 'abc_123', file_size: '2404350' } },
  ])
  assert.equal(files.length, 1)
  assert.equal(files[0].name, '新项目.zip', '名字不能是空（原来取 d.name 永远取不到，日志一片 (?)）')
  assert.equal(files[0].fileId, 'abc_123')
  assert.equal(files[0].size, 2404350, 'file_size 是字符串也要转成数字')
})

test('FILE-B 带扩展名的 file 不当 file_id；没有 file_id 时句柄为空但名字还在', () => {
  const { files } = extractText([
    { type: 'file', data: { file: 'H-团队对抗.md' } },
  ])
  assert.equal(files[0].name, 'H-团队对抗.md')
  assert.equal(files[0].fileId, '', '不能拿文件名当 file_id 去问协议端')
})

test('FILE-C 句柄放在 file 里（没有扩展名）时仍认作 file_id', () => {
  const { files } = extractText([
    { type: 'file', data: { file: 'abc-1234-def', file_id: '' } },
  ])
  assert.equal(files[0].fileId, 'abc-1234-def')
})

// ── ②/③/④ 取字节的三条路 ──────────────────────────────────────────
async function bootWithFile(text, bytes) {
  const h = await bootKernel()
  const link = await serveBytes(Buffer.from(bytes))
  // 模拟真机：get_file 回**容器内**路径（宿主机不存在），url 也不是 http
  h.kernel.onebot.getFile = async () => ({ file: '/app/.config/QQ/NapCat/temp/' + text, url: '/app/.config/QQ/NapCat/temp/' + text })
  h.kernel.onebot.getFileUrl = async () => link.url
  return { h, link }
}

test('FILE-D 容器路径读不到时，靠 getFileUrl 换直链把文件拿回来并落盘', async (t) => {
  const content = '# H-团队对抗\n这是内容\n'
  const { h, link } = await bootWithFile('x.md', content)
  t.after(() => { h.dispose(); return link.close() })
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })

  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'private',
    user_id: MEMBER_QQ,
    message_id: 71,
    sender: { user_id: MEMBER_QQ, nickname: '网友' },
    message: [{ type: 'file', data: { file: 'H-团队对抗.md', file_id: 'fid-1', file_size: String(content.length) } }],
  })
  await sleep(150)

  const saved = fs.readdirSync(uploadDir)
  assert.equal(saved.length, 1, `应落盘 1 个文件，实际：${saved.join(',')}`)
  assert.match(saved[0], /-H-团队对抗\.md$/, '文件名要带原文件名（原来日志是 (?)）')
  assert.equal(fs.readFileSync(path.join(uploadDir, saved[0]), 'utf8'), content, '内容要一字不差')
})

test('FILE-E 直链下载失败时，如实说"直链取不到"，不再说"缺 url"', async (t) => {
  const h = await bootKernel()
  t.after(() => h.dispose())
  h.kernel.onebot.getFile = async () => ({ file: '/app/.config/QQ/NapCat/temp/a.md' })
  h.kernel.onebot.getFileUrl = async () => 'http://127.0.0.1:1/expired' // 必然连不上
  const tap = tapInbound(h.kernel)
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })

  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'private',
    user_id: MEMBER_QQ,
    message_id: 72,
    sender: { user_id: MEMBER_QQ, nickname: '网友' },
    message: [{ type: 'file', data: { file: 'a.md', file_id: 'fid-2', file_size: '10' } }],
  })
  await sleep(200)
  assert.equal(fs.readdirSync(uploadDir).length, 0, '没下到就不许落盘空文件')

  const ev = tap.last()
  assert.ok(ev, '应捕获到入站事件')
  const hint = (ev.hint || []).join('\n')
  assert.match(hint, /\[文件: a\.md 保存失败/, '失败原因要写进 hint（模型能看到文件没到）')
  assert.match(hint, /直链|签名|过期|连不上|fetch failed|ECONNREFUSED/i, '要说明是直链下不来，别只说"缺 url"')
  assert.doesNotMatch(hint, /缺 url/, '容器路径读不到时不该再归因成"缺 url"（会把人带偏）')
})

test('FILE-F 只有文件名、既没 file_id 也没 url：落不了盘，hint 说清缺什么', async (t) => {
  const h = await bootKernel()
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  const uploadDir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'private',
    user_id: MEMBER_QQ,
    message_id: 73,
    sender: { user_id: MEMBER_QQ, nickname: '网友' },
    message: [{ type: 'file', data: { file: 'only-name.md' } }],
  })
  await sleep(120)
  assert.equal(fs.readdirSync(uploadDir).length, 0)
  const hint = (tap.last()?.hint || []).join('\n')
  assert.match(hint, /only-name\.md 保存失败/, '名字要出现在 hint 里（原来这里是 (?)）')
})
