/**
 * test/audit-media-plugins.test.js — 生图 / 头像（imagegen）与链接/卡片解析（link-parser）。
 *
 * 迁移自旧 `audit-media-plugins.test.js`：保留行为级断言；删除现网 config 继承、旧 admin 写值、
 * 旧 sidecar 细节用例。上游 HTTP 用临时替换的 globalThis.fetch 打桩（不外网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractUrls, stripUrls, extractCardUrl, fmtDuration } from '../plugins/link-parser/index.js'
import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

// 1x1 PNG（最小合法图片字节）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

function installFetchMock(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    return handler(String(url), opts, calls.length)
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

async function bootImagegen(t, { imagegen = {}, credentials = null, llm = undefined } = {}) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      ...(credentials ? { credentials } : {}),
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        imagegen: { enabled: true, cooldownMs: 60, ackCooldownMs: 30, ...imagegen },
      },
    },
  })
  // 一次性文本补全桩（真内核从宿主 ctx.llm 取；夹具里直接换掉内核能力对象）
  if (llm) h.kernel.textCompletion = llm
  t.after(() => h.dispose())
  return h
}

/** 造一个假的 llm 能力：记录调用、返回固定/自定义文本。 */
function fakeLlm(impl) {
  const calls = []
  return {
    calls,
    available: () => true,
    route: async () => ({ provider: 'p', model: 'm', source: 'test' }),
    complete: async (opts) => {
      calls.push(opts)
      if (typeof impl === 'function') return impl(opts, calls.length)
      return { ok: true, text: impl || '优化后的提示词', reason: '', provider: 'p', model: 'm', ms: 1 }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// link-parser：纯函数（无网络）
// ─────────────────────────────────────────────────────────────────────────────

test('link-parser extractUrls：最多取 2 条、去掉中文标点/尾部半角符号、平台识别', () => {
  const text = '看这个 https://www.bilibili.com/video/BV1xx411c7mD，还有 https://v.douyin.com/abc123/。第三个 https://example.invalid/x'
  const urls = extractUrls(text, 2)
  assert.equal(urls.length, 2, '最多 2 条')
  assert.ok(urls[0].includes('bilibili.com'), '中文逗号不进链接')
  assert.ok(urls[1].includes('douyin.com'))
  assert.equal(urls[1].endsWith('。'), false, '尾部中文标点削掉')
  const again = extractUrls('同一条 https://b23.tv/abc https://b23.tv/abc', 5)
  assert.equal(again.length, 1, '去重')
})

test('link-parser stripUrls：剥链接后剩正文（判断"在跟我说话"用）', () => {
  assert.equal(stripUrls('看看这个 https://b23.tv/abc 吧').trim(), '看看这个  吧'.replace(/\s+/g, ' ').trim())
  assert.ok(stripUrls('https://b23.tv/abc').trim() === '', '纯链接剥完为空')
})

test('link-parser extractCardUrl：detail_1.qqdocurl / miniapp / news 挖真链；图片字段跳过', () => {
  const segData = (json) => ({ data: JSON.stringify(json) }) // OneBot json 段的 seg.data 形态
  assert.equal(extractCardUrl(segData({ meta: { detail_1: { qqdocurl: 'https://b23.tv/abc' } } })), 'https://b23.tv/abc')
  assert.equal(extractCardUrl(segData({ meta: { miniapp: { jumpUrl: 'https://example.invalid/mini' } } })), 'https://example.invalid/mini')
  assert.equal(extractCardUrl(segData({ meta: { news: { jumpUrl: 'https://example.invalid/news' } } })), 'https://example.invalid/news')
  assert.equal(extractCardUrl(segData({ meta: { detail_1: { icon: 'https://example.invalid/icon.png' } } })), null)
})

test('link-parser fmtDuration：分:秒 格式（向下取整）', () => {
  assert.equal(fmtDuration(59), '0:59')
  assert.equal(fmtDuration(65), '1:05')
  assert.equal(fmtDuration(319.9), '5:19')
  assert.equal(fmtDuration(3725), '62:05')
})

test('link-parser 默认关闭：带链接的消息不抢答，照常交给模型', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, 'persona-voice': { splitReplyEnabled: false } },
    },
  })
  t.after(() => h.dispose())
  await emitRaw(h.kernel, groupAtEvent({ text: '看看这个 https://b23.tv/abc', messageId: 201 }))
  const prompt = await h.ctx._prompts?.[0]
  assert.ok(prompt, '链接消息应照常进模型（插件默认关）')
  assert.ok(prompt.content[0].text.includes('b23.tv'), '链接留在正文里')
})

