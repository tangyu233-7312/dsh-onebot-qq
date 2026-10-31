/**
 * gate-wake.js — 硬门禁 + 唤醒判定 + 免模型拦截（id: 'gate-wake', order: 10）
 *
 * 门禁优先级：
 *   ① 群内黑名单 `groupUserBlocklist`（最高优先，命中**不回、不入站留档**）
 *   ② 群屏蔽 `ignoreGroups` + 运行时 `runtimeIgnore`（compat 网关 / 控制台群卡片共用）
 *   ③ 群内白名单 `groupUserAllowlist[群号]`（该群配了非空白名单时，非主人不在名单 → 拦）
 *   ④ 全局 `allowedUsers`（非空时，非主人不在名单 → 拦；**主人永远放行**）
 * ⚠️ 这些值**每次判定都现读 `bot.cfg`**（控制台写配置会原地热同步这个对象，热改要立即生效），
 *    不在 setup 开头算死。本插件只认实例配置，**没有旧配置文件回落**。
 *
 * 唤醒行为约束（都是线上踩出来的，改之前先看手册 §2 / §4 / §7）：
 *   · 唤醒顺序：**@本机 → 引用本机 → 接续窗口 → 关键词**。@ 优先，因为"@ 了还带正文"是最明确的呼叫。
 *   · 判"是不是在叫本机"看**内容**，不看 @ 的是谁（模型侧纪律见 QQ 线指令文件）——
 *     所以这里只做代码能判的：@ 段、被引发送者、唤醒词，不猜语义。
 *   · 纯 @ / 纯呼名 / 只引用但无正文 → **先回一句罐头话（callAck）+ 开接续窗口，不进模型、零 token**
 *     （群线一次调用 ≈1 万 token，不值得为"干嘛呀"花）。但**纯 @ + 带引用**例外：引用本身就是
 *     "我在说这条"，直接按被引内容答，不开窗口。
 *   · **纯呼名不参与关键词冷却**：它不拦、也不写冷却时间戳 —— 两处沾一样就会出现
 *     "刚聊完再喊一声 + 补正文 → 整段没人应"。
 *   · 引用反查拿不到发送者 → 当**没叫本机**（宁可漏唤醒，也不越界插话）。
 *
 * 免模型拦截（intercept）：
 *   · 被戳 → 回戳 **+** 回一句话（句池 poke 节；适配器不支持 poke 时只剩回话，不影响回话）。
 *   · 引用一条 + 说"撤回" → 撤那一条，**同一条只试一次**（批量重试会把群刷爆）。
 *   · 审批等待期的「允许/拒绝」→ 交给内核挂的回调（本插件不持有审批状态）。
 */

/** 纯呼名判定用的语气词（「名字呀」/「名字～」这种不算正文） */
const NAME_ONLY_FILLERS = /[呀啊欸诶嘛啦哦喔咯嗯哎哟呜呦]/g
/** 没有 callAck 句池时的兜底（句池由 persona-voice 挂在 bot.linesPool 上） */
const DEFAULT_ACK = ['在', '嗯？', '怎么了？', '听着呢']
/** 没有 poke 句池时的兜底 */
const DEFAULT_POKE = ['嗯？', '在', '怎么了？', '别戳', '有事说事']
/** 同一人同群"不重复答应"间隔（旧 callAckMs 默认 20000；schema 没这项，内置） */
const ACK_DEDUPE_MS = 20000
/** 同一人回戳冷却（旧 pokeCooldownMs 默认 3000） */
const POKE_COOLDOWN_MS = 3000

