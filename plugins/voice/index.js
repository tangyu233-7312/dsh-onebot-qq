/**
 * voice — 语音子插件（id: 'voice', order: 50）
 *
 * 两条路，**各自独立开关**：
 *   · 语音输出（speak）—— TTS 生成人声 → RVC 换成 DV5 音色 → QQ 语音
 *   · 唱歌（sing）    —— 曲库找歌 → ft 分离人声/伴奏 → RVC 换音色 → 混回伴奏 → QQ 语音
 *
 * 为什么说话也要过 RVC：
 *   MiMo 的 voicedesign 每次调用都重新生成音色（实测同一描述三次不是同一个人，
 *   f0 差 8.8%）。而 RVC 是**给定样本固定复刻**，所以最终音色必须落在 RVC 上。
 *   TTS 只负责「说什么、怎么说」，音色身份由 Dv5.pth 决定。
 *
 * 三条从实测换来的纪律（改之前先读）：
 *   ① **instruct 里别写「稚嫩 / 奶气 / 软」** —— 实测这类词会让语速掉 36%、音高降 40Hz，
 *      反效果。要幼就直接抬 pitch，要快就用 atempo（变速不变调），别指望形容词。
 *   ② **唱歌的 pitch 有硬上限** —— 女声歌 +4 到顶（+6 的 f0 反而比 +4 低）；
 *      男声歌 +8 到顶（+12 同样失效）。超过就是失真，不是更高的音。
 *   ③ **和声/叠唱段转不干净** —— RVC 的 f0 跟踪假设单音高，遇到复调（实测主唱 262Hz +
 *      和声 438Hz 五度）会在两者间跳，听感是「唱着突然变成啊~~」。这是架构限制，
 *      不是参数问题。产品决定：不屏蔽这类歌（算角色特点）。
 *
 * 状态位置：`bot.state.get(chatKey)._scratch['voice:...']`（契约纪律：不开全局 Map）。
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cqMedia } from '../../platform/cq-file.js'

const pexec = promisify(execFile)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_TTS = path.join(HERE, 'scripts', 'tts_say.py')
const SCRIPT_SILK = path.join(HERE, 'scripts', 'audio2silk.py')

/** A2 的声音定义（2026-10 实测选定）：冰糖 → DV5，pitch+2 → f0≈280Hz。 */
export const DEFAULT_INSTRUCT =
  '语速轻快，比平时快一点，语调活泼上扬，句尾习惯上翘，透着股机灵和小得意，'
  + '像机灵的小女孩一口气说完一件让她骄傲的事。不要平稳播报的腔调。'
  + '说话带一点小孩子气的稚嫩感，像年纪更小的小女孩，声音小巧清脆。'

/** TTS 标签：`(得意)` `[轻笑]` 只给 TTS 演，群里看不到。 */
const TAG_PAREN = /[（(][^\s）)]{1,8}[）)]/g
const TAG_SQUARE = /\[[^\]]{1,8}\]/g

export function splitText(text, keepTags = true) {
  const raw = String(text ?? '')
  const display = raw.replace(TAG_SQUARE, '').replace(TAG_PAREN, '')
    .replace(/[ \t]{2,}/g, ' ').trim()
  return { display, tts: keepTags ? raw : display }
}

function scratchOf(bot, chatKey) {
  const st = bot.state?.get?.(chatKey) ?? {}
  return (st._scratch ||= Object.create(null))
}

/** 跑一个 Python 脚本，返回它最后一行 JSON。永不抛。
 *
 *  cwd 很关键：rvc-infer.py 用的是**相对路径**（`voice-models/Dv5.pth`、`python/rvc-infer.py`），
 *  必须在能力包目录里执行；不传 cwd 会报 Command failed，而 stderr 里只有一堆 fairseq 日志，
 *  看不出是路径问题。
 */
export async function runPy(py, args, { timeoutMs = 600_000, cwd } = {}) {
  try {
    const { stdout, stderr } = await pexec(py, args, {
      timeout: timeoutMs, maxBuffer: 64 << 20, cwd,
      // ⚠️ Windows 上 python 的 stdout 默认 GBK，Node 按 utf8 读会把中文路径读成乱码
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
    if (!line) {
      const tail = String(stderr || '').trim().split('\n').slice(-2).join(' | ')
      return { ok: false, reason: `脚本无输出${tail ? `：${tail.slice(0, 200)}` : ''}` }
    }
    return JSON.parse(line)
  } catch (e) {
    // 失败时把 stderr 的最后几行带出来 —— 否则只能看到「Command failed」，无从排查
    const tail = String(e.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ')
    const msg = e.killed ? `超时（${Math.round(timeoutMs / 1000)}s）` : e.message
    return { ok: false, reason: `${msg}${tail ? ` ｜ ${tail.slice(0, 260)}` : ''}`.slice(0, 300) }
  }
}

/** 在曲库里模糊找歌：整名匹配 → 包含匹配。 */
export function findSong(dir, query) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter(f => /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(f))
  } catch { return { ok: false, reason: `曲库目录读不到：${dir}` } }
  if (!files.length) return { ok: false, reason: '曲库是空的' }
  const q = String(query || '').trim()
  if (!q) return { ok: false, reason: '没说歌名' }
  const norm = (s) => s.toLowerCase().replace(/[\s_\-()[\]（）·]/g, '')
  const nq = norm(q)
  const exact = files.find(f => norm(path.parse(f).name) === nq)
  if (exact) return { ok: true, file: path.join(dir, exact), name: exact }
  const partial = files.filter(f => norm(path.parse(f).name).includes(nq))
  if (partial.length === 1) return { ok: true, file: path.join(dir, partial[0]), name: partial[0] }
  if (partial.length > 1) {
    return {
      ok: false,
      reason: `找到 ${partial.length} 首相关的，说得具体点：`
        + partial.slice(0, 3).map(f => path.parse(f).name).join(' / '),
    }
  }
  return { ok: false, reason: `曲库里没有「${q}」（共 ${files.length} 首）` }
}


const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|aac)$/i

