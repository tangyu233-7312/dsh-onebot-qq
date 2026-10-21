/**
 * video-read — 让模型"看得见"群里直接发的视频文件（id: 'video-read', order: 44）
 *
 * 现状：内核把视频段压成一个字符串 `[视频]`（`kernel/format.js:395`），模型只知道"有人发了个视频"，
 * 画面、时长、说了什么一概不知。本插件补的就是这一段：
 *
 *   入站视频段 / B 站·抖音链接 → 交给**侧车** → 侧车下载/定位 + ffprobe 探时长 + ffmpeg 抽 N 帧
 *   → 返回帧的本地路径 → 本插件读成 base64 → 塞进 `ev.imageParts`
 *
 * 四条纪律（改之前先读）：
 *
 *   ① **本插件不 spawn 任何子进程**（包内红线）。抽帧/下载全在侧车；插件只做 HTTP + 读文件，
 *      跟 `link-parser` 找解析侧车是同一个模式。
 *
 *   ② **order 必须 < 45**。`kernel:context` 在 **order 50** 填图片，条件是
 *      `if (!ev.imageParts.length)`；晚于它，我们塞的帧会被直接跳过。
 *      本插件 < video-link-read(45) < kernel:context(50)，链路才是通的。
 *
 *   ③ **只在被叫的那轮看**（`onlyWhenAddressed` 默认开）。群里没人叫它却发视频/贴链接，
 *      看一眼就是一次多模态调用，白烧钱。另外**额度要先查再发请求** ——
 *      旧机器人踩过"先下载几百 MB 再报超限"。
 *
 *   ④ **链接只从"原始文本"里挖，不从 `ev.cards`**。`link-parser` 会把卡片里的链接搬进群，
 *      我们不重复搬；这里要的是"群里有人贴了个 B 站链接，它能不能真的点开看看"。
 *
 * 状态（额度窗口）进 `bot.state.get(chatKey)._scratch`，遵守契约：插件不开全局 Map。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 从原始段里挖视频。
 *
 * OneBot v11 规范是 `{type:'video', data:{file, file_id, url, path}}`，但 **NapCat 实际给的字段
 * 不一定齐**：`file` 可能是个文件名、`file_id` 可能空、`url` 可能没有。所以这里按优先级收集
 * **所有可能的把手**，交给下游 resolveLocal 逐个试 —— 而不是只取第一个非空就返回。
 * @returns {{file:string, fileId:string, url:string, local:string, keys:string[]}|null} keys = 实际拿到值的字段名（排障用）
 */
function videoSegOf(ev) {
  const segs = Array.isArray(ev?.rawSegments) ? ev.rawSegments : []
  for (const seg of segs) {
    if (String(seg?.type || '') !== 'video') continue
    const d = seg?.data ?? seg ?? {}
    // 大小写/别名都认：file / file_id / fileId / fid / url / path / file_path / filename
    const pick = (...names) => {
      for (const n of names) {
        const v = d[n]
        if (typeof v === 'string' && v.trim()) return v.trim()
        if (typeof v === 'number' && v > 0) return String(v)
      }
      return ''
    }
    const file = pick('file', 'filename')
    const fileId = pick('file_id', 'fileId', 'fid')
    const url = pick('url', 'file_url')
    const local = pick('path', 'file_path', 'local_path')
    const keys = Object.entries({ file, fileId, url, local }).filter(([, v]) => v).map(([k]) => k)
    if (!keys.length) continue
    return { file, fileId, url, local, keys }
  }
  return null
}

/** 链接正则：中文/全角符号不进链接，尾部半角标点削掉（跟 link-parser 的教训一致） */
const URL_RE = /https?:\/\/[^\s<>"'`，。；、！？（）【】《》「」]+/gi
function extractUrls(text) {
  const out = []
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = m[0].replace(/[)\]}>.,;:'"!?]+$/, '')
    if (u.length > 10) out.push(u)
  }
  return out
}

/** 认平台：只认侧车白名单里的那几家，别的交给下游（web_fetch 之类） */
function platformOf(url) {
  const u = String(url || '').toLowerCase()
  if (/bilibili\.com|b23\.tv|bili2233\.cn/.test(u)) return 'bilibili'
  if (/douyin\.com|iesdouyin\.com/.test(u)) return 'douyin'
  return ''
}

