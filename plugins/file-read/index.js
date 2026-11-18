/**
 * file-read — 让模型真的能"打开"群友发来的文件（id: 'file-read', order: 32）
 *
 * 为什么必须有这个插件：
 *   QQ 线的 preset（cordis.patch.yml 里的 qq-chat）**故意禁用了 tool-fs / tool-bash**
 *   —— 纯聊天不需要 shell 和任意写盘。副作用是：file-transfer 把文件落盘、路径也写进提示了，
 *   模型却**没有任何工具能读它**，只能说「本鱼这儿没有打开文件的工具，只有消息和图片能进眼睛」。
 *   （2026-11-18 现场：发 .zip 和 .md，机器人都说读不了）
 *
 * 三条纪律：
 *   ① **只读**：本插件只开放"读"，没有 write / 覆盖 / 执行，也不 spawn 任何子进程
 *      （unzip 也不调，zip 解析用 node 内置 zlib 自己做完 —— 包内红线：不 spawn）。
 *   ② **路径白名单**：只认入站文件目录（qq_uploads）与数据目录里的真实文件，
 *      realpath 之后用 platform/paths.js 的 isInsidePath 判定（软链穿不出去）。
 *   ③ **有上限**：单次回给模型的字符数、zip 内单文件大小、可读条目数都有硬上限，
 *      免得一个 200MB 的日志把上下文炸了。
 *
 * 工具：`read_file`（一个工具三种用法，模型不用学三个名字）
 *   - `read_file({ path })`                 → 文本内容（带行号，可 offset/limit）
 *   - `read_file({ path, zip: true })`      → .zip 里有哪些文件（名 / 大小 / 是否文本）
 *   - `read_file({ path, entry: 'a/b.md' })`→ 直接读 .zip 里某个文件的内容
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { isInsidePath } from '../../platform/paths.js'

/** 单次回给模型的字符上限（再大就截断并说明） */
const MAX_CHARS = 20000
/** zip 内单个条目允许解压的上限（防 zip 炸弹） */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
/** zip 里最多列多少个条目 */
const MAX_ENTRIES = 300

/** 看起来是文本的扩展名（覆盖群友常用：md / txt / json / 代码 / 字幕 / 配置） */
const TEXT_EXT = /\.(md|markdown|txt|text|log|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|bat|sql|lua|vue|svelte|srt|ass|vtt|nfo|gitignore|env)$/i

const looksText = (name) => TEXT_EXT.test(String(name || ''))

/** 把字节按 utf8 解；明显不是 utf8 的（有大量替换符）退回 latin1，别把二进制当文本灌给模型 */
function decodeText(buf) {
  const s = buf.toString('utf8')
  const bad = (s.match(/\uFFFD/g) || []).length
  if (bad > Math.max(8, s.length * 0.01)) return buf.toString('latin1')
  return s
}

/** 带行号切片（模型按行看比按字符看稳） */
function sliceLines(text, offset = 1, limit = 0) {
  const lines = text.split('\n')
  const from = Math.max(1, Math.floor(Number(offset) || 1))
  const take = Math.floor(Number(limit) || 0)
  const end = take > 0 ? from - 1 + take : lines.length
  const out = []
  for (let i = from - 1; i < Math.min(end, lines.length); i += 1) {
    out.push(`${String(i + 1).padStart(5, ' ')}| ${lines[i]}`)
  }
  return {
    text: out.join('\n'),
    totalLines: lines.length,
    from,
    to: Math.min(end, lines.length),
  }
}

