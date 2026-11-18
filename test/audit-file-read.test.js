/**
 * audit-file-read — 「模型能真的打开收到的文件」这条链
 *
 * 现场（2026-11-18）：文件落盘成功了（`QQ 文件已保存: .../新项目.zip`），
 * 但模型回「本鱼这儿没有打开文件的工具，只有消息和图片能进眼睛」。
 * 原因不是收不到，是 QQ 线 preset 把 tool-fs / tool-bash 全禁了（纯聊天安全面），
 * 于是路径给了也读不了。
 *
 * 这里钉住新插件 file-read：
 *   ① 文本文件能按行读出来（带行号）；
 *   ② .zip 能列目录（不依赖系统 unzip，包内不许 spawn）；
 *   ③ .zip 里的文本条目能直接读出来；
 *   ④ 白名单外的路径一律拒（不许拿它当任意文件读取器）；
 *   ⑤ 入站文件的提示里要告诉模型「用 read_file 读」，否则它不知道有这个工具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { bootKernel, emitRaw, tapInbound } from './helpers.mjs'

const MEMBER_QQ = 10002
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 手搓一个最小 zip（store 方式，不压缩），只为验证解析路径 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, content } of entries) {
    // name 可以是 Buffer（模拟 Windows 打出来的 GBK 文件名），也可以是普通字符串（UTF-8）
    const nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = zlib.crc32 ? zlib.crc32(data) : 0
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)      // version needed
    local.writeUInt16LE(0, 6)       // flags（故意不带 UTF-8 位，跟 Windows 打包一致）
    local.writeUInt16LE(0, 8)       // method = store
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)     // flags
    central.writeUInt16LE(0, 10)    // method = store
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

async function bootWithUpload(t) {
  const h = await bootKernel()
  t.after(() => h.dispose())
  const dir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(dir, { recursive: true })
  const tool = h.ctx._registeredTools.get('mcp__qq__read_file')
  assert.ok(tool, '应注册 read_file 工具')
  return { h, dir, tool }
}test('FILE-R1 文本文件按行读出来，带行号', async (t) => {
  const { dir, tool } = await bootWithUpload(t)
  const f = path.join(dir, '20260101000000-测试.md')
  fs.writeFileSync(f, '# 标题\n第一段\n第二段\n')
  const r = await tool.execute({ path: f })
  assert.equal(r.ok, true)
  assert.equal(r.totalLines, 4, '三行内容 + 末尾空行')
  assert.match(r.content, /1\| # 标题/)
  assert.match(r.content, /2\| 第一段/)
})

test('FILE-R2 offset / limit 只读指定行段', async (t) => {
  const { dir, tool } = await bootWithUpload(t)
  const f = path.join(dir, 'a.txt')
  fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'))
  const r = await tool.execute({ path: f, offset: 3, limit: 2 })
  assert.equal(r.from, 3)
  assert.equal(r.to, 4)
  assert.match(r.content, /3\| L3/)
  assert.match(r.content, /4\| L4/)
  assert.doesNotMatch(r.content, /L5/)
})

test('FILE-R3 .zip 能列目录，且标出哪些是文本', async (t) => {
  const { dir, tool } = await bootWithUpload(t)
  const f = path.join(dir, 'pkg.zip')
  fs.writeFileSync(f, makeZip([
    { name: 'a.md', content: '# A\n内容A\n' },
    { name: 'img.png', content: 'not-really-png' },
  ]))
  const r = await tool.execute({ path: f, zip: true })
  assert.equal(r.kind, 'zip')
  assert.equal(r.count, 2)
  assert.ok(r.entries.some((e) => /a\.md/.test(e)), '要列出 a.md')
  assert.ok(r.entries.some((e) => /img\.png.*二进制/.test(e)), '二进制的要标出来')
})

test('FILE-R4 .zip 里的文本条目能直接读出内容（不 spawn unzip）', async (t) => {
  const { dir, tool } = await bootWithUpload(t)
  const f = path.join(dir, 'pkg2.zip')
  fs.writeFileSync(f, makeZip([{ name: 'docs/readme.md', content: '# 说明\n这是压缩包里的内容\n' }]))
  const r = await tool.execute({ path: f, entry: 'docs/readme.md' })
  assert.equal(r.ok, true)
  assert.match(r.content, /这是压缩包里的内容/)
})

test('FILE-R5 白名单外的路径一律拒', async (t) => {
  const { h, tool } = await bootWithUpload(t)
  const outside = path.join(h.dataDir, '..', 'secret.txt')
  fs.writeFileSync(outside, '不该被读到')
  t.after(() => { try { fs.unlinkSync(outside) } catch { /* ignore */ } })
  await assert.rejects(() => tool.execute({ path: outside }), /白名单|只能读|收件箱/)
})

