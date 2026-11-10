/**
 * link-parser — 链接解析子插件（id: link-parser，order: 70）
 *
 * 干什么：群里/私聊出现受支持的分享链接（B 站）时，插件**自己**调一个**外部解析侧车**
 * （默认 `http://127.0.0.1:3972/parse`，用户自备；本包不附带）把视频/图集直接发出去，
 * 不占模型一步、不烧 token。**默认关闭**：没起侧车时开了只会白等超时后降级。
 *
 * 下面这些纯函数是反复调 bug 才对的，**不要重新发明**：
 *   · `URL_RE` / `extractUrls` / `stripUrls`：中文/全角符号不进链接（否则「看 https://b23.tv/x，真的」
 *     会把「，真的」吃进链接），链接尾部半角标点要削掉。
 *   · `CARD_PATHS` / `firstUrl` / `extractCardUrl`：QQ 的分享卡片是一条 `json` 段、正文一个字没有，
 *     真链接藏在 `meta.detail_1.qqdocurl` 之类字段里（不挖卡片就只能看到"[卡片]"）。
 *
 * 三条铁律：
 *   ① **失败一律降级放行**：侧车没起 / 没匹配 / 超时 / 超 maxBytes → 只记日志，消息照旧交给模型。
 *      绝不因为解析器坏了让机器人变哑巴（宁可少发一个视频，也不能吞掉一句话）。
 *   ② **命令永远优先**：`/` 开头的一律不抢（命令插件处理；就算它没处理也不能被我们吞掉）。
 *   ③ **视频单独一条发**：QQ 客户端把视频当独立消息，文字/多视频混在一条会被协议端拒绝
 *      （SnowLuma 直接报 `video must be the only segment`；详见 deliverResult 注释）。
 *
 * 触发规则（照旧）：链接出现就解析，不需要 @；但如果这条**同时还在跟本机器人说话**
 * （被 @ 了，或去掉链接后还剩 ≥ modelTextThreshold 个字），发完媒体**继续交给模型**回话；
 * 否则只发媒体、不再叫模型。被引用的内容**一律不解析**（引用卡片再自动搬一遍 = 群里重复刷屏）。
 */

import { cqImage, cqVideo } from '../../platform/cq-file.js'

/**
 * URL 里不会出现中文/全角符号，直接排除掉：否则 "看 https://b23.tv/xyz，真的" 会把「，真的」吃进链接
 */
const URL_RE = /https?:\/\/[^\s"'<>\\\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g
/** 链接结尾常被半角标点/括号粘住，抽出后要削掉 */
const URL_TAIL_RE = /[)\]}>,.!?;:'"]+$/

/** 从文本里抽链接（按出现顺序，去重，最多 max 条）。 */
export function extractUrls(text, max = 2) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(URL_RE)) {
    const url = m[0].replace(URL_TAIL_RE, '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= max) break
  }
  return out
}

