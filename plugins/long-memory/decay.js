/**
 * plugins/long-memory/decay.js — 长期记忆的**纯函数层**（无 IO、无状态、最好测）。
 *
 * 这一层只回答三个问题，别把业务塞进来：
 *   ① 一条记忆现在有多“清晰”（宽限 → 半衰期衰减）；
 *   ② 它跟这一轮的话有多“相关”（标签 / 中文字符二元组，人物只负责作用域）；
 *   ③ 综合三项打分该排第几（0.65 相关 + 0.20 新鲜 + 0.15 重要），必要时沿标签/人物关联扩展。
 *
 * 口径来自《妹居物语》长期记忆那套公示：7 天宽限、重要的事衰减慢、真正想起一次就重置宽限、
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
 *   age = now - max(createdAt, lastReinforcedAt) ← 真正想起 = 重新计时
 *   age' = max(0, age - grace)                  ← 宽限期内不衰减
 *   effective = importance * 0.5 ** (age' / halfLife)
 *
 * 半衰期按重要性拉长（重要的忘得慢）：halfLife × (0.5 + importance)。
 * 这样 0.9 的重要事半衰期是日常（0.5）的 1.4/1.0 = 1.4 倍，和公示里“重要的事掉得更慢”一致。
 *
 * @param {{importance:number, createdAt:number, lastReinforcedAt?:number}} m
 * @param {{now?:number, graceDays?:number, halfLifeDays?:number}} o
 * @returns {number} [0,1]
 */
