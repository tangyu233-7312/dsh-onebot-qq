/**
 * video-wander — 自己上 B 站找视频看，看完写感想发给主人（id: 'video-wander', order: 47）
 *
 * 它跟「看视频链接」不是一回事：
 *   · video-link-read 是**被动**的（有人贴链接 → 抽帧给模型看，在同一次对话里回答）
 *   · 本插件是**主动**的（没人理它 → 每隔几小时自己挑一个视频看 → 写完感想私聊发给主人）
 *
 * 为什么要做成独立子插件而不是塞进 pacing：
 *   pacing 只负责「什么时候开口」，它不该知道「看视频」这件事；反过来看视频要下载、抽帧、起一轮模型，
 *   也不该污染主动接话的判定逻辑。两者共用的是「静默时段」这一条纪律，各自读自己的配置即可。
 *
 * 四条纪律（改之前先读）：
 *   ① **本插件不 spawn 子进程**（包内红线）。下载/抽帧全在侧车，插件只发 HTTP + 读帧文件。
 *   ② **只在专用会话里干活**：会话由 bot.dsh.ensureSession 建，用 bot.core.markScope 登记工具白名单
 *      （只放行 report_watched / skip_watching / watch_status），**连 send_message 都调不到** ——
 *      这样它绝不可能在看视频的时候顺手往群里说话。发消息由本插件自己 deliver。
 *   ③ **失败一律静默降级**：侧车挂了 / 排行榜拉不到 / 模型没写 —— 只记日志，不打扰主人。
 *      主动找上门的消息只该是「我真的看到点东西了」，不能变成错误播报器。
 *   ④ **所有数字都在 configSchema 里**：间隔、上限、分区、帧数、字数、超时、静默时段……
 *      代码里只留「缺了也能跑」的兜底值，且兜底值与 schema 的 default 一致。
 *
 * 状态落盘：<dataDir>/video-wander-state.json
 *   { lastRunAt, runs: [{at,bvid,title,ok,reason}], seen: { bvid: ts } }
 */
import fs from 'node:fs'
import path from 'node:path'

const STATE_FILE = 'video-wander-state.json'
// 状态文件保留多久的「看过」记录。内部闸门，不做成用户项：太小会让去重失效、太大只是多个几百字节
const STATE_KEEP_DAYS = 30

/**
 * 挑视频用的接口。为什么不只用 ranking/v2：
 *   2026-10-29 实测 —— ranking/v2 连续请求会返回 code:-352（风控），**HTTP 仍是 200**，
 *   只看 res.ok 会以为成功、拿到空列表，于是"没候选"。而 popular / 旧版 ranking 当时都还通。
 *   所以按优先级逐个试，任意一个给出非空列表就够。
 */
const BILI_APIS = {
  // 综合热门：不支持指定分区，最像"随便刷刷"
  popular: (limit) => 'https://api.bilibili.com/x/web-interface/popular?ps=' + Math.max(1, Math.min(50, limit)) + '&pn=1',
  // 旧版分区排行榜（支持 rid），风控比 v2 松
  rankingV1: (rid) => 'https://api.bilibili.com/x/web-interface/ranking?rid=' + encodeURIComponent(rid) + '&day=3',
  // 新版分区排行榜：最新、条数最多，但最容易撞 -352
  rankingV2: (rid) => 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=' + encodeURIComponent(rid) + '&type=all',
}

/** 多分区之间至少隔这么久再打下一个请求 —— 连着打是触发 -352 最快的方式 */
const API_GAP_MS = 900
const BRIEF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 分区表：控制台「从哪些分区挑」用这里；value 是 B 站 rid */
const BILI_REGIONS = [
  { value: '0', label: '全站' },
  { value: '1000', label: '知识' },
  { value: '1001', label: '动画' },
  { value: '1003', label: '音乐' },
  { value: '1005', label: '娱乐' },
  { value: '1007', label: '生活' },
  { value: '1010', label: '美食' },
  { value: '1014', label: '动物' },
  { value: '4', label: '游戏' },
  { value: '188', label: '科技' },
  { value: '119', label: '鬼畜' },
  { value: '180', label: '影视' },
]

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const now = () => Date.now()

/** 本地日期（只用来分天，不做时区运算） */
function localDate(ts = now()) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 秒 → mm:ss / h:mm:ss */
function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const t = String(s % 60).padStart(2, '0')
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + t : m + ':' + t
}

/** 播放量：12345 → 1.2万 */
function viewText(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
  return String(v)
}

// ── 状态读写（原子写；坏文件不致命）────────────────────────────
function readState(dataDir) {
  const file = path.join(dataDir, STATE_FILE)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      lastRunAt: Number(raw.lastRunAt) || 0,
      runs: Array.isArray(raw.runs) ? raw.runs.slice(-100) : [],
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    }
  } catch {
    return { lastRunAt: 0, runs: [], seen: {} }
  }
}

