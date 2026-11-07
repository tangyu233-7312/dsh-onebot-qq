/**
 * 官方 ComfyUI 原生适配器：POST /prompt → GET /history/<id> → GET /view。
 * 使用者提供 ComfyUI「Save (API Format)」导出的工作流，插件只替换占位符，不猜模型。
 */

import fs from 'node:fs'
import { detectImageMediaType } from '../../kernel/format.js'
import { fetchWithTimeout, fetchJsonOrThrow, saveBuf, LOCAL_SIZE_MAP } from './local-runtime.js'

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const NUMERIC_KEYS = new Set(['width', 'height', 'seed', 'denoise'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 整字段为数值占位符时输出数字；嵌在字符串里时只替换文本。 */
export function substituteWorkflow(template, values) {
  const text = String(template || '').trim()
  if (!text) throw new Error('还没填本机工作流模板：请在 ComfyUI 里把工作流用 Save (API Format) 导出，JSON 贴进控制台「本机工作流模板」，并用 {{prompt}} / {{width}} / {{height}} / {{seed}} 标记要替换的值')
  let parsed
  try { parsed = JSON.parse(text) } catch (e) { throw new Error('本机工作流模板不是合法 JSON：' + e.message) }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('本机工作流模板必须是节点 ID → 节点定义 的 JSON 对象（请用 Save (API Format)，不是普通 Save）')
  const walk = (node) => {
    if (typeof node === 'string') {
      const whole = node.match(/^\{\{\s*([a-zA-Z_]+)\s*\}\}$/)
      if (whole && NUMERIC_KEYS.has(whole[1]) && values[whole[1]] != null) return Number(values[whole[1]])
      return node.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => values[key] == null ? match : String(values[key]))
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, value] of Object.entries(node)) out[key] = walk(value)
      return out
    }
    return node
  }
  return walk(parsed)
}

export async function probeNative(baseUrl, timeoutMs = 2500) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return { ok: false, reason: '没配本地服务地址' }
  try {
    const j = await fetchJsonOrThrow(base + '/system_stats', { method: 'GET' }, timeoutMs, '本地 ComfyUI 探测')
    const dev = (j.devices || [])[0] || {}
    return { ok: true, reason: '', gpu: String(dev.name || ''), vramFreeMB: Number(dev.vram_free) > 0 ? Math.round(Number(dev.vram_free) / 1048576) : 0 }
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 160) } }
}

export async function listNativeModels(baseUrl, timeoutMs = 5000) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return { ok: false, items: [], reason: '没配本地服务地址' }
  const items = []
  for (const [node, field, kind] of [['CheckpointLoaderSimple', 'ckpt_name', 'checkpoint'], ['UNETLoader', 'unet_name', 'unet'], ['VAELoader', 'vae_name', 'vae']]) {
    try {
      const j = await fetchJsonOrThrow(base + '/object_info/' + node, { method: 'GET' }, timeoutMs, '读取本机模型')
      const names = j?.[node]?.input?.required?.[field]
      if (Array.isArray(names?.[0])) for (const name of names[0]) items.push({ id: String(name), label: kind })
    } catch { /* 某类节点不存在，不影响其它模型清单 */ }
  }
  return items.length ? { ok: true, items, reason: '' } : { ok: false, items: [], reason: '读不到模型清单；原生 ComfyUI 的模型和参数都应写在工作流模板里' }
}

export async function nativeGenerate({ prompt, refs = [], size, local, tmp, log, timeoutMs }) {
  const base = String(local.baseUrl || '').replace(/\/+$/, '')
  const requested = String(size || '1024x1024')
  const mapped = LOCAL_SIZE_MAP[requested]
  const [w, h] = requested.split('x')
  const width = mapped?.w || Number(w) || 1024
  const height = mapped?.h || Number(h) || 1024
  const totalMs = Math.max(10000, Number(timeoutMs) || 240000)
  const values = { prompt: String(prompt || ''), negative: '', width, height, seed: Math.floor(Math.random() * 2147483647), denoise: local.denoise }
  if (refs.length) {
    const buf = fs.readFileSync(refs[0])
    const mediaType = detectImageMediaType(buf)
    const name = 'qqbot_' + Date.now() + '.' + (IMG_EXT[mediaType] || 'png')
    const form = new FormData()
    form.append('image', new Blob([buf], { type: mediaType }), name)
    form.append('overwrite', 'true')
    const uploaded = await fetchJsonOrThrow(base + '/upload/image', { method: 'POST', body: form }, Math.min(totalMs, 60000), '本地生图(上传底图)')
    if (uploaded.error) throw new Error('上传底图失败：' + JSON.stringify(uploaded.error))
    values.image = String(uploaded.name || name)
  }
  // 防呆：缺 {{prompt}} = 机器人说什么都不进图，宁可明确报错也不静默出无关的图
  const tplText = String(local.workflow || '')
  if (!/\{\{\s*prompt\s*\}\}/.test(tplText)) {
    throw new Error('工作流模板里没有 {{prompt}} 占位符 —— 请在 ComfyUI 里把正向提示词那个输入框的值改成 {{prompt}}，再重新导出（Save API Format）')
  }
  if (refs.length && !/\{\{\s*image\s*\}\}/.test(tplText)) {
    throw new Error('这是图生图请求，但工作流模板里没有 {{image}} 占位符 —— 请加一个 LoadImage 节点并把它的 image 值改成 {{image}}；不带参考图则不受影响')
  }
  const workflow = substituteWorkflow(local.workflow, values)
  const submitted = await fetchJsonOrThrow(base + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: 'qqbot-' + Date.now() }) }, Math.min(totalMs, 60000), '本地生图(提交)')
  if (submitted.error) throw new Error('提交工作流失败：' + JSON.stringify(submitted.error).slice(0, 240))
  if (submitted.node_errors && Object.keys(submitted.node_errors).length) throw new Error('工作流有节点报错：' + JSON.stringify(submitted.node_errors).slice(0, 240))
  const id = String(submitted.prompt_id || '')
  if (!id) throw new Error('提交成功但没拿到 prompt_id')
  const started = Date.now()
  while (Date.now() - started < totalMs) {
    await sleep(1500)
    const history = await fetchJsonOrThrow(base + '/history/' + encodeURIComponent(id), { method: 'GET' }, 15000, '本地生图(进度)')
    const entry = history?.[id]
    if (!entry) continue
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI 执行出错：' + JSON.stringify(entry.status.messages || entry.status).slice(0, 300))
    const images = Object.values(entry.outputs || {}).flatMap((node) => node.images || [])
    if (!images.length) {
      if (entry.status?.completed === true) throw new Error('任务结束但没出图：请确认工作流含 SaveImage 等图像输出节点')
      continue
    }
    const image = images[0]
    const query = new URLSearchParams({ filename: String(image.filename), subfolder: String(image.subfolder || ''), type: String(image.type || 'output') })
    const response = await fetchWithTimeout(base + '/view?' + query, { method: 'GET' }, Math.max(1000, totalMs - (Date.now() - started)), '本地生图(取图)')
    if (!response.ok) throw new Error('取图 HTTP ' + response.status)
    const buf = Buffer.from(await response.arrayBuffer())
    if (!buf.length) throw new Error('取到的图片为空')
    if (log) log.info('[生图] 原生 ComfyUI 出图完成（' + width + 'x' + height + '，' + ((Date.now() - started) / 1000).toFixed(1) + 's）')
    return saveBuf(buf, tmp)
  }
  throw new Error('本地生图超时（' + Math.round(totalMs / 1000) + 's）')
}