/** 去掉链接后剩下的正文（用来判断"这条是不是还在跟本机器人说话"） */
export function stripUrls(text) {
  return String(text || '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * QQ 卡片取链的优先级路径，对齐 astrbot_plugin_parser 的 `extract_json_url()`（core/utils.py:231）。
 */
export const CARD_PATHS = [
  ['miniapp', 'legacyUrl'], ['miniapp', 'pcJumpUrl'], ['miniapp', 'jumpUrl'], ['miniapp', 'sourceUrl'], ['miniapp', 'url'],
  ['detail_1', 'qqdocurl'], ['detail_1', 'jumpUrl'], ['detail_1', 'url'], ['detail_1', 'sourceUrl'], ['detail_1', 'shareUrl'], ['detail_1', 'targetUrl'],
  ['news', 'jumpUrl'], ['news', 'url'], ['news', 'sourceUrl'], ['news', 'shareUrl'],
  ['music', 'musicUrl'], ['music', 'jumpUrl'], ['music', 'url'],
]
/** 这几个字段是图（图标/预览图），不是"分享的内容"，兜底扫描时要跳过 */
const CARD_SKIP_KEYS = /^(icon|preview|image|imageUrl|cover|coverUrl|thumb|thumbnail|avatar|poster)$/i
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)(\?|#|$)/i

/** 从任意字符串里抠第一个 http(s) 链接（卡片 JSON 里的 `/` 是转义过的 `\/`） */
export function firstUrl(value) {
  const s = String(value || '').replace(/\\\//g, '/')
  const m = s.match(/https?:\/\/[^\s"'<>\\\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/)
  return m ? m[0].replace(URL_TAIL_RE, '') : null
}

/**
 * 从一条 json 段里挖出可解析的链接。
 * @param {object|string} card OneBot 的 seg.data（`{data:"<JSON串>"}`）或内层 JSON 串/对象
 * @returns {string|null}
 */
export function extractCardUrl(card) {
  let obj = card
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  if (obj.data && typeof obj.data === 'object') obj = obj.data
  else if (typeof obj.data === 'string') {
    try { obj = JSON.parse(obj.data) } catch { /* 不是 JSON 就按原对象继续找 */ }
  }

  const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : null
  if (meta) {
    for (const [k1, k2] of CARD_PATHS) {
      const node = meta[k1]
      if (node && typeof node === 'object') {
        const url = firstUrl(node[k2])
        if (url) return url
      }
    }
    // 兜底：扫所有子字段，跳过图标/预览图
    for (const node of Object.values(meta)) {
      if (!node || typeof node !== 'object') continue
      for (const [k, v] of Object.entries(node)) {
        if (typeof v !== 'string' || CARD_SKIP_KEYS.test(k)) continue
        const url = firstUrl(v)
        if (url && !IMG_EXT_RE.test(url)) return url
      }
    }
  }
  return firstUrl(obj.url) // 少数卡片把链接放在顶层
}

/** 秒 → "5:19"（**向下取整**：319.9 秒显示 5:19，跟平台自己显示的一致） */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** 拼一条简短说明（平台 + 标题 + 作者/时长）。标题可能很长（抖音 desc 是整段），按预算截断。 */
export function buildCaption(d, maxChars = 80) {
  const head = d.platformName ? `【${d.platformName}】` : ''
  let title = String(d.title || '').replace(/\s+/g, ' ').trim()
  if (title.length > maxChars) title = `${title.slice(0, maxChars)}…`

  const meta = []
  if (d.author) meta.push(String(d.author))
  const video = (d.media || []).find((x) => x.kind === 'video' && x.duration)
  if (video) meta.push(`时长 ${fmtDuration(video.duration)}`)

  let cap = `${head}${title}`.trim()
  if (meta.length) cap += `${cap ? ' ' : ''}(${meta.join(' · ')})`
  return cap.trim()
}

/** 媒体项 → CQ 码；不支持的返回 null（宁可少发一条，也不发一个会让整条消息失败的码） */
function toCq(item) {
  const p = item?.path
  if (!p) return null
  switch (item.kind) {
    case 'image': return cqImage(p)
    case 'video': return cqVideo(p)
    default: return null // audio（语音）与 file 都不发 —— 只保留 image / video
  }
}

// 侧车下载/合流最慢可到几分钟；插件 schema 没给超时键，按侧车给满
const PARSE_TIMEOUT_MS = 300000
const MAX_URLS = 2
const MAX_ITEMS = 3
const CAPTION_MAX_CHARS = 80

export default {
  id: 'link-parser',
  title: '链接解析',
  order: 70,

  configSchema: {
    enabled: {
      type: 'bool', default: false, group: '链接解析', label: '链接解析',
      hint: '需要自备解析侧车（默认 127.0.0.1:3972）；没起侧车时开启只会超时后降级放行，默认关',
    },
    parserUrl: { type: 'str', default: 'http://127.0.0.1:3972', group: '链接解析', label: '侧车地址', hint: '链接解析侧车地址（需要你自己跑一个解析服务，默认 127.0.0.1:3972）；留空 = 不解析。' },
    maxBytes: { type: 'int', default: 100 * 1024 * 1024, group: '链接解析', label: '单条媒体上限（字节）', hint: '单个文件/图片的下载上限；超过就跳过不下载（防大文件卡住）。' },
    continueWhenAddressed: { type: 'bool', default: true, group: '链接解析', label: '同时在跟我说话时继续交给模型', hint: '开：正在跟它说话时，消息里带链接也照常交给模型回答；关：带链接就只解析、不接话。' },
    modelTextThreshold: { type: 'int', default: 4, group: '链接解析', label: '剥链接后正文多少字算在跟我说话', hint: '剥掉链接后正文超过这么多字，才算「在跟它说话」（否则只发链接、不接话）。' },
    platforms: { type: 'group', default: ['bilibili'], group: '链接解析', label: '只解析这些平台', hint: '只解析这些平台的链接（逗号分隔，现支持 bilibili；抖音 2026-11-10 下线）；留空 = 支持的全部。' },
  },

  setup(bot) {
    const cfg = bot.cfg
    const log = bot.log
    // 每次请求动态读取 cfg（控制台热改即时生效）
    const parserUrlOf = () => String(cfg.parserUrl || '').trim().replace(/\/+$/, '')
    const maxBytesOf = () => (Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : 100 * 1024 * 1024)
    const thresholdOf = () => (Number(cfg.modelTextThreshold) > 0 ? Number(cfg.modelTextThreshold) : 4)
    const platformsOf = () => (Array.isArray(cfg.platforms) ? cfg.platforms.map(String) : [])

    /**
     * 调 Python 侧车；返回 null 表示服务不可用（调用方**降级放行**，消息照旧交给模型）。
     * 用原生 fetch + AbortSignal.timeout，不引新依赖。
     */
    async function callParse(url, session) {
      const parserUrl = parserUrlOf()
      if (!parserUrl) return null
      try {
        const res = await fetch(`${parserUrl}/parse`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, session, limit: MAX_ITEMS }),
          signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
        })
        if (!res.ok) {
          log.warn(`[链接解析] 侧车 HTTP ${res.status}, 本条按普通消息处理`)
          return null
        }
        return await res.json()
      } catch (e) {
        log.warn(`[链接解析] 服务不可用(${e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message}), 本条按普通消息处理`)
        return null
      }
    }

    /**
     * 把一次解析结果发出去；返回 {sent, oversize} —— 一条都没发出去时要能降级。
     *
     * ⚠️ **视频必须单独一条消息**（2026-10-27 真机踩坑，SnowLuma 2.2.0）：
     *   协议端把视频当独立消息处理，文字 + 视频混在一条会被直接拒绝
     *   （`message element "video" must be the only segment in a message`），
     *   同一条里出现两个视频也不行（`video may appear only once`）。
     *   所以有视频时：每个视频各自一条、图片并一条、说明文字最后单独一条；
     *   没有视频时保持旧行为（说明 + 图片一条发，各协议端都允许）。
     *   注意这是 QQ 客户端的真实形态，不是 SnowLuma 的怪癖 —— 老实现时代混发只是被 QQ 静默丢弃兄弟元素。
     */
    async function deliverResult(chatKey, data) {
      const maxBytes = maxBytesOf()
      const items = [] // [{ kind, code }] —— 保留类型，发送时按"视频单独一条"分组
      let oversize = 0
      for (const item of data.media || []) {
        if (!item?.path) continue
        // 侧车自己也卡一道大小闸门，这里再卡一道：配置的 maxBytes 是最后防线（大文件走 QQ 上传很慢）
        if (Number(item.size) > maxBytes) {
          oversize += 1
          log.warn(`[链接解析] 跳过 ${item.kind || '媒体'}: ${item.size}B 超过上限 ${maxBytes}B`)
          continue
        }
        const code = toCq(item)
        if (code) items.push({ kind: item.kind, code })
        else log.warn(`[链接解析] 跳过不支持的媒体类型: ${item.kind}`)
      }
      let note = ''
      if (!items.length) {
        // 视频没合出来（例如没装 ffmpeg）时，用服务给的封面兜底，至少不是什么都不发
        const cover = (data.skipped || []).find((s) => s.cover)
        if (cover) {
          items.push({ kind: 'image', code: cqImage(cover.cover) })
          note = '（视频没合出来，先发封面）'
        }
      }
      // 被跳过的东西要说清楚（成品体积超限 / 时长超限 / 下载失败），否则用户只看到"什么都没发"
      for (const s of data.skipped || []) {
        if (s && s.reason) log.info(`[链接解析] 跳过 ${s.kind || '媒体'}: ${s.reason}`)
      }
      if (!items.length) {
        log.warn(`[链接解析] ${data.platformName || data.platform} 没有可发送的媒体`)
        return { sent: false, oversize: oversize > 0 }
      }

      const caption = buildCaption(data, CAPTION_MAX_CHARS) + note
      const videos = items.filter((it) => it.kind === 'video')
      // 纯图片/封面：说明 + 图片一条发（图片没有"必须唯一 segment"的限制）
      if (!videos.length) {
        await bot.sendMedia(chatKey, items.map((it) => it.code).join(' '), caption)
        return { sent: true, oversize: oversize > 0 }
      }

      // 有视频：先逐条发媒体（视频各自一条、图片并一条），媒体发出去了再补说明；
      // 全部媒体都失败时抛错，让上层走"没发出媒体 → 本条按普通消息处理"的降级。
      let firstError = null
      let sentMedia = 0
      const sendOne = async (code, label) => {
        try {
          await bot.sendMedia(chatKey, code)
          sentMedia += 1
        } catch (e) {
          if (!firstError) firstError = e
          log.error(`[链接解析] ${label}发送失败: ${e.message}`)
        }
      }
      for (const it of videos) await sendOne(it.code, '视频')
      const images = items.filter((it) => it.kind === 'image')
      if (images.length) await sendOne(images.map((it) => it.code).join(' '), '图片')
      if (!sentMedia) throw firstError || new Error('媒体发送失败')
      if (caption) {
        try {
          await bot.deliver(chatKey, caption)
        } catch (e) {
          // 媒体已经发出去了，说明文字丢了不至于把整条判失败
          log.warn(`[链接解析] 说明文字发送失败(忽略): ${e.message}`)
        }
      }
      return { sent: true, oversize: oversize > 0 }
    }

    bot.on('intercept', async (ev) => {
      if (!cfg.enabled) return
      // 命令永远优先：`/` 开头一律不抢（命令插件处理；就算它没处理，也不能被链接解析吞掉）
      if (String(ev.text || '').trimStart().startsWith('/')) return

      // 卡片链接优先：那才是这次分享的东西（正文里的链接其次）；最多解析 2 条
      const urls = []
      for (const c of Array.isArray(ev.cards) ? ev.cards.filter(Boolean) : []) if (!urls.includes(c)) urls.push(c)
      for (const u of extractUrls(ev.text, 99)) if (!urls.includes(u)) urls.push(u)
      const targets = urls.slice(0, MAX_URLS)
      if (!targets.length) return

      let matched = false
      let failed = 0   // 匹配到了、但一条媒体都没发出去（超过上限 / 解析失败）→ 这种不能吞消息
      let sent = false

      for (const url of targets) {
        const data = await callParse(url, ev.chatKey)
        if (!data) break // 服务不可用：整条降级放行，别再打第二次浪费时间
        if (data.code === 'nomatch') {
          log.debug(`[链接解析] 没有解析器匹配: ${url}`)
          continue // 别的链接可能匹配
        }
        if (data.code === 'debounced') {
          matched = true
          log.info(`[链接解析] 同会话重复内容, 静默跳过 (${data.resourceId || ''})`)
          continue
        }
        if (!data.ok) {
          matched = true
          log.warn(`[链接解析] ${data.code}: ${data.error}`)
          failed += 1
          continue
        }
        // 只转发配置允许的平台（侧车 enabledPlatforms 之外的平台不主动搬媒体）；
        // 不当作"已处理"—— 这条链接仍该交给模型按普通消息看
        const platforms = platformsOf()
        if (platforms.length && data.platform && !platforms.includes(data.platform)) {
          log.info(`[链接解析] 平台 ${data.platform} 不在允许列表, 按普通消息处理`)
          continue
        }
        matched = true
        log.info(`[链接解析] ${ev.chatKey} ${data.platformName} ${data.elapsedMs}ms `
          + `媒体=${(data.media || []).length} 跳过=${(data.skipped || []).length} title=${String(data.title || '').slice(0, 40)}`)
        try {
          const r = await deliverResult(ev.chatKey, data)
          if (r.sent) sent = true
          if (r.oversize && !r.sent) failed += 1
        } catch (e) {
          log.error(`[链接解析] 发送失败: ${e.message}`)
          failed += 1
        }
      }

      if (!matched) return // 一条都没匹配上 → 完全不受影响
      if (!sent && failed) {
        // 匹配上了、但一条媒体都没发出去（媒体被跳过 / 解析失败 / 超大文件）。
        // **不能吞消息**：照旧交给下游（私聊会叫模型、群里按"没唤醒"处理）—— 跟文件头写的"失败一律降级"一致。
        log.info(`[链接解析] ${failed} 条匹配但没发出媒体 → 本条按普通消息处理`)
        return
      }

      // 这条是不是还在跟本机器人说话？是 → 发完媒体（或 debounced）继续交给模型；否 → 只发媒体，不再叫模型
      const threshold = thresholdOf()
      const original = String(ev.rawText ?? ev.text ?? '')
      const stripped = stripUrls(String(ev.text || ''))
      const addressed = Boolean(ev.mentionedSelf) || stripUrls(original).length >= threshold
      if (cfg.continueWhenAddressed && addressed) {
        // URL 已由侧车解析成媒体，剥完仍有正文时更新 ev.text；若剥完为空（如"@本机 + 纯链接"），
        // 保留原文本以免下游 gate-wake 看到空串误判成"纯@无正文"去发 callAck。
        if (stripped) ev.text = stripped
        log.info('[链接解析] 本条在跟本机器人说话 → 继续交给模型')
        return
      }
      ev.stopped = true
      ev.stopReason = 'link-parser'
    })
  },
}
