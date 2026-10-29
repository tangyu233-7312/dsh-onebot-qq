/**
 * video-link-read — 链接级"点开看看"（id: 'video-link-read', order: 45）
 *
 * 2026-10-29 起支持两种情况：
 *   ① 消息里贴了 B 站 / 抖音链接（正文或分享卡片）；
 *   ② 消息里**只给了 BV 号**（`BV1GJ411x7h7` 这种），自动补成 `https://www.bilibili.com/video/<BV号>`。
 * 命中后走侧车 `/read` → 下载 → ffprobe → ffmpeg 抽 N 帧 → 塞进 `ev.imageParts`，模型于是"真的看过"。
 *
 * 为什么拆成两个插件：
 *   · `video-link-read` 要在 **order 45** 拦链接 —— 那里 `ev.wake` 已经由 gate-wake(10) 判完了，
 *     而且必须**早于** `link-parser`(70)、`persona-voice`(40) 已过，才能干净地把"链接"这条支线截住；
 *   · `video-read` 必须在 **order < 45** 把群文件视频抽成帧塞进 `ev.imageParts` ——
 *     晚了 `kernel:context`(50) 就不认（它只在 imageParts 为空时自己填）。
 *   两个 order 互相咬死，只能拆。
 *
 * 这个插件干的事：消息里有 B 站 / 抖音链接、**并且这条消息是在叫它** →
 *   先问侧车 `/read`，抽几帧塞进 `ev.imageParts`（模型于是"真的看过"这条视频）。
 *   搬不搬视频由 `link-parser`（intercept 阶段，早于本插件）决定 —— 本插件只负责"让模型看见"，
 *   不在这一层 stop（before-turn 拦不住已经在 intercept 发出的媒体，stop 只会把模型回话也吞掉）。
 *
 * 三条纪律：
 *   ① **侧车不可用 = 完全让路**（不 stop、不吭声），链接照旧交给下游，
 *      绝不会因为侧车没起就把消息吞掉。
 *   ② **不叫它就不看**：群里随手贴个链接，不该触发下载 + 多模态。
 *   ③ **不搬媒体**：只抽帧给模型看，不往群里发视频（那是 `link-parser` 的活，它开着就它干）。
 */
import fs from 'node:fs'

const URL_RE = /https?:\/\/[^\s<>"'`，。；、！？（）【】《》「」]+/gi

function extractUrls(text) {
  const out = []
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = m[0].replace(/[)\]}>.,;:'"!?]+$/, '')
    if (u.length > 10) out.push(u)
  }
  return out
}

/** 裸 BV 号（B 站视频 id）：`BV` + 10 位 base58。群里经常只贴这串，不给链接 */
const BV_RE = /(?<![0-9A-Za-z])[Bb][Vv]([0-9A-Za-z]{10})(?![0-9A-Za-z])/g

/**
 * 从文本里捞裸 BV 号并补成完整链接。
 * 只认"独立的 BV 号"（前后不能是字母数字），避免把 `xxBV1234567890yy` 这种误判。
 * @returns {string[]} 形如 https://www.bilibili.com/video/BV1GJ411x7h7
 */
function bvLinksOf(text) {
  const out = []
  for (const m of String(text || '').matchAll(BV_RE)) {
    const bv = 'BV' + m[1]
    const url = `https://www.bilibili.com/video/${bv}`
    if (!out.includes(url)) out.push(url)
  }
  return out
}

function platformOf(url) {
  const u = String(url || '').toLowerCase()
  if (/bilibili\.com|b23\.tv|bili2233\.cn/.test(u)) return 'bilibili'
  if (/douyin\.com|iesdouyin\.com/.test(u)) return 'douyin'
  return ''
}

/**
 * 从「原始段」里捞卡片链接（兜底层）。
 * `ev.cards` 已经被内核抽过一遍，但 QQ 小程序卡片的链接埋在 `meta.detail_1.qqdocurl` /
 * `meta.news.jumpUrl` 之类的深层字段里，内核的 `extractCardUrl` 只认它知道的几个路径。
 * 这里把 json 段整段丢进正则再按平台过滤 —— 宁可多找一个，也别整条漏掉。
 */