/** 本插件开关表（控制台据此渲染；值每轮现读 bot.cfg） */
const configSchema = {
  enabled: { type: 'bool', default: true, group: '唤醒', label: '门禁与唤醒', hint: '总开关：关掉后群里不再响应 @ / 唤醒词 / 戳一戳（等于机器人闭嘴）。' },
  adminQq: {
    type: 'int', default: 0, group: '权限', label: '主人 QQ（一般不用改）',
    hint: '插件侧的主人 QQ（内核会用实例配置的 adminQq 自动填，两边保持一致）。用途：① 主人私聊豁免出站脱敏；② 群里「主人指令」按它判定；③ 改配置类命令只认它。'
      + '一般不用动；在「群聊」页顶部改主人 QQ 后，内核会自动同步到这里。',
  },
  keywords: {
    type: 'text', default: '', group: '唤醒', label: '群唤醒词（免 @ 唤醒）',
    hint: '控制台用「填空 + 添加」维护（加/删写 config，底层存储仍是 `*: 词1,词2` / `<群号>: 词1,词2` 文本行）；人设 `.wake.txt` 里的词**合并生效**（去重）。',
  },
  ignoreGroups: {
    type: 'group', default: [], group: '门禁', label: '屏蔽群（整群不理）',
    hint: '群号列表（逗号分隔）。这些群的消息完全忽略：@ 它、叫它、发文件都不处理，不回复、不进对话映射。'
      + '例：123456789,987654321。「群聊」页每张群卡片上的「屏蔽」改的是同一份配置，改哪边都一样；热生效，不用重启。',
  },
  groupUserBlocklist: {
    type: 'str', default: '', group: '门禁', label: '群内黑名单「群号:QQ,QQ;群号:QQ」',
    hint: '格式：群号:QQ,QQ;群号:QQ。命中的人发的消息「不回、也不进留档」（连上下文都不写），优先级最高（主人也拦）。'
      + '例：123456789:10001,10002;987654321:10003。也接受 {"群号":[QQ]} 的 JSON 对象形态；「群聊」页群卡片里的「黑名单」改的是同一份配置。',
  },
  groupUserAllowlist: {
    type: 'str', default: '', group: '门禁', label: '群内白名单「群号:QQ,QQ;群号:QQ」',
    hint: '格式同黑名单：群号:QQ,QQ;群号:QQ。某个群配了非空白名单后，只有名单内的人和主人能在这个群触发对话（别人发的消息不处理）；留空 = 该群不限制。'
      + '例：123456789:10001,10002。也接受 JSON 对象形态；「群聊」页群卡片里的「白名单」改的是同一份配置。',
  },
  allowedUsers: {
    type: 'group', default: [], group: '门禁', label: '全局允许用户（空 = 不限制）',
    hint: 'QQ 号列表（逗号分隔）。非空时：只有名单内的 QQ 和主人能使用本机（群聊 + 私聊都生效）；空 = 不限制。'
      + '和「群内白名单」的区别：这个限制所有群和私聊，群内白名单只限制某一个群。适合「只给自己和几个朋友用」的场景。',
  },
  groupAtRequired: { type: 'bool', default: true, group: '唤醒', label: '群聊必须被叫才回', hint: '开：群里必须 @ 它或叫到唤醒词才回；关：没人叫也会接话（容易吵，一般保持开）。' },
  groupFollowUpMs: {
    type: 'int', default: 20000, unit: '秒', scale: 1000, group: '唤醒', label: '接续窗口',
    hint: '值按毫秒存（旧配置 40000 = 40 秒）；也认小于 1000 的"秒"值。0 = 关闭接续窗口。',
  },
  keywordCooldownMs: {
    type: 'int', default: 60000, unit: '秒', scale: 1000, group: '唤醒', label: '关键词冷却',
    hint: '同群命中唤醒词后这段时间内再命中只记日志（防刷屏）；纯呼名不参与冷却。',
  },
  callAck: { type: 'bool', default: true, group: '唤醒', label: '被叫但没正文时先答应一声', hint: '开：有人只叫了它名字却没接着说事，先回一声「在」再等下文；关：安静等对方把话说完。' },
  pokeBack: {
    type: 'bool', default: true, group: '唤醒', label: '被戳回一句',
    hint: '有人戳一戳（双击头像）它时：开 = 回戳时再加一句（句子从人设 `.lines.txt` 的 `## poke` 节里挑，回戳失败也照常回话）；关 = 完全不理。戳一戳不算唤醒，不会进模型、不花 token。',
  },
}

/** 是否"只喊了名字"：剥掉关键词后只剩空白/标点/符号(含 emoji)/语气词 → true */
function isNameOnlyCall(text, keyword) {
  let t = String(text || '')
  if (keyword) t = t.replace(new RegExp(String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
  return t.replace(/[\s\p{P}\p{S}]/gu, '').replace(NAME_ONLY_FILLERS, '').length === 0
}

/** 数字列表归一（群号/QQ 都可能是字符串、数组、逗号分隔串） */
function toNumList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,，\s]+/)
  return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

