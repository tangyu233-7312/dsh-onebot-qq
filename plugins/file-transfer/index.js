/**
 * file-transfer — 文件收发子插件（id: 'file-transfer', order: 30）
 *
 * ⚠️ **QQ 只收不发文件**：OneBot 的 `upload_private_file` / `upload_group_file` 内核从来没接，
 *    发文件能力已移除 —— **别加回来**。能发出去的只有文本和图片。
 *
 * 两件事：
 *   ① 入站文件（`ev.files`）落盘到 uploadDir，文件名加时间戳前缀防覆盖，`ev.hint` 里告知路径；
 *      字节溯源优先本地路径/fileId → 直链下载，拿不到如实写进 hint。
 *   ② 出站图片工具 `send_image`：**realpath 解析后**做路径白名单校验（软链穿不出去），
 *      防任意本地文件（含配置/凭据）被当图片发出去；之后走 `bot.sendMedia()`。
 *
 * 平台边界：白名单判定只用 `platform/paths.js` 的 `isInsidePath()`（Windows 反斜杠/大小写都正确）；
 * 媒体码只用 `platform/cq-file.js` 的 `cqImage()`；默认目录由内核按 dataDir 解析成绝对路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { isInsidePath } from '../../platform/paths.js'
import { cqImage } from '../../platform/cq-file.js'

/** target 只认这两种形态（sendImageTo 的校验口径） */
const TARGET_RE = /^(group|private):(\d{1,12})$/
/** 入站文件下载超时：QQ 文件可能几十 MB，给足时间；失败只记日志，不阻塞聊天 */
const FILE_TIMEOUT_MS = 60000

/**
 * 校验本地图片路径：必须是白名单目录下的真实**文件**，返回 realpath。
 * 发图与图生图都是"把本地文件交给外部"（发 QQ / 发第三方中转），所以白名单必须有，
 * 且必须先 realpath 再比对 —— 否则一个指向系统目录的软链就能把配置/凭据发出去。
 */
function resolveAllowedImage(file, roots) {
  if (!file || !fs.existsSync(file)) throw new Error(`图片文件不存在: ${file}`)
  const real = fs.realpathSync(file)
  if (!roots.some((root) => isInsidePath(root, real))) {
    throw new Error(`图片路径必须在白名单目录下（当前白名单：${roots.join(' / ')}）: ${file}`)
  }
  if (!fs.statSync(real).isFile()) throw new Error(`不是文件: ${file}`)
  return real
}

/** 文件名加时间戳前缀防覆盖；basename + 过滤控制字符，防路径穿越/奇怪名字 */
function destName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')) || 'file'
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file'
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) // yyyymmddhhmmss
  return `${ts}-${safe}`
}

/**
 * 取入站文件字节。`ev.files` 给 `{ name, url, path, size, fileId }`：
 *   · url/path 是**这台机器上真实存在**的本地文件 → 直接读；
 *   · url 是 http 直链 → 下载；
 *   · 只有 fileId（或容器路径读不到）时 → 回协议端要 http 直链（getFileUrl）→ 下载；
 *   · 最后才回 getFile 的本地路径（PC 直装、非容器部署时它是有效的）；
 *   · 都拿不到 → 抛错（如实写进 hint，比静默吞掉强：模型能看出文件没到）。
 *
 * 为什么顺序是这样：容器部署下 `get_file` 回的 `/app/...` 在宿主机**根本不存在**，
 * 以前先信它 → existsSync false → 报「文件段没有可取的地址（缺 url）」，
 * 用户看到的就是"文件发了三遍都收不到"。（2026-11-18 踩过）
 */
