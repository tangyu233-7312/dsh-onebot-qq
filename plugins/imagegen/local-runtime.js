/** 本地出图共用的小型运行时：图片落盘、带超时的 HTTP、JSON 解析。 */
import fs from 'node:fs'
import path from 'node:path'
import { detectImageMediaType } from '../../kernel/format.js'
import { resolveTmpDir } from '../../platform/paths.js'

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
let tmpSeq = 0
export const LOCAL_SIZE_MAP = { '1536x1024': { w: 1216, h: 832 }, '1024x1536': { w: 832, h: 1216 }, '512x512': { w: 768, h: 768 } }

export function saveBuf(buf, tmp) {
  const ext = IMG_EXT[detectImageMediaType(buf)] || 'png'
  const file = tmp?.file ? tmp.file('imagegen', '.' + ext) : path.join(resolveTmpDir('imagegen'), 'qq_imagegen_' + Date.now() + '_' + (++tmpSeq) + '.' + ext)
  fs.writeFileSync(file, buf)
  return file
}

export async function fetchWithTimeout(url, opts, timeoutMs, label) {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 240000)) }) }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(label + '超时 (' + Math.round((Number(timeoutMs) || 240000) / 1000) + 's)')
    throw e
  }
}

export async function fetchJsonOrThrow(url, opts, timeoutMs, label) {
  const res = await fetchWithTimeout(url, opts, timeoutMs, label)
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    let detail = raw
    try { detail = JSON.parse(raw)?.error?.message || JSON.parse(raw)?.error || raw } catch { /* 保留文本 */ }
    throw new Error(label + ' HTTP ' + res.status + (detail ? '：' + String(typeof detail === 'object' ? JSON.stringify(detail) : detail).slice(0, 200) : ''))
  }
  try { return await res.json() } catch { throw new Error(label + ' 响应不是 JSON（服务没起或地址填错？）') }
}