/**
 * zip 里的文件名解码。
 * 坑：Windows 上打的包（这个项目就是）默认用**本地代码页 GBK**存文件名，而且 flags 里的
 * UTF-8 位（bit 11）不一定置。直接 `toString('utf8')` 会得到 `docs/00-��Ŀ����.md` 这种乱码，
 * 模型看得见名字却读不出来（2026-11-18 实机遇到的）。
 *
 * ⚠️ 不能只靠"有没有替换符 U+FFFD"来判断：GBK 的双字节里有一部分**恰好也是合法 UTF-8**
 *    （`C4 BF` → `Ŀ`、`C2 BC` → `¼`），解出来没有替换符，但明显是乱码。
 *    所以判据要放宽到「文件名里出现 U+0080–U+024F 这种西文扩展字符 / 替换符」——
 *    中文项目的文件名里不可能有这些。
 *
 * 策略：有 UTF-8 标志 → 信它；否则先按 utf8 试，可疑就按 GBK 再试，还不行才原样留着。
 */
const SUSPECT_NAME = /[\u0080-\u024f\ufffd]/

function decodeZipName(bytes, flags = 0) {
  if (flags & 0x800) return bytes.toString('utf8')
  const asUtf8 = bytes.toString('utf8')
  if (!SUSPECT_NAME.test(asUtf8)) return asUtf8
  for (const enc of ['gbk', 'gb18030']) {
    try {
      const decoded = new TextDecoder(enc).decode(bytes)
      if (decoded && !decoded.includes('\uFFFD') && !SUSPECT_NAME.test(decoded)) return decoded
    } catch { /* 运行时不支持这个编码（small-icu），试下一个 */ }
  }
  return asUtf8
}

/** 读 zip 的中央目录（不依赖外部 unzip：包内禁止 spawn，且 NAS 上不一定有 unzip） */
function listZip(buf) {
  // End of Central Directory：从尾部往回找签名 0x06054b50（注释最长 64KB）
  let eocd = -1
  const stop = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count && i < 10000; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const crc = buf.readUInt32LE(off + 16)
    const compSize = buf.readUInt32LE(off + 20)
    const size = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const extAttr = buf.readUInt32LE(off + 38)
    const localOff = buf.readUInt32LE(off + 42)
    const flags = buf.readUInt16LE(off + 8)
    const name = decodeZipName(buf.slice(off + 46, off + 46 + nameLen), flags)
    off += 46 + nameLen + extraLen + commentLen
    // 目录项（文件名以 / 结尾，或外部属性里的目录位）
    const isDir = name.endsWith('/') || ((extAttr >>> 16) & 0x10) !== 0
    out.push({ name, isDir, size, compSize, method, crc, localOff })
  }
  return out
}

/** 取出 zip 里单个条目的字节（store / deflate 两种；加密条目直接说不支持） */
function readZipEntry(buf, entry) {
  const local = entry.localOff
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
    throw new Error('zip 条目头损坏（文件可能没传完整）')
  }
  const nameLen = buf.readUInt16LE(local + 26)
  const extraLen = buf.readUInt16LE(local + 28)
  const start = local + 30 + nameLen + extraLen
  const slice = buf.slice(start, start + entry.compSize)
  if (entry.method === 0) return slice // store
  if (entry.method === 8) {
    if (entry.size > MAX_ENTRY_BYTES) throw new Error(`压缩包里这个文件 ${(entry.size / 1048576).toFixed(1)}MB，超过单文件读取上限`)
    return zlib.inflateRawSync(slice, { maxOutputLength: MAX_ENTRY_BYTES })
  }
  throw new Error(`这个 zip 用了不支持的压缩方式（method=${entry.method}，常见是加密包）`)
}

