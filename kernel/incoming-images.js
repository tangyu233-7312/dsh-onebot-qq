/** 普通图、被引图与转发图共享下载/缩图路径；转发图另外限制数量、字节及耗时。 */
import fs from 'node:fs'
import { detectImageMediaType } from './format.js'
import { appendForwardStatus } from './forward-context.js'

export const FORWARD_IMAGE_LIMITS = Object.freeze({
  perImageBytes: 10 * 1024 * 1024, totalBytes: 24 * 1024 * 1024,
  downloadMs: 15000, totalMs: 45000,
})

function failure(reason) { return Object.assign(new Error(reason), { imageReason: reason }) }
function knownImage(buf) {
  return (buf[0] === 0xff && buf[1] === 0xd8)
    || (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG')
    || /^GIF8[79]a/.test(buf.slice(0, 6).toString())
    || (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP')
}

async function download(url, maxBytes, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) })
  if (!response.ok) { await response.body?.cancel?.(); throw failure('图片下载失败') }
  const length = Number(response.headers?.get?.('content-length'))
  if (length > maxBytes) { await response.body?.cancel?.(); throw failure('图片体积超限') }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > maxBytes) throw failure('图片体积超限')
    return buf
  }
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) { await reader.cancel(); throw failure('图片体积超限') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, bytes)
}

export async function loadIncomingImages(ev, { onebot, tmp, shrink = async (buf) => buf, log = console,
  limits = {}, fetchImpl = fetch, now = Date.now } = {}) {
  const cap = { ...FORWARD_IMAGE_LIMITS, ...limits }
  const deadline = now() + cap.totalMs
  let usedBytes = 0
  const hasEarlierParts = ev.imageParts.length > 0
  for (const im of ev.images || []) {
    const forwarded = !!im._forwardLabels?.length
    // 保持视频插件原有优先级，但它已有帧时，不能再把本轮转发图一起跳过。
    if (hasEarlierParts && !forwarded) continue
    if (forwarded && now() >= deadline) { im._forwardResult = { reason: '图片处理超时' }; continue }
    const maxBytes = forwarded ? Math.min(cap.perImageBytes, cap.totalBytes - usedBytes) : Infinity
    if (maxBytes <= 0) { im._forwardResult = { reason: '图片总量超限' }; continue }
    const file = String(im.file || ''), url = String(im.url || '')
    let buf = null, reason = '图片下载失败或文件不可用'
    const attempt = async (fn) => {
      if (buf) return
      if (forwarded && now() >= deadline) { reason = '图片处理超时'; return }
      try {
        const value = await fn()
        if (value?.length) {
          if (value.length > maxBytes) throw failure('图片体积超限')
          if (forwarded && !knownImage(value)) throw failure('下载内容不是有效图片')
          buf = value
        }
      } catch (error) {
        if (error.imageReason) reason = error.imageReason
        else if (/Timeout|Abort/.test(error.name || '')) reason = '图片下载超时'
      }
    }
    const readLocal = (local) => {
      if (!local || !fs.existsSync(local) || !fs.statSync(local).isFile()) return null
      if (fs.statSync(local).size > maxBytes) throw failure('图片体积超限')
      return fs.readFileSync(local)
    }
    const readUrl = (link) => /^https?:\/\//.test(String(link || ''))
      ? download(link, maxBytes, forwarded ? Math.min(cap.downloadMs, deadline - now()) : cap.downloadMs, fetchImpl)
      : null
    try {
      await attempt(() => readLocal(file))
      if (!buf && file && typeof onebot.getFile === 'function') {
        let info = null
        await attempt(async () => { info = await onebot.getFile(file); return readLocal(info?.file) })
        if (info?.url) await attempt(() => readUrl(info.url))
        if (!buf && typeof onebot.getFileUrl === 'function') {
          await attempt(async () => {
            const link = await onebot.getFileUrl(file, {
              groupId: ev.isGroup ? ev.groupId : null, userId: ev.sender?.qq ?? null,
            })
            return readUrl(link)
          })
        }
      }
      if (!buf) await attempt(() => readUrl(url))
      if (!buf?.length) throw failure(reason)
      // 按下载原始字节计预算，压缩后变小也不返还；不重复下载大图绕过总量上限。
      if (forwarded) usedBytes += buf.length
      buf = await shrink(buf)
      if (forwarded && now() >= deadline) throw failure('图片处理超时')
      const mediaType = detectImageMediaType(buf)
      const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/gif' ? 'gif' : mediaType === 'image/webp' ? 'webp' : 'jpg'
      const tmpPath = tmp.file('incoming', `.${ext}`)
      fs.writeFileSync(tmpPath, buf)
      const name = forwarded ? `qq-forward:${im._forwardLabels.join('、')}` : 'qq-image'
      ev.imageParts.push({ mediaType, data: buf.toString('base64'), name })
      ev.imagePaths.push(tmpPath)
      if (forwarded) im._forwardResult = { ok: true }
    } catch (error) {
      if (forwarded) im._forwardResult = { reason: error.imageReason || '图片处理失败' }
      // 不把带签名的图片直链或文件内容写入日志。
      log.warn?.(`入站图片处理失败：${error.imageReason || '图片处理失败'}`)
    }
  }
  appendForwardStatus(ev)
}