// ─────────────────────────────────────────────────────────────────────────────
// link-parser：真发（侧车用 fetch 打桩）
// 2026-10-27 SnowLuma 真机踩坑：视频必须是消息里唯一的 segment，
// 「文字 + [CQ:video]」或「两个视频一条」都会被协议端直接拒绝 → 视频必须拆条发。
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO_MEDIA = { kind: 'video', path: '/tmp/qqbot-linkparser-demo.mp4', size: 1024 * 1024, duration: 61 }
const IMAGE_MEDIA = { kind: 'image', path: '/tmp/qqbot-linkparser-demo.png', size: 1024 }

async function bootLinkParser(t, parsed) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ },
        'persona-voice': { splitReplyEnabled: false },
        'link-parser': { enabled: true, parserUrl: 'http://sidecar.invalid', platforms: ['bilibili', 'douyin'] },
      },
    },
  })
  t.after(() => h.dispose())
  installFetchMock(t, (url) => (String(url).endsWith('/parse')
    ? jsonResponse({
      ok: true, platform: 'bilibili', platformName: 'B站', title: '测试视频', author: '测试UP',
      elapsedMs: 12, skipped: [], media: [], ...parsed,
    })
    : jsonResponse({}, 404)))
  return h
}

const linkEvent = (text = '看 https://b23.tv/abc', messageId = 301) => groupAtEvent({ text, at: false, messageId })