/**
 * 群号 → QQ 列表映射（黑名单/白名单**同构**：旧实现只写了一份解析，别各写一套）。
 * 兼容两种录入形态：`{"群号":[QQ]}` 对象（旧配置）与 `"群号:QQ,QQ;群号:QQ"` 字符串（控制台）。
 */
function groupMapOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw).map(([g, qqs]) => [String(g), toNumList(qqs)]))
  }
  const map = {}
  for (const part of String(raw || '').split(/[;；\n]/)) {
    const [g, qs] = part.split(/[:：]/)
    const gid = String(g ?? '').trim()
    if (gid) map[gid] = toNumList(qs)
  }
  return map
}

/** 毫秒归一：两种口径都认 —— 旧配置存 ms（40000），控制台可能写"秒"（40）。 */
function msOf(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1000 ? Math.round(n) : Math.round(n * 1000)
}

/** 取生效值：**每次判定现读 `bot.cfg`**（控制台热改立即生效），缺键回落到 schema 默认值。 */
function effective(bot, field) {
  const cur = bot?.cfg?.[field]
  return cur === undefined ? configSchema[field]?.default : cur
}

/**
 * 运行时屏蔽（compat 网关的 `/ignore/*` 与控制台群卡片共用同一份）。
 * 除了任务要求的 `{ set, add, remove, list, has }`，额外给 `delete` 别名与迭代器：
 * kernel/compat-server.js 里那份实现是 `Set`（用 `delete` + `[...set]`），这样它可以**直接换成这一份**
 * 而不用改写法（见汇报里的接线建议）。
 */
function createRuntimeIgnore() {
  const set = new Set()
  const norm = (gid) => String(Number(gid))
  return {
    set,
    add(gid) {
      const g = norm(gid)
      if (!/^\d+$/.test(g)) throw new Error(`群号不合法: ${gid}`)
      set.add(g)
      return [...set]
    },
    remove(gid) {
      set.delete(norm(gid))
      return [...set]
    },
    delete(gid) {
      set.delete(norm(gid))
      return [...set]
    },
    list() {
      return [...set]
    },
    has(gid) {
      return set.has(norm(gid))
    },
    [Symbol.iterator]() {
      return set[Symbol.iterator]()
    },
  }
}

/**
 * 契约里的 `bot.state` = ChatState；跨轮状态一律进它（纪律：插件不自己开全局 Map）。
 * `_scratch` 是 ChatState 上的插件传值槽，按 chatKey 天然隔离；内核没建就懒建。
 */
function scratchOf(bot, chatKey) {
  const st = bot.state?.get?.(chatKey) ?? {}
  return (st._scratch ||= Object.create(null))
}

/** 冷却判定：距上次不足 ms → 还在冷却；否则记下这次。旧 inCooldown 的语义（放行才点时间戳）。 */
function inCooldown(scratch, key, ms) {
  const now = Date.now()
  if (now - (scratch[key] || 0) < ms) return true
  scratch[key] = now
  return false
}

/** 从 bot.linesPool（persona-voice 挂的）取一句；拿不到用内置兜底 */
function pickLine(bot, pool, fallback) {
  try {
    const picked = bot.linesPool?.pick?.(pool)
    if (typeof picked === 'string' && picked) return picked
  } catch (e) {
    bot.log.warn(`句池 ${pool} 取句失败: ${e.message}`)
  }
  return fallback[Math.floor(Math.random() * fallback.length)]
}

/**
 * 反查被引消息的发送者（唤醒判定用；只看发送者，不下载图）。
 * 优先用内核 before-turn 已反查好的 `ev._scratch.quote`（省一次接口），其次 onebot.msgById，
 * 最后从群历史里找。全拿不到 = 当没叫本机（宁可漏唤醒，不越界插话）。
 */
