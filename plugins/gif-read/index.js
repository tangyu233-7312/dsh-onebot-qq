/**
 * gif-read — 把 QQ 图片段里的 GIF 抽成多帧，按时间顺序交给 DSH。
 *
 * GIF 不是可靠的多模态动画输入：模型通常只会看到容器的一张静态图。
 * 这里复用 video-read 的侧车 /read 接口，插件只负责识别图片、解析文件把手、
 * 读取侧车生成的帧并填入 ev.imageParts；ffmpeg 仍由侧车负责。
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const GIF_EXPANDED = 'gif-read:expanded'
const GIF_CONSUMED = 'gif-read:consumed'

function pick(value, ...names) {
  for (const name of names) {
    const v = value?.[name]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && v > 0) return String(v)
  }
  return ''
}

function gifSegsOf(rawSegments) {
  const out = []
  for (const seg of Array.isArray(rawSegments) ? rawSegments : []) {
    if (String(seg?.type || '') !== 'image') continue
    const d = seg?.data ?? seg ?? {}
    const file = pick(d, 'file', 'filename', 'name')
    const fileId = pick(d, 'file_id', 'fileId', 'fid')
    const url = pick(d, 'url', 'file_url')
    const local = pick(d, 'path', 'file_path', 'local_path')
    const mime = pick(d, 'mime_type', 'mimetype', 'content_type', 'media_type')
    const summary = pick(d, 'summary')
    const looksGif = /image\/gif/i.test(mime)
      || [file, url, local].some((v) => /\.gif(?:[?#].*)?$/i.test(v))
      || /\bgif\b/i.test(summary)
    if (!looksGif) continue
    const keys = Object.entries({ file, fileId, url, local })
      .filter(([, v]) => v).map(([key]) => key)
    if (keys.length) out.push({ file, fileId, url, local, keys })
  }
  return out
}

function mediaTypeOf(buf) {
  if (!buf?.length) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

function shouldLook(ev, cfg) {
  if (!ev?.wake) return false
  if (cfg.onlyWhenAddressed === false) return true
  return ['at', 'quote', 'keyword', 'followup', 'private'].includes(String(ev.wake.kind || ''))
}

export default {
  id: 'gif-read',
  title: '看 GIF 动图',
  order: 43,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '文件与图片', section: '群里的 GIF 动图',
      label: '让模型看 GIF 动图',
      hint: '开：被叫到时把 GIF 抽成多张静态帧，按时间顺序交给 DSH；关：GIF 按普通图片处理。'
        + '需要侧车在跑（控制台「链接解析」页底部可启动）。',
    },
    sidecarUrl: {
      type: 'str', default: 'http://127.0.0.1:3972', group: '文件与图片', section: '群里的 GIF 动图',
      label: '侧车地址',
      hint: '默认 http://127.0.0.1:3972；留空 = 关闭 GIF 抽帧。',
    },
    onlyWhenAddressed: {
      type: 'bool', default: true, group: '文件与图片', section: '群里的 GIF 动图',
      label: '只在叫到它时才看 GIF',
      hint: '开：只有 @ 它、唤醒词、引用它或私聊时才抽帧；关：群里每个 GIF 都可能进入视觉输入。',
    },
    frames: {
      type: 'int', default: 8, min: 2, max: 24, step: 1, group: '文件与图片', section: '群里的 GIF 动图',
      label: '每个 GIF 抽几帧',
      hint: '默认 8 帧，按时长均匀采样；帧数越多，模型越容易看出动作变化，也会增加视觉输入。',
    },
    maxPerMessage: {
      type: 'int', default: 2, min: 1, max: 4, step: 1, group: '文件与图片', section: '群里的 GIF 动图',
      label: '一条消息最多处理几个 GIF',
      hint: '超出数量的 GIF 仍按普通图片处理，避免一条消息产生过多图片。',
    },
    maxSide: {
      type: 'int', default: 1024, min: 256, max: 2048, step: 64, group: '文件与图片', section: '群里的 GIF 动图',
      label: '抽出帧的长边像素',
      hint: '默认 1024；越大越清晰，也越容易增加单张图片体积。',
    },
    maxSeconds: {
      type: 'int', default: 120, unit: '秒', min: 1, max: 600, group: '文件与图片', section: '群里的 GIF 动图',
      label: '最长处理多长的 GIF',
      hint: '超过这个时长就降级为普通图片，避免异常长动画占用侧车。',
    },
    timeoutMs: {
      type: 'int', default: 60, unit: '秒', scale: 1000, min: 5, max: 300,
      group: '文件与图片', section: '群里的 GIF 动图', label: '等待侧车的超时',
      hint: '默认 60 秒；GIF 较大或帧数较多时可适当增加。',
    },
    tellOnFail: {
      type: 'bool', default: true, group: '文件与图片', section: '群里的 GIF 动图',
      label: 'GIF 没读成时说一句',
      hint: '开：明确告诉模型没有拿到后续帧，避免它把首帧当成完整动画；关：静默降级。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const sidecarUrl = () => String(cfg().sidecarUrl || '').trim()
    const timeoutMs = () => {
      const n = Number(cfg().timeoutMs)
      if (!Number.isFinite(n) || n <= 0) return 60_000
      return n >= 1000 ? Math.round(n) : Math.round(n * 1000)
    }

    bot.on('before-turn', async (ev) => {
      if (cfg().enabled === false || !sidecarUrl() || !shouldLook(ev, cfg())) return
      let gifs = gifSegsOf(ev.rawSegments)
      if (!gifs.length && ev.replyToId) {
        try {
          const msg = await bot.onebot.msgById(ev.replyToId)
          gifs = gifSegsOf(msg?.message ?? msg?.raw_message)
        } catch (e) {
          bot.log.debug?.('[看动图] 引用反查失败: ' + String(e?.message || e))
        }
      }
      if (!gifs.length) return

      const max = Math.max(1, Math.min(4, Number(cfg().maxPerMessage) || 2))
      const selected = gifs.slice(0, max)
      if (gifs.length > selected.length) {
        ev.hint.push('[系统提示: 这条消息有 ' + gifs.length + ' 个 GIF，当前最多读取 ' + selected.length + ' 个]')
      }
      for (const seg of selected) await readOneGif(ev, seg)
    })

    async function readOneGif(ev, seg) {
      const req = await mediaRequest(ev, seg)
      if (!req) {
        bot.log.warn?.('[看动图] 拿不到 GIF 文件：keys=[' + (seg.keys || []).join(',') + ']')
        tell(ev, '这张动图我没拿到原文件')
        return
      }
      if (req.localPath && !(await hasGifHeader(req.localPath))) {
        bot.log.info?.('[看动图] 文件扩展名像 GIF，但文件头不是 GIF；按普通图片处理')
        ev.hint.push('[系统提示: 这条图片的文件内容不是 GIF，按普通静态图片理解]')
        return
      }
      const frames = Math.max(2, Math.min(24, Number(cfg().frames) || 8))
      let data
      try {
        const res = await fetch(sidecarUrl().replace(/\/+$/, '') + '/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: req.url, platform: 'file', subtitle: false,
            frames, framesLong: frames, framesSplitSec: 600,
            maxSide: Number(cfg().maxSide) || 1024,
            maxSeconds: Number(cfg().maxSeconds) || 120,
          }),
          signal: AbortSignal.timeout(timeoutMs()),
        })
        data = await res.json()
      } catch (e) {
        bot.log.warn?.('[看动图] 侧车请求失败：' + String(e?.message || e))
        tell(ev, '看动图的服务没连上')
        return
      }
      if (!data?.ok) {
        bot.log.info?.('[看动图] 侧车拒绝：' + String(data?.code || '') + ' ' + String(data?.error || ''))
        tell(ev, data?.code === 'too_long' ? '这张动图太长，暂时看不了' : '这张动图没抽出画面')
        return
      }

      const parts = []
      const seenFrames = new Set()
      const times = []
      for (const [index, frame] of (Array.isArray(data.frames) ? data.frames : []).entries()) {
        try {
          const buf = await fs.promises.readFile(String(frame.path || ''))
          if (!buf.length) continue
          const fingerprint = createHash('sha256').update(buf).digest('hex')
          if (seenFrames.has(fingerprint)) continue
          seenFrames.add(fingerprint)
          parts.push({
            mediaType: mediaTypeOf(buf),
            data: buf.toString('base64'),
            name: 'gif-frame-' + (index + 1) + '@' + (Number(frame.sec) || 0) + 's',
          })
          times.push((Number(frame.sec) || 0) + 's')
        } catch (e) {
          bot.log.warn?.('[看动图] 读帧失败：' + String(e?.message || e))
        }
      }
      if (!parts.length) {
        tell(ev, '这张动图的画面没读出来')
        return
      }
      if (parts.length === 1) {
        ev.hint.push('[系统提示: 这张 GIF 的抽样只发现一个不同画面，按静态图片理解，不要推断动画动作]')
        bot.log.info?.('[看动图] ' + ev.chatKey + ' → 仅一个不同画面，按静态图处理')
        return
      }
      ev.imageParts.push(...parts)
      markConsumed(ev, seg)
      ev.hint.push('[GIF 动图：已按时间顺序抽取 ' + parts.length + ' 个不同画面（' + times.join('/') + '）。这些图片来自同一段动图，可据此描述动作变化；看不清处如实说明]')
      bot.log.info?.('[看动图] ' + ev.chatKey + ' → ' + parts.length + ' 帧')
    }

    function markConsumed(ev, seg) {
      const keys = new Set([seg.file, seg.fileId, seg.url, seg.local].filter(Boolean).map(String))
      const consumed = (ev._scratch[GIF_CONSUMED] ||= new Set())
      for (const key of keys) consumed.add(key)
      ev._scratch[GIF_EXPANDED] = true
    }

    function tell(ev, message) {
      if (cfg().tellOnFail === false) return
      ev.hint.push('[系统提示: ' + message + '（动图后续帧未获取）请如实说明，只能参考已收到的静态图，不要猜动画变化]')
    }

    async function mediaRequest(ev, seg) {
      const locals = [seg.local, seg.file].filter(Boolean)
      for (const candidate of locals) {
        try {
          if (/^[A-Za-z]:[\\/]|^\//.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return { url: candidate, platform: 'file', localPath: candidate }
          }
        } catch { /* 尝试下一个把手 */ }
      }
      for (const id of [seg.fileId, seg.file].filter(Boolean)) {
        if (typeof bot.onebot?.getFile !== 'function') break
        try {
          const info = await bot.onebot.getFile(id)
          const local = String(info?.file || '')
          if (local && fs.existsSync(local) && fs.statSync(local).isFile()) return { url: local, platform: 'file', localPath: local }
          const url = String(info?.url || '')
          if (/^https?:\/\//i.test(url)) return { url, platform: 'qq' }
        } catch (e) { bot.log.debug?.('[看动图] getFile 失败：' + String(e?.message || e)) }
      }
      if (seg.fileId && typeof bot.onebot?.getFileUrl === 'function') {
        try {
          const url = await bot.onebot.getFileUrl(seg.fileId, {
            groupId: ev.isGroup ? ev.groupId : null, userId: ev.sender?.qq ?? null,
          })
          if (/^https?:\/\//i.test(String(url || ''))) return { url, platform: 'qq' }
        } catch (e) { bot.log.debug?.('[看动图] getFileUrl 失败：' + String(e?.message || e)) }
      }
      if (/^https?:\/\//i.test(seg.url || '')) return { url: seg.url, platform: 'qq' }
      return null
    }

    async function hasGifHeader(file) {
      let handle
      try {
        handle = await fs.promises.open(file, 'r')
        const header = Buffer.alloc(6)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        return bytesRead === 6 && /^GIF8[79]a$/.test(header.toString('latin1'))
      } catch { return false } finally { await handle?.close().catch(() => {}) }
    }
  },
}