function urlsFromRawSegments(segs) {
  const out = []
  for (const seg of Array.isArray(segs) ? segs : []) {
    if (String(seg?.type || '') !== 'json') continue
    const d = seg?.data ?? seg ?? {}
    // QQ 卡片 JSON 里的斜杠是转义过的。段里的 data 既可能是**原始 JSON 串**（`https:\/\/`），
    // 也可能是被内核 JSON.parse 过再 stringify 的（`https:\\/\\/`）。**两种转义都还原**，别只认一种。
    const body = typeof d === 'string' ? d : (d.data ?? '')
    const raw = String(body)
      .replace(/\\\\\//g, '/')   // \\/  → /
      .replace(/\\\//g, '/')     // \/   → /
    if (!raw) continue
    for (const m of raw.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const u = m[0].replace(/[)\]}>.,;:'"!?]+$/, '')
      if (u.length > 10 && !out.includes(u)) out.push(u)
    }
  }
  return out
}

/** 按文件头认图片 MIME：侧车通常给 JPEG，但不硬编码（防止协议漂移） */
function mediaTypeOf(buf) {
  if (!buf?.length) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

function quotaCheck(bot, chatKey, qq, perUserHour, perGroupHour) {
  const st = bot.state?.get?.(chatKey) ?? {}
  const scratch = (st._scratch ||= Object.create(null))
  const slot = (scratch['video-read:quota'] ||= { users: new Map(), group: [] })
  const now = Date.now()
  const hourAgo = now - 3600_000
  slot.group = slot.group.filter((t) => t > hourAgo)
  for (const [k, arr] of slot.users) {
    const kept = arr.filter((t) => t > hourAgo)
    if (kept.length) slot.users.set(k, kept)
    else slot.users.delete(k)
  }
  const mine = slot.users.get(Number(qq)) ?? []
  if (perUserHour > 0 && mine.length >= perUserHour) return { ok: false, why: 'user', used: mine.length, max: perUserHour }
  if (perGroupHour > 0 && slot.group.length >= perGroupHour) return { ok: false, why: 'group', used: slot.group.length, max: perGroupHour }
  return {
    ok: true,
    commit() { mine.push(now); slot.users.set(Number(qq), mine); slot.group.push(now) },
  }
}

export default {
  id: 'video-link-read',
  title: '看视频链接',
  order: 45,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '文件与图片',
      label: '点开 B 站 / 抖音链接看视频',
      hint: '开：群里有人**叫它**并贴了 B 站/抖音链接时，它会把视频下下来抽帧真看一眼再回话；'
        + '关：链接按普通网页处理（模型只拿得到标题和简介）。需要侧车在跑。',
    },
    sidecarUrl: {
      type: 'str', default: 'http://127.0.0.1:3972', group: '文件与图片',
      label: '侧车地址',
      hint: '跟看视频共用一个侧车；留空 = 关闭。',
    },
    onlyWhenAddressed: {
      type: 'bool', default: true, group: '文件与图片',
      label: '只在被叫到时点开链接',
      hint: '建议开：只有 @ 它 / 叫唤醒词 / 引用它 / 私聊里贴的链接才下载抽帧；关：群里任何人贴的链接都看（更费钱）。\n'
        + '⚠️ 主动接话轮不在这里面——那是它自己找的话，不会为了它去下载视频。',
    },
    allowBvOnly: {
      type: 'bool', default: true, group: '文件与图片',
      label: '只发 BV 号也能看',
      hint: '开：群里只贴一串 BV 号（如 BV1GJ411x7h7）而不贴链接时，也当 B 站视频去下载抽帧。\n'
        + '关：只认完整链接。',
    },
    platforms: {
      type: 'group', default: ['bilibili', 'douyin'], group: '文件与图片',
      label: '只点开这些平台',
      hint: '默认 bilibili,douyin。抖音要求侧车配了 cookie（见侧车 sidecar.config.json）。',
    },
    frames: {
      type: 'int', default: 8, min: 1, max: 12, step: 1, group: '文件与图片',
      label: '抽几帧',
      hint: '跟群文件视频一致即可。',
    },
    maxSide: {
      type: 'int', default: 1024, min: 256, max: 2048, step: 64, group: '文件与图片',
      label: '帧的长边像素',
      hint: 'DSH 单图上限 2MB，1024 基本不会超。',
    },
    maxSeconds: {
      type: 'int', default: 600, unit: '秒', group: '文件与图片',
      label: '最长看多久的视频',
      hint: '超过就不看。默认 600 秒。',
    },
    timeoutMs: {
      type: 'int', default: 240, unit: '秒', scale: 1000, group: '文件与图片',
      label: '等侧车的超时',
      hint: '链接要现下载，比群文件慢，默认 240 秒。超时后链接照旧交给下游。',
    },
    perUserHour: {
      type: 'int', default: 0, min: 0, max: 100, group: '文件与图片',
      label: '每人每小时最多看几个（0 = 不限）',
      hint: '默认 **0 = 不限制**（不擅自搬旧机器人的额度）。'
        + '想跟「看视频」统一，就把两处填同一个数：**计数槽本来就是共用的**，这里只决定"拦不拦"。',
    },
    perGroupHour: {
      type: 'int', default: 0, min: 0, max: 500, group: '文件与图片',
      label: '每群每小时最多看几个（0 = 不限）',
      hint: '默认 **0 = 不限制**。',
    },
    tellOnFail: {
      type: 'bool', default: true, group: '文件与图片',
      label: '没看成时说一句',
      hint: '开：链接打不开/超时长时如实说一句；关：静默交给下游。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const urlOf = () => String(cfg().sidecarUrl || '').trim()

    /**
     * 这条消息是不是"冲它来的"（=「只在被叫到时看」的判据）。
     *
     * 为什么不用 `ev.wake`：内核只在「被叫」（@ / 引用 / 唤醒词 / 接续）时才置 wake，
     * 而**私聊**由 gate-wake 置 `{kind:'private'}`、**主动接话轮**则根本没有 wake 语义。
     * 旧实现一律 `if (!ev.wake) return`，等于"私聊里贴链接永远不看"——现在是按来源判断：
     *   · 私聊（非群）→ 只要对方发了就看
     *   · 群聊 → @它 / 引用它 / 叫了唤醒词 / 接续补发 都算；主动接话轮（proactive/continuation）不算
     */
    function isAddressed(ev) {
      if (!ev) return false
      if (!ev.isGroup) return true
      if (ev.mentionedSelf) return true
      const kind = String(ev.wake?.kind || '')
      if (['at', 'quote', 'keyword', 'followup'].includes(kind)) return true
      // 没有 wake（主动接话轮 / 没被叫）→ 不看
      return false
    }

    bot.on('before-turn', async (ev) => {
      if (cfg().enabled === false || !urlOf()) return
      // 已经在别处（比如群文件视频）成功塞过帧 = 这一轮已经"看过东西"了，别再看第二段
      if (Array.isArray(ev.imageParts) && ev.imageParts.length) return
      // 「只在被叫到时看」：判据是这条消息**是不是冲它来的**，不是 ev.wake 有没有值。
      // ⚠️ 内核只在「被叫」时置 ev.wake；主动接话轮（wake.kind=proactive/continuation）没有 wake 语义，
      //    但它们也不该触发下载（见 isAddressed 的注释）。
      if (cfg().onlyWhenAddressed !== false && !isAddressed(ev)) return

      // 链接来源有两条，**都要看**：
      //   ① 正文里的链接（用户直接打字贴的）
      //   ② `ev.cards` —— QQ 小程序/分享卡片。⚠️ 内核 format.js:405-407 把卡片里的链接
      //      抽出来单独放 cards，**不塞进 text**（注释：保持"卡片不算文字"的旧行为）。
      //      所以只搜 rawText 会漏掉所有卡片分享 —— 这是踩过的坑，别再改回去。
      const text = String(ev.rawText ?? ev.text ?? '')
      const candidates = [
        ...extractUrls(text),
        ...(Array.isArray(ev.cards) ? ev.cards.map(String) : []),
        ...urlsFromRawSegments(ev.rawSegments),
      ]
      // ③ 裸 BV 号：群里经常只贴一串 BV1xxxxxxxxx，不给链接 —— 补成完整地址再走同一条路
      if (cfg().allowBvOnly !== false) candidates.push(...bvLinksOf(text))
      const allowed = Array.isArray(cfg().platforms) ? cfg().platforms.map(String) : ['bilibili', 'douyin']
      const hit = candidates.map((u) => ({ url: u, platform: platformOf(u) }))
        .find((x) => x.platform && allowed.includes(x.platform))
      if (!hit) return                                   // 不是支持的平台 → 完全不碰
      const src = text.includes(hit.url) ? '正文'
        : ev.cards?.some?.((c) => String(c) === hit.url) ? '卡片'
          : 'BV号'
      bot.log.debug(`[看链接] 命中 ${hit.platform} ${hit.url.slice(0, 80)}（来源=${src}）`)

      // 额度（跟 video-read 共用一个槽）
      const q = quotaCheck(bot, ev.chatKey, ev.sender?.qq,
        Number(cfg().perUserHour ?? 0), Number(cfg().perGroupHour ?? 0))
      if (!q.ok) {
        bot.log.info(`[看链接] 额度用完（${q.why}：${q.used}/${q.max}）${ev.chatKey}`)
        if (cfg().tellOnFail !== false) {
          ev.hint.push(`[系统提示: ${q.why === 'user' ? '你看太多视频啦' : '这群今天看太多视频啦'}（这条链接的视频内容未获取）请如实说没看到，别猜内容]`)
        }
        return
      }

      const started = Date.now()
      let data = null
      try {
        const res = await fetch(`${urlOf().replace(/\/+$/, '')}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: hit.url,
            platform: hit.platform,
            frames: Number(cfg().frames) || 8,
            maxSide: Number(cfg().maxSide) || 1024,
            maxSeconds: Number(cfg().maxSeconds) || 600,
          }),
          signal: AbortSignal.timeout(Math.max(5000, Number(cfg().timeoutMs) || 240000)),
        })
        data = await res.json()
      } catch (e) {
        // 侧车不可用 → 完全让路，链接照旧交下游。
        // 但**要说一句**：否则模型只拿到标题简介，会顺着简介编画面（用户看到的就是"它其实没看"）。
        bot.log.warn(`[看链接] 侧车不可用（${ev.chatKey}）: ${e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message}`)
        if (cfg().tellOnFail !== false) {
          ev.hint.push('[系统提示: 看视频的服务这会儿没连上（视频内容未获取）请如实说没看到画面，别按标题瞎猜内容]')
        }
        return
      }
      if (!data?.ok) {
        bot.log.info(`[看链接] 侧车拒绝: ${data?.code} ${data?.error || ''}`)
        if (cfg().tellOnFail !== false) {
          ev.hint.push(`[系统提示: ${failText(data)}（链接的视频内容未获取）请如实说没看到，别猜内容]`)
        }
        return    // 让路：link-parser / 模型照常处理这条链接
      }

      let pushed = 0
      for (const f of Array.isArray(data.frames) ? data.frames : []) {
        try {
          const buf = await fs.promises.readFile(String(f.path || ''))
          if (!buf.length) continue
          ev.imageParts.push({
            mediaType: mediaTypeOf(buf),
            data: buf.toString('base64'),
            name: `link-frame@${Number(f.sec) || 0}s`,
          })
          pushed += 1
        } catch (e) {
          bot.log.warn(`[看链接] 读帧失败 ${f.path}: ${e.message}`)
        }
      }
      if (!pushed) {
        if (cfg().tellOnFail !== false) ev.hint.push('[系统提示: 这链接的画面没抽出来（视频内容未获取）请如实说没看到，别猜内容]')
        return
      }

      q.commit()
      const dur = Number(data.durationSec) || 0
      const mmss = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`
      const title = String(data.title || '').trim()
      const plat = data.platform === 'bilibili' ? 'B 站' : data.platform === 'douyin' ? '抖音' : '视频'
      ev.hint.push(`[${plat}视频${title ? `「${title.slice(0, 40)}」` : ''}: 时长 ${mmss}，已抽 ${pushed} 帧（`
        + `${(data.frames || []).map((f) => `${f.sec}s`).join('/')}）。`
        + `这些图就是视频画面（按时间顺序），直接据此回话即可；没看清的地方如实说看不清]`)
      // 把"这次看了哪条视频"记下来，供出站装饰/控制台排障（不参与回复内容）
      ev._scratch['video-link-read:last'] = {
        url: hit.url, platform: data.platform || hit.platform, title: title.slice(0, 80),
        durationSec: dur, frames: pushed, at: Date.now(),
      }
      // 不 stop：视频是否搬进群由 link-parser（intercept 阶段，早于本插件）决定；
      // 本插件只负责给模型塞画面，stop 在这里拦不住已经发出的媒体，只会把模型回话也吞掉。
      bot.log.info(`[看链接] ${ev.chatKey} ${data.platform} ${mmss} ${pushed} 帧 (${Date.now() - started}ms)`)

      function failText(d) {
        switch (String(d?.code || '')) {
          case 'too_long': return '这视频太长了，我看不动…'
          case 'too_big': return '这视频太大了，我看不动…'
          case 'busy': return '我这会儿正看着别的视频，等会儿再看~'
          case 'nomatch': return '这链接我打不开…'
          case 'download_failed': return '这链接我打不开（平台可能要求登录）…'
          default: return '这视频我没看成…'
        }
      }
    })
  },
}