async function quotedSenderOf(bot, ev) {
  if (ev.quotedSenderQq != null) return ev.quotedSenderQq
  if (ev.quotedSenderId != null) return ev.quotedSenderId
  if (ev._scratch?.quote?.senderId != null) return ev._scratch.quote.senderId
  if (!ev.replyToId) return null
  try {
    const msg = await bot.onebot.msgById?.(ev.replyToId)
    const uid = msg?.sender?.user_id ?? msg?.user_id
    if (uid != null) return uid
  } catch (e) {
    bot.log.warn(`引用反查失败 (rid=${ev.replyToId}): ${e.message}`)
  }
  try {
    if (!ev.isGroup || !ev.groupId) return null
    const list = await bot.onebot.groupHistory(ev.groupId, 50)
    const hit = (Array.isArray(list) ? list : []).find((m) => String(m?.message_id ?? m?.messageId) === String(ev.replyToId))
    return hit?.sender?.user_id ?? hit?.sender?.qq ?? null
  } catch {
    return null
  }
}

function selfIdOf(bot, ev) {
  return bot.onebot?.selfId ?? bot.selfId ?? ev.selfId ?? null
}

async function isQuotingSelf(bot, ev) {
  if (!ev.replyToId) return false
  const selfId = selfIdOf(bot, ev)
  if (!selfId) return false
  const sender = await quotedSenderOf(bot, ev)
  return sender != null && String(sender) === String(selfId)
}

/**
 * 该群生效的唤醒词（含人设词表）：
 *   ① persona-voice 挂的 `bot.readWakeWords`（人设 `.wake.txt` 覆盖全局 `*`，群号专属叠加）；
 *   ② 它没注册/返回空时，回落内核解析好的 `bot.core.keywordTable`（`pluginConfig['gate-wake'].keywords`）。
 */
function wakeWordsOf(bot, gid) {
  const norm = (list) => list.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)
  try {
    const v = bot.readWakeWords?.(gid)
    const list = Array.isArray(v) ? v : Array.isArray(v?.words) ? v.words : []
    if (list.length) return norm(list)
  } catch (e) {
    bot.log.warn(`读唤醒词失败: ${e.message}`)
  }
  const table = bot.core?.keywordTable
  if (!table || typeof table !== 'object') return []
  const global = Array.isArray(table['*']) ? table['*'] : []
  const extra = gid != null && gid !== '' && Array.isArray(table[String(gid)]) ? table[String(gid)] : []
  return norm([...global, ...extra])
}

/** 命中哪个唤醒词（包含匹配、大小写不敏感）；没词表 = 不启用关键词唤醒（不自己造词，通用词会误触发） */
function matchKeyword(bot, ev) {
  const text = String(ev.text || '').toLowerCase()
  if (!text) return null
  return wakeWordsOf(bot, ev.groupId).find((k) => text.includes(k)) || null
}

/**
 * "叫了本机但没正文" → 先答应一声（纯 @ / 纯呼名 / 只引用 三种入口共用）。
 * ⚠️ 直接发罐头句、**不走模型**：秒回且零 token；引用[对方那条呼叫消息]回复，看起来才像在应他；
 *    同一人同群 ACK_DEDUPE_MS 内只答应一次（防连点）。
 */
async function ackCall(bot, ev, why) {
  const scratch = scratchOf(bot, ev.chatKey)
  const key = `callAck:${ev.sender?.qq ?? ''}`
  if (Date.now() - (scratch[key] || 0) < ACK_DEDUPE_MS) {
    bot.log.debug(`${why}: ${ACK_DEDUPE_MS}ms 内已答应过, 不重复答应`)
    return
  }
  if (effective(bot, 'callAck') === false) return
  scratch[key] = Date.now()
  const line = pickLine(bot, 'callAck', DEFAULT_ACK)
  bot.log.debug(`${why}: 先答应一声「${line}」`)
  // ⚠️ 必须走 deliver（唯一出站口）：脱敏/留档/引用定夺都在里面
  await bot.deliver(ev.chatKey, line, { replyTo: ev.messageId })
}

/**
 * 开"等同一人补发正文"的窗口（groupFollowUpMs；0 = 关闭）。
 * ⚠️ 挂起时必须把这条消息的**引用/图一起存下来**：常见用法是"引用一张图 + 只 @ 一下"，
 *    补发正文时若丢掉引用，图永远不会被反查/识图（线上踩过）。
 */