test('link-parser 视频：视频单独一条、说明文字另起一条（视频不能和文字混发）', async (t) => {
  const h = await bootLinkParser(t, { media: [VIDEO_MEDIA] })
  await emitRaw(h.kernel, linkEvent())
  const media = await waitFor(() => h.sent.find((s) => s.kind === 'media'), { label: '视频出站' })
  assert.match(media.wire, /^\[CQ:video,file=/, '视频消息必须是纯 CQ 视频（唯一 segment）')
  assert.equal(media.wire.includes('B站'), false, '视频消息里不能混说明文字（SnowLuma 会整条拒绝）')
  const msg = await waitFor(() => h.sent.find((s) => s.kind === 'msg'), { label: '说明文字出站' })
  assert.ok(msg.wire.includes('测试视频'), '说明文字仍要发（标题）')
  assert.ok(msg.wire.includes('B站'), '说明文字带平台名')
  assert.equal(h.sent.filter((s) => s.kind === 'media').length, 1, '只有一个视频就只发一条视频')
})

test('link-parser 多视频：每个视频各一条（同条放两个视频也会被拒）', async (t) => {
  const h = await bootLinkParser(t, {
    media: [{ ...VIDEO_MEDIA, path: '/tmp/qqbot-linkparser-a.mp4' }, { ...VIDEO_MEDIA, path: '/tmp/qqbot-linkparser-b.mp4', duration: 30 }],
  })
  await emitRaw(h.kernel, linkEvent())
  await waitFor(() => h.sent.filter((s) => s.kind === 'media').length >= 2, { label: '两个视频出站' })
  const media = h.sent.filter((s) => s.kind === 'media')
  assert.equal(media.length, 2, '两个视频 = 两条消息')
  for (const m of media) {
    assert.equal(m.wire.match(/\[CQ:video/g).length, 1, '每条只含一个视频')
    assert.equal(m.wire.includes('测试视频'), false, '视频消息不混文字')
  }
  await waitFor(() => h.sent.some((s) => s.kind === 'msg'), { label: '说明文字出站' })
})

test('link-parser 纯图片：保持旧行为（说明 + 图片同条，不拆）', async (t) => {
  const h = await bootLinkParser(t, { media: [IMAGE_MEDIA] })
  await emitRaw(h.kernel, linkEvent())
  const media = await waitFor(() => h.sent.find((s) => s.kind === 'media'), { label: '图片出站' })
  assert.ok(media.wire.includes('[CQ:image,file='), '图片在媒体消息里')
  assert.ok(media.wire.includes('测试视频'), '说明和图片同条（图片没有唯一 segment 限制）')
  assert.equal(h.sent.some((s) => s.kind === 'msg'), false, '纯图片不该再拆一条说明')
})

test('link-parser 视频发送全失败：不发说明文字、按普通消息降级（不吞消息）', async (t) => {
  const h = await bootLinkParser(t, { media: [VIDEO_MEDIA] })
  h.kernel.onebot.sendMedia = async () => { throw new Error('mock send fail') }
  await emitRaw(h.kernel, groupAtEvent({ text: '看这个 https://b23.tv/abc 怎么样', messageId: 305 }))
  const prompt = await waitFor(() => h.ctx._prompts?.[0], { label: '降级放行进模型' })
  assert.ok(prompt.content[0].text.includes('b23.tv'), '媒体没发出时链接仍交给模型')
  assert.equal(h.sent.some((s) => s.kind === 'msg'), false, '媒体都没发出去就不该单独发说明（免得只留一句标题）')
})

// ─────────────────────────────────────────────────────────────────────────────
// imagegen
// ─────────────────────────────────────────────────────────────────────────────

test('imagegen 总开关关闭：工具明确报"未启用"，不发上游请求', async (t) => {
  const h = await bootImagegen(t, { imagegen: { enabled: false } })
  const calls = installFetchMock(t, () => jsonResponse({ data: [] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  assert.ok(tool, '应注册 generate_image')
  await assert.rejects(() => tool.execute({ prompt: '一只猫' }), /未启用/)
  assert.equal(calls.length, 0, '关闭时不打上游')
})

test('imagegen 无凭据：给出可操作的中文错误（环境变量/credentials）', async (t) => {
  const h = await bootImagegen(t) // baseConfig 的 credentials.gptImage.apiKey 为空
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await assert.rejects(() => tool.execute({ prompt: '一只猫' }), /QQ_IMAGEGEN|凭据/)
})

test('imagegen 参考图白名单：白名单外的本地图在请求上游前被拒', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-ref-')), 'ref.png')
  fs.writeFileSync(outside, PNG)
  await assert.rejects(() => tool.execute({ prompt: '改图', image: outside }), /白名单/)
  assert.equal(calls.length, 0, '白名单外参考图不打上游')
})

test('imagegen 成功生成 → 发到会话；冷却内第二次返回 blocked（不生成、不排队、不重试）', async (t) => {
  const h = await bootImagegen(t, {
    imagegen: { cooldownMs: 60, ackCooldownMs: 30 },
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r1 = await tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` })
  assert.equal(r1.ok, true)
  assert.equal(calls.length, 1, '只打一次上游（成功不重试）')
  assert.ok(h.sent.some((s) => s.kind === 'media'), '生成后通过唯一媒体出站口发出')

  const r2 = await tool.execute({ prompt: '再来一只', target: `group:${GROUP_ID}` })
  assert.equal(r2.ok, true)
  assert.equal(r2.blocked, true, '冷却中返回 blocked')
  assert.ok(r2.retryAfterMs > 0)
  assert.ok(String(r2.suggestedText || '').length > 0, '给模型一句可用的回话参考')
  assert.equal(calls.length, 1, '冷却中不再打上游（不花钱）')
})

test('imagegen 上游失败：零重试 + 插件自己如实代答一句（不吞错）', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  let calls = 0
  installFetchMock(t, () => {
    calls += 1
    return jsonResponse({ error: { message: 'boom' } }, 500)
  })
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await assert.rejects(() => tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` }), /不要重试|失败/)
  assert.equal(calls, 1, '失败零重试（只请求一次）')
  assert.ok(h.sent.some((s) => s.kind === 'msg'), '插件自己发了一句失败说明（不哑火）')
})

test('imagegen openai-chat 协议：chat/completions 返回 base64 图片 → 落盘并发出', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, (url) => {
    assert.ok(url.endsWith('/chat/completions'), `chat 协议应请求 /chat/completions，实际 ${url}`)
    return jsonResponse({
      choices: [{
        message: {
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }],
        },
      }],
    })
  })
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'generate')
  assert.equal(r.protocol, 'openai-chat', '返回体应带当前协议')
  assert.ok(fs.existsSync(r.file), '生成的图片应落盘')
  assert.ok(fs.statSync(r.file).size > 0)
  assert.equal(calls.length, 1, '只请求一次 chat 上游')
  const body = JSON.parse(String(calls[0].opts.body))
  assert.equal(body.model, 'gpt-image-2')
  assert.equal(body.stream, false)
  assert.equal(body.messages[0].role, 'user')
  assert.ok(JSON.stringify(body.messages[0].content).includes('一只猫'), '提示词进 messages')
  assert.ok(h.sent.some((s) => s.kind === 'media'), '生成后经唯一媒体出站口发出')
})

