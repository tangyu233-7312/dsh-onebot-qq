/**
 * qq-sidecar — QQ 机器人的「解析 / 看视频」侧车（站点私有，不进 dsh-onebot-qq 包）
 *
 * 为什么有这个进程：`dsh-onebot-qq` 的子插件跑在 DSH 宿主进程内，包内红线**禁止 child_process**，
 * 而下载 / 抽帧必须调 yt-dlp + ffmpeg。所以把「起子进程」挪到进程外，插件只发 HTTP。
 *
 * 对外两个端点（都只 bind 127.0.0.1）：
 *   GET  /health  → { ok, ffmpeg, ytdlp, queue, dirs }
 *   POST /read    → 看视频：下载(或本地文件) → ffprobe 探时长 → ffmpeg 抽帧 → 返回帧路径
 *   POST /parse   → 解析链接：下载媒体 → 返回本地路径（供 plugins/link-parser 搬运）
 *
 * 三条纪律（改之前先读）：
 *   ① **群友能间接触发**（发视频 / 贴链接）→ 必须做 host 白名单 + 私网拒绝 + 本地路径白名单。
 *   ② **失败一律 200 + ok:false**，让插件能干净降级，不要 500 把插件的 try/catch 变成猜谜。
 *   ③ **用完就删**：源视频几百兆，攒几天机器就满。帧目录延迟删（插件还在读）。
 *
 * 启动：双击同目录的 start.bat（或 `node server.mjs`）。
 * 零 npm 依赖：只用 Node 内置模块。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '1.0.0'

// ── 配置：sidecar.config.json（不存在就用这里的默认值）────────────────
const DEFAULTS = {
  port: 3972,
  host: '127.0.0.1',
  token: '',                      // 非空时要求请求头 x-token 一致
  pythonPath: '',                 // 跑 yt-dlp 用的 python（空 = 用 yt-dlp 可执行文件）
  ffmpegPath: '',                 // 空 = 从 PATH / 常见安装位置找
  ffprobePath: '',
  ytdlpPath: '',                  // 空 = 依次试 python -m yt_dlp / yt-dlp
  maxMb: 250,                     // 单文件上限
  maxSeconds: 600,                // 单视频时长上限
  maxFrames: 12,                  // 单次最多抽几帧
  concurrency: 2,                 // 同时最多几个任务（多了直接 busy）
  taskTimeoutMs: 300000,          // 单个任务总超时（5 分钟）
  frameTtlMs: 600000,             // 帧目录保留多久（10 分钟）
  reuseMinutes: 10,               // 同一链接多久内复用已下载文件（抽帧 + 搬进群只下一次）
  maxCacheMb: 2048,               // 临时目录总量上限
  allowLocalDirs: [],             // 允许读取的本地目录前缀（空 = 只允许 tmpDir 与 NapCat 目录）
  allowedHosts: [
    'bilibili.com', 'b23.tv', 'bili2233.cn',
    'douyin.com', 'iesdouyin.com', 'v.douyin.com',
  ],
}

function loadConfig() {
  const file = path.join(HERE, 'sidecar.config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return { ...DEFAULTS, ...raw, _file: file }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[sidecar] 配置读取失败，用默认值: ${e.message}`)
    return { ...DEFAULTS }
  }
}
const CFG = loadConfig()

const TMP = path.join(os.tmpdir(), 'qq-sidecar')
const DL_DIR = path.join(TMP, 'downloads')
const FRAME_DIR = path.join(TMP, 'frames')

// ── 小工具 ──────────────────────────────────────────────────────────
const log = (...a) => console.error(`[sidecar ${new Date().toISOString().slice(11, 19)}]`, ...a)
const nowMs = () => Date.now()
const rand = () => crypto.randomBytes(4).toString('hex')
const mb = (n) => Math.round((Number(n) || 0) / 1048576 * 10) / 10

/** 找 ffmpeg/ffprobe：配置 → 环境变量 → PATH → 已知的 winget 安装位置 */
function findBin(kind, configured) {
  const exe = process.platform === 'win32' ? `${kind}.exe` : kind
  const cands = []
  if (configured) cands.push(configured)
  const envKey = `${kind.toUpperCase()}_PATH`
  if (process.env[envKey]) cands.push(process.env[envKey])
  cands.push(exe)   // 交给 PATH
  // Gyan winget 包（本机实测存在的位置）；找不到就靠 PATH
  const winget = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const d of fs.readdirSync(winget)) {
      if (!/^Gyan\.FFmpeg/i.test(d)) continue
      const bin = path.join(winget, d)
      for (const sub of fs.readdirSync(bin)) cands.push(path.join(bin, sub, 'bin', exe))
    }
  } catch { /* 没有 winget 就算了 */ }
  for (const c of cands) {
    try {
      if (c === exe) return c                     // PATH 名字，直接信
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch { /* 忽略 */ }
  }
  return ''
}
const FFMPEG = findBin('ffmpeg', CFG.ffmpegPath)
const FFPROBE = findBin('ffprobe', CFG.ffprobePath)