/**
 * 读 Windows 系统代理（Clash 开了「系统代理」就写在这里）。
 * Node 进程不继承这个设置，而 B 站搜索接口无代理会稳定 412，所以得自己拿。
 * 返回值形如 "127.0.0.1:7897"；没开代理返回空串。
 */
export function detectSystemProxy() {
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)
    if (!m) return ''
    const raw = m[1].trim()
    // 可能是 "127.0.0.1:7897"，也可能是 "http=1.2.3.4:8080;https=1.2.3.4:8080"
    if (raw.includes('=')) {
      const h = /https?=([^;]+)/.exec(raw)
      return h ? h[1].trim() : ''
    }
    return raw
  } catch { return '' }
}

/** 代理参数：配置优先，其次系统代理，都没有就空。 */
export function proxyArg(cfg) {
  const custom = String(cfg?.biliProxy || '').trim()
  const host = custom || detectSystemProxy()
  if (!host) return []
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`
  return ['--proxy', url]
}


/**
 * 取入站文件的字节。逻辑照抄 file-transfer 的 fetchFileBytes（那套已被真机验证）：
 *   · url 是本地缓存路径 → 直接读；· url 是 http → 下载；· 只有 fileId → 回 NapCat 溯源。
 */
export async function fetchRemote(bot, f, timeoutMs = 180_000) {
  const src = String(f?.url || f?.path || '')
  if (src && fs.existsSync(src)) return fs.readFileSync(src)
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  if (f?.fileId && typeof bot.napcat?.getFile === 'function') {
    const info = await bot.napcat.getFile(f.fileId)
    const local = info?.file
    if (local && fs.existsSync(local) && fs.statSync(local).isFile()) return fs.readFileSync(local)
    if (info?.url && /^https?:\/\//.test(info.url)) {
      const res = await fetch(info.url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`溯源直链 HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }
  }
  throw new Error(src ? `无法识别的文件地址: ${src.slice(0, 60)}` : '文件段没有可取的地址')
}


/** 曲库目录：配置优先，留空用 <dataDir>/music_mp3（用户指定的默认位置）。 */
export function musicDirOf(cfg, core) {
  const custom = String(cfg?.musicDir || '').trim()
  if (custom) return custom
  const base = String(core?.dataDir || process.env.DSH_HOME || '').trim()
  return base ? path.join(base, 'music_mp3') : path.join(os.homedir(), '.dsh', 'dsh-onebot-qq', 'music_mp3')
}

/** 标题里出现这些词的大概率不是想唱的原曲（翻唱/鬼畜/伴奏/合集）。 */
const BILI_BAD = /翻唱|鬼畜|MAD|mad|合集|全集|直播|reaction|钢琴|伴奏|纯音乐|instrumental|karaoke|鼓谱|曲谱|简谱|教学|教程|切片|名场面|搬运/i

/**
 * B 站搜索。**用 yt-dlp 而不是官方 API** —— 官方 `/x/web-interface/search/type` 有风控，
 * 不带 cookie 直接返回 HTML 页面（实测），yt-dlp 的 `bilisearchN:` 已经把风控处理掉了。
 * 代价：每个结果要解析详情（5 条约 7 秒），只在「本地没有 + 要下载」时调用。
 */
export async function searchBili(py, keyword, limit = 5, proxy = []) {
  const { stdout } = await pexec(py, [
    '-m', 'yt_dlp', '--dump-json', '--no-warnings', '--no-playlist',
    ...proxy,
    '--playlist-items', `1-${limit}`,
    `bilisearch${limit}:${keyword}`,
  ], { timeout: 180_000, maxBuffer: 32 << 20, windowsHide: true })
  const list = String(stdout || '').trim().split('\n').filter(Boolean).map(l => {
    try {
      const j = JSON.parse(l)
      return {
        bvid: String(j.id || ''),
        title: String(j.title || ''),
        author: String(j.uploader || j.channel || ''),
        duration: Number(j.duration) || 0,   // 秒
      }
    } catch { return null }
  }).filter(v => v && v.bvid)
  if (!list.length) throw new Error('yt-dlp 没返回任何搜索结果')
  return list
}

