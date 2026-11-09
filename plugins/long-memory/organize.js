/**
 * plugins/long-memory/organize.js — 写入侧：读留档 → 调接口提炼 → 落库。
 *
 * 不放进 index.js 的原因：整理是“有状态的长流程”（水位、单飞锁、分批、失败隔离），
 * 和“每轮挂个钩子”的入口逻辑混在一起最难读。这里是纯流程，注入 store / fetch 好测。
 *
 * 四条纪律：
 *   ① **水位按“实际喂给模型的最新一条消息 ts”推进**，不是 Date.now()。
 *      否则整理期间新进来的消息会被当成“已消化”，永久丢失（旧插件踩过这个坑）。
 *   ② **一个作用域一次调用**：绝不把 A 群的话和 B 群的记忆混在一次请求里 —— 隔离靠结构，不靠提示词。
 *   ③ 模型给坏 JSON → 一个字都不写，只记 lastError（控制台可见），下次照常重试。
 *   ④ 单飞：上一轮没跑完，这一轮直接返回 busy（定时器每 30 分钟一次的常见情况）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripBom } from '../../platform/atomic.js'
import { chatComplete, parseMemoryJson } from './relay.js'

/** 默认整理提示词（控制台可整段改写；`{scopeLabel}` 之类占位符由 buildPrompt 替换）。 */
export const DEFAULT_ORGANIZE_PROMPT = [
  '你在帮一个 QQ 机器人整理「长期记忆」。下面是它和对方最近的一段聊天记录。',
  '请从中提炼**值得长期记住**的事，写成 JSON 数组，最多 {maxMemories} 条。',
  '',
  '记什么：对方自己说的事实/计划/承诺/喜好/忌讳/强烈情绪/重要的人和事（工作、学业、健康、感情、日期、约定）。',
  '不记什么：寒暄客套、机器人自己说过的话、一时兴起的闲聊、没头没尾的追问、能随便查到的公共信息。',
  '写法：以「我」的口吻（机器人视角）写一句完整的话，带上前因后果，不要流水账。',
  '例：「主人 8 号要去面试一家很想去的地方，紧张得睡不着，我答应那天在家等他回来。」',
  '',
  '字段：',
  '- text：这句记忆（不超过 120 字，不许编造，聊天里没说的绝不写）',
  '- importance：0~1。承诺/关键转折 ≥0.85，喜好/计划/强烈情绪 ≥0.6，日常见闻 ≤0.5',
  '- type：commitment | plan | preference | event | emotion | fact 之一',
  '- tags：2~4 个短标签（如「面试」「火锅」）',
  '- entities：提到的人，形如 [{"qq":"10086","name":"主人"}]；qq 用聊天记录里的号码，不知道就省掉这项',
  '',
  '只输出 JSON 数组本身，不要解释、不要 Markdown 代码块。没有值得记的就输出 []。',
  '',
  '--- 聊天记录（{scopeLabel}）---',
  '{transcript}',
].join('\n')

/** 把留档 jsonl 读成行数组（按时间升序；坏行跳过）。 */
export function readArchiveLines(file, { limit = 400, maxBytes = 4 * 1024 * 1024 } = {}) {
  let text = ''
  try {
    const st = fs.statSync(file)
    const size = Math.min(st.size, maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size))
      text = stripBom(buf.toString('utf8'))
    } finally { fs.closeSync(fd) }
  } catch { return [] }
  const rows = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object') rows.push(v)
    } catch { /* 只跳坏行 */ }
  }
  rows.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  return rows.slice(-Math.max(1, limit))
}

/** 留档文件路径：<archiveDir>/<kind>_<id>.jsonl（与内核 makeArchiver 的命名一致）。 */
export function archiveFileOf(archiveDir, scope) {
  const [kind, id] = String(scope || '').split(':')
  if (!kind || !id) return ''
  return path.join(String(archiveDir || ''), `${kind}_${id}.jsonl`)
}