export function effectiveImportance(m, o = {}) {
  const imp = clamp01(m?.importance)
  // lastRecalledAt 只记录“被送进提示词”的次数，不能让自动注入形成自我续期。
  const base = Math.max(Number(m?.createdAt) || 0, Number(m?.lastReinforcedAt) || 0)
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
const GENERIC_LINKS = new Set(['主人', '我', '本鱼', '机器人', '自己', '日常', '事情', '东西', '生活', '聊天', '记录'])

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
 *   · 人物实体不单独把这段关系下的所有记忆变成相关
 *   · 标签命中：每个 +0.2，封顶 0.5
 *   · 二元组重叠：综合整体 Dice 相似度和查询词覆盖率，避免短关键词被长记忆稀释
 *
 * @param {object} m 记忆
 * @param {{text?:string, qqList?:string[]}} ctx 本轮查询
 * @returns {{relevance:number, why:string[]}}
 */
export function relevanceOf(m, ctx = {}) {
  const why = []
  let score = 0

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
  if (dice > 0) {
    const memoryGrams = grams(m?.text || '')
    let matched = 0
    for (const gram of gramsQ) if (memoryGrams.has(gram)) matched += 1
    const coverage = matched / gramsQ.size
    score += 0.25 * dice + 0.35 * coverage
    why.push(`措辞相近 ${Math.round(coverage * 100)}%`)
  }
  const query = text.trim()
  const memoryText = String(m?.text || '')
  if (query.length >= 2 && memoryText.includes(query)) {
    score += 0.35
    why.push('短语直命中')
  }

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

/**
 * 关联图：记忆条目共享具体标签或同一实体时相互可达。
 * 这不是把整库按人物串起来；只有先被当前话题命中的种子，才允许向外扩展。
 */
function relationTokens(memory) {
  const tags = (Array.isArray(memory?.tags) ? memory.tags : []).map((x) => String(x || '').trim())
  const names = (Array.isArray(memory?.entities) ? memory.entities : []).map((e) => String(e?.name || '').trim())
  return new Set([...tags, ...names].filter((x) => x.length >= 2 && !GENERIC_LINKS.has(x)))
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
 * @param {Array<{text:string, createdAt:number, memoryType?:string, state?:string, dueAt?:number}>} list 已排序、已截断
 * @param {{now?:number, maxChars?:number, header?:string}} o
 */
export function formatInjection(list, o = {}) {
  const items = Array.isArray(list) ? list.filter((x) => x && String(x.text || '').trim()) : []
  if (!items.length) return ''
  const header = String(o.header || '[以下为系统信息，非用户发言：按当前话题联想到的经历，仅供理解上下文；计划状态以标记为准，不要主动催问]')
  const now = nowOf(o)
  const maxChars = Math.max(80, Number(o.maxChars ?? 600))
  const lines = []
  let used = header.length
  for (const m of items) {
    const age = agoText(m.createdAt, now)
    const state = String(m.state || '')
    const dueAt = Number(m.dueAt)
    const pastDue = Number.isFinite(dueAt) && dueAt > 0 && dueAt <= now
    const stateText = ({ completed: '已完成', cancelled: '已取消', superseded: '已被后续计划替代', expired: '已过期', stale: pastDue ? '状态待确认，且已过截止时间' : '状态未确认' })[state]
      || (pastDue && ['plan', 'commitment'].includes(String(m.memoryType || '')) ? '状态待确认，且已过截止时间' : '')
    const label = stateText ? `历史状态：${stateText}；` : ''
    const line = `- ${label}${String(m.text).replace(/\s+/g, ' ').trim()}（${age}）`
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
 *   weightRelevance?:number, weightFresh?:number, weightImportance?:number, relevanceFloor?:number,
 *   maxSeeds?:number, maxHops?:number, maxNodes?:number, hopDecay?:number, minAssociation?:number,
 *   relationWeight?:number, allowRelated?:boolean, excludeTerminal?:boolean}} o
 * @returns {Array<{memory:object, score:number, relevance:number, fresh:number, importance:number, why:string[]}>}
 */
export function rankMemories(memories, o = {}) {
  const scope = String(o.scope || '')
  const topK = Math.max(1, Math.round(Number(o.topK ?? 5) || 5))
  const source = Array.isArray(memories) ? memories : []
  const scoped = source.filter((m) => {
    if (!m || !String(m.text || '').trim()) return false
    if (String(m.scope || m.key || '') !== scope) return false
    if (o.excludeForgotten !== false && Number(m.forgottenAt) > 0) return false
    return true
  })
  const ctx = { text: o.text || '', qqList: o.qqList || [] }
  const hasQuery = String(o.text || '').trim().length > 0
  const directFloor = Math.max(0, Number(o.relevanceFloor ?? (hasQuery ? 0.15 : 0)))
  const terminal = (m) => {
    if (!['plan', 'commitment'].includes(String(m?.memoryType || ''))) return false
    if (['completed', 'cancelled', 'superseded', 'expired'].includes(String(m?.state || ''))) return true
    const dueAt = Number(m?.dueAt)
    return Number.isFinite(dueAt) && dueAt > 0 && dueAt <= nowOf(o)
  }
  const direct = scoped
    .filter((m) => hasQuery || o.excludeTerminal === false || !terminal(m))
    .map((memory) => ({ memory, ...scoreMemory(memory, ctx, o) }))
  const pool = scoped.filter((m) => !terminal(m))
  const poolById = new Map(pool.filter((m) => m.id).map((m) => [String(m.id), m]))
  const seeds = direct.filter((x) => !terminal(x.memory) && x.relevance >= directFloor)
    .sort((a, b) => b.relevance - a.relevance || b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, Number(o.maxSeeds) || 20)))
  const relationScores = new Map()
  const directSeeds = new Set(seeds.map((x) => String(x.memory.id || '')))

  if (hasQuery && o.allowRelated !== false && seeds.length) {
    const linkIndex = new Map()
    for (const memory of pool) {
      for (const token of relationTokens(memory)) {
        if (!linkIndex.has(token)) linkIndex.set(token, [])
        linkIndex.get(token).push(memory)
      }
    }
    const hubLimit = Math.max(4, Math.ceil(pool.length * 0.2))
    for (const [token, rows] of linkIndex) if (rows.length > hubLimit) linkIndex.delete(token)
    const neighbors = (memory) => {
      const out = new Set()
      for (const token of relationTokens(memory)) for (const row of linkIndex.get(token) || []) out.add(row)
      const links = Array.isArray(memory.relatedIds) ? memory.relatedIds.map(String) : []
      for (const id of links) if (poolById.has(id)) out.add(poolById.get(id))
      for (const row of pool) if (Array.isArray(row.relatedIds) && row.relatedIds.map(String).includes(String(memory.id || ''))) out.add(row)
      return [...out]
    }
    const maxHops = Math.max(1, Math.min(4, Number(o.maxHops) || 4))
    const maxNodes = Math.max(1, Math.min(30, Number(o.maxNodes) || 30))
    const visited = new Set(directSeeds)
    const queue = seeds.map((x) => ({ memory: x.memory, strength: x.relevance, hops: 0 }))
    for (let cursor = 0; cursor < queue.length && visited.size < maxNodes; cursor += 1) {
      const current = queue[cursor]
      if (current.hops >= maxHops) continue
      for (const next of neighbors(current.memory)) {
        const id = String(next.id || '')
        if (!id || visited.has(id)) continue
        visited.add(id)
        const hops = current.hops + 1
        const strength = current.strength * Number(o.hopDecay ?? 0.5)
        if (strength >= Number(o.minAssociation ?? 0.03)) {
          relationScores.set(id, Math.max(relationScores.get(id) || 0, strength))
          queue.push({ memory: next, strength, hops })
        }
        if (visited.size >= maxNodes) break
      }
    }
  }

  return direct
    .map((hit) => {
      const id = String(hit.memory.id || '')
      const relation = relationScores.get(id) || 0
      const relatedScore = relation * Number(o.relationWeight ?? 0.25)
      const why = hit.why.slice()
      if (relation > 0) why.push(`关系网 ${Math.round(relation * 100)}%`)
      return { ...hit, relation, score: hit.score + relatedScore, why }
    })
    .filter((hit) => !hasQuery || hit.relevance >= directFloor || relationScores.has(String(hit.memory.id || '')))
    .sort((a, b) => b.score - a.score || (Number(b.memory.createdAt) || 0) - (Number(a.memory.createdAt) || 0))
    .slice(0, topK)
}