function writeState(dataDir, st) {
  const file = path.join(dataDir, STATE_FILE)
  const cutoff = now() - STATE_KEEP_DAYS * 24 * 3600 * 1000
  const seen = {}
  for (const [k, v] of Object.entries(st.seen || {})) if (Number(v) > cutoff) seen[k] = Number(v)
  const body = { lastRunAt: Number(st.lastRunAt) || 0, runs: (st.runs || []).slice(-100), seen }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(body, null, 1))
    fs.renameSync(tmp, file)   // 原子替换：写一半断电不会留下半个 JSON
  } catch (e) {
    // 落盘失败只影响「下次别再看同一条」，不该拦住这次的功能
    try { console.warn('[看视频的地方] 状态落盘失败: ' + e.message) } catch { /* ignore */ }
  }
}

/**
 * 用户填的分区 → B 站 rid 列表。
 * 认三种写法：中文名（全站/知识…）、B 站编号（0/1000…）、以及它们混着写。
 * 认不出来的直接忽略（宁可少看一个分区，也不因为一个错字整轮不跑）。
 */
function resolveRegions(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\s]+/)
  const byLabel = new Map(BILI_REGIONS.map((r) => [r.label, r.value]))
  const known = new Set(BILI_REGIONS.map((r) => r.value))
  const out = []
  for (const x of list) {
    const t = String(x || '').trim()
    if (!t) continue
    const rid = byLabel.get(t) ?? (known.has(t) ? t : '')
    if (rid && !out.includes(rid)) out.push(rid)
  }
  return out.length ? out : ['0']   // 一个都没认出来 = 退回全站，别让功能整个停摆
}

/** 按文件头认图片 MIME（侧车通常给 JPEG，但不硬编码） */
function mediaTypeOf(buf) {
  if (!buf?.length) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') return 'image/webp'
  return 'image/jpeg'
}