/** 把消息转成模型能读的对话文本。机器人自己的话标成「我」。 */
export function toTranscript(rows, { maxChars = 6000 } = {}) {
  const lines = []
  for (const r of rows) {
    const text = String(r.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const who = r.dir === 'out'
      ? '我'
      : `对方${r.sender?.name ? `(${r.sender.name}${r.sender?.qq ? `,${r.sender.qq}` : ''})` : ''}`
    lines.push(`${who}: ${text}`)
  }
  let out = lines.join('\n')
  if (out.length > maxChars) {
    // 超长从最早开始丢（保留最新的对话）
    let cut = out.length - maxChars
    const nl = out.indexOf('\n', cut)
    out = nl >= 0 ? out.slice(nl + 1) : out.slice(cut)
    out = `（更早的消息已省略）\n${out}`
  }
  return out
}

/** 挑出「水位之后、且来自人的」消息。 */
export function pendingRows(rows, watermark) {
  const since = Number(watermark) || 0
  return rows.filter((r) => (Number(r.ts) || 0) > since)
}

/**
 * 拼整理提示词。
 * @param {{scope:string, scopeLabel?:string, rows:object[], promptTemplate?:string, maxMemories?:number}} o
 */
export function buildPrompt({ scope, scopeLabel = '', rows = [], promptTemplate = '', maxMemories = 5 } = {}) {
  const tpl = String(promptTemplate || '').trim() || DEFAULT_ORGANIZE_PROMPT
  const label = scopeLabel || String(scope || '').replace(/^group:/, '群 ').replace(/^private:/, '私聊 ')
  // 用函数替换：聊天正文里出现 `$&` / `$1` 之类不会被 String.replace 当成组引用改写
  return tpl
    .replace(/\{maxMemories\}/g, () => String(maxMemories))
    .replace(/\{scopeLabel\}/g, () => label)
    .replace(/\{transcript\}/g, () => toTranscript(rows))
}

/** 校验并归一模型给出的单条记忆；不合格返回 null。 */
export function normalizeMemory(raw, { scope, key, sourceMsgIds = [], now = Date.now(), maxChars = 240 } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text || raw.memory || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (text.length > maxChars * 2) return null // 太长多半是模型把整段聊天抄回来了
  const imp = Number(raw.importance ?? raw.score)
  const types = ['commitment', 'plan', 'preference', 'event', 'emotion', 'fact']
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => String(t || '').trim()).filter((t) => t && t.length <= 16).slice(0, 6)
  const entities = (Array.isArray(raw.entities) ? raw.entities : [])
    .map((e) => (typeof e === 'object'
      ? { qq: String(e?.qq || '').trim(), name: String(e?.name || '').trim() }
      : { qq: '', name: String(e || '').trim() }))
    .filter((e) => e.qq || e.name)
    .slice(0, 8)
  return {
    key: String(key || scope),
    scope: String(scope),
    kind: String(scope).startsWith('group:') ? 'group' : 'private',
    text: text.slice(0, maxChars),
    importance: Number.isFinite(imp) ? Math.max(0, Math.min(1, imp)) : 0.6,
    memoryType: types.includes(String(raw.type || raw.memoryType || '')) ? String(raw.type || raw.memoryType) : 'fact',
    tags,
    entities,
    sourceMsgIds: sourceMsgIds.slice(0, 40),
    createdAt: now,
  }
}

/**
 * 建一个整理器。
 * @param {object} o
 * @param {ReturnType<import('./store.js').createStore>} o.store
 * @param {() => object} o.cfgOf               现取插件配置（热改下一轮生效）
 * @param {() => string} o.archiveDirOf
 * @param {(msg:string)=>void} [o.log]
 * @param {(m:object)=>boolean} [o.inScope]    作用域是否允许（存储范围）
 * @param {Function} [o.fetchImpl]             测试注入
 */