export default {
  id: 'file-read',
  title: '读文件',
  order: 32,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '文件与图片',
      label: '让模型能打开收到的文件',
      hint: '开：模型可以调 `read_file` 读入站文件的内容（文本直接读，zip 可以先列目录再读里面的文件）。'
        + '关：只能看到路径，读不了内容。**只读**，没有写入 / 删除 / 执行能力。',
    },
    uploadDir: {
      type: 'str', default: '', group: '文件与图片',
      label: '可读目录（自动跟「入站文件目录」走）',
      hint: '留空 = 用「文件与图片 → 入站文件目录」（默认 `<数据目录>/qq_uploads`）。'
        + '这是本工具**唯一**能读的目录 —— 填了也只认这一处，读不到配置、凭据、会话记录。'
        + '想换位置请改「入站文件目录」，两边会自动保持一致。',
    },
    maxChars: {
      type: 'int', default: MAX_CHARS, min: 1000, max: 200000, group: '文件与图片',
      label: '单次最多读多少字',
      hint: '一次读超了就截断并在结果里说明还有多少行。太大会把上下文撑爆，默认 20000 字够读十几页 markdown。',
    },
    allowExtensions: {
      type: 'str', default: '', group: '文件与图片',
      label: '额外允许当文本读的扩展名',
      hint: '逗号分隔（如 `.abc,.def`）。默认已覆盖常见文本 / 代码 / 字幕格式；二进制文件不会硬灌给模型。',
    },
  },

  setup(bot) {
    const log = bot.log
    const cfg = () => bot.cfg || {}
    const enabled = () => cfg().enabled !== false
    const maxChars = () => {
      const n = Number(cfg().maxChars)
      return Number.isFinite(n) && n >= 1000 ? Math.min(200000, Math.floor(n)) : MAX_CHARS
    }
    const extraExt = () => String(cfg().allowExtensions || '')
      .split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    const isTextName = (name) => looksText(name) || extraExt().some((e) => name.toLowerCase().endsWith(e.toLowerCase()))

    /**
     * 允许读的根目录：**只有一个** —— 入站文件目录（file-transfer 落盘的那个独立文件夹）。
     *
     * 为什么这么严：这个工具的入参来自模型，而模型的话又是群友能影响的。
     * 早先版本把整个数据目录（config.json / 凭据 / 会话 / 记忆）都算进白名单，
     * 等于给 QQ 线开了一个任意读后门的入口。现在只认 "收件箱" 一个目录，
     * 配置由内核注入（`cfg.uploadDir`），插件自己不接受额外目录。
     */
    const inboxDir = () => String(cfg()?.uploadDir || '').trim()

    /**
     * 参数里的路径 → 校验过的真实文件路径（只认收件箱 + realpath + 必须是文件）。
     *
     * 三层防穿：
     *   ① 绝对路径也必须在收件箱内（不许直接给 /etc/passwd）；
     *   ② `../` 越界靠 path.resolve + isInsidePath 挡；
     *   ③ realpath 之后再判一次 —— 收件箱里放个指向外面的软链也读不到。
     */
    function resolveFile(input) {
      const root = inboxDir()
      if (!root) throw new Error('收件目录没配置（内核应注入 file-transfer 的 uploadDir），暂时不能读文件')
      const raw = String(input || '').trim()
      if (!raw) throw new Error('path 不能为空（把提示里 [文件: 路径] 的那个路径原样传进来）')
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
      if (!fs.existsSync(abs)) throw new Error(`文件不在收件箱里或已被清理（保留期见「文件与图片」页）: ${abs}`)
      const real = fs.realpathSync(abs)
      if (!isInsidePath(root, real)) {
        throw new Error(`只能读收件箱里的文件（${root}）；这个路径不在里面: ${real}`)
      }
      if (!fs.statSync(real).isFile()) throw new Error(`不是文件: ${real}`)
      return real
    }

    bot.registerTool('read_file', {
      description: '读取群友发来的文件内容。文本文件（md/txt/json/代码/字幕等）直接返回带行号的正文；'
        + '.zip 先列目录（传 zip: true），再用 entry 指定里面某个文件读取。'
        + '路径用消息提示里 `[文件: 路径]` 给的那个，原样传入。只读，不能写、不能删、不能执行。',
      parameters: {
        path: { type: 'string', required: true, description: '文件绝对路径（见提示里的 [文件: ...]）' },
        zip: { type: 'boolean', description: '.zip 时设为 true 表示"列出包里有哪些文件"' },
        entry: { type: 'string', description: '.zip 里的条目名（先用 zip:true 列出来，再原样传入）' },
        offset: { type: 'integer', description: '从第几行开始读（默认 1）' },
        limit: { type: 'integer', description: '读多少行（默认全读，受单次字数上限约束）' },
      },
      async execute(args = {}) {
        if (!enabled()) throw new Error('读文件功能被关掉了（控制台「文件与图片 → 让模型能打开收到的文件」）')
        const real = resolveFile(args.path)
        const name = path.basename(real)
        const isZip = /\.zip$/i.test(name)

        // ── .zip：列目录 / 读条目 ──
        if (isZip) {
          const buf = fs.readFileSync(real)
          const entries = listZip(buf)
          if (args.entry) {
            const want = String(args.entry).replace(/^\/+/, '')
            const hit = entries.find((e) => e.name === want) || entries.find((e) => e.name.endsWith('/' + want))
            if (!hit) throw new Error(`包里的条目里没有 "${want}"（先传 zip: true 看看有哪些）`)
            if (hit.isDir) throw new Error(`"${hit.name}" 是目录，不是文件`)
            const bytes = readZipEntry(buf, hit)
            if (!isTextName(hit.name)) {
              return { ok: true, path: real, entry: hit.name, binary: true, size: bytes.length,
                message: `这个条目是二进制（${bytes.length} 字节），没转成文本。要看画面可以把它当图片发出去。` }
            }
            const text = decodeText(bytes)
            const cut = sliceLines(text, args.offset, args.limit)
            const cap = maxChars()
            const body = cut.text.length > cap ? cut.text.slice(0, cap) + `\n…（已截断，全文 ${cut.totalLines} 行）` : cut.text
            log.info(`[读文件] zip 条目 ${name} → ${hit.name}（${bytes.length} 字节，回 ${body.length} 字）`)
            return { ok: true, path: real, entry: hit.name, totalLines: cut.totalLines, from: cut.from, to: cut.to, content: body }
          }
          const listing = entries.slice(0, MAX_ENTRIES).map((e) => (e.isDir ? `${e.name}` : `${e.name}  (${(e.size / 1024).toFixed(1)}KB${isTextName(e.name) ? '' : '，二进制'})`))
          log.info(`[读文件] 列 zip ${name}：${entries.length} 项`)
          return {
            ok: true, path: real, kind: 'zip', count: entries.length, truncated: entries.length > MAX_ENTRIES,
            entries: listing,
            message: '这是压缩包里的文件清单。想看哪个就把它的名字传给 entry 参数读取内容（.md/.txt/代码可以直接读）。',
          }
        }

        // ── 普通文件：文本读出来，二进制如实说 ──
        const st = fs.statSync(real)
        if (!isTextName(name)) {
          return { ok: true, path: real, binary: true, size: st.size,
            message: `这是二进制文件（${name}，${(st.size / 1024).toFixed(1)}KB），没转成文本。`
              + '图片可以用 send_image 发出去；压缩包用 zip: true 列目录。' }
        }
        if (st.size > MAX_ENTRY_BYTES * 2) throw new Error(`文件 ${(st.size / 1048576).toFixed(1)}MB 太大了，先用 offset/limit 指定要读的行段`)
        const text = decodeText(fs.readFileSync(real))
        const cut = sliceLines(text, args.offset, args.limit)
        const cap = maxChars()
        const body = cut.text.length > cap
          ? cut.text.slice(0, cap) + `\n…（已截断：这次回 ${cap} 字；全文 ${cut.totalLines} 行，用 offset/limit 接着读）`
          : cut.text
        log.info(`[读文件] ${name}（${st.size} 字节）→ 回 ${body.length} 字 / 第 ${cut.from}-${cut.to} 行`)
        return { ok: true, path: real, totalLines: cut.totalLines, from: cut.from, to: cut.to, content: body }
      },
    })
  },
}