function openFollowUp(bot, ev, why) {
  const ms = msOf(effective(bot, 'groupFollowUpMs'))
  if (ms <= 0) return
  const st = bot.state?.get?.(ev.chatKey)
  if (!st) return
  st.followUpUntil = Date.now() + ms
  st.followUpCache = {
    userId: String(ev.sender?.qq ?? ''),
    replyToId: ev.replyToId ?? null,
    images: Array.isArray(ev.images) ? ev.images.slice() : [], // 纯呼名时自带的图也别丢
  }
  bot.log.debug(`${why}: 等同一人补发内容, 窗口 ${ms}ms${ev.replyToId ? '（带引用, 已挂起）' : ''}`)
}

/** 答应一声 + 开窗口 + 这条到此为止（不进模型） */
async function ackAndWait(bot, ev, why) {
  await ackCall(bot, ev, why)
  openFollowUp(bot, ev, why)
  ev.stopped = true
  ev.stopReason = `gate-wake:followup(${why})`
}

/**
 * 被戳（OneBot notice：notice_type=notify / sub_type=poke）→ 回戳 **+** 回一句句池话。
 * 事件形态由 format.normalizeEvent 塞进 `ev._scratch.notice`；
 * `ev.mentionedSelf` 已在那边按 target_id === selfId 算好 —— 戳别人的不理。
 *
 * ⚠️ 回戳和回话**不是二选一**（2026-10-31 修）：原来「poke 成功就 return」，
 *    而 NAS 上的 NapCat 支持 send_poke 且一直成功 → 人设 `## poke` 句池**永远发不出去**，
 *    只看到一个回戳、群里一句话没有。戳一戳本来就是轻交互，两样都做才像被戳了有反应。
 */
async function handlePoke(bot, ev, notice) {
  // notice 永远不是聊天消息：这条到此为止，哪怕不回（否则宽松模式下空正文会进模型）
  ev.stopped = true
  ev.stopReason = 'gate-wake:poke'
  if (effective(bot, 'pokeBack') === false || !ev.mentionedSelf) return
  const poker = notice?.userId ?? ev.sender?.qq ?? null
  const scratch = scratchOf(bot, ev.chatKey)
  if (inCooldown(scratch, `poke:${poker ?? ''}`, POKE_COOLDOWN_MS)) {
    bot.log.debug(`[戳一戳] ${POKE_COOLDOWN_MS}ms 内已回过, 跳过 user=${poker}`)
    return
  }
  // 回戳是锦上添花：适配器没有 poke / 本机 QQ 不支持 send_poke / 接口抽风，都不该连带着把话也吞了
  let poked = false
  try {
    if (typeof bot.onebot?.poke === 'function') poked = await bot.onebot.poke(ev.chatKey, poker)
    else bot.log.debug(`[戳一戳] 适配器没有 poke，只回一句`)
  } catch (e) {
    bot.log.warn(`回戳失败 (${ev.chatKey}): ${e.message}（照常回一句）`)
  }
  bot.log.info(`[戳一戳] ${ev.chatKey} user=${poker} 戳了本机 → ${poked ? '回戳 + 回一句' : '回一句'}`)
  await bot.deliver(ev.chatKey, pickLine(bot, 'poke', DEFAULT_POKE))
}

const RECALL_INTERNAL = /Timeout|NTEvent|EventRet|decode failed|recallMsg|result\s*[:=]?\s*7/i

/**
 * 撤回失败时给群里看的话术：**绝不回显协议端原始报错**（NTEvent/EventRet/decode failed…）。
 * 2026-10-23 15:37 线上事故：适配器把 `wording` 原样拼进 `res.msg`，gate-wake 又原样贴进群里。
 */
function recallFailureNote(res) {
  const raw = String(res?.raw || '')
  const msg = String(res?.msg || '')
  if (RECALL_INTERNAL.test(raw) || RECALL_INTERNAL.test(msg)) {
    return '撤回没成功：撤回接口超时/返回异常（这条可能已经过期、被删了，或协议端临时抽风）'
  }
  if (/超时/.test(msg)) return '撤回没成功：撤回接口超时（这条可能已经过期，或协议端临时故障）'
  if (/权限|permission|denied/i.test(msg)) return '撤回没成功：本机没有权限撤这条消息'
  if (msg && msg.length <= 80 && !/[\n{}]/.test(msg)) return msg // 适配器给的人话
  return '无法撤回（可能不是本机能撤的消息、没权限，或超过时限）'
}