export function createOrganizer({ store, cfgOf, archiveDirOf, log = () => {}, inScope = () => true, fetchImpl = null }) {
  let running = null
  let lastRun = null

  const num = (v, d, min, max) => {
    const n = Number(v)
    const base = Number.isFinite(n) ? n : d
    return Math.max(min, Math.min(max, base))
  }

  /** 当前允许记忆的作用域列表（由 index.js 的 scope 配置决定）。 */
  function scopesOf(cfg = cfgOf() || {}) {
    const out = new Set()
    const qqs = Array.isArray(cfg.privateInclude) ? cfg.privateInclude.map(String).filter(Boolean) : []
    if (cfg.privateAll !== false && !qqs.length) out.add('__all_private__')
    for (const q of qqs) out.add(`private:${q}`)
    const groupsMode = String(cfg.groupsMode || 'none')
    const gids = Array.isArray(cfg.groupsInclude) ? cfg.groupsInclude.map(String).filter(Boolean) : []
    if (groupsMode === 'all') out.add('__all_groups__')
    if (groupsMode === 'list') for (const g of gids) out.add(`group:${g}`)
    return [...out]
  }

  /** 把通配作用域展开成真实作用域（留档目录里出现了哪些私聊/群）。 */
  function expandScope(tag) {
    if (tag === '__all_private__' || tag === '__all_groups__') {
      const kind = tag === '__all_private__' ? 'private' : 'group'
      let names = []
      try { names = fs.readdirSync(String(archiveDirOf() || '')) } catch { return [] }
      return names
        .filter((n) => n.startsWith(`${kind}_`) && n.endsWith('.jsonl'))
        .map((n) => `${kind}:${n.slice(kind.length + 1, -'.jsonl'.length)}`)
    }
    return [tag]
  }

  function scopeAllowed(scope) {
    const cfg = cfgOf() || {}
    const tags = scopesOf(cfg)
    if (tags.includes(scope)) return true
    if (scope.startsWith('private:') && tags.includes('__all_private__')) return true
    if (scope.startsWith('group:') && tags.includes('__all_groups__')) return true
    return false
  }

  /** 这一轮该整理哪些作用域（有足够新消息的）。 */
  function dueScopes({ force = false } = {}) {
    const cfg = cfgOf() || {}
    const minNew = num(cfg.minNewMessages, 8, 0, 500)
    const maxMsgs = num(cfg.maxMessagesPerRound, 120, 10, 2000)
    const maxChars = num(cfg.maxCharsPerRound, 6000, 500, 60000)
    const due = []
    for (const tag of scopesOf(cfg)) {
      for (const scope of expandScope(tag)) {
        if (!inScope(scope)) continue
        const file = archiveFileOf(archiveDirOf(), scope)
        if (!file) continue
        const wm = store.watermarkOf(scope)
        const rows = readArchiveLines(file, { limit: maxMsgs + 50 })
        const fresh = pendingRows(rows, wm)
        const human = fresh.filter((r) => r.dir !== 'out' && String(r.text || '').trim())
        const chars = toTranscript(fresh, { maxChars }).length
        if (!force && human.length < minNew) continue
        if (!fresh.length) continue
        due.push({ scope, rows: fresh.slice(-maxMsgs), chars })
      }
    }
    return due
  }

  /** 只跑一个作用域（控制台“预览/手动整理指定会话”用）。 */
  async function organizeOne({ scope, rows = null, dryRun = false, promptOverride = '', ignoreWatermark = false } = {}) {
    const cfg = cfgOf() || {}
    if (!scopeAllowed(scope)) return { ok: false, scope, code: 'out_of_scope', reason: '这个会话不在「存储范围」里' }
    const file = archiveFileOf(archiveDirOf(), scope)
    const wm = ignoreWatermark ? 0 : store.watermarkOf(scope)
    const maxMsgs = num(cfg.maxMessagesPerRound, 120, 10, 2000)
    const maxChars = num(cfg.maxCharsPerRound, 6000, 500, 60000)
    const all = Array.isArray(rows) ? rows : readArchiveLines(file, { limit: maxMsgs + 50 })
    const fresh = pendingRows(all, wm).slice(-maxMsgs)
    if (!fresh.length) return { ok: true, scope, added: 0, reason: '没有新消息' }
    const transcript = toTranscript(fresh, { maxChars })
    if (!transcript.trim()) return { ok: true, scope, added: 0, reason: '新消息里没有可读文本' }
    // 水位候选：本轮**实际喂给模型**的最新一条消息（不是现在的时间 —— 整理期间新来的消息必须留到下一轮）
    const newestTs = fresh.reduce((a, r2) => Math.max(a, Number(r2.ts) || 0), 0)
    const prompt = buildPrompt({
      scope,
      rows: fresh,
      promptTemplate: promptOverride || cfg.organizePrompt,
      maxMemories: num(cfg.maxMemoriesPerRound, 5, 1, 20),
    })
    // 接口配置走扁平字段（configSchema 一条一条渲染，别套嵌套对象 —— 控制台只认扁平键）
    const r = await chatComplete({
      protocol: cfg.llmProtocol || 'openai-chat',
      baseUrl: cfg.llmBaseUrl || '',
      apiKey: cfg.llmApiKey || '',
      model: cfg.llmModel || '',
      reasoningEffort: cfg.llmReasoningEffort || '',
      ...(cfg.llmTimeoutMs ? { timeoutMs: Number(cfg.llmTimeoutMs) } : {}),
      fetchImpl,
    }, { prompt })
    if (!r.ok) return { ok: false, scope, code: r.code, reason: r.reason, ms: r.ms }
    const parsed = parseMemoryJson(r.text)
    if (!parsed.ok) return { ok: false, scope, code: 'bad_output', reason: parsed.reason, raw: r.text.slice(0, 500) }
    const maxPer = num(cfg.maxMemoriesPerRound, 5, 1, 20)
    const maxCharsMem = num(cfg.maxCharsPerMemory, 240, 40, 800)
    const srcIds = fresh.map((x) => Number(x.messageId)).filter((n) => Number.isFinite(n))
    const picked = []
    for (const item of parsed.list.slice(0, maxPer * 2)) {
      const m = normalizeMemory(item, { scope, sourceMsgIds: srcIds, maxChars: maxCharsMem })
      if (m) picked.push(m)
      if (picked.length >= maxPer) break
    }
    if (dryRun) {
      return { ok: true, scope, dryRun: true, wouldAdd: picked.length, items: picked.map((m) => ({ text: m.text, importance: m.importance, tags: m.tags, type: m.memoryType })), ms: r.ms }
    }
    const ids = []
    for (const m of picked) {
      try {
        const res = store.add({ ...m, origin: 'organize' })
        if (res.id) ids.push(res.id)
      } catch (e) {
        log(`[long-memory] 落库失败 ${scope}: ${e.message}`)
      }
    }
    // 水位：模型给了**能解析的数组**（哪怕是空数组）就把水位推到“实际喂进去的最新一条”，
    // 这样同一批消息不会每轮重复烧 token；接口报错/坏 JSON 则不推进，下次重试。
    if (parsed.ok) store.setWatermark(scope, newestTs)
    return { ok: true, scope, added: ids.length, ids, items: picked.map((m) => m.text), ms: r.ms }
  }

  /** 跑一轮（定时器/手动）。force=true 忽略「新消息门槛」。 */
  async function run({ force = false, reason = 'auto' } = {}) {
    if (running) return { ok: false, code: 'busy', reason: '上一轮还在跑' }
    const t0 = Date.now()
    running = (async () => {
      const due = dueScopes({ force })
      const result = { at: t0, reason, scopes: due.length, added: 0, failed: [], skipped: [] }
      for (const d of due) {
        try {
          const r = await organizeOne({ scope: d.scope })
          if (r.ok) result.added += Number(r.added) || 0
          else result.failed.push({ scope: d.scope, code: r.code, reason: r.reason })
        } catch (e) {
          result.failed.push({ scope: d.scope, code: 'exception', reason: String(e?.message || e) })
        }
      }
      result.ms = Date.now() - t0
      if (due.length) {
        store.recordOrganize({
          at: t0, result: { scopes: result.scopes, added: result.added, failed: result.failed.slice(0, 5), ms: result.ms },
          error: result.failed.length ? `${result.failed[0].scope}: ${result.failed[0].reason}` : '',
        })
      }
      lastRun = result
      if (due.length) log(`[long-memory] 整理一轮：${result.scopes} 个会话，新增 ${result.added} 条，失败 ${result.failed.length}`)
      return result
    })().finally(() => { running = null })
    return running
  }

  return {
    run,
    organizeOne,
    scopesOf,
    scopeAllowed,
    dueScopes,
    isRunning: () => Boolean(running),
    lastRun: () => lastRun,
  }
}