test('imagegen openai-chat 协议：markdown/URL 形态 → 下载后落盘', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  let imageDownloads = 0
  installFetchMock(t, (url) => {
    if (url.endsWith('/chat/completions')) {
      return jsonResponse({ choices: [{ message: { content: '画好了：![cat](https://example.invalid/files/gen.png)' } }] })
    }
    if (url === 'https://example.invalid/files/gen.png') {
      imageDownloads += 1
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return jsonResponse({ error: 'unexpected url' }, 404)
  })
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '一只狗', target: `group:${GROUP_ID}` })
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(r.file), 'URL 形态应下载并落盘')
  assert.equal(imageDownloads, 1)
})

test('imagegen openai-chat 协议：参考图以 data URL 放进 messages；上游失败零重试且错误带协议名', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  const ref = path.join(refDir, 'ref.png')
  fs.writeFileSync(ref, PNG)

  let calls = 0
  installFetchMock(t, (url) => {
    calls += 1
    assert.ok(url.endsWith('/chat/completions'))
    return jsonResponse({ error: { message: 'chat upstream boom' } }, 500)
  })
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await assert.rejects(() => tool.execute({ prompt: '改成水彩', image: ref, target: `group:${GROUP_ID}` }), /openai-chat/)
  assert.equal(calls, 1, '失败只请求一次（不重试）')
  assert.ok(h.sent.some((s) => s.kind === 'msg'), '插件自己如实代答一句失败说明')
})

test('imagegen openai-chat 参考图请求体：messages 里带 data URL 的 image_url', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  const ref = path.join(refDir, 'ref.png')
  fs.writeFileSync(ref, PNG)
  let capturedBody = null
  installFetchMock(t, (url, opts) => {
    capturedBody = JSON.parse(String(opts.body))
    return jsonResponse({ choices: [{ message: { images: [{ url: `data:image/png;base64,${PNG_B64}` }] } }] })
  })
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '改成水彩', image: ref, target: `group:${GROUP_ID}` })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'edit')
  const content = capturedBody.messages[0].content
  assert.ok(Array.isArray(content), 'content 应是数组')
  assert.equal(content[0].type, 'text')
  const imgPart = content.find((c) => c.type === 'image_url')
  assert.ok(imgPart, '参考图应以 image_url 形式发送')
  assert.match(imgPart.image_url.url, /^data:image\/png;base64,/, '参考图用 data URL')
})

test('avatar：QQ 头像下载 → 缓存复用（第二次不再下载）', async (t) => {
  const h = await bootImagegen(t)
  let calls = 0
  installFetchMock(t, () => {
    calls += 1
    return new Response(Buffer.concat([PNG, Buffer.alloc(200, 1)]), { status: 200, headers: { 'content-type': 'image/png' } })
  })
  const tool = h.ctx._registeredTools.get('mcp__qq__avatar')
  assert.ok(tool, '应注册 avatar')
  const r1 = await tool.execute({ target: `group:${GROUP_ID}`, user: '50001' })
  assert.ok(String(r1).length > 0)
  assert.equal(calls, 1)
  await tool.execute({ target: `group:${GROUP_ID}`, user: '50001' })
  assert.equal(calls, 1, '缓存命中不重复下载')
})