async function fetchFileBytes(bot, f, ctx = {}) {
  const src = String(f?.url || f?.path || '')
  if (src && fs.existsSync(src) && fs.statSync(src).isFile()) return fs.readFileSync(src)
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  // ① 容器部署的关键一步：拿 file_id 换 http 直链（宿主机能下，协议端自己回源）
  if (f?.fileId && typeof bot.onebot?.getFileUrl === 'function') {
    const url = await bot.onebot.getFileUrl(f.fileId, ctx)
    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
      if (res.ok) return Buffer.from(await res.arrayBuffer())
      throw new Error(`直链下载 HTTP ${res.status}（签名链接可能已过期，重发一次文件即可）`)
    }
  }
  // ② 退回本地缓存路径（PC 直装部署有效；容器部署拿到的是容器内路径，必然读不到）
  if (f?.fileId && typeof bot.onebot?.getFile === 'function') {
    const info = await bot.onebot.getFile(f.fileId)
    const local = info?.file
    if (local && fs.existsSync(local) && fs.statSync(local).isFile()) return fs.readFileSync(local)
    if (info?.url && /^https?:\/\//.test(info.url)) {
      const res = await fetch(info.url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`溯源直链 HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }
  }
  if (src) throw new Error(`文件不在这台机器上: ${src.slice(0, 80)}`)
  throw new Error(f?.fileId ? `协议端没给可下载地址（file_id 有，直链取不到）` : '文件段没有可取的地址（缺 url 且缺 file_id）')
}

export default {
  id: 'file-transfer',
  title: '文件与图片',
  order: 30,
  configSchema: {
    enabled: { type: 'bool', default: true, group: '文件与图片', label: '文件与图片（收文件 + 发图）', hint: '总开关：关 = 不接收入站文件、send_image 拒绝发图（纯文本照常）。' },
    downloadPolicy: {
      type: 'enum', default: 'woken', group: '文件与图片', label: '什么时候下载入站文件',
      options: [{ value: 'woken', label: '被叫到时才下（推荐）' }, { value: 'all', label: '过门禁的消息都下' }],
      hint: '「被叫到时才下」= 只有真正会回复的消息才落盘（群里没叫它的文件不占磁盘）；「都下」= 任何通过门禁的消息都落盘（旧行为，更占磁盘）。',
    },
    uploadDir: {
      type: 'str', default: 'qq_uploads', group: '文件', label: '入站文件目录',
      hint: '收到的群文件 / 私聊文件会按「时间戳-原文件名」存到这个**独立目录**（相对路径按数据目录解析；留空 = <数据目录>/qq_uploads）。'
        + '模型提示里会给出完整路径，`read_file` 工具也只认这个目录。磁盘紧张就换到大盘目录；过期清理在下面设（默认保留 5 天）。',
    },
    maxFileMB: {
      type: 'int', default: 20, unit: 'MB', min: 0, max: 500, group: '文件与图片', label: '单个文件大小上限',
      hint: '超过就不下载、只在提示里写明「未接收」（0 = 不限）。防大文件吃内存 / 塞满盘。',
    },
    maxFilesPerMsg: {
      type: 'int', default: 5, min: 1, max: 20, group: '文件与图片', label: '单条消息最多处理几个文件',
      hint: '防一次刷一堆文件；超出的只提示、不下载。',
    },
    keepDays: {
      type: 'int', default: 5, unit: '天', min: 0, max: 365, group: '文件与图片', label: '入站文件保留天数',
      hint: '默认 **5 天**：每 24 小时检查一次，把超过这个天数的入站文件删掉（0 = 永不清）。'
        + '删的只是 qq_uploads 里的收件，不碰人设、记忆、聊天记录。',
    },
    imageWhitelist: {
      type: 'group', default: [], group: '发图', label: '可发图片目录白名单',
      hint: '允许 send_image / 图生图读取的目录白名单（一项一个目录，相对路径按数据目录解析）。默认由内核注入「数据目录 + 系统临时目录」；'
        + '自己填了就只认填的目录。校验会先 realpath（软链穿不出去），不是真实文件也发不出去。想让它发某个固定文件夹的图，把那个目录加进来即可。',
    },
  },

  setup(bot) {
    const log = bot.log
    const cfgNow = () => bot.cfg || {}
    const enabledNow = () => cfgNow().enabled !== false
    const fallbackUploadDir = () => path.join(String(bot.core?.dataDir || '.'), 'qq_uploads')
    // 内核已在 buildPluginCfg 里把它解析成绝对路径；这里仍兜一层（单测/手工装配时 cfg 可能是相对值）
    const uploadDirNow = () => {
      const raw = String(cfgNow().uploadDir || '').trim()
      if (!raw) return fallbackUploadDir()
      return path.isAbsolute(raw) ? raw : path.resolve(String(bot.core?.dataDir || '.'), raw)
    }
    /** 单文件上限（字节；0 = 不限） */
    const maxFileBytes = () => {
      const mb = Number(cfgNow().maxFileMB)
      return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0
    }
    /** 单条消息最多处理几个文件（1~20，默认 5） */
    const maxFilesPerMsg = () => {
      const n = Number(cfgNow().maxFilesPerMsg)
      return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : 5
    }
    const whitelist = () => {
      const v = cfgNow().imageWhitelist
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\n]/) : []
      const roots = list.map((x) => String(x).trim()).filter(Boolean)
      if (roots.length) return roots
      // 内核注入缺失时（单测/手工装配）的兜底：数据目录 + 临时根
      return [String(bot.core?.dataDir || '.'), String(bot.core?.tmp?.root || '')].filter(Boolean)
    }

    /**
     * 清理过期入站文件（默认保留 5 天，每 24 小时检查一次）。
     *
     * 为什么要有定时器而不只是启动时清一次：NAS 上的机器人一跑就是十几天不重启，
     * 只挂启动钩子 = 实际永远不清，收件箱会一直涨。（2026-11-18 用户要求）
     *
     * 判定用 mtime：下载完成那一刻就是 mtime，比文件名里的时间戳更可靠。
     * 失败只记日志，绝不影响聊天。
     * @param {boolean} force 忽略 24 小时节流（启动时跑的那次）
     */
    let lastPruneAt = 0
    function pruneOldUploads(force = false) {
      const days = Number(cfgNow().keepDays)
      if (!(days > 0)) return 0
      const intervalMs = 24 * 3600 * 1000
      if (!force && Date.now() - lastPruneAt < intervalMs) return 0
      lastPruneAt = Date.now()
      const dir = uploadDirNow()
      let names = []
      try { names = fs.readdirSync(dir) } catch { return 0 }
      const cutoff = Date.now() - days * intervalMs
      let removed = 0
      for (const name of names) {
        const file = path.join(dir, name)
        try {
          const st = fs.statSync(file)
          if (st.isFile()) {
            if (st.mtimeMs >= cutoff) continue
            fs.unlinkSync(file)
            removed += 1
          } else if (st.isDirectory()) {
            // 收件箱里理论只有文件；真出现子目录（手工放的），整棵树过期了才删
            if (st.mtimeMs >= cutoff) continue
            fs.rmSync(file, { recursive: true, force: true })
            removed += 1
          }
        } catch { /* 单个文件清理失败不影响其它 */ }
      }
      if (removed) log.info(`已清理 ${removed} 个过期入站文件（保留 ${days} 天，目录 ${dir}）`)
      return removed
    }
    try { pruneOldUploads(true) } catch (e) { log.warn(`清理过期入站文件失败: ${e.message}`) }
    // 每 24 小时自检一次；unref() 让它不阻止进程退出（机器人正常运行时进程一直在，无影响）
    const pruneTimer = setInterval(() => {
      try { pruneOldUploads() } catch (e) { log.warn(`定时清理入站文件失败: ${e.message}`) }
    }, 24 * 3600 * 1000)
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref()

    // ── 入站：文件段落盘 ───────────────────────────────────────
    // 默认「被叫才下」：挂在 before-turn（wake 之后、prompt 之前）—— 没叫它的群聊文件不落盘；
    // 想回到旧的"过门禁就下"，把「文件与图片 → 什么时候下载文件」调成「都下」（改挂 passive-tap）。
    const downloadPolicy = () => String(cfgNow().downloadPolicy || 'woken')

    async function handleFiles(ev) {
      if (!enabledNow()) return
      const files = Array.isArray(ev.files) ? ev.files : []
      if (!files.length) return
      const scratch = ev._scratch || (ev._scratch = Object.create(null))
      if (scratch.fileTransferDone) return // 两个阶段都挂着时防重复（热改策略的瞬间）
      scratch.fileTransferDone = true
      const cap = maxFilesPerMsg()
      const picked = files.slice(0, cap)
      if (files.length > picked.length) {
        ev.hint.push(`[文件: 本条消息共 ${files.length} 个，只处理前 ${picked.length} 个]`)
      }
      const limitBytes = maxFileBytes()
      const maxMB = Number(cfgNow().maxFileMB) || 0
      const dir = uploadDirNow()
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        log.warn(`建入站文件目录失败 (${dir}): ${e.message}`)
        return
      }
      for (const f of picked) {
        const label = f?.name || '?'
        const declared = Number(f?.size) || 0
        if (limitBytes && declared > limitBytes) {
          ev.hint.push(`[文件: ${label} 超过上限 ${maxMB}MB（${(declared / 1048576).toFixed(1)}MB），未接收]`)
          log.info(`跳过超大入站文件 ${label}（声明 ${declared} 字节 > ${limitBytes}）`)
          continue
        }
        try {
          const buf = await fetchFileBytes(bot, f, {
            groupId: ev.groupId ?? null,
            // 私聊时发送者就是文件所有者；群聊也带上（会话类型判断错时还有一次机会）
            userId: ev.sender?.qq ?? null,
          })
          if (limitBytes && buf.length > limitBytes) {
            ev.hint.push(`[文件: ${label} 超过上限 ${maxMB}MB，未接收]`)
            log.info(`跳过超大入站文件 ${label}（下载后 ${buf.length} 字节 > ${limitBytes}）`)
            continue
          }
          const dest = path.join(dir, destName(label))
          fs.writeFileSync(dest, buf)
          // hint 会原样拼进 prompt：让模型知道"用户发了这个文件、在服务器哪儿"，**并且知道怎么读它**。
          // 没有后半句的后果（2026-11-18）：文件明明落盘了，模型只会说"本鱼没有打开文件的工具"。
          const isZip = /\.zip$/i.test(label)
          ev.hint.push(`[文件: ${dest}（${(buf.length / 1024).toFixed(1)}KB）`
            + `—— 想看内容就调 read_file({"path":"${dest}"}）`
            + `${isZip ? '，先传 zip:true 列出包里有什么，再用 entry 读里面的文件' : ''}]`)
          log.info(`QQ 文件已保存: ${dest}（${buf.length} 字节，来自 ${label}）`)
        } catch (e) {
          // 落盘失败也如实告知；不抛，别让一个坏文件拖垮整条消息
          log.warn(`QQ 文件接收失败 (${label}): ${e.message}`)
          ev.hint.push(`[文件: ${label} 保存失败: ${e.message}]`)
        }
      }
    }

    // 策略 all：任何过门禁的消息都落盘（passive-tap 是 fire-and-forget，不阻塞聊天）
    bot.on('passive-tap', async (ev) => {
      if (downloadPolicy() !== 'all') return
      await handleFiles(ev)
    })

    // 策略 woken（默认）：被叫到、真正要回复时才落盘（wake 已判定；before-turn 阶段一定会跑，所以这里自己看 wake）
    bot.on('before-turn', async (ev) => {
      if (!ev.wake) return // 没被叫醒 = 这条不进模型，文件不落盘
      if (downloadPolicy() !== 'woken') return
      await handleFiles(ev)
    })

    // ── 出站：发图工具（引擎会加工具前缀，名字沿用旧工具，人设/指令文件不用改） ──
    bot.registerTool('send_image', {
      description: '把服务器上的本地图片发到 QQ 会话（只能发图，不能发文件）。'
        + '图片路径必须在白名单目录下；caption 里不要写服务器内部信息。',
      parameters: {
        target: { type: 'string', required: true, description: '会话目标，形如 group:<群号> 或 private:<QQ号>' },
        file: { type: 'string', required: true, description: '服务器上的本地图片绝对路径（必须在白名单目录下）' },
        text: { type: 'string', description: '随图发送的一句说明文字' },
      },
      async execute(args) {
        if (!enabledNow()) throw new Error('文件与发图未启用（file-transfer.enabled=false）：先去控制台「文件与图片」页打开开关')
        const target = String(args?.target || '')
        if (!TARGET_RE.test(target)) {
          throw new Error(`target 格式错误: "${target}"，应为 group:<群号> 或 private:<QQ号>`)
        }
        const real = resolveAllowedImage(String(args?.file || ''), whitelist())
        const r = await bot.sendMedia(target, cqImage(real), String(args?.text ?? '').trim())
        const messageId = r && typeof r === 'object' ? (r.messageId ?? null) : (r ?? null)
        log.info(`发出图片 ${target} (${real}, id=${messageId ?? '?'})`)
        return { ok: true, target, file: real, messageId }
      },
    })
  },
}
