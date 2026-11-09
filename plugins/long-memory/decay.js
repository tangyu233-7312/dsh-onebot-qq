/**
 * plugins/long-memory/decay.js — 长期记忆的**纯函数层**（无 IO、无状态、最好测）。
 *
 * 这一层只回答三个问题，别把业务塞进来：
 *   ① 一条记忆现在有多“清晰”（宽限 → 半衰期衰减）；
 *   ② 它跟这一轮的话有多“相关”（实体 / 标签 / 中文字符二元组）；
 *   ③ 综合三项打分该排第几（0.65 相关 + 0.20 新鲜 + 0.15 重要）。
 *
 * 口径来自《妹居物语》长期记忆那套公示：7 天宽限、重要的事衰减慢、被想起一次就重置宽限、
 * 低于阈值就忘掉。数字全部可配（index.js 的 configSchema），这里是兜底默认值。
 */

const DAY = 86400 * 1000

/** 夹到 [0,1]（NaN / 非数一律当 0）。 */
export function clamp01(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 时钟注入：测试里传固定 now，生产传 Date.now。 */
const nowOf = (o) => (Number.isFinite(Number(o?.now)) ? Number(o.now) : Date.now())

/**
 * 衰减后的有效重要性。
 *   age = now - max(createdAt, lastRecalledAt)   ← 被想起 = 重新计时
 *   age' = max(0, age - grace)                  ← 宽限期内不衰减
 *   effective = importance * 0.5 ** (age' / halfLife)
 *
 * 半衰期按重要性拉长（重要的忘得慢）：halfLife × (0.5 + importance)。
 * 这样 0.9 的重要事半衰期是日常（0.5）的 1.4/1.0 = 1.4 倍，和公示里“重要的事掉得更慢”一致。
 *
 * @param {{importance:number, createdAt:number, lastRecalledAt?:number}} m
 * @param {{now?:number, graceDays?:number, halfLifeDays?:number}} o
 * @returns {number} [0,1]
 */
export function effectiveImportance(m, o = {}) {
  const imp = clamp01(m?.importance)
  const base = Math.max(Number(m?.createdAt) || 0, Number(m?.lastRecalledAt) || 0)
  if (!base) return imp // 没有时间锚（老数据）→ 不衰减，别凭空把它忘掉
  const graceMs = Math.max(0, Number(o.graceDays ?? 7)) * DAY
  const age = Math.max(0, nowOf(o) - base)
  const over = Math.max(0, age - graceMs)
  const half = Math.max(1, Number(o.halfLifeDays ?? 18)) * DAY * (0.5 + imp)
  const factor = Math.pow(0.5, over / half)
  return clamp01(imp * factor)
}

/** 新鲜度：相对它自己的初始重要性还剩多少（刚记下 = 1，很久没被想起 → 0）。 */
export function freshness(m, o = {}) {
  const imp = clamp01(m?.importance)
  if (imp <= 0) return 0
  return clamp01(effectiveImportance(m, o) / imp)
}

/** 是否该忘：有效重要性低于阈值。调用方负责写 forgottenAt（本函数不产生副作用）。 */
export function isForgettable(m, o = {}) {
  const threshold = o.forgetThreshold == null ? 0.2 : Number(o.forgetThreshold)
  if (!Number.isFinite(threshold)) return false
  return effectiveImportance(m, o) < threshold
}

// ── 相关性 ────────────────────────────────────────────────────────────────

const isCjk = (ch) => /[\u3400-\u9fff]/.test(ch)
const isAlnum = (ch) => /[0-9a-zA-Z]/.test(ch)

/**
 * 切成“可比较的片段”：中文按二元组，拉丁/数字按整词（≥2 字）。
 * 中文没有空格，切词需要词典 —— 二元组是零依赖方案里性价比最高的近似。
 * @param {string} s
 * @returns {Set<string>}
 */
export function grams(s) {
  const text = String(s ?? '').toLowerCase()
  const out = new Set()
  let latin = ''
  const flush = () => {
    if (latin.length >= 2) out.add(latin)
    latin = ''
  }
  let run = ''
  const flushRun = () => {
    if (run.length >= 2) {
      for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
    } else if (run.length === 1) {
      out.add(run)
    }
    run = ''
  }
  for (const ch of text) {
    if (isCjk(ch)) { flush(); run += ch; continue }
    flushRun()
    if (isAlnum(ch)) latin += ch
    else flush()
  }
  flush()
  flushRun()
  return out
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，空集返回 0。 */
export function diceCoefficient(a, b) {
  const A = a instanceof Set ? a : grams(a)
  const B = b instanceof Set ? b : grams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return (2 * hit) / (A.size + B.size)
}

/**
 * 相关度 [0,1]：
 *   · 实体命中（QQ 号对上）：+0.35（说的人就是记忆里那个人，强信号）
 *   · 标签命中：每个 +0.2，封顶 0.5
 *   · 二元组重叠：+0.4 × dice
 *   · 名字命中（记忆里记的是“主人”，对话里叫“主人”）：+0.1
 *
 * @param {object} m 记忆
 * @param {{text?:string, qqList?:string[]}} ctx 本轮查询
 * @returns {{relevance:number, why:string[]}}
 */
export function relevanceOf(m, ctx = {}) {
  const why = []
  let score = 0
  const qqq = new Set((ctx.qqList || []).map(String).filter(Boolean))
  const ents = Array.isArray(m?.entities) ? m.entities : []
  const entHit = ents.some((e) => e && qqq.has(String(e.qq || '')))
  if (entHit) { score += 0.35; why.push('同一个人') }

  const text = String(ctx.text || '')
  const gramsQ = grams(text)
  const tags = (Array.isArray(m?.tags) ? m.tags : []).map((t) => String(t || '').trim()).filter(Boolean)
  let tagHit = 0
  for (const t of tags) {
    if (!t) continue
    if (text.includes(t) || (grams(t).size && diceCoefficient(grams(t), gramsQ) >= 0.5)) tagHit += 1
  }
  if (tagHit) { score += Math.min(0.5, tagHit * 0.2); why.push(`标签命中 ${tagHit}`) }

  const dice = diceCoefficient(grams(m?.text || ''), gramsQ)
  if (dice > 0) { score += 0.4 * dice; why.push(`措辞相近 ${Math.round(dice * 100)}%`) }

  // 记忆里提到的名字出现在本轮话里（不加分到 0.35 那么狠，只是提示“说的是这个人”）
  const names = ents.map((e) => String(e?.name || '').trim()).filter((n) => n.length >= 2)
  if (!entHit && names.some((n) => text.includes(n))) { score += 0.1; why.push('提到同一个称呼') }

  return { relevance: clamp01(score), why }
}

/**
 * 综合打分。权重可配，默认照公示 0.65 / 0.20 / 0.15。
 * @returns {{score:number, relevance:number, fresh:number, importance:number, why:string[]}}
 */
export function scoreMemory(m, ctx = {}, o = {}) {
  const { relevance, why } = relevanceOf(m, ctx)
  const fresh = freshness(m, o)
  const importance = clamp01(m?.importance)
  const w = {
    relevance: Number(o.weightRelevance ?? 0.65),
    fresh: Number(o.weightFresh ?? 0.2),
    importance: Number(o.weightImportance ?? 0.15),
  }
  const score = relevance * w.relevance + fresh * w.fresh + importance * w.importance
  return { score, relevance, fresh, importance, why }
}

// ── 展示 ──────────────────────────────────────────────────────────────────

/** 中文的“X 天前”：当天 0 天前 → 今天，1 → 昨天，其余 N 天前。 */
export function agoText(at, now = Date.now()) {
  const d = Math.floor((Math.max(0, now - (Number(at) || 0))) / DAY)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  return `${d} 天前`
}

/**
 * 拼注入块。**格式是给模型看的**，改动前先想清楚：
 *   · 必须带“系统信息、非用户发言”的保护前缀 —— 否则模型会把记忆当成群友说的话（旧插件踩过）；
 *   · 每条带“多久以前”，让模型自己判断该不该提；
 *   · 空列表返回 ''（调用方据此决定不加 hint）。
 *
 * @param {Array<{text:string, createdAt:number, recallCount?:number}>} list 已排序、已截断
 * @param {{now?:number, maxChars?:number, header?:string}} o
 */
export function formatInjection(list, o = {}) {
  const items = Array.isArray(list) ? list.filter((x) => x && String(x.text || '').trim()) : []
  if (!items.length) return ''
  const header = String(o.header || '[以下为系统信息，非用户发言：可能相关的记忆，自行判断是否需要提及]')
  const now = nowOf(o)
  const maxChars = Math.max(80, Number(o.maxChars ?? 600))
  const lines = []
  let used = header.length
  for (const m of items) {
    const age = agoText(m.createdAt, now)
    const times = Number(m.recallCount) > 0 ? `，想起过 ${Number(m.recallCount)} 次` : ''
    const line = `- ${String(m.text).replace(/\s+/g, ' ').trim()}（${age}${times}）`
    if (used + line.length + 1 > maxChars && lines.length) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  return `${header}\n${lines.join('\n')}`
}

/**
 * 按作用域过滤 + 打分 + 取前 K。**纯函数**：不写 recall 事件（那是 store 的事）。
 *
 * @param {Array<object>} memories
 * @param {{scope:string, text?:string, qqList?:string[], topK?:number, excludeForgotten?:boolean, now?:number,
 *   graceDays?:number, halfLifeDays?:number, forgetThreshold?:number,
 *   weightRelevance?:number, weightFresh?:number, weightImportance?:number}} o
 * @returns {Array<{memory:object, score:number, relevance:number, fresh:number, importance:number, why:string[]}>}
 */
export function rankMemories(memories, o = {}) {
  const scope = String(o.scope || '')
  const topK = Math.max(1, Math.round(Number(o.topK ?? 5) || 5))
  const pool = (Array.isArray(memories) ? memories : []).filter((m) => {
    if (!m || !String(m.text || '').trim()) return false
    if (String(m.scope || m.key || '') !== scope) return false
    if (o.excludeForgotten !== false && Number(m.forgottenAt) > 0) return false
    return true
  })
  const ctx = { text: o.text || '', qqList: o.qqList || [] }
  return pool
    .map((m) => ({ memory: m, ...scoreMemory(m, ctx, o) }))
    .sort((a, b) => b.score - a.score || (Number(b.memory.createdAt) || 0) - (Number(a.memory.createdAt) || 0))
    .slice(0, topK)
}