/** yt-dlp 的调用方式（python -m yt_dlp 或可执行文件） */
function ytdlpCmd() {
  if (CFG.ytdlpPath) return { cmd: CFG.ytdlpPath, pre: [] }
  if (CFG.pythonPath) return { cmd: CFG.pythonPath, pre: ['-m', 'yt_dlp'] }
  return { cmd: 'yt-dlp', pre: [] }
}

/**
 * cookie 参数：抖音现在**必须**带 cookie（yt-dlp 会报 "Fresh cookies ... are needed"）。
 * 两种给法，配一个就行：
 *   · cookiesFromBrowser: "edge" / "chrome" / "firefox" —— 直接借浏览器里已登录的 cookie
 *   · cookiesFile: "C:\\path\\cookies.txt" —— 事先导出的 Netscape 格式 cookie 文件
 * 都不配 = 只靠公开接口，B 站通常够用，抖音大概率失败。
 */
function cookieArgs() {
  const out = []
  const br = String(CFG.cookiesFromBrowser || '').trim()
  if (br) {
    for (const b of br.split(/[,，\s]+/).filter(Boolean)) out.push('--cookies-from-browser', b)
  }
  const f = String(CFG.cookiesFile || '').trim()
  if (f && fs.existsSync(f)) out.push('--cookies', f)
  return out
}

/** execFile 的 Promise 版（**参数走数组，绝不拼命令行**） */
function run(cmd, args, { timeout = CFG.taskTimeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '', error: err })
    })
  })
}

// ── 安全 ────────────────────────────────────────────────────────────
const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|7\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
const PRIVATE_V4_172 = /^172\.(1[6-9]|2\d|3[01])\./

function isPrivateHost(h) {
  if (!h) return true
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.test(h) || PRIVATE_V4_172.test(h)
  return false
}

function hostAllowed(urlStr) {
  let u
  try { u = new URL(urlStr) } catch { return { ok: false, why: 'URL 解析失败' } }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, why: `不支持的协议 ${u.protocol}` }
  const host = u.hostname.toLowerCase()
  if (isPrivateHost(host)) return { ok: false, why: `拒绝内网地址 ${host}` }
  const hit = CFG.allowedHosts.some((d) => host === d || host.endsWith(`.${d}`))
  if (!hit) return { ok: false, why: `域名不在白名单 ${host}` }
  return { ok: true, host }
}

/** 本地路径白名单：realpath 之后必须落在允许前缀里（防任意文件读） */
function localAllowed(p) {
  let real
  try { real = fs.realpathSync(p) } catch { return { ok: false, why: '文件不存在' } }
  const roots = [
    ...CFG.allowLocalDirs,
    // 系统临时目录整棵放行：QQ / NapCat 落盘的视频、语音、图片都在这里，
    // 而真正的敏感文件（~/.dsh/.credentials.yaml、config.json）不在临时目录下，仍然读不到。
    os.tmpdir(),
    path.join(os.homedir(), '.dsh', 'dsh-onebot-qq'),   // NapCat 落盘/资产目录
  ].filter(Boolean).map((r) => {
    try { return fs.realpathSync(r) } catch { return path.resolve(r) }
  })
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const ok = roots.some((r) => norm(real) === norm(r) || norm(real).startsWith(norm(r.endsWith(path.sep) ? r : r + path.sep)))
  if (!ok) return { ok: false, why: `路径不在允许目录内（允许：${roots.join(' | ')}）` }
  return { ok: true, real }
}