// ─────────────────────────────────────────────────────────────────────────────
// 额外请求字段（extraBody，JSON）：不同平台字段不同，由用户在控制台自己补
// ─────────────────────────────────────────────────────────────────────────────

test('imagegen 额外字段：留空时请求体与旧版一致（不多发任何字段）', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` })
  const body = JSON.parse(String(calls[0].opts.body))
  assert.deepEqual(Object.keys(body).sort(), ['model', 'n', 'prompt', 'size'], `不应有多余字段：${Object.keys(body)}`)
  assert.equal('watermark' in body, false)
})

test('imagegen 额外字段：{"watermark": false} → 文生图 JSON 带上（sensenova 关水印）', async (t) => {
  const h = await bootImagegen(t, {
    imagegen: { extraBody: '{"watermark": false}' },
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` })
  const gen = calls.find((c) => c.url.endsWith('/images/generations'))
  assert.equal(JSON.parse(String(gen.opts.body)).watermark, false)
})

test('imagegen 额外字段：任意平台字段（quality/style/数字）都能并进 JSON 并覆盖默认值', async (t) => {
  const h = await bootImagegen(t, {
    imagegen: { extraBody: '{"quality": "hd", "style": "vivid", "n": 2}' },
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` })
  const body = JSON.parse(String(calls[0].opts.body))
  assert.equal(body.quality, 'hd')
  assert.equal(body.style, 'vivid')
  assert.equal(body.n, 2, '用户写的值应覆盖默认 n=1')
})

test('imagegen 额外字段：图生图逐项追加到 multipart（布尔转字符串）', async (t) => {
  const h = await bootImagegen(t, {
    imagegen: { extraBody: '{"watermark": false, "quality": "hd"}' },
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  const ref = path.join(refDir, 'ref.png')
  fs.writeFileSync(ref, PNG)
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await tool.execute({ prompt: '改成黑猫', image: ref, target: `group:${GROUP_ID}` })
  const edit = calls.find((c) => c.url.endsWith('/images/edits'))
  assert.ok(edit, '应请求 /images/edits')
  assert.equal(edit.opts.body.get('watermark'), 'false', '布尔应转成字符串 false')
  assert.equal(edit.opts.body.get('quality'), 'hd')
  assert.equal(edit.opts.body.get('model'), 'gpt-image-2')
})

test('imagegen 额外字段：JSON 写错 → 立刻报清晰错误、不打上游、不占冷却', async (t) => {
  const h = await bootImagegen(t, {
    imagegen: { extraBody: '{watermark: false' }, // 不是合法 JSON
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  await assert.rejects(() => tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` }), /额外请求字段.*JSON/)
  assert.equal(calls.length, 0, 'JSON 错不能打上游')
  assert.equal(h.sent.some((s) => s.kind === 'msg'), false, '配置错不代答（不该先说「在画了」）')

  // 修好配置后立刻能画（说明没占冷却）
  h.raw.pluginConfig.imagegen.extraBody = '{"watermark": false}'
  await h.kernel.applyRuntimeConfig(h.raw)
  const r = await tool.execute({ prompt: '一只猫', target: `group:${GROUP_ID}` })
  assert.equal(r.ok, true)
})

test('imagegen 额外字段：控制台「生图」页有该项（text 多行框，归 imagegen）', async (t) => {
  const h = await bootImagegen(t)
  const { collectSchema } = await import('../admin/schema.js')
  const schema = collectSchema(h.kernel, h.raw)
  const c = (schema.controls || []).find((x) => x.key === 'imagegen.extraBody')
  assert.ok(c, '控制台应有 imagegen.extraBody')
  assert.equal(c.plugin, 'imagegen')
  assert.equal(c.group, '生图')
  assert.equal(c.type, 'text', '应是多行文本域')
  assert.equal(c.value, '')
})

// ─────────────────────────────────────────────────────────────────────────────
// 图片清单：不再每轮塞正文（2026-10-26 主人要求），改成按需工具 list_images
// ─────────────────────────────────────────────────────────────────────────────