test('FILE-R5a 只认收件箱：数据目录里的配置/凭据/会话一律读不到', async (t) => {
  const { h, tool } = await bootWithUpload(t)
  // 数据目录里真实存在的敏感文件：config.json 里就有 API Key
  const cfgFile = path.join(h.dataDir, 'config.json')
  assert.ok(fs.existsSync(cfgFile), '夹具应有 config.json')
  await assert.rejects(() => tool.execute({ path: cfgFile }), /只能读收件箱/)
  // ../ 穿越也不行
  await assert.rejects(() => tool.execute({ path: '../config.json' }), /只能读收件箱|不在收件箱/)
  // 收件箱里的软链指向外面 → realpath 之后必须拒
  const link = path.join(h.dataDir, 'qq_uploads', 'sneaky.txt')
  try {
    fs.symlinkSync(cfgFile, link)
    await assert.rejects(() => tool.execute({ path: link }), /只能读收件箱/)
  } catch (e) {
    if (e.code !== 'EPERM') throw e // Windows 无权限建软链时跳过这一条
  }
})

test('FILE-R5b Windows 打包的 GBK 文件名不乱码（真机 新项目.zip 就是这种）', async (t) => {
  const { dir, tool } = await bootWithUpload(t)
  const f = path.join(dir, 'gbk.zip')
  // 「docs/00-目录.md」的 GBK 字节（目录 = C4BF C2BC），且不带 UTF-8 标志位
  const gbkName = Buffer.concat([
    Buffer.from('docs/00-', 'latin1'),
    Buffer.from([0xc4, 0xbf, 0xc2, 0xbc]), // 目录（GBK）
    Buffer.from('.md', 'latin1'),
  ])
  fs.writeFileSync(f, makeZip([{ name: gbkName, content: '# 目录\n内容\n' }]))
  const r = await tool.execute({ path: f, zip: true })
  assert.ok(r.entries.some((e) => e.includes('docs/00-目录.md')), `名字应解成中文，实际：${r.entries.join('|')}`)
  assert.ok(!r.entries.some((e) => e.includes('\uFFFD')), '不该出现替换符乱码')
  // 按解出来的名字还能读回内容
  const r2 = await tool.execute({ path: f, entry: 'docs/00-目录.md' })
  assert.equal(r2.ok, true)
  assert.match(r2.content, /内容/)
})

test('FILE-R6 入站文件的提示里要告诉模型用 read_file 读', async (t) => {
  const h = await bootKernel()
  t.after(() => h.dispose())
  const dir = path.join(h.dataDir, 'qq_uploads')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(h.dataDir, 'src.md')
  fs.writeFileSync(src, '# hi\n')
  h.kernel.onebot.getFileUrl = async () => ''
  h.kernel.onebot.getFile = async () => ({ file: src })
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'private',
    user_id: MEMBER_QQ,
    message_id: 81,
    sender: { user_id: MEMBER_QQ, nickname: '网友' },
    message: [{ type: 'file', data: { file: '题目.md', file_id: 'fid-r6', file_size: '5' } }],
  })
  await sleep(150)
  const hint = (tap.last()?.hint || []).join('\n')
  assert.match(hint, /\[文件: /, '要有落盘路径')
  assert.match(hint, /read_file/, '要告诉模型怎么读（不然它会说"没有打开文件的工具"）')
})