// ── 并发闸门 ────────────────────────────────────────────────────────
let running = 0
const queueInfo = () => ({ running, max: CFG.concurrency })
const probeYtdlp = { at: 0, ok: false, version: '' }

// ── 最近下载复用（"先搬视频、再发感想" 只下一次）─────────────────────
/**
 * url → { file, size, at, meta }。
 * 为什么要有：`video-link-read`（抽帧看内容）和 `link-parser`（把媒体搬进群）会对**同一个 URL**
 * 各发一次请求。没有这份缓存就是下载两遍（十几 MB × 2 + 两次 yt-dlp 元信息）。
 * 复用窗口见配置 `reuseMinutes`（默认 10 分钟）。
 */
const recentDownloads = new Map()
const reuseMs = () => Math.max(60_000, (Number(CFG.reuseMinutes) || 10) * 60_000)

function cachedDownload(url) {
  const hit = recentDownloads.get(String(url).trim())
  if (!hit) return null
  if (nowMs() - hit.at > reuseMs()) { recentDownloads.delete(String(url).trim()); return null }
  try {
    if (!fs.existsSync(hit.file)) { recentDownloads.delete(String(url).trim()); return null }
    return hit
  } catch { return null }
}
function rememberDownload(url, entry) {
  recentDownloads.set(String(url).trim(), { ...entry, at: nowMs() })
}

// ── 帧目录 / 下载目录清理 ────────────────────────────────────────────
async function sweep() {
  try {
    const dirs = await fsp.readdir(FRAME_DIR, { withFileTypes: true }).catch(() => [])
    let total = 0
    const entries = []
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const full = path.join(FRAME_DIR, d.name)
      const st = await fsp.stat(full).catch(() => null)
      if (!st) continue
      let size = 0
      for (const f of await fsp.readdir(full).catch(() => [])) {
        size += (await fsp.stat(path.join(full, f)).catch(() => ({ size: 0 }))).size
      }
      entries.push({ full, mtime: st.mtimeMs, size })
      total += size
    }
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const e of entries) {
      const tooOld = nowMs() - e.mtime > CFG.frameTtlMs
      const tooBig = total > CFG.maxCacheMb * 1048576
      if (tooOld || tooBig) {
        await fsp.rm(e.full, { recursive: true, force: true }).catch(() => {})
        total -= e.size
        log(`清理帧目录 ${path.basename(e.full)}（${tooOld ? '过期' : '超额度'}）`)
      }
    }

    // 下载目录：留着是给"搬进群"复用，过期 / 超额度就删
    const dlDirs = await fsp.readdir(DL_DIR, { withFileTypes: true }).catch(() => [])
    let dlTotal = 0
    const dlEntries = []
    for (const d of dlDirs) {
      if (!d.isDirectory()) continue
      const full = path.join(DL_DIR, d.name)
      const st = await fsp.stat(full).catch(() => null)
      if (!st) continue
      let size = 0
      for (const f of await fsp.readdir(full).catch(() => [])) {
        size += (await fsp.stat(path.join(full, f)).catch(() => ({ size: 0 }))).size
      }
      dlEntries.push({ full, mtime: st.mtimeMs, size })
      dlTotal += size
    }
    dlEntries.sort((a, b) => a.mtime - b.mtime)
    for (const e of dlEntries) {
      const tooOld = nowMs() - e.mtime > Math.max(reuseMs() * 2, CFG.frameTtlMs)
      const tooBig = dlTotal > CFG.maxCacheMb * 1048576
      if (tooOld || tooBig) {
        await fsp.rm(e.full, { recursive: true, force: true }).catch(() => {})
        dlTotal -= e.size
        log(`清理下载目录 ${path.basename(e.full)}（${tooOld ? '过期' : '超额度'}）`)
      }
    }
    // 缓存表顺手瘦身
    for (const [u, v] of recentDownloads) {
      if (nowMs() - v.at > reuseMs() || !fs.existsSync(v.file)) recentDownloads.delete(u)
    }
  } catch { /* 清理失败不影响服务 */ }
}
setInterval(sweep, 60_000).unref?.()