/**
 * "引用一条消息 + 说撤回" → 撤那一条。返回 true = 已处理（调用方直接 return）。
 * ⚠️ 同一条只试一次：以前批量撤回时对同一条反复重试, 每条都超时, 把群刷爆了。
 */
async function tryRecall(bot, ev) {
  if (!ev.replyToId || !/撤回|撤掉|撤销|回收|删除这条|把它撤了|撤了这/i.test(String(ev.text || ''))) return false
  const scratch = scratchOf(bot, ev.chatKey)
  const tried = (scratch.recallTried ||= new Set())
  const key = String(ev.replyToId)
  if (tried.has(key)) {
    await bot.deliver(ev.chatKey, '🙅 这条已经试过撤回啦，撤不掉就别难为人家了嘛～')
    ev.stopped = true
    return true
  }
  if (tried.size > 500) tried.clear()
  tried.add(key)
  // 适配器 recall() 返回 `{ok, msg}` 且**不抛错**（超时也包成 ok:false）；改成抛错的实现也一并认。
  try {
    const res = await bot.onebot.recall(ev.replyToId)
    const ok = res === true || res?.ok === true
    if (ok) {
      bot.log.info(`已撤回消息 (${ev.chatKey}, rid=${ev.replyToId})`)
      await bot.deliver(ev.chatKey, '✅ 已撤回那条消息~')
    } else {
      bot.log.warn(`[撤回] ${ev.chatKey} rid=${ev.replyToId} 失败：${String(res?.raw || res?.msg || '').slice(0, 500)}`)
      await bot.deliver(ev.chatKey, `🙅 ${recallFailureNote(res)}\u3000剩下还超时内的可以继续引用着撤～`)
    }
  } catch (e) {
    bot.log.warn(`[撤回] ${ev.chatKey} rid=${ev.replyToId} 请求异常：${String(e?.message || e).slice(0, 500)}`)
    await bot.deliver(ev.chatKey, `🙅 ${recallFailureNote({ raw: e?.message })}\u3000剩下还超时内的可以继续引用着撤～`)
  }
  ev.stopped = true
  ev.stopReason = 'gate-wake:recall'
  return true
}

