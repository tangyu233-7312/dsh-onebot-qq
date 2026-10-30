/**
 * qzone — QQ 空间日记（order 62）
 *
 * 一句话：**一个机器人、一块空间、一天一条**；素材是「一整天所有会话的经历」，不是一个群的一小段。
 *
 * 为什么整个重写（2026-10-28）：旧实现把提醒挂在 `before-turn` 的 `ev.wake` 上，而且配额是
 * 「每个群一份」。实战里暴露三件事：
 *   ① 22 点后没人 @ 它 → `ev.wake` 为空 → 提醒钩子直接 return，**一晚上根本没人提醒它**；
 *      它那会儿的发言全是 pacing 的「主动接话」，那条路径跑不到提醒；
 *   ② 配额按群算，两个群各能发一条，可空间只有一个；
 *   ③ 它只读得到本群记忆 —— 「读不到一整天」不是 bug，是旧设计。
 *
 * 现在的结构：
 *   · **状态全局**（`qzone-state.json` 的 `days['YYYY-MM-DD']`），一天一条，跨重启保留；
 *   · **定时兜底**：到点（默认 22:30）还没写，就在「空间工作区」会话里推一次当日回顾；
 *   · **素材跨群**：material.js 把当天所有留档 + 各群记忆摘要合成一篇 Markdown，落地可查；
 *   · **一个常驻会话**「空间工作区」：只放行 post/skip/status 三个工具，看得见、聊得着、有历史；
 *   · **能看自己的空间**：feed.js 用机器人自己的 cookie 读最近 N 天说说，避免天天一个调子。
 *
 * 三条红线（改之前先读）：
 *  ① **「不写」绝不能进空间**：skip 与 post 是两个工具，skip 一个字都不发；post 里还有正文防呆。
 *  ② **写盘只有一处**：withState()；读取侧永远不写。
 *  ③ **工作区会话只读空间、不碰聊天**：工具入口只放行三个空间工具
 *     （用内核的通用受限会话 markScope 登记，连 send_message 都调不到）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildDailyMaterial, localDateOf } from './material.js'
import { readOwnFeed } from './feed.js'

const STATE_FILE = 'qzone-state.json'
const DESK_CHAT_KEY = 'desk:qzone'
const DESK_TITLE = '空间工作区'
const FEED_TTL_MS = 6 * 3600 * 1000

/** 控制台计数用的运行时快照（schema 渲染早于 setup，拿不到 bot） */
const RUNTIME = { dataDir: '', limit: 1, workspaceDir: '', nudge: '', ready: false }

const statePath = (dataDir) => path.join(String(dataDir || '.'), STATE_FILE)

function emptyState() {
  return { version: 2, days: {}, desk: {}, feed: null }
}

function readState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return emptyState()
    const st = emptyState()
    if (raw.days && typeof raw.days === 'object') st.days = raw.days
    if (raw.desk && typeof raw.desk === 'object') st.desk = raw.desk
    if (raw.feed && typeof raw.feed === 'object') st.feed = raw.feed
    return st
  } catch {
    return emptyState()
  }
}

/** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半个 JSON */
function writeState(dataDir, value) {
  const file = statePath(dataDir)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function dayOf(all, date) {
  const d = String(date || localDateOf(Date.now()))
  const cur = all.days[d]
  if (cur && typeof cur === 'object') {
    cur.date = d
    if (!Number.isFinite(Number(cur.posted))) cur.posted = 0
    if (!Number.isFinite(Number(cur.attempts))) cur.attempts = 0
    if (typeof cur.skipped !== 'boolean') cur.skipped = false
    if (typeof cur.text !== 'string') cur.text = ''
    return cur
  }
  const fresh = {
    date: d, posted: 0, chars: 0, images: 0, at: 0, text: '', source: '',
    skipped: false, skipReason: '', decidedAt: 0, nudgedAt: 0, nudged2At: 0, attempts: 0, retryAt: 0,
    sessionId: '', material: null,
  }
  all.days[d] = fresh
  return fresh
}

/** 只留最近 keepDays 天（按日期键排序，最旧的先丢） */
function prune(all, keepDays) {
  const keep = Math.max(7, Number(keepDays) || 90)
  const dates = Object.keys(all.days).sort()
  if (dates.length <= keep) return
  for (const d of dates.slice(0, dates.length - keep)) delete all.days[d]
}

const decided = (day) => Number(day.posted) > 0 || day.skipped === true

/** 控制台顶部计数行（每次读 schema 现算，刷新即最新） */
function consoleSummary() {
  if (!RUNTIME.ready) return '📔 今日已发 —/—（等插件首次装配）'
  const all = readState(RUNTIME.dataDir)
  const day = all.days[localDateOf(Date.now())]
  if (!day || !decided(day)) {
    return '📔 今日还没写' + (RUNTIME.nudge ? '（' + RUNTIME.nudge + ' 会提醒它一次）' : '')
  }
  if (Number(day.posted) > 0) return '📔 今日已发 ' + day.posted + '/' + RUNTIME.limit + '（' + day.chars + ' 字）'
  return '📔 今日决定不写：' + (day.skipReason || '(未说原因)')
}

/** 最近几天的时间线（控制台 info 块） */
function recentLines(n) {
  if (!RUNTIME.ready) return ''
  const all = readState(RUNTIME.dataDir)
  const dates = Object.keys(all.days).sort().slice(-(Number(n) || 7)).reverse()
  if (!dates.length) return '（还没有任何记录）'
  const out = []
  for (const d of dates) {
    const x = all.days[d]
    if (Number(x.posted) > 0) out.push('· ' + d + ' 写了：' + (String(x.text || '').slice(0, 40) || '(无摘要)'))
    else if (x.skipped) out.push('· ' + d + ' 没写：' + (x.skipReason || '(未说原因)'))
    else out.push('· ' + d + ' 没决定（' + (x.nudgedAt ? '提醒过' : '未提醒') + '）')
  }
  return out.join('\n')
}

export default {
  id: 'qzone',
  title: 'QQ 空间日记',
  order: 62,

  configSchema: {
    info: {
      type: 'info', group: '空间日记',
      get text() {
        return consoleSummary() + '\n\n'
          + '最近几天（新→旧）\n' + recentLines(7) + '\n\n'
          + '给它一块自己的 QQ 空间当日记本：一天一条，写不写由它自己定。\n'
          + '· 素材是**当天所有会话**的经历（含私聊），不是某一个群。\n'
          + '· 到点还没写，就在「空间工作区」会话里推一次当日回顾（提醒 ≠ 强制）。\n'
          + '· 那个会话只放行 post_qzone / skip_qzone / qzone_status，碰不到聊天。\n'
          + '· 配图只接受本地绝对路径（表情包库、群友发来的图、生成图都可引用，只读不改）。'
      },
    },
    enabled: {
      type: 'bool', default: true, group: '空间日记',
      label: '启用空间日记',
      hint: '关掉后不会有定时回顾，也不能调发说说工具。',
    },
    nudgeHour: {
      type: 'int', default: 22, min: 0, max: 23, step: 1, group: '空间日记',
      label: '每天几点提醒它写空间',
      hint: '24 小时制。到点还没写也没跳过，就**在私聊里问一句**（不自动写、不催第三句）。'
        + '填 0 = 不提醒（全靠它自己想起来）。',
    },
    nudgeMinute: {
      type: 'int', default: 30, min: 0, max: 59, step: 1, group: '空间日记',
      label: '提醒的分钟',
      hint: '配合上一项，默认 22:30。',
    },
    nudgeMinute2: {
      type: 'int', default: 30, min: 1, max: 240, step: 5, group: '空间日记',
      label: '第二次提醒隔多久（分钟）',
      hint: '第一次提醒后它还没决定写不写，隔这么多分钟再问一句（默认 30 = 23:00）。\n'
        + '**只问两次**，之后不再打扰 —— 写不写是它自己的事。',
    },
    nudgeTo: {
      type: 'str', default: '', group: '空间日记',
      label: '提醒发到哪',
      hint: '留空 = 不推（只记日志）；填 private:<主人QQ> 就在私聊里问它。例：private:10001',
    },
    dailyLimit: {
      type: 'int', default: 1, min: 1, max: 5, step: 1, group: '空间日记',
      label: '每天最多发几条（全账号）',
      hint: '按整个空间算，不分群。建议保持 1 —— 只有一次机会才写得认真。',
    },
    maxChars: {
      type: 'int', default: 300, min: 20, max: 2000, step: 10, group: '空间日记',
      label: '单条最多多少字',
      hint: '说说正文上限，超出会被截断（不是报错）。',
    },
    maxImages: {
      type: 'int', default: 1, min: 0, max: 9, step: 1, group: '空间日记',
      label: '最多配几张图',
      hint: '默认 1 张稳妥；QQ 空间本身支持到 9 张。填 0 = 不许配图。',
    },
    imageDir: {
      type: 'str', default: 'qzone-imgs', group: '空间日记',
      label: '配图目录',
      hint: '相对数据目录。生成/转存的空间配图放这里。',
    },
    allowStickers: {
      type: 'bool', default: true, group: '空间日记',
      label: '允许引用表情包库里的图',
      hint: '只读引用（不发、不写、不改图库）。关掉后只能引用配图目录与其它本地路径。',
    },
    materialMaxChars: {
      type: 'int', default: 60000, min: 5000, max: 200000, step: 5000, group: '空间日记',
      label: '素材总字数上限',
      hint: '一天所有会话的正文上限，超了从最早的消息开始丢。越大越全，token 也越多。',
    },
    materialMsgsPerChat: {
      type: 'int', default: 400, min: 20, max: 3000, step: 20, group: '空间日记',
      label: '每个会话最多取多少条',
      hint: '从最近的消息往前取；和下面「素材往回看多少天」配合使用（热闹的群靠条数截、冷清的群靠天数兜）。',
    },
    materialDays: {
      type: 'int', default: 2, min: 1, max: 7, step: 1, group: '空间日记',
      label: '素材往回看多少天',
      hint: '1 = 只看今天（推荐）；2 = 今天 + 昨天。再往前的事对「今天写什么」没意义，别调太大。',
    },
    deskDryRun: {
      type: 'bool', default: false, group: '空间日记',
      label: '演练模式（只回顾、不发出去）',
      hint: '开着时：照常装配素材、照常让它回顾，但 post_qzone 会被拒，空间不会有任何变化。用来看它到底怎么想。',
    },
    feedDays: {
      type: 'int', default: 30, min: 0, max: 180, step: 1, group: '空间日记',
      label: '读自己空间最近多少天',
      hint: '写之前先看看前些天写了什么，避免天天一个调子。填 0 = 不读（只靠本地记录）。',
    },
    recentDays: {
      type: 'int', default: 7, min: 1, max: 60, step: 1, group: '空间日记',
      label: '回顾时带上最近几天写过的说说',
      hint: '从本地决策记录里取最近 N 天「写过什么/为什么没写」一起放进提示词。',
    },
    keepDays: {
      type: 'int', default: 90, min: 7, max: 365, step: 1, group: '空间日记',
      label: '本地保留多少天决策记录',
      hint: '状态文件里每天一条记录（写了什么摘要、为什么没写），过期自动清。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const dataDir = String(bot.core?.dataDir || '')
    // 素材落在「QQ 工作区」里：GUI 侧栏能直接打开看（相对路径按数据目录解析，和内核一致）
    const workspaceRaw = String(bot.core?.dsh?.qqWorkspacePath || 'workspace')
    const workspaceDir = path.isAbsolute(workspaceRaw) ? workspaceRaw : path.join(dataDir, workspaceRaw)
    const limit = () => Math.max(1, Number(cfg().dailyLimit) || 1)

    function nudgeLabel() {
      const h = Math.max(0, Number(cfg().nudgeHour) || 0)
      if (!h) return ''
      const m = Math.max(0, Math.min(59, Number(cfg().nudgeMinute) || 0))
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
    }

    /**
     * 协议端只读句柄：新内核叫 bot.onebot，2026-10 之前的安装副本叫 bot.napcat。
     * 两个名字都认，插件才能在老副本上先跑起来（否则发说说会静默变成 undefined）。
     */
    const nb = () => bot.onebot || bot.napcat || {}

    RUNTIME.dataDir = dataDir
    RUNTIME.workspaceDir = workspaceDir
    RUNTIME.limit = Math.max(1, Number(cfg().dailyLimit) || 1)
    RUNTIME.nudge = nudgeLabel()
    RUNTIME.ready = true

    /** 读状态 → 改 → 写回。所有落盘都走这里（唯一写入口） */
    function withState(mutator) {
      const all = readState(dataDir)
      const out = mutator(all)
      prune(all, cfg().keepDays)
      const ok = writeState(dataDir, all)
      if (!ok) bot.log?.warn?.('[空间] 状态落盘失败：重启后可能重复计数')
      return out
    }

    const today = () => dayOf(readState(dataDir), localDateOf(Date.now()))

    /** 配图目录（相对 dataDir 由内核解析；这里再兜底一次） */
    const imageDir = () => {
      const raw = String(cfg().imageDir || 'qzone-imgs').trim() || 'qzone-imgs'
      return path.isAbsolute(raw) ? raw : path.join(dataDir, raw)
    }

    /** 配图校验：必须存在；只读引用，不改图库（表情包库里的图也能发） */
    const checkImage = (p) => {
      const abs = path.resolve(String(p || '').trim())
      if (!abs) return { ok: false, msg: '图片路径为空' }
      let real = abs
      try { real = fs.realpathSync(abs) } catch { return { ok: false, msg: '图片不存在：' + abs } }
      if (cfg().allowStickers === false) {
        const stickerReal = (() => { try { return fs.realpathSync(path.join(dataDir, 'qq-stickers')) } catch { return '' } })()
        if (stickerReal && (real === stickerReal || real.startsWith(stickerReal + path.sep))) {
          return { ok: false, msg: '配置里关掉了「引用表情包库」，请换一张图' }
        }
      }
      return { ok: true, path: real }
    }

    // ── 工具 ①：写说说 ──────────────────────────────────────
    bot.registerTool('post_qzone', {
      description: '把一条说说发到自己的 QQ 空间。**全账号每天只有一次机会**（不是每个群一次），发了就用完。'
        + '在任何对话里都能直接写（包括跟你主人的私聊）—— 写完会有一句回执告诉你「什么时候该说点别的」。'
        + '不想写时千万不要调这个工具，改调 skip_qzone() —— 千万别把「今天不写」当正文发出去，那是公开可见的。'
        + 'images 只能给本地文件绝对路径（表情包、群友发的图、生成图都行），最多 9 张。',
      parameters: {
        target: {
          type: 'string',
          description: '留空即可（自动按当前对话）；也接受 desk / group:<群号> / private:<QQ号>',
        },
        content: {
          type: 'string', required: true,
          description: '说说正文（就是这一条的内容本身；不要写「今天不写」这类话）',
        },
        images: {
          description: '配图：本地文件绝对路径，可传字符串或数组。可选。',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
      async execute(args = {}) {
        if (cfg().enabled === false) return { ok: false, reason: '空间日记未启用' }
        if (cfg().deskDryRun === true) {
          return { ok: false, reason: '现在是演练模式（控制台「空间日记」里关掉它才能真的发出去）' }
        }
        const day = today()
        if (day.posted >= limit()) {
          return { ok: false, reason: '今天已经写过 ' + day.posted + ' 条了（全账号上限 ' + limit() + '），明天再来' }
        }
        const text = String(args.content ?? '').trim()
        if (!text) return { ok: false, reason: 'content 不能为空' }
        if (/^[【\[]?不写[】\]]?[。.]?$/.test(text) || /^今天不写/.test(text)) {
          return { ok: false, reason: '这看起来是「不写」的意思 —— 请改用 skip_qzone()，不要发到空间' }
        }
        const maxChars = Math.max(1, Number(cfg().maxChars) || 300)
        const body = text.length > maxChars ? text.slice(0, maxChars) : text

        const rawImg = args.images
        const list = Array.isArray(rawImg) ? rawImg : (rawImg ? [rawImg] : [])
        const maxImg = Math.max(0, Number(cfg().maxImages) || 1)
        if (maxImg === 0 && list.length) return { ok: false, reason: '配置里关掉了配图（最多配图数 = 0）' }
        const paths = []
        for (const p of list.slice(0, maxImg)) {
          const r = checkImage(p)
          if (!r.ok) return { ok: false, reason: r.msg }
          paths.push(r.path)
        }

        const adapter = nb()
        if (typeof adapter.sendQzoneMsg !== 'function') {
          return { ok: false, reason: '这个安装副本的协议端封装里没有 sendQzoneMsg（内核太旧）' }
        }
        const res = await adapter.sendQzoneMsg({ content: body, images: paths })
        if (!res?.ok) return { ok: false, reason: res?.msg || '发说说失败' }

        withState((all) => {
          const d = dayOf(all, localDateOf(Date.now()))
          d.posted += 1
          d.chars = body.length
          d.images = paths.length
          d.at = Date.now()
          d.text = body.slice(0, 120)
          d.source = String(args.target || '')
          d.decidedAt = Date.now()
        })
        bot.log?.info?.('[空间] 发出说说 ' + body.length + ' 字' + (paths.length ? ' + ' + paths.length + ' 张图' : '')
          + '（今天第 ' + (day.posted + 1) + '/' + limit() + ' 条，来源 ' + String(args.target || '未知') + '）')
        // 跨会话流水账（2026-10-30）：写说说多半发生在「空间工作区」这个专用会话里，
        // 私聊里的它根本不知道，于是会问「我是不是还没写」。记一行，家里那轮就能看到。
        try {
          bot.selfLog?.append?.({
            kind: 'qzone',
            what: '在 QQ 空间发了一条说说（' + body.length + ' 字' + (paths.length ? ' + ' + paths.length + ' 张图' : '') + '）',
            why: '我自己想记一笔',
            where: '空间工作区',
          })
        } catch { /* 记账失败不影响已经发出去的说说 */ }
        return {
          ok: true,
          posted: true,
          chars: body.length,
          images: paths.length,
          next: '发出去了。现在用你自己的话跟对方说一句 —— 你刚才在空间里写了什么、为什么写，'
            + '像聊天那样说，别复述正文、别说"已发布"。',
        }
      },
    })

    // ── 工具 ②：今天不写（绝不发任何东西）──────────────────────
    bot.registerTool('skip_qzone', {
      description: '今天不写说说。**这个工具不会往空间发任何内容**，只记下「我考虑过了，今天没有想写的」。'
        + '在群/私聊里调用只表示这段对话不用写，不影响晚上的回顾；只有在空间工作区里调才算「今天不写」。',
      parameters: {
        target: { type: 'string', description: '留空 = 当前对话；desk = 空间工作区；也接受 group:<群号> / private:<QQ号>' },
        reason: { type: 'string', description: '为什么不想写（只记日志，不会发到空间）' },
      },
      async execute(args = {}) {
        // 2026-10-30：target 可选 —— 它现在可以在私聊里直接说「今天不写」。
        // 以前必须传 desk 才真的生效，等于「家里说的不算」，正是要解决的割裂。
        const a = args || {}
        const target = String(a.target || '').trim() || (() => {
          const turn = (() => { try { return bot.currentTurn?.() || null } catch { return null } })()
          return String(turn?.chatKey || '') || DESK_CHAT_KEY
        })()
        const why = String(a.reason ?? '').trim() || '(没说原因)'
        const inDesk = target === 'desk' || target === DESK_CHAT_KEY
        withState((all) => {
          const d = dayOf(all, localDateOf(Date.now()))
          d.skipped = true
          d.skipReason = why
          d.decidedAt = Date.now()
        })
        bot.log?.info?.('[空间] 今天决定不写：' + why)
        try {
          bot.selfLog?.append?.({ kind: 'qzone', what: '今天不写说说（' + why.slice(0, 40) + '）', why: '自己决定的', where: '空间工作区' })
        } catch { /* ignore */ }
        return { ok: true, skipped: true, global: true }
      },
    })

    // ── 工具 ③：查状态 ────────────────────────────────────────
    bot.registerTool('qzone_status', {
      description: '查今天这块空间的状况（写过没有、还剩几次机会、素材覆盖了多少会话）。'
        + '在任何会话里都能调；想确认「今天我是不是已经写过了」就用它。',
      parameters: {
        target: { type: 'string', description: '可留空' },
      },
      async execute() {
        const all = readState(dataDir)
        const d = dayOf(all, localDateOf(Date.now()))
        return {
          ok: true,
          enabled: cfg().enabled !== false,
          date: d.date,
          used: d.posted,
          limit: limit(),
          remaining: Math.max(0, limit() - d.posted),
          skippedToday: d.skipped === true,
          skipReason: d.skipReason || '',
          decided: decided(d),
          nudgedAt: d.nudgedAt || 0,
          material: d.material || null,
          feedDays: Number(cfg().feedDays) || 0,
        }
      },
    })

    // ── 空间工作区会话 ───────────────────────────────────────
    let deskRunning = false

    async function ensureDeskSession() {
      const dsh = bot.dsh
      if (typeof dsh?.ensureSession !== 'function') throw new Error('会话控制器不可用，无法开空间工作区')
      const sessionId = await dsh.ensureSession(DESK_CHAT_KEY, DESK_TITLE)
      // 登记成受限会话：这个会话里只放行空间三件套（内核按 scopedSessions 拦）
      try {
        bot.core?.markScope?.(sessionId, DESK_TITLE, ['post_qzone', 'skip_qzone', 'qzone_status'])
      } catch { /* 老内核没有 markScope 就退化成普通会话 */ }
      try { if (typeof dsh.rename === 'function') await dsh.rename(sessionId, DESK_TITLE) } catch { /* 改名失败不影响 */ }
      return sessionId
    }

    /** 给会话发一条提示词并等这一轮结束（超时返回 { timeout: true }，不抛） */
    function promptAndWait(sessionId, text, timeoutMs) {
      const dsh = bot.dsh
      return new Promise((resolve, reject) => {
        let off = null
        let done = false
        let timer = null
        const finish = (v) => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          try { off?.() } catch { /* ignore */ }
          resolve(v)
        }
        timer = setTimeout(() => finish({ timeout: true }), Math.max(30000, Number(timeoutMs) || 720000))
        timer.unref?.()
        try {
          off = dsh.onTurnEnd(sessionId, () => finish({ timeout: false }))
        } catch (e) {
          clearTimeout(timer)
          return reject(e)
        }
        Promise.resolve(dsh.prompt(sessionId, text)).catch((e) => {
          if (done) return
          done = true
          clearTimeout(timer)
          try { off?.() } catch { /* ignore */ }
          reject(e)
        })
      })
    }

    /** 最近 N 天写过的说说（本地记录，秒回） */
    function recentPosted(all, days) {
      const out = []
      const dates = Object.keys(all.days).sort().slice(-Math.max(1, Number(days) || 7))
      for (const d of dates.slice().reverse()) {
        const x = all.days[d]
        if (Number(x.posted) > 0 && x.text) out.push('· ' + d + '：' + x.text)
        else if (x.skipped) out.push('· ' + d + '：（那天没写）' + (x.skipReason ? ' ' + x.skipReason : ''))
      }
      return out.length ? out.join('\n') : '（最近几天都没写过）'
    }

    /** 读自己空间的说说（6 小时缓存；失败就当没有） */
    async function feedItems(all) {
      const days = Math.max(0, Number(cfg().feedDays) || 0)
      if (!days) return { ok: false, items: [], reason: '配置里关掉了读取' }
      const cached = all.feed
      if (cached && Array.isArray(cached.items) && Date.now() - Number(cached.at || 0) < FEED_TTL_MS) {
        return { ok: Boolean(cached.ok), items: cached.items, reason: cached.reason || '' }
      }
      const res = await readOwnFeed({ onebot: nb(), days, log: bot.log })
      withState((s) => { s.feed = { at: Date.now(), ok: Boolean(res.ok), items: res.items, reason: res.reason || '' } })
      return res
    }

    function buildDeskPrompt({ material, feed, all, reason, onlyChatKey = '' }) {
      const now = new Date()
      const stamp = localDateOf(now.getTime()) + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
      const parts = []
      const rangeText = Number(material.stats && material.stats.days) > 1 ? '最近 ' + material.stats.days + ' 天' : '今天'
      parts.push('【' + rangeText + '的经历】' + (onlyChatKey ? '（只看 ' + onlyChatKey + ' 这一段）' : '') + '（' + stamp + '，' + reason + '）')
      parts.push(material.text)
      parts.push('')
      parts.push('【你最近几天写过的说说】')
      parts.push(recentPosted(all, Number(cfg().recentDays) || 7))
      if (feed.ok && feed.items.length) {
        parts.push('')
        parts.push('【你空间里最近 ' + (Number(cfg().feedDays) || 0) + ' 天的说说（含更早的）】')
        for (const it of feed.items.slice(0, 40)) {
          const t = new Date(it.ts)
          parts.push('· ' + localDateOf(it.ts) + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
            + '：' + (it.text || '(无正文)') + (it.pics ? '（' + it.pics + ' 张图）' : ''))
        }
      }
      parts.push('')
      parts.push('【现在】这块空间今天还没有写（全账号一天只有一条机会）。')
      if (cfg().deskDryRun === true) {
        parts.push('【演练模式】这次不发出去：**不要调任何工具**。把你想写的那一条原样写出来，再补一句为什么这么写；如果今天不想写，也直说。')
      } else {
        parts.push('想写就调 post_qzone(target="desk", content=..., images=...)：写你**自己**今天真正想记下的一件事，不是群聊流水账。')
        parts.push('不想写就调 skip_qzone(target="desk", reason=...)：这也是完全正常的选项，不欠账，明天照常。')
        parts.push('别只回一句话就结束 —— 要么调工具，要么说清为什么今天不写（同样要调 skip）。')
      }
      return parts.join('\n')
    }

    /** 到点兜底：一天最多试 5 次，失败 20 分钟后重试 */
    async function runDesk(reason, opts = {}) {
      const onlyChatKey = String(opts.onlyChatKey || '').trim()
      if (deskRunning) return { skipped: 'running' }
      deskRunning = true
      try {
        const archiveRaw = String(bot.core?.archive?.dir || 'logs/qq_chat')
        const archiveDir = path.isAbsolute(archiveRaw) ? archiveRaw : path.join(dataDir, archiveRaw)
        const material = buildDailyMaterial({
          archiveDir,
          memoryDir: path.join(dataDir, 'qq-memory'),
          workspaceDir,
          date: localDateOf(Date.now()),
          msgPerChat: Number(cfg().materialMsgsPerChat) || 400,
          totalChars: Number(cfg().materialMaxChars) || 60000,
          onlyChatKey,
          days: Math.max(1, Number(cfg().materialDays) || 1),
          memoryMaxAgeDays: Math.max(1, Number(cfg().materialDays) || 1),
        })
        withState((all) => {
          const d = dayOf(all, localDateOf(Date.now()))
          d.nudgedAt = Date.now()
          d.attempts = (Number(d.attempts) || 0) + 1
          d.material = material.stats
        })
        bot.log?.info?.('[空间] 当日回顾开始：' + material.stats.chats + ' 个会话 / ' + material.stats.messages + ' 条消息'
          + '（素材 ' + material.stats.chars + ' 字' + (material.file ? '，' + material.file : '') + '）')

        if (!material.stats.messages) {
          withState((all) => {
            const d = dayOf(all, localDateOf(Date.now()))
            d.skipped = true
            const rangeText = Number(material.stats.days) > 1 ? '最近 ' + material.stats.days + ' 天' : '今天'
            d.skipReason = onlyChatKey ? ('这一段' + rangeText + '没有人说话（' + onlyChatKey + '）') : (rangeText + '没有任何人说话')
            d.decidedAt = Date.now()
          })
          bot.log?.info?.('[空间] 今天没人说话，不打扰它了')
          return { skipped: 'empty' }
        }

        const all = readState(dataDir)
        const feed = await feedItems(all)
        const sessionId = await ensureDeskSession()
        withState((s) => { dayOf(s, localDateOf(Date.now())).sessionId = sessionId })
        const prompt = buildDeskPrompt({ material, feed, all, reason, onlyChatKey })
        const r = await promptAndWait(sessionId, prompt, 12 * 60000)
        // 假警报防护：模型偶发「先说一句、下一步才调工具」，turn/end 到落库之间有几百毫秒到十几秒，
        // 直接判「没做决定」会在日志里留下误导性 WARN。给 20 秒缓冲再判一次。
        if (!decided(today())) await new Promise((resolve) => { const t = setTimeout(resolve, 20000); t.unref?.() })
        if (cfg().deskDryRun === true) {
          withState((s) => { dayOf(s, localDateOf(Date.now())).retryAt = Date.now() + 12 * 3600 * 1000 })
          bot.log?.info?.('[空间] 演练结束（没有发出去）；去看「' + DESK_TITLE + '」会话里它怎么写的')
          return { ok: true, dryRun: true }
        }
        const after = today()
        if (decided(after)) {
          bot.log?.info?.('[空间] 当日回顾结束：' + (Number(after.posted) > 0
            ? '写了 ' + after.chars + ' 字'
            : '决定不写（' + (after.skipReason || '未说原因') + '）'))
          return { ok: true, decided: true }
        }
        withState((s) => { dayOf(s, localDateOf(Date.now())).retryAt = Date.now() + 20 * 60000 })
        bot.log?.warn?.('[空间] 回顾结束但它没做决定（' + (r.timeout ? '超时' : '只回了话没调工具') + '），20 分钟后再问')
        return { ok: false, reason: 'undecided' }
      } catch (e) {
        withState((s) => { dayOf(s, localDateOf(Date.now())).retryAt = Date.now() + 20 * 60000 })
        bot.log?.warn?.('[空间] 当日回顾失败：' + (e?.message || e))
        return { ok: false, reason: String(e?.message || e) }
      } finally {
        deskRunning = false
      }
    }

    // ── 定时器：到点兜底（不依赖有人说话，这是旧版最大的坑） ────
    const currentMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes() }
    const nudgeMinutes = () => {
      const h = Math.max(0, Math.min(23, Number(cfg().nudgeHour) || 0))
      if (!h) return 0
      const m = Math.max(0, Math.min(59, Number(cfg().nudgeMinute) || 0))
      return h * 60 + m
    }

    /**
     * 到点提醒（2026-10-30 改语义：**只提醒，不自动写**）。
     *
     * 用户要的是「它自己决定什么时候写」，不是「到点被塞着写」。所以这里只：
     *   ① 到 nudgeHour:nudgeMinute 往**发起会话**（私聊/群）说一句话；
     *   ② 如果它还是没决定，再等 nudgeHour2 分钟说第二句；
     *   ③ 说完就完 —— 不催第三次，也不自动 runDesk。
     *
     * 真写还是走 runDesk（它自己在空间工作区里调 post_qzone），那条路没变。
     * 提醒的记录落在当日状态里（nudgedAt / nudged2At），重启不会重复提醒。
     */
    async function tick() {
      if (cfg().enabled === false) return
      const start = nudgeMinutes()
      if (!start || currentMinutes() < start) return
      const d = today()
      if (decided(d)) return
      if (deskRunning) return
      // 演练模式下不推（否则每小时都可能往私聊塞一句）
      const dry = cfg().deskDryRun === true

      const now = Date.now()
      const secondAt = Math.max(start + 1, Number(cfg().nudgeMinute2) ? start + Math.max(1, Number(cfg().nudgeMinute2)) : start + 30)
      const firstDone = Number(d.nudgedAt) > 0
      const secondDone = Number(d.nudged2At) > 0
      if (firstDone && (secondDone || currentMinutes() < secondAt)) return

      const round = firstDone ? 2 : 1
      withState((all) => {
        const x = dayOf(all, localDateOf(Date.now()))
        if (round === 1) x.nudgedAt = now
        else x.nudged2At = now
      })
      if (dry) {
        bot.log?.info?.('[空间] 演练模式：到点了，但不推提醒（第 ' + round + ' 次）')
        return
      }
      // 在哪说话：优先发到配置里的提醒会话（默认主人私聊）；没有就只记日志
      const to = String(cfg().nudgeTo || '').trim()
      const line = round === 1
        ? '今天快过完了，要不要记点什么到空间？（不写也完全没关系，明天照常）'
        : '再问一次：今天想不想记点什么？不写也行，以后不问了。'
      bot.log?.info?.('[空间] 到点提醒（第 ' + round + ' 次）' + (to ? ' → ' + to : '（没配提醒会话，只记日志）'))
      if (!to) return
      try { await bot.deliver(to, line) } catch (e) { bot.log?.warn?.('[空间] 提醒发送失败: ' + (e?.message || e)) }
    }

    const timer = setInterval(() => { tick().catch(() => {}) }, 60 * 1000)
    timer.unref?.()
    bot.onDispose?.(() => clearInterval(timer))
    // 开机那次 tick 原来把异常整个吞了（catch(() => {})）：
    // 主循环里有 catch，这里再吞一次 = 开机那一次失败永远查不到原因。
    const boot = setTimeout(() => {
      tick().catch((e) => bot.log?.warn?.('[空间] 开机检查失败（不影响聊天）: ' + (e?.message || e)))
    }, 90 * 1000)
    boot.unref?.()
    bot.onDispose?.(() => clearTimeout(boot))
    // 老内核没有 bot.onDispose（2026-10 之前的副本）：用进程级槽兜底，
    // 否则控制台每改一次配置热重载插件，就多叠一个 60s 定时器。
    const slot = Symbol.for('dsh.onebot.qzone.timers')
    const prev = globalThis[slot]
    if (prev) { try { clearInterval(prev.timer); clearTimeout(prev.boot) } catch { /* ignore */ } }
    globalThis[slot] = { timer, boot }

    // ── 主人手动触发（/qzone 或 /空间）─────────────────────────
    const cmdReply = async (ev, text, name) => {
      ev.stopped = true
      ev.stopReason = 'qzone:' + name
      try { await bot.deliver(ev.chatKey, text, { replyTo: ev.messageId }) } catch { /* 回复失败不影响状态 */ }
    }
    for (const name of ['qzone', '空间']) {
      bot.registerCommand(name, {
        description: '立刻让它回顾今天并决定写不写空间（仅主人）；/空间 群聊 = 只按本群的事写',
        async handler(ev, args = []) {
          if (ev.sender?.isMaster !== true) return cmdReply(ev, '🙅 这个命令只有主人能用', 'qzone')
          const mode = String((args || [])[0] || '').trim()
          const scoped = mode === '群聊' || mode === '群' || mode === '本群'
          if (mode && !scoped) {
            return cmdReply(ev, '📔 用法：/空间（按一整天的经历写）或 /空间 群聊（只按本群的事写）', 'qzone')
          }
          if (scoped && !String(ev.chatKey || '').startsWith('group:')) {
            return cmdReply(ev, '📔 「群聊」要在一个群里发，才知道读哪个群的记忆', 'qzone')
          }
          const d = today()
          if (decided(d)) {
            return cmdReply(ev, d.posted > 0
              ? '📔 今天已经写过了（' + d.chars + ' 字）'
              : '📔 今天已经决定不写了：' + (d.skipReason || '未说原因'), 'qzone')
          }
          await cmdReply(ev, scoped
            ? '📔 好，我按这个群今天的事来写写看。'
            : '📔 好，我把今天一整天过一遍再决定。', 'qzone')
          runDesk(scoped ? '主人叫的（本群）' : '主人叫的', scoped ? { onlyChatKey: ev.chatKey } : {}).catch(() => {})
        },
      })
    }

    /** 控制台按钮：重置今天的额度（只动本地状态，不碰空间里已有的说说） */
    bot.shared.qzoneResetToday = (opts = {}) => {
      const all = readState(dataDir)
      const d = dayOf(all, localDateOf(Date.now()))
      if (opts && opts.preview) {
        return {
          ok: true,
          previewLines: [
            '日期：' + d.date,
            '今天已发：' + Number(d.posted || 0) + ' 条' + (d.text ? '（' + d.text.slice(0, 40) + '）' : ''),
            '今天是否已跳过：' + (d.skipped ? '是（' + (d.skipReason || '未说原因') + '）' : '否'),
            '重置后：今天的额度归零，它还可以再写一条；空间里已经发出去的说说不会被删。',
          ],
          message: '预演完成，确认后才会真的重置',
        }
      }
      withState((s) => {
        const x = dayOf(s, localDateOf(Date.now()))
        x.posted = 0
        x.chars = 0
        x.images = 0
        x.at = 0
        x.text = ''
        x.source = ''
        x.skipped = false
        x.skipReason = ''
        x.decidedAt = 0
        x.nudgedAt = 0
        x.nudged2At = 0
        x.attempts = 0
        x.retryAt = 0
      })
      bot.log?.info?.('[空间] 主人重置了今天的额度')
      return { ok: true, message: '今日额度已重置（今天还能再写一条）' }
    }

    // 控制台/排障可手动触发一次回顾
    bot.shared.qzoneRunNow = (note) => {
      runDesk(String(note || '控制台手动触发')).catch(() => {})
      return { ok: true, message: '已经让它开始回顾了，去看「' + DESK_TITLE + '」会话' }
    }

    bot.shared.qzoneDesk = {
      runNow: (note) => runDesk(String(note || '手动触发')),
      status: () => {
        const all = readState(dataDir)
        const d = dayOf(all, localDateOf(Date.now()))
        return { date: d.date, posted: d.posted, decided: decided(d), material: d.material, nudgedAt: d.nudgedAt, attempts: d.attempts }
      },
    }
  },
}