// ── /read：看视频 ────────────────────────────────────────────────────
async function probeDuration(file) {
  if (!FFPROBE) return 0
  const r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 30000 })
  const n = Number(String(r.stdout).trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 用 yt-dlp 先探元信息（不下载）：能拿到时长/标题，且能在下载前就拒掉超长视频 */
async function ytdlpMeta(url) {
  const { cmd, pre } = ytdlpCmd()
  const r = await run(cmd, [...pre, '-J', '--no-playlist', '--no-warnings', ...cookieArgs(), url], { timeout: 60000 })
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.stdout)
    return {
      title: String(j.title || '').slice(0, 120),
      durationSec: Number(j.duration) || 0,
      platform: /bilibili|b23/i.test(url) ? 'bilibili' : /douyin/i.test(url) ? 'douyin' : 'unknown',
      extractor: String(j.extractor_key || j.extractor || ''),
    }
  } catch { return null }
}

async function ytdlpDownload(url, outDir, { maxHeight = 720 } = {}) {
  const { cmd, pre } = ytdlpCmd()
  const tpl = path.join(outDir, '%(id)s.%(ext)s')
  // 封顶高度：太大对"看内容"没意义，只会让下载和抽帧都变慢。
  // 看视频传 480（帧长边 1024 都够，还快一半），搬媒体传 720（群里看着要清楚）。
  // ⚠️ 别用 `-f bv*[height<=N]+ba/b[height<=N]/b` 这种"硬过滤"：B 站有些稿件（竖屏/HEVC/只有高分辨率）
  //    一个 height<=N 的格式都没有，整条表达式就直接 "Requested format is not available"，视频下不下来。
  //    （2026-10-29 实测：BV18YxK6NEPy「一颗钻石里藏着多少光？」就是这么挂的）
  //    改用 -S 排序：先挑最接近 maxHeight 的，挑不到就往下降，任何稿件都有得选。
  const r = await run(cmd, [
    ...pre, '-f', 'bv*+ba/b/best', '-S', `res:${maxHeight}`,
    '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
    ...cookieArgs(),
    '-o', tpl, url,
  ], { timeout: CFG.taskTimeoutMs })
  if (!r.ok) {
    return { ok: false, error: String(r.stderr || r.error?.message || 'yt-dlp 失败').slice(0, 300) }
  }
  const files = (await fsp.readdir(outDir).catch(() => []))
    .map((f) => path.join(outDir, f))
    .filter((f) => /\.(mp4|mkv|webm|flv|m4a|mp3)$/i.test(f))
  const mp4 = files.find((f) => /\.mp4$/i.test(f)) || files[0]
  if (!mp4) return { ok: false, error: 'yt-dlp 没产出文件' }
  const st = await fsp.stat(mp4)
  return { ok: true, file: mp4, size: st.size }
}

/**
 * 直接 HTTP 下载（QQ CDN 那种直链走这条）。
 * yt-dlp 只适合它认识的平台；对 "xxx.cn/download?appid=..." 这种地址它会当成文件名，
 * Windows 上 ? 非法 → Errno 22。直链就直接 fetch。
 */