test('不再把参考图清单塞进每轮正文（改成按需 list_images）', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  fs.writeFileSync(path.join(refDir, '大肥鱼_三视图.jpg'), PNG)
  installFetchMock(t, () => jsonResponse({ data: [] }))
  await emitRaw(h.kernel, groupAtEvent({ text: '换成deepseek的大肥鱼', messageId: 401 }))
  const prompt = await waitFor(() => h.ctx._prompts?.[0], { label: '普通轮进模型' })
  const text = prompt.content[0].text
  assert.equal(text.includes('[参考图库'), false, '正文里不应再出现参考图库清单')
  assert.equal(text.includes('大肥鱼_三视图.jpg'), false, '正文里不应出现文件名')
})

test('list_images：列出参考图目录的图片（含尺寸），路径可直接喂给 generate_image', async (t) => {
  const h = await bootImagegen(t, {})
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  fs.writeFileSync(path.join(refDir, '大肥鱼_三视图.jpg'), PNG)
  fs.writeFileSync(path.join(refDir, 'notes.txt'), '不是图片')
  fs.mkdirSync(path.join(refDir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(refDir, 'sub', '另一张.png'), PNG)
  const tool = h.ctx._registeredTools.get('mcp__qq__list_images')
  assert.ok(tool, 'list_images 应注册')
  const r = await tool.execute({ where: 'refs' })
  assert.equal(r.ok, true)
  const names = r.items.map((x) => x.name).sort()
  assert.deepEqual(names, ['另一张.png', '大肥鱼_三视图.jpg'].sort(), '应列出图片、忽略非图片、含子目录')
  const one = r.items.find((x) => x.name === '大肥鱼_三视图.jpg')
  assert.equal(one.size, '1x1', '应带尺寸')
  assert.ok(one.path.startsWith(h.dataDir), '应给绝对路径')
  assert.equal(one.where, 'refs')
})

test('list_images：limit 截断 + 非法 where / 越界 dir 报错', async (t) => {
  const h = await bootImagegen(t, {})
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(refDir, `图${i}.png`), PNG)
  const tool = h.ctx._registeredTools.get('mcp__qq__list_images')
  const r = await tool.execute({ where: 'refs', limit: 2 })
  assert.equal(r.items.length, 2)
  assert.equal(r.truncated, true)
  await assert.rejects(() => tool.execute({ where: 'nope' }), /where 只能是/)
  await assert.rejects(() => tool.execute({ where: 'refs', dir: '../../etc' }), /不能跳出/)
})