/** 给候选打分：纯音频 > MV，正常歌长 > 合集/切片。抽出来给「逐个试」排序复用。 */
export function scoreBili(v) {
  const t = Number(v?.duration) || 0
  let score = 0
  // MV 版常带对白/环境音，分离时会一起吞进 vocals 轨
  if (/(^|[^A-Za-z])MV([^A-Za-z]|$)|官方|片尾曲|片头曲/.test(String(v?.title || ''))) score -= 6
  // 纯音频搬运一般标「无损 / Hi-Res / 音质」，这类源最干净
  if (/无损|Hi-?Res|音质|高音质|lossless/i.test(String(v?.title || ''))) score += 5
  if (t >= 180 && t <= 420) score += 10   // 正常歌曲
  else if (t > 480) score -= 5            // 合集/长视频
  else if (t > 0 && t < 90) score -= 8    // 切片/短视频
  return score
}

/** 从候选里挑最像原曲的一条。 */
export function pickBiliBest(list) {
  if (!list?.length) return null
  const clean = list.filter(v => !BILI_BAD.test(v.title))
  const pool = clean.length ? clean : list
  return [...pool].sort((a, b) => scoreBili(b) - scoreBili(a))[0] || null
}

/** 用 yt-dlp 下 B 站音频到曲库。返回落地文件路径。 */
export async function downloadBili(py, bvid, dir, proxy = []) {
  await fsp.mkdir(dir, { recursive: true })
  const before = new Set(fs.readdirSync(dir))
  const outTpl = path.join(dir, '%(title)s.%(ext)s')
  const { stderr } = await pexec(py, [
    '-m', 'yt_dlp', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3',
    '--audio-quality', '0', '--no-playlist', '--no-progress',
    ...proxy,
    '-o', outTpl, `https://www.bilibili.com/video/${bvid}`,
  ], { timeout: 300_000, maxBuffer: 32 << 20, windowsHide: true })
  const added = fs.readdirSync(dir).filter(f => !before.has(f) && /\.mp3$/i.test(f))
  if (!added.length) throw new Error(`yt-dlp 没产出文件${stderr ? '：' + String(stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 200) : ''}`)
  return path.join(dir, added[0])
}
export default {
  id: 'voice',
  title: '语音与唱歌',
  order: 50,

  configSchema: {
    // ── 总开关已移除（2026-10-30）───────────────────────────
    // 原来这里有个「启用这个子插件」，用户反馈是多余的：
    //   · 「语音输出」有 ttsEnabled、「唱歌」有 singEnabled，「曲库」有 autoLibrary，
    //     三个分区各自有独立开关，再套一层总开关只会"开了总开关却什么都没开"；
    //   · 而且它一关，整页只剩这一个开关，看着像坏了。
    // 现在插件加载与否走「子插件」页的停用（config.json 的 plugins.voice=false），
    // 三个分区各自有开关 —— 少一层、不重复。
    // ── 语音输出 ────────────────────────────────────────────
    ttsEnabled: {
      type: 'bool', default: false, group: '语音与唱歌',
      section: '语音输出',
      label: '启用语音输出',
      hint: '开：模型可以调 speak 工具把话念成语音。关：说话只能用文字。'
        + '和「唱歌」是两个独立开关，互不影响。',
    },
    ttsInstruct: {
      type: 'text', default: DEFAULT_INSTRUCT, group: '语音与唱歌',
      section: '语音输出',
      label: '语气指令',
      hint: '写给 TTS 的「怎么说」。实测教训：别写「稚嫩/奶气/软」，会让语速掉 36%、音高降 40Hz，'
        + '是反效果。要幼就调下面的 pitch，要快就用 atempo。',
    },
    ttsVoice: {
      type: 'str', default: '冰糖', group: '语音与唱歌',
      section: '语音输出',
      label: 'TTS 底音色',
      hint: 'MiMo 内置音色：冰糖 / 茉莉（女）、苏打 / 白桦（男）。'
        + '它只是「原料」，最终音色由 RVC 模型决定。',
    },
    ttsPitch: {
      type: 'str', default: '2', group: '语音与唱歌',
      section: '语音输出',
      label: '说话变调（半音）',
      hint: 'RVC 的 pitch。实测 +2 时 f0≈280Hz；每 +1 约 +6%。别超过 +4，会开始失真。',
    },
    ttsAtempo: {
      type: 'str', default: '1.1', group: '语音与唱歌',
      section: '语音输出',
      label: '说话语速倍率',
      hint: 'ffmpeg atempo，**变速不变调**。1.1 = 快 10%。这是唯一能精确控语速的地方，'
        + 'instruct 里写「快」不准。',
    },
    ttsMaxChars: {
      type: 'int', default: 60, min: 2, max: 300, step: 1, group: '语音与唱歌',
      section: '语音输出',
      label: '单条最多念几个字',
      hint: '超过就不念（返回 ok:false）。人设是短句，60 够用。',
    },
    ttsPerTurn: {
      type: 'int', default: 1, min: 0, max: 5, step: 1, group: '语音与唱歌',
      section: '语音输出',
      label: '每轮最多几条',
      hint: '语音比文字占耳朵，一轮一条就够。0 = 不允许主动发。',
    },

    // ── 唱歌 ───────────────────────────────────────────────
    singEnabled: {
      type: 'bool', default: false, group: '语音与唱歌',
      section: '唱歌',
      label: '启用唱歌',
      hint: '开：模型可以调 sing 工具点歌。独立开关，关掉不影响语音输出。',
    },
    singPitch: {
      type: 'str', default: '4', group: '语音与唱歌',
      section: '唱歌',
      label: '唱歌变调（半音）',
      hint: '实测：女声歌 +4 到顶（+6 的 f0 反而更低，说明超出模型能力）；'
        + '男声歌 +8 到顶（+12 同样失效）。唱出来偏低就往上涨，但别超这两个数。',
    },
    singMaxSeconds: {
      type: 'int', default: 300, min: 30, max: 600, step: 10, group: '语音与唱歌',
      section: '唱歌',
      label: '单首时长上限（秒）',
      hint: '超过这个长度的歌不唱。实测 260 秒的歌能作为单条语音发出（770KB silk）。',
    },
    singCooldownMin: {
      type: 'int', default: 10, min: 0, max: 1440, step: 1, group: '语音与唱歌',
      section: '唱歌',
      label: '别人的点歌冷却（分钟）',
      hint: '除主人外，同一个人在同一个会话里点过一首后，要等这么久才能再点。0 = 不冷却。设这个是因为一首歌要跑 40~90 秒，不限的话很容易被连着点爆。',
    },
    singMasterFree: {
      type: 'bool', default: true, group: '语音与唱歌',
      section: '唱歌',
      label: '主人不受冷却和轮次限制',
      hint: '开：主人点歌想唱几首唱几首、不用等冷却。关：主人也按上面的规则来。',
    },
    singPerTurn: {
      type: 'int', default: 1, min: 0, max: 2, step: 1, group: '语音与唱歌',
      section: '唱歌',
      label: '每轮最多几首',
      hint: '唱歌一次要 40~90 秒，一轮一首就够。0 = 不允许主动唱。',
    },

    // ── 运维 ───────────────────────────────────────────────
    ttsPython: {
      type: 'str', default: '', group: '运维',
      label: 'TTS 用的 python',
      hint: '留空 = 用 PATH 里的 python。需要装 edge-tts、pysilk。用来跑 tts_say.py 和 audio2silk.py。\n'
        + 'Windows 示例：C:/Python310/python.exe（正斜杠，别用反斜杠）。',
    },
    rvcPython: {
      type: 'str', default: '', group: '运维',
      label: 'RVC 用的 python',
      hint: '留空 = 用 PATH 里的 python。需要装 rvc-python + torch。**必须是 Python 3.10** —— '
        + '3.11 起 fairseq/hydra 的可变 dataclass 默认值会直接报错。\n'
        + '想用 GPU：先装 CUDA 版 torch，再用 python rvc-infer.py info 确认 cudaAvailable=true。',
    },
    rvcDir: {
      type: 'str', default: '', group: '运维',
      label: 'RVC 能力包目录',
      hint: '留空 = <数据目录>/singing-pack。里面要有：\n'
        + '· python/rvc-infer.py（仓库 tools/singing-pack/ 里有）\n'
        + '· voice-models/<名字>.pth 与 .index（**你自己训练的，仓库不含**）\n'
        + '· songs/（分离人声时的临时工作目录，会自动建）',
    },
    apiKey: {
      type: 'str', default: '', group: '运维',
      label: 'MiMo API Key',
      hint: '只在语音输出时需要。也可写在实例 config 的 credentials.mimoTts。',
    },
    autoSpeak: {
      type: 'bool', default: false, group: '运维',
      label: '自动朗读每条回复',
      hint: '开：每条回复都念一遍（另发一条语音）。关：只靠模型主动调 speak。',
    },
    autoLibrary: {
      type: 'bool', default: true, group: '语音与唱歌',
      section: '曲库',
      label: '自动收群里的音频',
      hint: '开：群友/私聊直接发 mp3、wav、flac、m4a、ogg 时，自动下载进曲库（songs/），之后点歌就能唱。关：只用手动放进 songs/ 的歌。文件很大时会跳过（见下面的上限）。'
    },
    musicDir: {
      type: 'str', default: '', group: '语音与唱歌',
      section: '曲库',
      label: '曲库目录',
      hint: '留空 = <数据目录>/music_mp3（即 dsh-onebot-qq/music_mp3）。群友发的音频、B 站下载的歌都放这里。',
    },
    biliProxy: {
      type: 'str', default: '', group: '语音与唱歌',
      section: '曲库',
      label: 'B站代理地址',
      hint: '留空 = 自动读 Windows 系统代理（Clash 开「系统代理」时通常是 127.0.0.1:7897）。B 站搜索不走代理会报 412；BV 号下载则不需要代理。',
    },
    biliSearch: {
      type: 'bool', default: true, group: '语音与唱歌',
      section: '曲库',
      label: '本地没有就去 B 站找',
      hint: '开：点歌时曲库里没有，自动去 B 站搜索并下载音频（用 yt-dlp）。关：只在本地曲库找，找不到就如实说没有。',
    },
    libraryMaxMB: {
      type: 'int', default: 50, min: 1, max: 500, step: 1, group: '语音与唱歌',
      section: '曲库',
      label: '单个音频大小上限（MB）',
      hint: '超过这个大小的入站音频不入库，避免一条大文件把磁盘吃满。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = bot.log || console
    const ttsOn = () => cfg().ttsEnabled === true
    const singOn = () => cfg().singEnabled === true
    // 路径全部可配；留空时回落「PATH 里的 python」与「<dataDir>/singing-pack」，
    // 不再写死任何一台机器的绝对路径（原版这里硬编码了开发机的 E:/ D:/ 路径）
    const pyTts = () => String(cfg().ttsPython || 'python')
    const pyRvc = () => String(cfg().rvcPython || 'python')
    const rvcDir = () => {
      const custom = String(cfg().rvcDir || '').trim()
      if (custom) return custom
      const base = String(bot.core?.dataDir || '').trim()
      return base ? path.join(base, 'singing-pack')
        : path.join(os.homedir(), '.dsh', 'dsh-onebot-qq', 'singing-pack')
    }
    const tmp = () => path.join(os.tmpdir(), 'dsh-qq-voice')

    const keyOf = () => String(cfg().apiKey || '').trim()
      || String(bot.credentials?.mimoTts || bot.core?.credentials?.mimoTts || '').trim()

    /** 音频 → silk → 发出去。 */
    async function sendAsVoice(target, audioPath, caption = '') {
      const dir = tmp()
      const r = await runPy(pyTts(), [SCRIPT_SILK, audioPath, dir], { timeoutMs: 300_000 })
      if (!r.ok) return { ok: false, reason: `转语音失败：${r.reason}` }
      try {
        await bot.sendMedia(target, cqMedia('record', r.silk), caption || '')
        return { ok: true, seconds: r.seconds, bytes: r.bytes }
      } catch (e) {
        return { ok: false, reason: `发送失败：${e.message}` }
      } finally {
        fsp.unlink(r.silk).catch(() => {})
      }
    }

    /** 说话：text → TTS wav → RVC → atempo → mp3。 */
    async function makeSpeech(text) {
      const { display, tts } = splitText(text, true)
      const n = display.replace(/\s/g, '').length
      if (!n) return { ok: false, reason: '没有能念的字' }
      const cap = Number(cfg().ttsMaxChars) || 60
      if (n > cap) return { ok: false, reason: `太长（${n} 字 > ${cap}）` }

      const dir = tmp()
      await fsp.mkdir(dir, { recursive: true })
      const tag = `sp-${Date.now()}`
      const t = await runPy(pyTts(), [SCRIPT_TTS, '--json', JSON.stringify({
        text: tts, backend: 'mimo-builtin', voice: String(cfg().ttsVoice || '冰糖'),
        instruct: String(cfg().ttsInstruct || DEFAULT_INSTRUCT),
        apiKey: keyOf(), keepTags: false, outDir: dir, saveWav: true, tag,
      })], { timeoutMs: 180_000 })
      if (!t.ok) return { ok: false, reason: `TTS 失败：${t.reason}` }
      if (!t.wav) return { ok: false, reason: 'TTS 没给 wav' }

      const wavIn = path.join(rvcDir(), 'songs', `_sp_${tag}.wav`)
      await fsp.copyFile(t.wav, wavIn)
      // TTS 的原始 wav 用不上了，立刻删 —— 之前漏了这一步，临时目录越攒越大（实测 418MB）
      fsp.unlink(t.wav).catch(() => {})
      // tts_say.py 同时会给一份 silk（我们用不上，只要 wav），也删掉
      if (t.silk) fsp.unlink(t.silk).catch(() => {})
      const mp3Out = path.join(dir, `${tag}_rvc.mp3`)
      const r = await runPy(pyRvc(), [
        'python/rvc-infer.py', 'infer',
        '-m', 'voice-models/Dv5.pth', '--index', 'voice-models/Dv5.index',
        '-i', wavIn, '-o', mp3Out,
        '--pitch', String(cfg().ttsPitch || '2'), '--device', 'cuda:0',
      ], { timeoutMs: 300_000 , cwd: rvcDir() })
      fsp.unlink(wavIn).catch(() => {})
      if (!r.ok) return { ok: false, reason: `RVC 失败：${r.error || r.reason}` }

      const at = String(cfg().ttsAtempo || '').trim()
      if (at && at !== '1') {
        const fast = path.join(dir, `${tag}_final.mp3`)
        try {
          await pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
            '-i', mp3Out, '-filter:a', `atempo=${at}`, '-b:a', '192k', fast],
          { timeout: 120_000, windowsHide: true })
          fsp.unlink(mp3Out).catch(() => {})
          return { ok: true, audio: fast }
        } catch (e) {
          log.warn(`[语音] atempo 失败，用原速: ${e.message}`)
        }
      }
      return { ok: true, audio: mp3Out }
    }

    /** 唱歌：曲库找歌 → ft 分离 + RVC → mp3。 */
    async function makeSong(query) {
      const libDir = musicDirOf(cfg(), bot.core)

      // ★ BV 号 / B站链接直接下，不走搜索。
      //   真机踩过：群友发「去唱这个歌：BV1qq6ZYNEj3」，模型提炼成歌名「何者」，
      //   走搜索后下不动，等于白丢了一个本来能直接下的准链接。
      let hit = null
      const bvHit = /(BV[0-9A-Za-z]{10})/.exec(String(query || ''))
      if (bvHit) {
        const bvid = bvHit[1]
        log.info(`[曲库] 收到 BV 号 ${bvid}，直接下载`)
        try {
          const file = await downloadBili(pyTts(), bvid, libDir, proxyArg(cfg()))
          hit = { ok: true, file, name: path.basename(file), fromBili: true }
          log.info(`[曲库] 已下载 ${path.basename(file)}`)
        } catch (e) {
          log.warn(`[曲库] BV ${bvid} 下载失败: ${e.message}`)
          return { ok: false, reason: `这个 BV 号下不下来：${e.message.split('｜')[0]}` }
        }
      } else {
        hit = findSong(libDir, query)
      }

      // 本地没有就去 B 站找（曲库来源③）。
      // 注意这是**兜底**：本地命中时绝不联网，避免每次点歌都白跑一趟搜索。
      if (!hit.ok && cfg().biliSearch !== false) {
        log.info(`[曲库] 本地没有「${query}」，去 B 站找`)
        try {
          const list = await searchBili(pyTts(), query, 5, proxyArg(cfg()))
          // ★ 按「像不像原曲」排序后**逐个试**：真机上搜到的第一条 404，
          //   结果整个放弃了 —— 明明后面几条都能下。
          const ranked = list.filter(v => !BILI_BAD.test(v.title))
          const ordered = ranked.length ? ranked : list
          ordered.sort((a, b) => scoreBili(b) - scoreBili(a))
          let got = null
          for (const cand of ordered.slice(0, 4)) {
            log.info(`[曲库] 试下「${cand.title.slice(0, 30)}」（${cand.bvid}）`)
            try {
              const file = await downloadBili(pyTts(), cand.bvid, libDir, proxyArg(cfg()))
              got = { file, name: path.basename(file) }
              log.info(`[曲库] 下载成功：${path.basename(file)}`)
              break
            } catch (e) {
              log.warn(`[曲库] ${cand.bvid} 下不动，换下一个：${String(e.message).split('｜')[0]}`)
            }
          }
          if (got) {
            hit = { ok: true, file: got.file, name: got.name, fromBili: true }
          } else {
            hit = { ok: false, reason: `B 站没搜到像样的「${query}」` }
          }
        } catch (e) {
          log.warn(`[曲库] B站获取失败: ${e.message}`)
          hit = { ok: false, reason: `本地没有，B 站也没拿到：${e.message}` }
        }
      }
      if (!hit.ok) return hit

      const maxSec = Number(cfg().singMaxSeconds) || 300
      try {
        const { stdout } = await pexec('ffprobe', ['-v', 'error', '-show_entries',
          'format=duration', '-of', 'csv=p=0', hit.file], { timeout: 30_000, windowsHide: true })
        const dur = Number(String(stdout).trim())
        if (dur && dur > maxSec) {
          return { ok: false, reason: `《${path.parse(hit.name).name}》有 ${Math.round(dur)} 秒，超过 ${maxSec} 秒上限` }
        }
      } catch { /* 读不到时长就不拦 */ }

      const dir = tmp()
      await fsp.mkdir(dir, { recursive: true })
      const out = path.join(dir, `sing-${Date.now()}.mp3`)
      const r = await runPy(pyRvc(), [
        'python/rvc-infer.py', 'infer',
        '-m', 'voice-models/Dv5.pth', '--index', 'voice-models/Dv5.index',
        '-i', hit.file, '-o', out,
        '--keep-bgm', '--pitch', String(cfg().singPitch || '4'), '--device', 'cuda:0',
      ], { timeoutMs: 600_000 , cwd: rvcDir() })
      if (!r.ok) return { ok: false, reason: `转换失败：${r.error || r.reason}` }
      return { ok: true, audio: out, name: path.parse(hit.name).name, ms: r.elapsedMs, fromBili: !!hit.fromBili }
    }

    // ── 工具 ①：说话 ─────────────────────────────────────────
    bot.registerTool('speak', {
      description: '把一句话念成语音发到当前会话（另发一条，不占正文）。'
        + '声音是「得意又软」的小女孩腔，可以先在心里定个情绪：在句首加 `(得意)` `(撒娇)` `(委屈)` '
        + '`(心虚)` `(轻声)` 这类标签，或在句中插 `[轻笑]` `[叹气]`，TTS 会照着演 —— **标签只给 TTS，群里看不到**。'
        + '只适合短句（默认 60 字上限）；长内容、报错、路径这类正经信息一律用文字，别念。'
        + '返回 ok:false（太长/没配/合成失败）就正常用文字说完，别解释为什么没语音。',
      parameters: {
        text: { type: 'string', description: '要念的话（可带 (情绪) / [音效] 标签）', required: true },
        caption: { type: 'string', description: '随语音附一句文字，一般不用给' },
      },
      async execute(args) {
        if (!ttsOn()) return { ok: false, reason: '语音输出没开' }
        const turn = bot.currentTurn()
        const target = turn?.chatKey
        if (!target) return { ok: false, reason: '没有进行中的会话' }
        const cap = Math.max(0, Number(cfg().ttsPerTurn))
        if (cap <= 0) return { ok: false, reason: '配置不允许主动发语音，用文字说' }
        const scratch = scratchOf(bot, target)
        const sent = Number(scratch['voice:spoke']) || 0
        if (sent >= cap) return { ok: false, reason: `这轮已经发过 ${sent} 条语音了（上限 ${cap}）` }
        if (turn.wakeKind === 'proactive' && (Number(turn.proactiveMessages) || 0) >= 2) {
          return { ok: false, reason: '主动接话这轮已经发满 2 条了' }
        }

        const r = await makeSpeech(args?.text ?? '')
        if (!r.ok) { log.warn(`[语音] 合成失败（降级为文字）: ${r.reason}`); return r }
        const s = await sendAsVoice(target, r.audio, args?.caption || '')
        fsp.unlink(r.audio).catch(() => {})
        if (!s.ok) return s
        scratch['voice:spoke'] = sent + 1
        if (turn.wakeKind === 'proactive') {
          turn.proactiveMessages = (Number(turn.proactiveMessages) || 0) + 1
        }
        log.info(`[语音] 发出 ${s.seconds}s / ${s.bytes}B → ${target}`)
        return { ok: true, target, seconds: s.seconds }
      },
    })

    // ── 工具 ②：唱歌 ─────────────────────────────────────────
    bot.registerTool('sing', {
      description: '有人点歌（「唱首 X」「来一段 X」）时用：从曲库找这首歌，把原唱的人声换成角色音色、'
        + '保留原伴奏，发成语音消息。传歌名即可（可以只说一部分，会自动匹配）。'
        + '**转换要 40~90 秒**，所以先说一句「本鱼去准备啦」再调，别让群里干等。'
        + '曲库里没有就如实说没有、并说可以让人把音频丢进曲库，**绝不要谎称唱了，'
        + '也不要用 TTS 念歌词冒充唱歌**。返回 ok:false 时把原因用人话说出来。',
      parameters: {
        song: { type: 'string', description: '歌名（可带歌手名，只说一部分也能匹配）。如果对方给的是 BV 号或 B 站链接，**把整串原样传进来**（如 BV1qq6ZYNEj3 或 https://www.bilibili.com/video/BVxxx）—— 那是最准的输入，别自己提炼成歌名', required: true },
      },
      async execute(args) {
        if (!singOn()) return { ok: false, reason: '唱歌功能没开' }
        const turn = bot.currentTurn()
        const target = turn?.chatKey
        if (!target) return { ok: false, reason: '没有进行中的会话' }
        const scratch = scratchOf(bot, target)

        // 谁在点歌（由 before-turn 记下）。拿不到就按「非主人」处理 —— 宁可严一点，也别让陌生人绕过冷却。
        const who = scratch['voice:who'] || {}
        const adminQq = Number(bot.core?.adminQq || bot.cfg?.adminQq || 0)
        const isMaster = !!who.isMaster || (!!adminQq && Number(who.qq) === adminQq)
        const masterFree = isMaster && cfg().singMasterFree !== false

        if (!masterFree) {
          // ① 轮次上限
          const cap = Math.max(0, Number(cfg().singPerTurn))
          if (cap <= 0) return { ok: false, reason: '配置不允许主动唱歌' }
          const sang = Number(scratch['voice:sang']) || 0
          if (sang >= cap) return { ok: false, reason: `这轮已经唱过 ${sang} 首了（上限 ${cap}）` }

          // ② 按「用户 + 会话」计时冷却
          const cdMin = Math.max(0, Number(cfg().singCooldownMin ?? 10))
          const cdKey = `voice:singCd:${who.qq || 'unknown'}`
          const until = Number(scratch[cdKey]) || 0
          if (cdMin > 0 && until > Date.now()) {
            const left = Math.ceil((until - Date.now()) / 60000)
            return { ok: false, reason: `刚唱过啦，本鱼歇会儿…再等 ${left} 分钟` }
          }
        }

        const r = await makeSong(args?.song ?? '')
        if (!r.ok) { log.warn(`[唱歌] ${r.reason}`); return r }
        const s = await sendAsVoice(target, r.audio, '')
        fsp.unlink(r.audio).catch(() => {})
        if (!s.ok) return s
        scratch['voice:sang'] = (Number(scratch['voice:sang']) || 0) + 1
        // 只有非主人需要记冷却（主人豁免）
        if (!(isMaster && cfg().singMasterFree !== false)) {
          const cdMin = Math.max(0, Number(cfg().singCooldownMin ?? 10))
          if (cdMin > 0) scratch[`voice:singCd:${who.qq || 'unknown'}`] = Date.now() + cdMin * 60_000
        }
        log.info(`[唱歌] 《${r.name}》 ${s.seconds}s / ${s.bytes}B / 转换${r.ms}ms → ${target}`)
        return { ok: true, target, song: r.name, seconds: s.seconds, convertMs: r.ms }
      },
    })

    // ── 记下「这轮是谁在说话」────────────────────────────────
    //   契约的 TurnContext 里没有 sender，工具 execute 也拿不到 ev；
    //   而内核按 chatKey 串行（state.serialize），所以存在本轮 scratch 里是安全的。
    //   唱歌的「主人豁免 + 别人的冷却」全靠这个。
    bot.on('before-turn', (ev) => {
      const scratch = scratchOf(bot, ev.chatKey)
      scratch['voice:who'] = {
        qq: Number(ev.sender?.qq) || 0,
        isMaster: !!ev.sender?.isMaster,
        at: Date.now(),
      }
    })

    // ── 入站音频自动入库（曲库来源①：群友/私聊直接发文件）──────
    //   用 passive-tap 而不是 intercept：这是**旁路采集**，不该影响消息本身的流程，
    //   抛错也只记日志（契约规定 passive-tap 是 fire-and-forget）。
    bot.on('passive-tap', async (ev) => {
      if (cfg().autoLibrary === false) return
      const files = Array.isArray(ev.files) ? ev.files : []
      const songsDir = musicDirOf(cfg(), bot.core)
      const maxBytes = (Number(cfg().libraryMaxMB) || 50) * 1024 * 1024
      for (const f of files) {
        const name = String(f?.name || '')
        if (!AUDIO_EXT.test(name)) continue
        if (Number(f?.size) > maxBytes) {
          log.warn(`[曲库] 跳过 ${name}：超过 ${Math.round(maxBytes / 1048576)}MB`)
          continue
        }
        try {
          const buf = await fetchRemote(bot, f)
          await fsp.mkdir(songsDir, { recursive: true })
          // 文件名消毒：去掉路径分隔符和控制字符，防穿越
          const safe = path.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'audio.mp3'
          const dest = path.join(songsDir, safe)
          // 同名且大小一致就不重复写（群里有人重发同一首歌很常见）
          if (fs.existsSync(dest) && fs.statSync(dest).size === buf.length) {
            log.info(`[曲库] ${safe} 已在库里，跳过`)
            continue
          }
          await fsp.writeFile(dest, buf)
          log.info(`[曲库] 收进 ${safe}（${(buf.length / 1048576).toFixed(1)}MB）→ 可以点歌了`)
        } catch (e) {
          log.warn(`[曲库] 收取 ${name} 失败: ${e.message}`)
        }
      }
    })

    // ── 自动朗读（可选，默认关）────────────────────────────────
    bot.onOutbound(async (out) => {
      if (!ttsOn() || cfg().autoSpeak !== true) return
      try {
        const text = String(out?.text || '').trim()
        const target = out?.target
        if (!text || !target) return
        const r = await makeSpeech(text)
        if (!r.ok) { log.warn(`[语音] 自动朗读跳过：${r.reason}`); return }
        const s = await sendAsVoice(target, r.audio, '')
        fsp.unlink(r.audio).catch(() => {})
        if (s.ok) log.info(`[语音] 自动朗读 ${s.seconds}s → ${target}`)
      } catch (e) {
        log.warn(`[语音] 自动朗读失败（不影响文字）: ${e.message}`)
      }
    })

    // ── 命令 /voice：状态自查 ─────────────────────────────────
    bot.registerCommand?.('voice', {
      permission: 'master',
      description: '语音与唱歌状态自查',
      async handler() {
        const c = cfg()
        const songsDir = musicDirOf(cfg(), bot.core)
        let songs = 0
        try { songs = fs.readdirSync(songsDir).filter(f => /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(f)).length } catch { /* */ }
        return [
          `语音输出：${ttsOn() ? '开' : '关'}｜唱歌：${singOn() ? '开' : '关'}`,
          `说话：${c.ttsVoice || '冰糖'} → DV5，pitch +${c.ttsPitch || 2}，语速 ×${c.ttsAtempo || 1}`,
          `唱歌：pitch +${c.singPitch || 4}，单首上限 ${c.singMaxSeconds || 300}s，曲库 ${songs} 首`,
          `自动朗读：${c.autoSpeak ? '开' : '关'}`,
          `tts python：${pyTts()}`,
          `rvc python：${pyRvc()}`,
          `MiMo Key：${keyOf() ? '有' : '没有'}`,
          `音色模型：${fs.existsSync(path.join(rvcDir(), 'voice-models', 'Dv5.pth')) ? '在' : '缺失'}`,
        ].join('\n')
      },
    })
  },
}