async function directDownload(url, outDir) {
  const dest = path.join(outDir, 'source.mp4')
  await fsp.mkdir(outDir, { recursive: true })
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CFG.taskTimeoutMs) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}（QQ 的直链通常带签名且会过期，可能已失效）` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, error: '下载到 0 字节' }
    if (buf.length > CFG.maxMb * 1048576) return { ok: false, error: `文件 ${mb(buf.length)}MB 超过上限 ${CFG.maxMb}MB` }
    await fsp.writeFile(dest, buf)
    return { ok: true, file: dest, size: buf.length }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) }
  }
}

/**
 * 请求里带的限制优先，配置文件只当默认值。
 * 为什么要这样：插件（控制台）里的「最长看多久 / 抽几帧」是用户真正在调的东西，
 * 侧车配置是部署时的兜底。原来这里只用 CFG，用户在控制台调多大都没用 ——
 * 表现出来就是「我把上限调到 1500 秒了，676 秒的视频还是说太长」（2026-10-29 踩过）。
 * 硬上限只是防失控：别让人填个 999999 把侧车挂在那儿下一整天。
 */
const HARD_CAP_SECONDS = 7200    // 2 小时
const HARD_CAP_FRAMES = 24

/**
 * 动态抽帧：短视频少抽、长视频多抽。
 * 为什么按时长走而不是固定：10 分钟的片子用 8 帧概括还行，11 分钟以上就开始"漏内容"了，
 * 多给 3 帧能明显把"讲了哪几段"接上；而 1 分钟的小视频抽 11 帧纯属浪费（相邻帧几乎一样）。
 * 阈值和帧数都由**插件传过来**（控制台可调），侧车只负责按实际时长选一个并卡硬上限。
 */
function pickFrames(durSec, { frames, framesLong, framesSplitSec }) {
  const short = Number(frames) > 0 ? Math.round(Number(frames)) : CFG.maxFrames
  const long = Number(framesLong) > 0 ? Math.round(Number(framesLong)) : short
  const split = Number(framesSplitSec) > 0 ? Number(framesSplitSec) : 600
  const want = Number(durSec) > split ? long : short
  return Math.max(1, Math.min(HARD_CAP_FRAMES, want))
}
function limitOf(body) {
  const wantSec = Number(body?.maxSeconds) > 0 ? Number(body.maxSeconds) : CFG.maxSeconds
  const wantFrames = Number(body?.frames) > 0 ? Number(body.frames) : CFG.maxFrames
  return {
    seconds: Math.min(wantSec, HARD_CAP_SECONDS),
    frames: Math.min(wantFrames, HARD_CAP_FRAMES),
  }
}

async function extractFrames(file, { frames, framesLong, framesSplitSec, maxSide, outDir }) {
  if (!FFMPEG) return { ok: false, code: 'no_ffmpeg', error: '找不到 ffmpeg' }
  const duration = await probeDuration(file)
  if (!duration) return { ok: false, code: 'no_frames', error: 'ffprobe 读不出时长（不是视频？）' }
  // 帧数按**实际时长**动态选（短视频少、长视频多），不再只看请求里那个固定值
  const n = pickFrames(duration, { frames, framesLong, framesSplitSec })
  const side = Math.max(256, Math.min(2048, Number(maxSide) || 1024))
  const out = []
  for (let i = 0; i < n; i++) {
    // 均匀取帧、避开首尾黑帧；不足 n 秒的视频退化成逐秒
    const t = duration < n ? i : duration * (i + 0.5) / n
    const dest = path.join(outDir, `${String(i).padStart(2, '0')}.jpg`)
    const r = await run(FFMPEG, [
      '-ss', String(Math.max(0, t).toFixed(3)),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale='min(${side},iw)':-2`,
      '-q:v', '3', '-y',
      dest, '-hide_banner', '-loglevel', 'error',
    ], { timeout: 60000 })
    if (!r.ok) { log(`抽第 ${i} 帧失败: ${String(r.stderr).slice(0, 120)}`); continue }
    try {
      const st = await fsp.stat(dest)
      if (st.size > 0) out.push({ path: dest, sec: Math.round(t), bytes: st.size })
    } catch { /* 跳过 */ }
  }
  if (!out.length) return { ok: false, code: 'no_frames', error: '一帧都没抽出来' }
  return { ok: true, durationSec: Math.round(duration), frames: out }
}