test('list_images：默认 all 覆盖 workbooks/workspace/uploads/avatars 里存在的目录', async (t) => {
  const h = await bootImagegen(t, {})
  fs.mkdirSync(path.join(h.dataDir, 'qq-refs'), { recursive: true })
  fs.mkdirSync(path.join(h.dataDir, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(h.dataDir, 'qq-refs', 'a.jpg'), PNG)
  fs.writeFileSync(path.join(h.dataDir, 'workspace', 'b.png'), PNG)
  const tool = h.ctx._registeredTools.get('mcp__qq__list_images')
  const r = await tool.execute({})
  const byName = Object.fromEntries(r.items.map((x) => [x.name, x.where]))
  assert.equal(byName['a.jpg'], 'refs')
  assert.equal(byName['b.png'], 'workspace')
})

test('imagegen 参考图：名字选错 → 报错里回图库清单（判断交给模型，不做代码匹配）', async (t) => {
  const h = await bootImagegen(t, {
    credentials: { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
  })
  const refDir = path.join(h.dataDir, 'qq-refs')
  fs.mkdirSync(refDir, { recursive: true })
  fs.writeFileSync(path.join(refDir, '大肥鱼_三视图.jpg'), PNG)
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  // 只写"大肥鱼"（不带扩展名）→ 不做模糊匹配，报错并指向 list_images
  await assert.rejects(
    () => tool.execute({ prompt: '改成黑猫', image: '大肥鱼', target: `group:${GROUP_ID}` }),
    (e) => /找不到图片「大肥鱼」/.test(e.message) && /list_images/.test(e.message),
  )
  assert.equal(calls.length, 0, '选错名字时不应发请求')
  // 同一轮换成正确文件名就能过（选错不占冷却、不消耗次数）
  const ok = await tool.execute({ prompt: '改成黑猫', image: '大肥鱼_三视图.jpg', target: `group:${GROUP_ID}` })
  assert.equal(ok.ok, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 生图提示词优化（2026-11-06）：先让大模型把需求改写成生图提示词，再交给生图模型
// 纪律：一次生图最多调一次优化；失败/超时一律退回原文，绝不让这次生图失败、也不重试。
// ─────────────────────────────────────────────────────────────────────────────

const IMG_CREDS = { gptImage: { baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } }
const upstreamPrompt = (calls) => JSON.parse(calls[calls.length - 1].opts.body).prompt

test('生图优化：开启时用优化后的提示词打生图上游，并回传原文/优化结果', async (t) => {
  const llm = fakeLlm('一只圆滚滚的蓝色大肥鱼，面馆木桌，暖黄顶灯，近景侧光，厚涂质感')
  const h = await bootImagegen(t, { credentials: IMG_CREDS, llm })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '画只胖鱼吃拉面', target: `group:${GROUP_ID}` })

  assert.equal(r.ok, true)
  assert.equal(llm.calls.length, 1, '每次生图只优化一次')
  assert.ok(llm.calls[0].prompt.includes('画只胖鱼吃拉面'), '优化请求里带上用户原话')
  assert.ok(llm.calls[0].prompt.includes('生图提示词'), '默认优化提示词是"把需求改写成生图提示词"')
  assert.equal(upstreamPrompt(calls), '一只圆滚滚的蓝色大肥鱼，面馆木桌，暖黄顶灯，近景侧光，厚涂质感', '生图模型收到的是优化后的提示词')
  assert.equal(r.promptOptimized, true)
  assert.equal(r.promptOriginal, '画只胖鱼吃拉面', '回执里保留原文，便于排查')
})

test('生图优化：优化失败（空回复/超时/没模型）→ 退回原文照画，不报错、不重试', async (t) => {
  const llm = fakeLlm(() => ({ ok: false, text: '', reason: '模型没有返回任何文字' }))
  const h = await bootImagegen(t, { credentials: IMG_CREDS, llm })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '画只胖鱼吃拉面', target: `group:${GROUP_ID}` })

  assert.equal(r.ok, true, '优化失败不影响生图')
  assert.equal(llm.calls.length, 1, '失败也不重试')
  assert.equal(calls.length, 1, '生图照常打一次上游')
  assert.equal(upstreamPrompt(calls), '画只胖鱼吃拉面', '上游收到的是原文')
  assert.equal(r.promptOptimized, false)
  assert.ok(r.promptOptimizeNote, '回执里说明为什么没用优化结果')
})

test('生图优化：关掉开关 → 完全不打模型，直接原文生图（旧行为）', async (t) => {
  const llm = fakeLlm('不该被用到')
  const h = await bootImagegen(t, { credentials: IMG_CREDS, llm, imagegen: { optimizePrompt: false } })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '画只胖鱼吃拉面', target: `group:${GROUP_ID}` })

  assert.equal(r.ok, true)
  assert.equal(llm.calls.length, 0, '关掉后一次都不调')
  assert.equal(upstreamPrompt(calls), '画只胖鱼吃拉面')
  assert.equal(r.promptOptimized, false)
})

test('生图优化：输出清洗 —— 去掉"好的，这是…："、引号、代码围栏，只留提示词本体', async (t) => {
  const llm = fakeLlm('好的，这是优化后的提示词：\n**"一只胖胖的蓝色大肥鱼，坐在面馆木桌前吃拉面，暖黄灯光，近景特写"**')
  const h = await bootImagegen(t, { credentials: IMG_CREDS, llm })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const r = await tool.execute({ prompt: '画只胖鱼吃拉面', target: `group:${GROUP_ID}` })

  assert.equal(r.ok, true)
  assert.equal(upstreamPrompt(calls), '一只胖胖的蓝色大肥鱼，坐在面馆木桌前吃拉面，暖黄灯光，近景特写')
  assert.equal(r.promptOptimized, true)
})