export default {
  id: 'gate-wake',
  title: '门禁与唤醒',
  order: 10,
  configSchema,

  setup(bot) {
    // ── 运行时屏蔽：挂在 bot 与共享的 bot.state 上（:3971/ignore/* 与控制台群卡片读同一份） ──
    // 不放插件私有 Map：控制台/HTTP 端点从内核那边也要拿到它，而 state 是所有插件共享的实例。
    const runtimeIgnore = createRuntimeIgnore()
    bot.runtimeIgnore = runtimeIgnore
    Object.defineProperty(bot, 'runtimeIgnoreSet', {
      get: () => runtimeIgnore.set,
      configurable: true,
    })
    if (bot.state && typeof bot.state === 'object') {
      bot.state.runtimeIgnore ||= runtimeIgnore
      bot.state.runtimeIgnoreSet ||= runtimeIgnore.set
    }
    // 现读：内核/控制台若替换了 runtimeIgnore，以它为准（没有就用本插件这份）
    const runtimeOf = (b) => b.runtimeIgnore ?? b.state?.runtimeIgnore ?? runtimeIgnore

    /** 门禁拦下：统一置 stopped + 原因（后续阶段全跳过 = 不写留档、不采集表情） */
    const stopGate = (ev, why, reason) => {
      bot.log.debug(why)
      ev.stopped = true
      ev.stopReason = `gate-wake:${reason}`
    }

    // ── pre-gate：硬门禁（fail-closed 阶段；异常会被内核当"拦住"，所以只做纯判断） ──
    bot.on('pre-gate', (ev) => {
      // 内核 normalizeEvent 已按 adminQq 填 sender.isMaster；本插件 adminQq 配了就以它为准
      // （配置迁移时 admins 可能不止一个，靠这一手兜底）。
      if (ev.sender && bot.cfg.adminQq) ev.sender.isMaster = String(ev.sender.qq) === String(bot.cfg.adminQq)

      // ⚠️ 下面的 effective() 每次判定都现读 `bot.cfg`（控制台热同步就地改这个对象 → 热改立即生效）
      const isMaster = ev.sender?.isMaster === true
      const qq = Number(ev.sender?.qq)
      const runtime = runtimeOf(bot)
      // 通知事件（入群/退群/戳一戳…）不是"某个人发的消息"：③④ 的用户级白名单不能套在它身上
      // （否则配了群内白名单的群，新人永远不在名单里 → 入群欢迎永远不触发）。
      // ①② 是群级屏蔽 / 用户黑名单语义，通知同样适用（屏蔽群不欢迎、拉黑的人入群也不欢迎）。
      const isNotice = Boolean(ev._scratch?.notice)

      if (ev.isGroup) {
        const gid = String(ev.groupId)
        // ① 群内黑名单**最高优先**：命中不回、不入站（连留档都不写），主人也不例外
        if ((groupMapOf(effective(bot, 'groupUserBlocklist'))[gid] || []).includes(qq)) {
          return stopGate(ev, `忽略群 ${gid} 黑名单用户 ${qq}（不回、不入站）`, 'blocklist')
        }
        // ② 群屏蔽：静态配置 + 运行时（compat 网关 /ignore/*、控制台群卡片；API 或裸 Set 两种持有形态都认）
        const ignored = toNumList(effective(bot, 'ignoreGroups')).includes(Number(ev.groupId))
        const runtimeIgnored = runtime?.has?.(gid) === true || runtime?.has?.(Number(ev.groupId)) === true
        if (ignored || runtimeIgnored) {
          return stopGate(ev, `忽略群 ${gid}（ignoreGroups/runtimeIgnore）`, 'ignore-group')
        }
        if (!isNotice) {
          // ③ 群内白名单：该群配了非空白名单时，非主人不在名单 → 拦
          const allow = groupMapOf(effective(bot, 'groupUserAllowlist'))[gid]
          if (Array.isArray(allow) && allow.length && !isMaster && !allow.includes(qq)) {
            return stopGate(ev, `群 ${gid} 白名单外用户 ${qq}`, 'group-allowlist')
          }
        }
      }

      if (!isNotice) {
        // ④ 全局允许用户：群聊 + 私聊都生效；主人永远放行（旧 isAllowed 的语义 + 主人豁免）
        const users = toNumList(effective(bot, 'allowedUsers'))
        if (users.length && !isMaster && !users.includes(qq)) {
          return stopGate(ev, `忽略未授权用户 ${qq}（allowedUsers）`, 'allowed-users')
        }
      }
    })

    // ── intercept：免模型拦截（戳一戳 / 撤回 / 审批应答） ──
    bot.on('intercept', async (ev) => {
      if (ev.stopped) return

      // 戳一戳：OneBot 里它是 notice，不是 message；format.normalizeEvent 把它原样塞在 ev._scratch.notice。
      const notice = ev._scratch?.notice
      if (notice && notice.type === 'notify' && notice.subType === 'poke') return handlePoke(bot, ev, notice)

      // 撤回：引用一条 + 说撤回
      if (await tryRecall(bot, ev)) return

      // 审批应答：挂起状态在内核，插件只负责"给内核一个优先处理的机会"。
      // 契约没定回调名 → 认 bot.onApprovalReply / bot.approval.handle；没有就跳过（消息照常往下走）。
      const answer = bot.onApprovalReply || bot.approval?.handle
      if (typeof answer === 'function') {
        try {
          if (await answer(ev)) {
            ev.stopped = true
            ev.stopReason = 'gate-wake:approval'
          }
        } catch (e) {
          bot.log.warn(`审批应答处理失败: ${e.message}`)
        }
      }
    })

    // ── wake：唤醒判定（顺序:@ → 引用本机 → 接续窗口 → 关键词） ──
    bot.on('wake', async (ev) => {
      if (ev.stopped || ev.wake) return // 别的插件（/history、自发接话）已经定了就不抢
      // notice 永远不是"聊天正文"（戳一戳/撤回/入群/点赞通知…）：绝不进模型。
      // 戳一戳在 intercept 已处理并 stop；其余 notice 到这里直接放弃。
      // （曾经漏了这条：点赞通知没有 user_id/group_id → 被下面"私聊永远算被叫"放行，造出空对话）
      if (ev._scratch?.notice) return

      // 私聊永远算被叫
      if (!ev.isGroup) {
        ev.wake = { kind: 'private' }
        return
      }

      const hasBody = Boolean(String(ev.text || '').trim())
        || (ev.images?.length ?? 0) > 0
        || (ev.files?.length ?? 0) > 0

      // ① @本机（最明确）
      if (ev.mentionedSelf) {
        if (!hasBody && !ev.replyToId) {
          // 纯 @(无正文无引用)：先不答，答应一声 + 等同一人补正文
          return ackAndWait(bot, ev, '纯@(无正文)')
        }
        // 有正文直接答；纯 @ + 带引用也直接答 —— 引用本身就是"我在说这条"，
        // 把被引内容当正文回应（手册 §2.3）
        ev.wake = { kind: 'at' }
        return
      }

      // ② 引用本机消息 = 在跟本机说话（哪怕没 @）—— 靠**代码**反查被引发送者，引用别人的不算（不越界）
      if (await isQuotingSelf(bot, ev)) {
        if (!hasBody) return ackAndWait(bot, ev, '纯引用(无正文)')
        ev.wake = { kind: 'quote' }
        return
      }

      // ③ 接续窗口：同一人在窗口内补发正文 = "接上条"，**只接一次**（答完就关，不顺延）
      const st = bot.state?.get?.(ev.chatKey)
      if (st && st.followUpUntil > Date.now() && String(st.followUpCache?.userId) === String(ev.sender?.qq)) {
        const cache = st.followUpCache || {}
        st.followUpUntil = 0
        st.followUpCache = null
        // 把"只 @ 那条"里挂起的引用/图并进来（引用图靠它才能被反查/识图）
        if (cache.replyToId && !ev.replyToId) ev.replyToId = cache.replyToId
        if (Array.isArray(cache.images) && cache.images.length) ev.images.push(...cache.images)
        bot.log.debug(`接续上条(同一人补发, 一次性) user=${ev.sender?.qq}`)
        ev.wake = { kind: 'followup' }
        return
      }

      // ④ 关键词（支持人设热读词表；取不到 = 不启用，回落由 persona-voice 负责）
      const keyword = matchKeyword(bot, ev)
      if (keyword) {
        // 纯呼名：复用"纯 @"那套（开窗口等补正文），且**在冷却之前**、**不点冷却** ——
        // 否则"刚聊完再喊一声 + 补正文"整段没人应
        if (isNameOnlyCall(ev.text, keyword)) {
          return ackAndWait(bot, ev, `纯呼名「${keyword}」(不参与冷却)`)
        }
        const scratch = scratchOf(bot, ev.chatKey)
        const cdMs = msOf(effective(bot, 'keywordCooldownMs'))
        if (Date.now() - (scratch.keywordWakeAt || 0) < cdMs) {
          // 冷却中：只记日志不回复，也绝不点新时间戳（冷却窗口不因被挡而延长）；不设 stopped 以免堵死下游主动接话
          bot.log.debug(`关键词「${keyword}」命中但冷却中(${cdMs}ms), 忽略`)
          ev.stopReason = 'gate-wake:keyword-cooldown'
          return
        }
        scratch.keywordWakeAt = Date.now()
        bot.log.debug(`关键词唤醒「${keyword}」 user=${ev.sender?.qq}`)
        ev.wake = { kind: 'keyword', keyword }
        return
      }

      // ⑤ groupAtRequired=false = 整群当对话态（旧 groupConversationTtlMs 的宽松分支，新契约没有 TTL）
      if (bot.cfg.groupAtRequired === false) {
        ev.wake = { kind: 'at' }
        return
      }
      // 未被 @/引用/接续/关键词唤醒：不设 ev.stopped —— 这条消息本身不进模型，
      // 但内核会把它交给「主动接话」看看要不要捡成接话时机（见 kernel/pacing.js 的 consider）。
      bot.log.debug(`群 ${ev.groupId} 未唤醒, 忽略（没 @、没引用本机、没接续、没关键词）`)
      ev.stopReason = 'gate-wake:not-woken'
    })
  },
}