async function handleRead(body) {
  const url = String(body.url || '').trim()
  const platform = String(body.platform || 'file').toLowerCase()
  if (!url) return { ok: false, code: 'bad_request', error: '缺少 url' }

  if (running >= CFG.concurrency) return { ok: false, code: 'busy', error: `并发已满（${running}/${CFG.concurrency}）` }
  running++
  const jobDir = path.join(FRAME_DIR, `${Date.now().toString(36)}-${rand()}`)
  const dlDir = path.join(DL_DIR, `${Date.now().toString(36)}-${rand()}`)
  // 本次请求实际生效的限制（请求优先，配置文件兜底，另有硬上限防失控）
  const LIM = limitOf(body)
  let source = ''
  try {
    // ① 拿源文件
    let meta = { title: '', durationSec: 0, platform }
    // ⚠️ 判据是 **URL 形态**，不是 platform 名字。
    //    platform='file' 只表示"这是群友发的东西"，它可能是本地路径，也可能是 QQ CDN 直链
    //    （multimedia.nt.qq.com.cn）—— 后者必须走网络分支，否则会被"本地路径白名单"拒掉。
    const isHttp = /^https?:\/\//i.test(url)
    if (!isHttp) {
      const chk = localAllowed(url)
      if (!chk.ok) return { ok: false, code: 'denied', error: chk.why }
      source = chk.real
      const st = await fsp.stat(source)
      if (st.size > CFG.maxMb * 1048576) {
        return { ok: false, code: 'too_big', error: `文件 ${mb(st.size)}MB 超过上限 ${CFG.maxMb}MB` }
      }
      const dur = await probeDuration(source)
      meta.durationSec = dur
      if (dur > LIM.seconds) {
        return { ok: false, code: 'too_long', error: `视频 ${Math.round(dur)} 秒，超过上限 ${LIM.seconds} 秒` }
      }
    } else {
      const allow = hostAllowed(url)
      if (!allow.ok) return { ok: false, code: 'denied', error: allow.why }
      // 先看有没有刚下过的同一 URL（"抽帧看 + 搬进群"是同一条视频，别再下一次）
      const hit = cachedDownload(url)
      if (hit) {
        meta = hit.meta || { title: '', durationSec: 0, platform }
        source = hit.file
        log(`/read 复用 ${Math.round((nowMs() - hit.at) / 1000)} 秒前下载的文件（跳过重复下载）`)
        // 复用也不能跳过时长检查：上一次可能是在别的 maxSeconds 下下过的
        if (meta.durationSec > LIM.seconds) {
          return { ok: false, code: 'too_long', error: `视频 ${Math.round(meta.durationSec)} 秒，超过上限 ${LIM.seconds} 秒` }
        }
      } else {
        // 分流：B站/抖音 → yt-dlp（它认识这些平台）；其它直链（QQ CDN 等）→ 直接 fetch。
        // 之前一律走 yt-dlp，"multimedia.nt.qq.com.cn/download?appid=..." 会被当成文件名，
        // Windows 上 ? 非法 → Errno 22。（踩过）
        const isKnownPlatform = /bilibili\.com|b23\.tv|bili2233\.cn|douyin\.com|iesdouyin\.com/i.test(url)
        let dl
        if (isKnownPlatform) {
          const m = await ytdlpMeta(url)
          if (!m) return { ok: false, code: 'nomatch', error: 'yt-dlp 认不出这个链接' }
          meta = m
          if (meta.durationSec > LIM.seconds) {
            return { ok: false, code: 'too_long', error: `视频 ${Math.round(meta.durationSec)} 秒，超过上限 ${LIM.seconds} 秒` }
          }
          await fsp.mkdir(dlDir, { recursive: true })
          dl = await ytdlpDownload(url, dlDir, { maxHeight: 480 })
        } else {
          log('/read 直链下载（不走 yt-dlp）')
          dl = await directDownload(url, dlDir)
        }
        if (!dl.ok) return { ok: false, code: 'download_failed', error: dl.error }
        if (dl.size > CFG.maxMb * 1048576) {
          return { ok: false, code: 'too_big', error: `文件 ${mb(dl.size)}MB 超过上限 ${CFG.maxMb}MB` }
        }
        source = dl.file
        rememberDownload(url, { file: dl.file, size: dl.size, meta })
        // 下下来的视频**不立刻删**：插件很可能紧接着要把它搬进群（"先搬视频、再发感想"那条链路），
        // 删早了那边就读到不存在的文件。改为登记进待删清单，交给 sweep() 按 TTL / 总量清理。
        log(`/read 下载 ${mb(dl.size)}MB → 保留 ${Math.round(reuseMs() / 60000)} 分钟供复用`)
      }
    }

    // ② 抽帧
    await fsp.mkdir(jobDir, { recursive: true })
    const ext = await extractFrames(source, {
      frames: LIM.frames,
      framesLong: body.framesLong,
      framesSplitSec: body.framesSplitSec,
      maxSide: body.maxSide,
      outDir: jobDir,
    })
    if (!ext.ok) return ext
    log(`/read ok ${platform} ${meta.durationSec || ext.durationSec}s → ${ext.frames.length} 帧`)
    return {
      ok: true,
      platform: meta.platform || platform,
      title: meta.title || '',
      durationSec: ext.durationSec,
      frames: ext.frames,
      // 源文件路径一并返回（插件要"先搬视频再评论"时直接用它，不必再下一次）
      mediaPath: source,
      mediaBytes: await fsp.stat(source).then((s) => s.size).catch(() => 0),
      note: `共 ${Math.floor(ext.durationSec / 60)} 分 ${ext.durationSec % 60} 秒，抽 ${ext.frames.length} 帧`,
    }
  } catch (e) {
    return { ok: false, code: 'internal', error: String(e?.message || e).slice(0, 300) }
  } finally {
    // 失败时把下了一半的目录清掉（成功的留给 sweep 按 TTL 删）
    if (!source?.startsWith(DL_DIR)) await fsp.rm(dlDir, { recursive: true, force: true }).catch(() => {})
    running--
  }
}