/** 本线额度窗口（一小时滑窗），返回 { ok, used, max } */
/** 本线额度窗口（一小时滑窗），返回 { ok, used, max } */
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

/** 该不该在这一轮看（唤醒方式 + 配置） */
function shouldLook(ev, cfg) {
  if (!ev?.wake) return false
  if (cfg.onlyWhenAddressed === false) return true
  // 主动接话轮 / 入群欢迎轮不是"有人在问它"，别为它们烧钱
  return ['at', 'quote', 'keyword', 'followup', 'private'].includes(String(ev.wake.kind || ''))
}

export default {
  id: 'video-read',
  title: '看视频',
  order: 44,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '文件与图片',
      label: '让模型看视频内容',
      hint: '开：群友发视频 / 贴 B 站·抖音链接时抽几帧交给模型，它能描述画面、说出讲了什么；'
        + '关：视频只显示成「[视频]」，链接按普通网页处理。'
        + '**需要侧车在跑**（控制台「运维」页有「启动侧车」按钮）；侧车不在时自动降级，不影响聊天。',
    },
    sidecarUrl: {
      type: 'str', default: 'http://127.0.0.1:3972', group: '文件与图片',
      label: '侧车地址',
      hint: '默认 http://127.0.0.1:3972，跟侧车自己的 port 一致。留空 = 关闭看视频。',
    },
    onlyWhenAddressed: {
      type: 'bool', default: true, group: '文件与图片',
      label: '只在这条视频/链接"叫了它"时才看',
      hint: '建议开。开：只有 @ 它 / 叫唤醒词 / 引用它之后再发视频、贴链接才看；'
        + '关：群里任何人发都去看（很费钱，适合小群）。',
    },
    frames: {
      type: 'int', default: 8, min: 1, max: 12, step: 1, group: '文件与图片',
      label: '抽几帧',
      hint: '越大越"看得全"，但一次多模态调用也越贵。10 分钟以内的视频，8 帧够描述"讲了什么"。',
    },
    maxSide: {
      type: 'int', default: 1024, min: 256, max: 2048, step: 64, group: '文件与图片',
      label: '帧的长边像素',
      hint: '1024 足够看清画面；DSH 单图上限 2MB，压到这个尺寸基本不会超。',
    },
    maxSeconds: {
      type: 'int', default: 600, unit: '秒', group: '文件与图片',
      label: '最长看多久的视频',
      hint: '超过就不看（回一句"太长了"）。默认 600 秒 = 10 分钟；直播回放别碰。',
    },
    timeoutMs: {
      type: 'int', default: 180, unit: '秒', scale: 1000, group: '文件与图片',
      label: '等侧车的超时',
      hint: '超过就放弃这一轮。链接要现下，比群文件慢，默认 180 秒。',
    },
    perUserHour: {
      type: 'int', default: 0, min: 0, max: 100, group: '文件与图片',
      label: '每人每小时最多看几个（0 = 不限）',
      hint: '默认 **0 = 不限制** —— 你没让人把旧机器人的额度搬过来，所以不默认打开。'
        + '想防刷就设 5；一旦设了，「看视频链接」会自动沿用同一个数（两个插件共用一份额度，不各算各的）。',
    },
    perGroupHour: {
      type: 'int', default: 0, min: 0, max: 500, group: '文件与图片',
      label: '每群每小时最多看几个（0 = 不限）',
      hint: '默认 **0 = 不限制**。想防刷可以设 15。',
    },
    tellOnFail: {
      type: 'bool', default: true, group: '文件与图片',
      label: '没看成时说一句',
      hint: '开：拉不到/太长/超额度时如实告诉对方（"这视频我没看成"），免得模型瞎猜画面；'
        + '关：完全不出声。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const urlOf = () => String(cfg().sidecarUrl || '').trim()
    const SLOT = 'video-read:seg'


    // ── passive-tap：把视频段记下来（fail-open，绝不阻塞主链） ──
    // ⚠️ 本插件**不负责拉起侧车**（那是运维/部署的事，也不该由插件 spawn 进程）。
    //    侧车没起时下面所有请求都会失败并降级，聊天不受影响。
    bot.on('passive-tap', async (ev) => {
      if (cfg().enabled === false) return
      if (!urlOf()) return
      const seg = videoSegOf(ev)
      if (seg) {
        ev._scratch[SLOT] = seg
        bot.log.debug(`[看视频] 收到视频段 file=${seg.file || '-'} fileId=${seg.fileId || '-'} url=${String(seg.url || '-').slice(0, 60)}`)
      } else {
        // 有视频段但挖不出字段 —— 这种最难查，必须留痕
        const hasVideoSeg = (Array.isArray(ev.rawSegments) ? ev.rawSegments : []).some((s) => String(s?.type) === 'video')
        if (hasVideoSeg) {
          bot.log.warn(`[看视频] 有 video 段但挖不出 file/url，段内容=${JSON.stringify(ev.rawSegments.filter((s) => String(s?.type) === 'video')).slice(0, 400)}`)
        }
      }
    })

    // ── ② before-turn：抽帧 → 塞 imageParts（order 44，必须早于 kernel:context 的 50） ──
    bot.on('before-turn', async (ev) => {
      if (cfg().enabled === false || !urlOf()) return
      // 每个门都留痕：不然"为什么没看"只能猜（trace 只在这一轮确实提到视频时才写，不刷屏）
      const seg0 = ev._scratch?.[SLOT]
      if (!seg0 && !ev.replyToId) return
      if (!shouldLook(ev, cfg())) return
      let seg = ev._scratch?.[SLOT]
      if (!seg) {
        // ── 被引视频：QQ 里"转发视频"只能**先发视频、再引用它说话**（客户端限制，绕不开）。
        //    内核的引用反查只取文本，视频段变成 `[媒体/富文本]` 且原始段被丢弃（index.js:744），
        //    所以这里**自己再反查一次**。
        //    ⚠️ 必须放在 before-turn（顺序 await，安全），**不能放在 passive-tap**——
        //    那个阶段内核是 fire-and-forget 的，不等 async 完成，会出现
        //    "before-turn 判定没有视频段 → 0.5 秒后才反查回来"的时序 bug（踩过）。
        if (ev.replyToId && typeof bot.napcat?.msgById === 'function') {
          try {
            const q = await bot.napcat.msgById(ev.replyToId)
            const qSeg = q ? videoSegOf({ rawSegments: q.message ?? q.raw_message ?? [] }) : null
            if (qSeg) {
              seg = qSeg
              ev._scratch[SLOT] = qSeg
              bot.log.debug(`[看视频] 被引消息里有视频段 (replyToId=${ev.replyToId}) file=${qSeg.file || '-'} id=${qSeg.fileId || '-'}`)
            }
          } catch (e) {
            bot.log.debug(`[看视频] 被引消息反查失败: ${e.message}`)
          }
        }
      }
      if (!seg) return

      // 额度：先查再发请求（别先下载几百 MB 再说超限）
      const q = quotaCheck(bot, ev.chatKey, ev.sender?.qq,
        Number(cfg().perUserHour ?? 5), Number(cfg().perGroupHour ?? 15))
      if (!q.ok) {
        bot.log.info(`[看视频] 额度用完（${q.why}：${q.used}/${q.max}）${ev.chatKey}`)
        return tell(ev, q.why === 'user' ? '你看太多视频啦，等会儿再看~' : '这群今天看太多视频啦，等会儿再看~')
      }

      const req = await videoRequest(ev, seg)
      if (!req) {
        bot.log.warn(`[看视频] 拿不到本地文件（file=${seg?.file || '-'} id=${seg?.fileId || '-'}）`)
        return tell(ev, '这视频我没拿到手，看不了…')
      }

      const started = Date.now()
      bot.log.debug(`[看视频] 请求侧车 ${String(req.url).slice(0, 80)} (${req.platform})`)
      let data = null
      try {
        const res = await fetch(`${urlOf().replace(/\/+$/, '')}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: req.url,
            platform: req.platform,
            frames: Number(cfg().frames) || 8,
            maxSide: Number(cfg().maxSide) || 1024,
            maxSeconds: Number(cfg().maxSeconds) || 600,
          }),
          signal: AbortSignal.timeout(Math.max(5000, Number(cfg().timeoutMs) || 180000)),
        })
        data = await res.json()
      } catch (e) {
        bot.log.warn(`[看视频] 侧车不可用（${ev.chatKey}）: ${e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message}`)
        return tell(ev, '看视频的服务没起来，这视频我看不了…')
      }

      if (!data?.ok) {
        bot.log.debug(`[看视频] 侧车拒绝: ${data?.code} ${String(data?.error || '').slice(0, 160)}`)
        bot.log.info(`[看视频] 侧车拒绝: ${data?.code} ${data?.error || ''}`)
        return tell(ev, failText(data))
      }

      // 读帧 → base64 → imageParts（内核只在 imageParts 为空时才自己填图，所以我们要早于它）
      let pushed = 0
      for (const f of Array.isArray(data.frames) ? data.frames : []) {
        try {
          const buf = fs.readFileSync(String(f.path || ''))
          if (!buf.length) continue
          ev.imageParts.push({
            mediaType: 'image/jpeg',
            data: buf.toString('base64'),
            name: `video-frame@${Number(f.sec) || 0}s`,
          })
          pushed += 1
        } catch (e) {
          bot.log.warn(`[看视频] 读帧失败 ${f.path}: ${e.message}`)
        }
      }
      if (!pushed) return tell(ev, '这视频的画面我没抽出来，看不了…')

      q.commit()
      const dur = Number(data.durationSec) || 0
      const mmss = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`
      const title = String(data.title || '').trim()
      ev.hint.push(`[视频${title ? `「${title.slice(0, 40)}」` : ''}: 时长 ${mmss}，已抽 ${pushed} 帧（`
        + `${(data.frames || []).map((f) => `${f.sec}s`).join('/')}）。`
        + `这些图就是视频画面（按时间顺序），直接据此回话即可；没看清的地方如实说看不清]`)
      bot.log.info(`[看视频] ${ev.chatKey} ${data.platform || req.platform} ${mmss} → ${pushed} 帧 (${Date.now() - started}ms)`)

      /** 失败时如实说一句（别让模型瞎猜画面） */
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
      function tell(e, text) {
        if (cfg().tellOnFail === false) return
        e.hint.push(`[系统提示: ${text}（视频内容未获取）请如实告诉对方没看到视频内容，别猜画面]`)
      }
    })

    /** 视频段 → 请求参数：拿本地路径（优先 NapCat 溯源，url 会过期，fileId 才是把手） */
    async function videoRequest(ev, seg) {
      const cands = [seg.local, seg.file].filter(Boolean)
      for (const c of cands) {
        try {
          if (/^[A-Za-z]:[\\/]|^\//.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) {
            return { url: c, platform: 'file' }
          }
        } catch { /* 忽略 */ }
      }
      // NapCat 溯源：**每个 handle 都试** —— file / file_id / url 在 NapCat 眼里是同一个东西的
      // 不同叫法，哪个能用取决于版本。只试 seg.fileId || seg.file 会漏掉"file 有值但其实是文件名"的情况。
      for (const id of [seg.fileId, seg.file].filter(Boolean)) {
        if (typeof bot.napcat?.getFile !== 'function') break
        try {
          const info = await bot.napcat.getFile(id)
          const p = String(info?.file || '')
          if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
            bot.log.debug(`[看视频] getFile(${String(id).slice(0, 20)}) → 本地 ${p}`)
            return { url: p, platform: 'file' }
          }
          const u = String(info?.url || '')
          if (/^https?:\/\//.test(u)) {
            bot.log.debug(`[看视频] getFile(${String(id).slice(0, 20)}) → 直链 ${u.slice(0, 60)}`)
            return { url: u, platform: 'qq' }
          }
        } catch (e) {
          bot.log.debug(`[看视频] getFile 抛错: ${e.message}`)
          bot.log.debug(`[看视频] getFile(${String(id).slice(0, 20)}) 失败: ${e.message}`)
        }
      }
      if (/^https?:\/\//.test(seg.url || '')) return { url: seg.url, platform: 'qq' }
      // 走到这里 = 所有把手都试过还拿不到。留一笔 warn（不是 debug），真机排障要靠它：
      // 会直接告诉你 NapCat 给的段里到底有什么字段。
      bot.log.warn(`[看视频] 拿不到视频文件：keys=[${(seg.keys || []).join(',')}] `
        + `file=${String(seg.file || '-').slice(0, 40)} id=${String(seg.fileId || '-').slice(0, 40)}`)
      return null
    }
  },
}