test('refine_image_prompt：只返回优化后的文字，不画图、不占冷却', async (t) => {
  const llm = fakeLlm('橘猫趴在窗台上晒太阳，午后逆光，浅景深，水彩质感')
  const h = await bootImagegen(t, { credentials: IMG_CREDS, llm })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const tool = h.ctx._registeredTools.get('mcp__qq__refine_image_prompt')
  assert.ok(tool, '应注册 refine_image_prompt')
  const r = await tool.execute({ prompt: '画只猫晒太阳' })

  assert.equal(r.ok, true)
  assert.equal(r.prompt, '橘猫趴在窗台上晒太阳，午后逆光，浅景深，水彩质感')
  assert.equal(calls.length, 0, '不调生图上游')
  // 没占冷却：紧接着生成一张不会被 blocked
  const gen = h.ctx._registeredTools.get('mcp__qq__generate_image')
  const g = await gen.execute({ prompt: '画只猫', target: `group:${GROUP_ID}` })
  assert.equal(g.ok, true)
  assert.notEqual(g.blocked, true, 'refine 不占生图冷却')
})

test('控制台「生图」页：三个优化配置项都在，且提示词框首次显示完整可编辑默认值', async (t) => {
  const h = await bootImagegen(t, { credentials: IMG_CREDS })
  const schema = h.kernel.adminSchema()   // 控制表本体（RPC 端点是 {ok,value} 信封）
  assert.ok(Array.isArray(schema.controls) && schema.controls.length > 0, '控制表应有控件')
  const byKey = (k) => (schema.controls || []).find((c) => c.key === k)
  const opt = byKey('imagegen.optimizePrompt')
  assert.ok(opt, '应有「先让大模型优化提示词」开关')
  assert.equal(opt.type, 'bool')
  assert.equal(opt.value, true, '默认开')
  const txt = byKey('imagegen.promptOptimizeText')
  assert.ok(txt, '应有可编辑的优化提示词框')
  assert.equal(txt.type, 'text')
  assert.equal(txt.plugin, 'imagegen')
  assert.ok(String(txt.value).includes('生图提示词'), '首次就把默认提示词显示在框里')
  assert.equal(txt.value, txt.helperDefault, '当前值=内置默认（没改过）')
  assert.ok(byKey('imagegen.promptOptimizeTimeoutMs'), '应有优化超时')
})

test('控制台「试优化一条提示词」：动作注册在生图页，调用只走文本模型、不画图', async (t) => {
  const llm = fakeLlm('一只圆滚滚的蓝色大肥鱼，面馆暖黄灯光，近景，厚涂')
  const h = await bootImagegen(t, { credentials: IMG_CREDS, llm })
  const calls = installFetchMock(t, () => jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
  const schema = h.kernel.adminSchema()
  const act = (schema.actions || []).find((a) => a.id === 'imagegen-optimize-preview')
  assert.ok(act, '应有 🧪 试优化动作')
  assert.equal(act.group, '生图')
  assert.equal(act.onGroup, true, '按钮长在生图页底部')
  assert.ok(Array.isArray(act.prompt.fields) && act.prompt.fields.length >= 2, '弹窗要有"需求 + 提示词"两个字段')
  assert.equal(act.prompt.fields[1].valueFrom, 'imagegen.promptOptimizeText', '提示词字段默认带出控制台里那份')

  const r = await h.kernel.handleAdminRpc('action', { id: 'imagegen-optimize-preview', text: '画只胖鱼吃拉面' })
  assert.equal(r.ok, true)
  assert.equal(r.prompt, '一只圆滚滚的蓝色大肥鱼，面馆暖黄灯光，近景，厚涂')
  assert.equal(r.original, '画只胖鱼吃拉面')
  assert.equal(calls.length, 0, '试优化不调生图上游')
  assert.equal(llm.calls.length, 1)

  // 空需求 → 明确报错，不调用模型
  const bad = await h.kernel.handleAdminRpc('action', { id: 'imagegen-optimize-preview', text: '   ' })
  assert.equal(bad.ok, false)
  assert.equal(llm.calls.length, 1, '空需求不打模型')
})