// ── /parse：给 plugins/link-parser 用（下载媒体 → 返回本地路径）────────
async function handleParse(body) {
  const t0Parse = nowMs()
  const url = String(body.url || '').trim()
  if (!url) return { ok: false, code: 'bad_request', error: '缺少 url' }
  const allow = hostAllowed(url)
  if (!allow.ok) return { ok: false, code: 'denied', error: allow.why }
  if (running >= CFG.concurrency) return { ok: false, code: 'busy', error: '并发已满' }
  running++
  const dir = path.join(DL_DIR, `${Date.now().toString(36)}-${rand()}`)
  try {
    // 复用：`video-link-read` 刚为同一个链接下过（480p）就直接用，不再下一次
    const hit = cachedDownload(url)
    if (hit) {
      const meta = hit.meta || {}
      log(`/parse 复用 ${Math.round((nowMs() - hit.at) / 1000)} 秒前下载的文件`)
      return {
        ok: true,
        platform: meta.platform || 'unknown',
        platformName: meta.platform === 'bilibili' ? '哔哩哔哩' : meta.platform === 'douyin' ? '抖音' : (meta.platform || ''),
        title: meta.title || '',
        resourceId: path.basename(hit.file).replace(/\.[^.]+$/, ''),
        durationSec: meta.durationSec || 0,
        elapsedMs: nowMs() - t0Parse,
        media: [{ kind: 'video', path: hit.file, size: hit.size }],
        skipped: [],
        reused: true,
      }
    }
    const meta = await ytdlpMeta(url)
    await fsp.mkdir(dir, { recursive: true })
    const dl = await ytdlpDownload(url, dir, { maxHeight: 720 })
    if (!dl.ok) return { ok: false, code: 'download_failed', error: dl.error }
    if (dl.size > CFG.maxMb * 1048576) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { ok: true, platform: meta?.platform || 'unknown', title: meta?.title || '', platformName: meta?.platform || '', resourceId: '', elapsedMs: 0, media: [], skipped: [{ kind: 'video', reason: `超过 ${CFG.maxMb}MB` }] }
    }
    rememberDownload(url, { file: dl.file, size: dl.size, meta: meta || {} })
    return {
      ok: true,
      platform: meta?.platform || 'unknown',
      platformName: meta?.platform === 'bilibili' ? '哔哩哔哩' : meta?.platform === 'douyin' ? '抖音' : (meta?.platform || ''),
      title: meta?.title || '',
      resourceId: path.basename(dl.file).replace(/\.[^.]+$/, ''),
      durationSec: meta?.durationSec || 0,
      elapsedMs: nowMs() - t0Parse,
      media: [{ kind: 'video', path: dl.file, size: dl.size }],
      skipped: [],
    }
  } catch (e) {
    return { ok: false, code: 'internal', error: String(e?.message || e).slice(0, 300) }
  } finally { running-- }
}