export default {
  id: 'video-wander',
  title: '自己找视频看',
  order: 47,

  configSchema: {
    // ── 常用 ────────────────────────────────────────────────
    enabled: {
      type: 'bool', default: true, group: '自己找视频看',
      label: '启用「自己找视频看」插件',
      hint: '关 = 整个插件停用（连控制台这一页都会变成「已禁用」）。只想临时停掉自动看，用下面那个开关就行。',
    },
    autoEnabled: {
      type: 'bool', default: false, group: '自己找视频看',
      label: '自动看视频（每几个小时自己挑一个）',
      hint: '开：每隔「多久看一次」这么久，自己从 B 站排行榜挑一个视频，下载抽帧真看一遍，'
        + '把感想和链接私聊发给你。\n'
        + '关（默认）：不会自己跑，但插件仍然启着 —— 你在控制台点「立刻看一个」还能手动触发。',
    },
    everyHours: {
      type: 'int', default: 4, unit: '小时', group: '自己找视频看',
      min: 1, max: 72, step: 1,
      label: '多久看一次',
      hint: '两次「自己找视频看」之间至少隔这么久。默认 4 小时（一天最多 6 次，还要受下面「每天最多」限制）。',
    },
    maxPerDay: {
      type: 'int', default: 6, unit: '次', group: '自己找视频看',
      min: 0, max: 24, step: 1,
      label: '每天最多看几次',
      hint: '按自然日算（本地时间 0 点重置）。0 = 一天都不看（等于关掉）。',
    },
    regions: {
      // 控制台没有多选控件，用逗号分隔的列表（type:'group' 就是干这个的）；
      // 中文分区名和 B 站 rid 都认，见 resolveRegions()
      type: 'group', default: ['全站'], group: '自己找视频看',
      label: '从哪些分区挑（逗号分隔，可写名字或编号）',
      hint: '从这些分区的「热门排行」里随机挑；写几个就每个都拉一遍再一起挑，更容易碰到不一样的东西。\n'
        + '可选名字：' + BILI_REGIONS.map((r) => r.label).join(' / ') + '。\n'
        + '也认 B 站分区编号（' + BILI_REGIONS.slice(0, 4).map((r) => r.value + '=' + r.label).join('、') + ' …）。默认「全站」。',
    },
    masterQq: {
      type: 'str', default: '', group: '自己找视频看',
      label: '看完发给谁（QQ 号）',
      hint: '留空 = 发给实例配置里的主人 QQ（adminQq，也就是能发命令的那个号）。'
        + '填了就以这里为准；必须是你自己的号，不然它会去骚扰别人。',
    },
    thoughtMaxChars: {
      type: 'int', default: 300, unit: '字', group: '自己找视频看',
      min: 30, max: 2000, step: 10,
      label: '感想最多多少字',
      hint: '提示里要求它写多长；超了会按这个数字截断再发（免得一条私聊甩几千字过来）。',
    },
    // ── 挑视频 ──────────────────────────────────────────────
    candidatesLimit: {
      type: 'int', default: 30, unit: '条', group: '自己找视频看', advanced: true,
      min: 1, max: 100, step: 1,
      label: '每个分区拉多少条候选',
      hint: '排行榜一次最多给 100 条。拉得多 = 更不容易总挑到同一批。默认 30。',
    },
    maxPickTries: {
      type: 'int', default: 3, unit: '次', group: '自己找视频看', advanced: true,
      min: 1, max: 10, step: 1,
      label: '一个下不动就换几个试试',
      hint: 'B 站偶尔有不给下载的稿子（版权/分区限制）。挑中但下载失败时，换个候选再试，最多试这么多次。'
        + '默认 3 —— 全都失败就当这次没看成，不打扰你。',
    },
    excludeDays: {
      type: 'int', default: 14, unit: '天', group: '自己找视频看', advanced: true,
      min: 0, max: 90, step: 1,
      label: '多久之内看过的不再挑',
      hint: '同一个 BV 号在这段时间内不会被再挑中。0 = 不排除（可能重复看同一条）。默认 14 天。',
    },
    // ── 看的时候 ────────────────────────────────────────────
    frames: {
      type: 'int', default: 8, unit: '帧', group: '自己找视频看', advanced: true,
      min: 1, max: 12, step: 1,
      label: '抽几帧',
      hint: '跟「看视频」一致即可。帧越多它看得越全，但一次多模态调用也越贵。',
    },
    maxSide: {
      type: 'int', default: 1024, unit: 'px', group: '自己找视频看', advanced: true,
      min: 256, max: 2048, step: 64,
      label: '帧的长边像素',
      hint: '1024 足够看清画面；DSH 单图上限 2MB，压到这个尺寸基本不会超。',
    },
    maxMinutes: {
      type: 'int', default: 15, unit: '分钟', group: '自己找视频看', advanced: true,
      min: 1, max: 120, step: 1,
      label: '最长看多久的视频',
      hint: '超过这个时长的视频直接跳过（换一个）。默认 15 分钟——排行榜上长视频不少，不设上限会一直看纪录片。',
    },
    sidecarUrl: {
      type: 'str', default: 'http://127.0.0.1:3972', group: '自己找视频看', advanced: true,
      label: '侧车地址',
      hint: '跟「看视频」共用一个侧车。留空 = 不跑（本插件需要它下载抽帧）。',
    },
    sidecarTimeoutSec: {
      type: 'int', default: 300, unit: '秒', group: '自己找视频看', advanced: true,
      min: 30, max: 900, step: 10,
      label: '等侧车的超时',
      hint: '链接要现下载，比群文件慢。超时就放弃这一次（不会记进「已看」，下次还能再挑）。',
    },
    reportGraceSec: {
      type: 'int', default: 20, unit: '秒', group: '自己找视频看', advanced: true,
      min: 5, max: 180, step: 5,
      label: '它说完话后再等多久收感想',
      hint: '实测模型常常「先回一句话、下一步才调工具交感想」。这一轮讲完之后再等这么久，'
        + '还没交才算它没写。默认 20 秒；模型慢的时候可以调大。',
    },
    turnTimeoutMinutes: {
      type: 'int', default: 8, unit: '分钟', group: '自己找视频看', advanced: true,
      min: 1, max: 30, step: 1,
      label: '等它写完感想的超时',
      hint: '起一轮模型看帧 + 写感想，超过这么久还没交就放弃这一次。',
    },
    retryMinutes: {
      type: 'int', default: 30, unit: '分钟', group: '自己找视频看', advanced: true,
      min: 5, max: 360, step: 5,
      label: '失败后多久再试',
      hint: '侧车挂了 / 没挑到合适的 / 模型没写，都按这个间隔重试（不算进「多久看一次」的正常节奏）。',
    },
    // ── 静默时段（自己一套，跟主动接话解耦）──────────────────
    quietEnabled: {
      type: 'bool', default: true, group: '自己找视频看',
      label: '静默时段内不看',
      hint: '开（默认）：下面这段时间里不起新的观看（正在进行的那次会照常跑完）。\n'
        + '注意这和「主动接话」的静默时段是**两套**配置，可以设成不一样。',
    },
    quietStart: {
      type: 'int', default: 1, unit: '点', group: '自己找视频看',
      min: 0, max: 23, step: 1,
      label: '静默开始',
      hint: '几点开始不看（0~23）。默认 1 点。',
    },
    quietEnd: {
      type: 'int', default: 8, unit: '点', group: '自己找视频看',
      min: 0, max: 24, step: 1,
      label: '静默结束',
      hint: '几点恢复（0~24）。默认 8 点。开始大于结束 = 跨零点；起止相同 = 不启用静默。',
    },
    // ── 发出去的样子 ─────────────────────────────────────────
    sendLink: {
      type: 'bool', default: true, group: '自己找视频看',
      label: '感想后面附视频链接',
      hint: '开（默认）：消息末尾带上 https://www.bilibili.com/video/<BV号>，你想看就点。关：只发感想。',
    },
    sendTitle: {
      type: 'bool', default: true, group: '自己找视频看',
      label: '也带上视频标题和时长',
      hint: '开（默认）：在感想前面标一行「看了：<标题>（<时长>）」，不然你不知道它在说哪个视频。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const dataDir = String(bot.core?.dataDir || '')
    const log = bot.log || console

    const dsh = bot.dsh
    if (!dsh || typeof dsh.ensureSession !== 'function') {
      log.warn('[看视频的地方] 会话控制器不可用，插件不启用')
      return
    }

    const SESSION_KEY = 'desk:video-wander'
    const SESSION_TITLE = '看视频的地方'
    const ALLOWED_TOOLS = ['report_watched', 'skip_watching', 'watch_status']

    let running = false
    let timer = null
    /** 本轮它交上来的东西（report_watched / skip_watching 写这里，轮次结束后统一发） */
    let pending = null

    const state = () => readState(dataDir)
    const save = (st) => writeState(dataDir, st)

    const quietOn = () => cfg().quietEnabled !== false
    const inQuiet = (ts = now()) => {
      if (!quietOn()) return false
      const s = Math.max(0, Math.min(23, Math.round(num(cfg().quietStart, 1))))
      const e = Math.max(0, Math.min(24, Math.round(num(cfg().quietEnd, 8))))
      if (s === e) return false
      const h = new Date(ts).getHours()
      return s < e ? (h >= s && h < e) : (h >= s || h < e)
    }

    /** 今天的次数（自然日，本地时间） */
    const runsToday = (st) => (st.runs || []).filter((r) => localDate(Number(r.at) || 0) === localDate()).length

    /** 正常节奏下的下次到点时间 */
    const dueAt = (st) => Number(st.lastRunAt || 0) + Math.max(1, num(cfg().everyHours, 4)) * 3600 * 1000

    /** 失败/空手而归之后：把 lastRunAt 往前挪，等于「retryMinutes 后再试」 */
    function backoff(st) {
      const gapMs = Math.max(1, num(cfg().everyHours, 4)) * 3600 * 1000
      st.lastRunAt = now() - gapMs + Math.max(5, num(cfg().retryMinutes, 30)) * 60000
      save(st)
    }

    // ── 挑视频 ──────────────────────────────────────────────
    /**
     * 拉排行榜 → 过滤（超时长 / 太短 / 最近看过）→ 随机挑一条。
     * 多分区时每个分区各拉一遍再合并去重 —— 单看「全站」容易天天是同一批大 UP。
     */
    /**
     * 拉一个接口，返回 { ok, list } 或 { ok:false, why, risked }。
     * ⚠️ B 站风控时 HTTP 200 + code:-352，所以必须判 code，不能只看 res.ok。
     */
    async function fetchJson(url) {
      const res = await fetch(url, {
        headers: { 'user-agent': BRIEF_UA, referer: 'https://www.bilibili.com/', accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return { ok: false, why: 'HTTP ' + res.status }
      let data = null
      try { data = await res.json() } catch { return { ok: false, why: '返回不是 JSON' } }
      const code = Number(data?.code)
      if (code !== 0) {
        // -352 / -412 = 风控或拦截；其它按普通失败
        const risked = code === -352 || code === -412
        return { ok: false, why: (risked ? '被 B 站挡了（code ' + code + '）' : 'code ' + code), risked }
      }
      const list = data?.data?.list || data?.data?.archives || []
      return { ok: true, list: Array.isArray(list) ? list : [] }
    }

    async function pickVideo(st, tried = new Set()) {
      const regions = resolveRegions(cfg().regions)
      const limit = Math.max(1, Math.min(100, num(cfg().candidatesLimit, 30)))
      const maxSec = Math.max(1, num(cfg().maxMinutes, 15)) * 60
      const excludeDays = Math.max(0, num(cfg().excludeDays, 14))
      const cutoff = excludeDays > 0 ? now() - excludeDays * 24 * 3600 * 1000 : 0

      const pool = new Map()
      // 一个接口被挡（-352）之后，本轮就别再打它了 —— 越打越久
      const blocked = new Set()
      let firstGap = true

      for (const rid of regions) {
        // 接口按「抗风控能力」排序：全站优先综合热门；指定分区优先旧版排行
        const plan = rid === '0'
          ? [['popular', () => BILI_APIS.popular(limit)], ['rankingV1', () => BILI_APIS.rankingV1(rid)], ['rankingV2', () => BILI_APIS.rankingV2(rid)]]
          : [['rankingV1', () => BILI_APIS.rankingV1(rid)], ['rankingV2', () => BILI_APIS.rankingV2(rid)]]

        for (const [name, urlOf] of plan) {
          if (blocked.has(name)) continue
          // ⚠️ 这个 setTimeout 不能 unref：它在 await 里，一 unref 事件循环就可能变空，
          //    这个 Promise 永远不 resolve，测试会被 Node 判成 "event loop resolved" 而 cancel。
          if (!firstGap) await new Promise((r) => setTimeout(r, API_GAP_MS))
          firstGap = false
          const got = await fetchJson(urlOf())
          if (!got.ok) {
            log.warn('[看视频的地方] ' + name + ' 取候选失败（rid=' + rid + '）: ' + got.why)
            if (got.risked) blocked.add(name)   // 风控了：本轮不再打这个接口
            continue
          }
          if (!got.list.length) { log.warn('[看视频的地方] ' + name + ' 返回 0 条（rid=' + rid + '）'); continue }

          for (const v of got.list.slice(0, limit)) {
            const bvid = String(v?.bvid || '').trim()
            if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue
            if (pool.has(bvid)) continue
            const duration = Number(v?.duration) || 0
            if (duration > maxSec) continue                                 // 太长，跳过
            if (duration > 0 && duration < 20) continue                      // 十几秒的切片没内容可看
            if (tried.has(bvid)) continue                                     // 本轮已经试过、失败了
            if (cutoff && Number(st.seen?.[bvid] || 0) > cutoff) continue     // 最近看过
            pool.set(bvid, {
              bvid,
              title: String(v?.title || '').slice(0, 120),
              owner: String(v?.owner?.name || v?.owner?.name || '').slice(0, 60),
              tname: String(v?.tname || ''),
              duration,
              view: Number(v?.stat?.view) || 0,
              desc: String(v?.desc || '').slice(0, 300),
            })
          }
          // 这个分区已经有候选了，不用再试更差的接口
          if (pool.size) break
        }
      }
      if (!pool.size) return null
      const all = [...pool.values()]
      return all[Math.floor(Math.random() * all.length)]
    }

    // ── 侧车抽帧 ────────────────────────────────────────────
    async function readViaSidecar(url) {
      const base = String(cfg().sidecarUrl || '').trim().replace(/\/+$/, '')
      if (!base) return { ok: false, code: 'no_sidecar' }
      const timeoutMs = Math.max(30000, num(cfg().sidecarTimeoutSec, 300) * 1000)
      try {
        const res = await fetch(base + '/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url,
            platform: 'bilibili',
            frames: Math.max(1, num(cfg().frames, 8)),
            maxSide: Math.max(256, num(cfg().maxSide, 1024)),
            maxSeconds: Math.max(60, num(cfg().maxMinutes, 15) * 60),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const data = await res.json()
        return data?.ok
          ? { ok: true, ...data }
          : { ok: false, code: String(data?.code || 'failed'), error: String(data?.error || '') }
      } catch (e) {
        const aborted = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        return { ok: false, code: aborted ? 'timeout' : 'unreachable', error: String(e?.message || e) }
      }
    }

    // ── 会话 ────────────────────────────────────────────────
    async function ensureSession() {
      const sessionId = await dsh.ensureSession(SESSION_KEY, SESSION_TITLE)
      // 登记工具白名单：这个会话里除三件套之外的工具一律被内核拒掉
      try { bot.core?.markScope?.(sessionId, SESSION_TITLE, ALLOWED_TOOLS) } catch { /* 老内核没有这个槽，工具守卫仍在 */ }
      try { if (typeof dsh.rename === 'function') await dsh.rename(sessionId, SESSION_TITLE) } catch { /* 改名失败不影响 */ }
      return sessionId
    }

    /**
     * 起一轮，然后**等它把感想交上来**。
     *
     * ⚠️ 不能只听 turn/end 就走：实测模型常常"先回一句话、下一个 turn 才调工具"
     *   （2026-10-29 线上就是：turn/end 后 1.5 秒判了 no_report，紧接着 report_watched 才到，
     *   于是这条视频白看了）。所以这里改成"轮询 pending + turn 结束后的宽限期"：
     *     · 一直到超时为止，每 POLL_MS 看一眼 pending 有没有值；
     *     · turn 结束后再宽限 reportGraceSec 秒（模型可能还在写工具调用）；
     *     · 宽限期过了仍然没有 → 才算它这轮没交。
     * @returns {Promise<{timeout:boolean, got:object|null}>}
     */
    function promptAndWait(sessionId, text, imageParts, timeoutMs) {
      return new Promise((resolve) => {
        const POLL_MS = 300
        const started = now()
        const hardDeadline = started + Math.max(30000, Number(timeoutMs) || 600000)
        let turnEndedAt = 0
        let off = null
        let done = false
        let ticker = null
        const finish = (v) => {
          if (done) return
          done = true
          if (ticker) clearInterval(ticker)
          try { off?.() } catch { /* ignore */ }
          resolve(v)
        }
        try {
          off = dsh.onTurnEnd(sessionId, () => { if (!turnEndedAt) turnEndedAt = now() })
        } catch (e) {
          return finish({ timeout: false, got: null, error: String(e?.message || e) })
        }
        ticker = setInterval(() => {
          if (pending) return finish({ timeout: false, got: pending })
          const t = now()
          const graceMs = Math.max(0, num(cfg().reportGraceSec, 20)) * 1000
          if (turnEndedAt && t - turnEndedAt > graceMs) {
            // 宽限期过了、还是没交 → 这轮算没交（不是超时，是"它没写"）
            return finish({ timeout: false, got: null })
          }
          if (t > hardDeadline) return finish({ timeout: true, got: null })
        }, POLL_MS)
        // ⚠️ 不能 unref：等待期间没有别的事可做，一 unref，Node 就认为事件循环空了，
        //    会把还在 pending 的 Promise 直接 cancel 掉（CI 的 Linux 上必现：
        //    "Promise resolution is still pending but the event loop has already resolved"）。
        //    finish() 会 clearInterval，不会泄漏。
        Promise.resolve()
          .then(() => dsh.prompt(sessionId, text, imageParts))
          .catch((e) => finish({ timeout: false, got: null, error: String(e?.message || e) }))
      })
    }

    /** 拼这一轮的提示词 —— 它看到的东西只有这些，别替它总结 */
    function buildPrompt(video, durText) {
      const lines = []
      lines.push('[看视频的地方] 这是你自己挑的一个 B 站视频，已经抽了几帧画面给你（按时间顺序）。')
      lines.push('')
      lines.push('视频：' + (video.title || '（无标题）'))
      if (video.owner) lines.push('UP 主：' + video.owner)
      const meta = []
      if (video.tname) meta.push('分区 ' + video.tname)
      if (durText) meta.push('时长 ' + durText)
      if (video.view) meta.push('播放 ' + viewText(video.view))
      if (meta.length) lines.push('信息：' + meta.join(' ｜ '))
      if (video.desc) lines.push('简介：' + video.desc)
      lines.push('')
      lines.push('下面这些图就是这个视频的画面。**只看你看得见的**：画面里有什么、在讲什么、你的感觉。')
      lines.push('看不清、看不懂、觉得无聊 —— 都可以直接说，别编画面里没有的东西。')
      lines.push('')
      const maxChars = Math.max(30, num(cfg().thoughtMaxChars, 300))
      lines.push('**你现在只有两个动作可做，必须选一个调用：**')
      lines.push('')
      lines.push('1. report_watched(thought="你的感想") —— 正常看完了，想把感觉说出来')
      lines.push('   不超过 ' + maxChars + ' 字，用你自己平时说话的语气，别写成影评/复述简介。')
      lines.push('2. skip_watching(reason="为什么不写") —— 画面看不清、内容没意思、什么都说不上来')
      lines.push('')
      lines.push('例子：report_watched(thought="开头那几下打磨声还挺解压，后面一直在讲切工，我其实是盯着那个光斑看完的。")')
      lines.push('')
      lines.push('⚠️ 这个会话里 **send_message 是不可用的**（你不在任何聊天里）。')
      lines.push('   写了正文而不调上面两个工具 = 这段白看了，谁也不会收到。交上去我负责发给主人。')
      return lines.join('\n')
    }

    // ── 一次完整的「自己看视频」 ─────────────────────────────
    async function runOnce(reason) {
      if (running) return { skipped: 'running' }
      running = true
      pending = null
      const st = state()
      try {
        // 挑一个 → 下载抽帧；下不动就换下一个（B 站偶有不让下载的稿子），最多换 maxPickTries 次
        const tried = new Set()
        const maxTries = Math.max(1, num(cfg().maxPickTries, 3))
        let video = null
        let data = null
        for (let i = 0; i < maxTries; i += 1) {
          const cand = await pickVideo(st, tried)
          if (!cand) break
          const candidateUrl = 'https://www.bilibili.com/video/' + cand.bvid
          log.info('[看视频的地方] 挑中 ' + cand.bvid + '「' + cand.title.slice(0, 30) + '」（' + reason + '，第 ' + (i + 1) + ' 次）')
          const got = await readViaSidecar(candidateUrl)
          if (got.ok) { video = cand; data = got; break }
          log.warn('[看视频的地方] 看不成 ' + cand.bvid + ': ' + (got.code || '') + ' ' + (got.error || '') + ' —— 换一个')
          tried.add(cand.bvid)
        }
        if (!video) {
          log.info('[看视频的地方] 试了 ' + tried.size + ' 个都没看成（' + reason + '），' + num(cfg().retryMinutes, 30) + ' 分钟后再试')
          backoff(st)
          return { ok: false, reason: tried.size ? 'all_failed' : 'no_candidate' }
        }
        const url = 'https://www.bilibili.com/video/' + video.bvid

        // 读帧 → base64（跟 video-link-read 同一套）
        const imageParts = []
        for (const f of Array.isArray(data.frames) ? data.frames : []) {
          try {
            const buf = await fs.promises.readFile(String(f.path || ''))
            if (!buf.length) continue
            imageParts.push({ mediaType: mediaTypeOf(buf), data: buf.toString('base64'), name: 'frame@' + (Number(f.sec) || 0) + 's' })
          } catch (e) {
            log.warn('[看视频的地方] 读帧失败 ' + f.path + ': ' + e.message)
          }
        }
        if (!imageParts.length) {
          log.warn('[看视频的地方] 一帧都没读出来，放弃 ' + video.bvid)
          backoff(st)
          return { ok: false, reason: 'no_frames' }
        }

        const durSec = Number(data.durationSec) || video.duration
        const sessionId = await ensureSession()
        const turn = await promptAndWait(
          sessionId,
          buildPrompt(video, durSec ? mmss(durSec) : ''),
          imageParts,
          Math.max(1, num(cfg().turnTimeoutMinutes, 8)) * 60000,
        )

        // 标记「看过」：不管它写没写，视频是真的看了，避免下次又挑同一条
        st.seen = { ...(st.seen || {}), [video.bvid]: now() }
        st.lastRunAt = now()

        const got = turn.got
        pending = null
        if (!got) {
          st.runs.push({ at: now(), bvid: video.bvid, title: video.title.slice(0, 60), ok: false, reason: turn.timeout ? 'timeout' : 'no_report' })
          save(st)
          log.warn('[看视频的地方] 看完了但它没交感想（' + (turn.timeout ? '超时' : '只回了话没调工具') + '）—— 不打扰主人')
          return { ok: false, reason: 'no_report' }
        }
        if (got.kind === 'skip') {
          st.runs.push({ at: now(), bvid: video.bvid, title: video.title.slice(0, 60), ok: true, reason: 'skip:' + String(got.reason || '').slice(0, 80) })
          save(st)
          log.info('[看视频的地方] 它决定不写这条（' + String(got.reason || '未说原因').slice(0, 60) + '）—— 不打扰主人')
          return { ok: true, skipped: true }
        }

        const text = composeMessage(video, got.thought)
        const to = masterTarget()
        if (!to) {
          log.warn('[看视频的地方] 没有可用的主人 QQ（masterQq 与 adminQq 都为空），本次不发')
          st.runs.push({ at: now(), bvid: video.bvid, title: video.title.slice(0, 60), ok: false, reason: 'no_master' })
          save(st)
          return { ok: false, reason: 'no_master' }
        }
        await bot.deliver(to, text)
        st.runs.push({ at: now(), bvid: video.bvid, title: video.title.slice(0, 60), ok: true, reason: 'sent' })
        save(st)
        log.info('[看视频的地方] 已发给 ' + to + '：' + video.bvid + '（' + got.thought.length + ' 字）')
        return { ok: true, sent: true, to, bvid: video.bvid }
      } catch (e) {
        log.error('[看视频的地方] 本轮失败: ' + (e?.stack || e?.message || e))
        st.lastRunAt = now()   // 记一次，避免失败后每 60 秒重试一次刷日志
        save(st)
        return { ok: false, reason: String(e?.message || e) }
      } finally {
        running = false
        pending = null
      }
    }

    // ── 消息组装 ────────────────────────────────────────────
    function masterTarget() {
      const raw = String(cfg().masterQq || '').trim() || String(bot.core?.adminQq || '').trim()
      const qq = raw.replace(/\D/g, '')
      return /^\d{4,12}$/.test(qq) ? 'private:' + qq : ''
    }

    function composeMessage(video, thought) {
      const maxChars = Math.max(30, num(cfg().thoughtMaxChars, 300))
      let body = String(thought || '').trim()
      if (body.length > maxChars) body = body.slice(0, maxChars).replace(/\s+$/, '') + '…'
      const parts = []
      if (cfg().sendTitle !== false) {
        const dur = video.duration ? '（' + mmss(video.duration) + '）' : ''
        parts.push('看了：' + (video.title || video.bvid) + dur)
        parts.push('')
      }
      parts.push(body)
      if (cfg().sendLink !== false) {
        parts.push('')
        parts.push('https://www.bilibili.com/video/' + video.bvid)
      }
      return parts.join('\n')
    }

    // ── 工具（只在这个会话里能调）───────────────────────────
    bot.registerTool('report_watched', {
      description: '把看完这个视频的感想交上去（由内核转成一条私聊发给主人）。只在你自己的「看视频的地方」会话里可用。',
      parameters: {
        thought: { type: 'string', required: true, description: '你的感想：看到什么、想到什么，用平时说话的语气，别写成影评' },
      },
      async execute(args = {}) {
        const text = String(args.thought ?? '').trim()
        log.info('[看视频的地方] report_watched 被调用（' + text.length + ' 字）')
        if (!text) return { ok: false, reason: 'thought 不能为空' }
        pending = { kind: 'report', thought: text, at: now() }
        return { ok: true, message: '记下了，我会替你发给主人' }
      },
    })

    bot.registerTool('skip_watching', {
      description: '这次看了但不想写（没内容、看不懂、觉得没意思都算）。比硬写一篇空的强。只在你自己的「看视频的地方」会话里可用。',
      parameters: {
        reason: { type: 'string', description: '为什么不写（一句话就够，会记进日志给你自己看）' },
      },
      async execute(args = {}) {
        log.info('[看视频的地方] skip_watching 被调用（' + String(args.reason ?? '').slice(0, 40) + '）')
        pending = { kind: 'skip', reason: String(args.reason ?? '').slice(0, 200), at: now() }
        return { ok: true, message: '好，这次不写' }
      },
    })

    bot.registerTool('watch_status', {
      description: '查自己「看视频」的节奏：多久看一次、今天看了几次、上次看了什么。想确认还能不能看时用。',
      parameters: {},
      async execute() {
        const st = state()
        const last = [...(st.runs || [])].reverse().find((r) => r.ok)
        return {
          ok: true,
          enabled: pluginOn(),
          autoEnabled: autoOn(),
          everyHours: num(cfg().everyHours, 4),
          maxPerDay: num(cfg().maxPerDay, 6),
          todayCount: runsToday(st),
          lastRunAt: Number(st.lastRunAt) || null,
          nextDueAt: dueAt(st),
          lastWatched: last ? { at: last.at, bvid: last.bvid, title: last.title } : null,
          quiet: { enabled: quietOn(), start: num(cfg().quietStart, 1), end: num(cfg().quietEnd, 8), active: inQuiet() },
        }
      },
    })

    // ── 定时器 ──────────────────────────────────────────────
    /** 插件是否启用（控制台「启用插件」那个开关；关掉内核就当它不存在） */
    const pluginOn = () => cfg().enabled !== false
    /**
     * 会不会「自己」跑。手动触发（控制台按钮 / bot.shared.videoWanderRunNow）不看这个开关 ——
     * 用户点了就是要看，不该被「自动开关」拦住。
     */
    function autoOn() {
      return pluginOn() && cfg().autoEnabled === true && num(cfg().maxPerDay, 6) > 0
    }

    function tick() {
      if (!autoOn() || running) return
      if (!String(cfg().sidecarUrl || '').trim()) return
      if (inQuiet()) return
      const st = state()
      if (runsToday(st) >= Math.max(0, num(cfg().maxPerDay, 6))) return
      if (now() < dueAt(st)) return
      runOnce('到点自己看').catch((e) => log.error('[看视频的地方] 定时触发失败: ' + (e?.message || e)))
    }

    function start() {
      if (timer) clearInterval(timer)
      timer = null
      if (!autoOn()) return null
      // 60 秒一查：比「每 4 小时一次」细得多，但每次只是一次 Map 查找，开销可以忽略；
      // 用长间隔会让「到点」偏出好几分钟，反而显得不自然
      timer = setInterval(() => {
        try { tick() } catch (e) { log.error('[看视频的地方] tick 异常: ' + (e?.message || e)) }
      }, 60000)
      timer.unref?.()
      return timer
    }

    function stop() {
      if (timer) clearInterval(timer)
      timer = null
    }

    start()
    bot.onDispose?.(() => { try { stop() } catch { /* ignore */ } })

    // 控制台 / 其他插件可以手动触发一次，也能查状态
    bot.shared.videoWanderRunNow = (note) => runOnce(String(note || '手动触发'))
    bot.shared.videoWanderStatus = () => {
      const st = state()
      return {
        ok: true,
        enabled: pluginOn(),
          autoEnabled: autoOn(),
        everyHours: num(cfg().everyHours, 4),
        maxPerDay: Math.max(0, num(cfg().maxPerDay, 6)),
        todayCount: runsToday(st),
        lastRunAt: Number(st.lastRunAt) || null,
        nextDueAt: dueAt(st),
        running,
        quiet: { enabled: quietOn(), start: num(cfg().quietStart, 1), end: num(cfg().quietEnd, 8), active: inQuiet() },
        recent: (st.runs || []).slice(-8).reverse(),
      }
    }
    bot.shared.videoWanderReload = () => { stop(); start() }

    log.info('[看视频的地方] 已装配：' + (autoOn()
      ? '自动看=开（每 ' + num(cfg().everyHours, 4) + ' 小时最多一次，每天 ≤' + num(cfg().maxPerDay, 6) + ' 次）'
      : '自动看=关'))
  },
}