// ── HTTP ────────────────────────────────────────────────────────────
function json(res, code, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

function readBody(req, limit = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const t0 = nowMs()
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  // 可选 token（群里的人拿不到它，能挡住"本机别的程序乱调"）
  if (CFG.token && String(req.headers['x-token'] || '') !== CFG.token) {
    return json(res, 401, { ok: false, code: 'unauthorized', error: 'token 不对' })
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      // yt-dlp 是否可用：真跑一次 --version（缓存 60 秒，别每次点按钮都起进程）
      if (!probeYtdlp.at || nowMs() - probeYtdlp.at > 60_000) {
        const { cmd, pre } = ytdlpCmd()
        const r = await run(cmd, [...pre, '--version'], { timeout: 15000 })
        probeYtdlp.at = nowMs()
        probeYtdlp.ok = r.ok
        probeYtdlp.version = r.ok ? String(r.stdout).trim().slice(0, 40) : ''
      }
      return json(res, 200, {
        ok: true, version: VERSION, ffmpeg: Boolean(FFMPEG), ffprobe: Boolean(FFPROBE),
        ytdlp: probeYtdlp.ok, ytdlpVersion: probeYtdlp.version,
        ffmpegPath: FFMPEG, queue: queueInfo(), tmp: TMP,
        configFile: CFG._file || '(默认值)',
        reuseMinutes: CFG.reuseMinutes,
      })
    }
    if (req.method === 'POST' && url.pathname === '/read') {
      const body = await readBody(req)
      const out = await handleRead(body)
      log(`/read ${body.platform || 'file'} → ${out.ok ? 'ok' : out.code} (${nowMs() - t0}ms)`)
      return json(res, 200, out)
    }
    if (req.method === 'POST' && url.pathname === '/parse') {
      const body = await readBody(req)
      const out = await handleParse(body)
      log(`/parse → ${out.ok ? 'ok' : out.code} (${nowMs() - t0}ms)`)
      return json(res, 200, out)
    }
    return json(res, 404, { ok: false, code: 'not_found', error: `没有 ${url.pathname}` })
  } catch (e) {
    log(`请求异常: ${e.message}`)
    return json(res, 200, { ok: false, code: 'internal', error: String(e.message).slice(0, 300) })
  }
})

await fsp.mkdir(TMP, { recursive: true })
await fsp.mkdir(DL_DIR, { recursive: true })
await fsp.mkdir(FRAME_DIR, { recursive: true })

server.listen(CFG.port, CFG.host, () => {
  log(`监听 http://${CFG.host}:${CFG.port}`)
  log(`ffmpeg: ${FFMPEG || '**没找到**（抽帧会失败）'}`)
  log(`ffprobe: ${FFPROBE || '**没找到**'}`)
  const { cmd, pre } = ytdlpCmd()
  log(`yt-dlp: ${cmd} ${pre.join(' ')}（链接解析要用）`)
  log(`临时目录: ${TMP}`)
  if (!FFMPEG) log('⚠️ 没找到 ffmpeg：把 sidecar.config.json 的 ffmpegPath 指到 ffmpeg.exe 上')
})

process.on('SIGINT', () => { log('收到 Ctrl+C，退出'); server.close(() => process.exit(0)) })
