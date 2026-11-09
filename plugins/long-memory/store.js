/**
 * plugins/long-memory/store.js — 长期记忆的持久化层。
 *
 * 两种形态各管一件事：
 *   · `memories.jsonl`：**append-only 事件流**（add / recall / forget / restore / boost）。
 *     它是唯一真相：谁在什么时候记了什么、被想起过几次、为什么忘掉，都留在历史里。
 *   · `memories.json`：**压缩快照**（当前视图 + 水位），启动时先读快照，再回放快照之后的 JSONL 尾部。
 *
 * 三条纪律：
 *   ① 写盘只有这里；读侧永远不写（除 recall 事件，那是显式记账）。
 *   ② 追加 JSONL 失败 = 整次操作失败，但**不许让聊天挂掉**：调用方 catch 后只记日志。
 *   ③ 快照写坏 / 不存在 → 从 JSONL 全量回放（行为完全一致，只是慢一点）。
 *
 * 为什么不用 sqlite：本插件要同时跑在 Windows 与 aarch64 NAS 上，Node 22 的 `node:sqlite`
 * 还是实验特性；记忆规模（几千条）用 JSONL + 内存索引绰绰有余，而且**人能直接读**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripBom, atomicWriteFileSync, writeJsonFileSync, backupFileSync } from '../../platform/atomic.js'
import { ensureDir } from '../../platform/paths.js'

const EVENT_FILE = 'memories.jsonl'
const SNAPSHOT = 'memories.json'
const REVISIONS = '.revisions'
/** 快照最多保留多少份（每次 purge / import 前备份）。 */
const KEEP_REVISIONS = 10

const rid = () => Math.random().toString(36).slice(2, 6)

/** 本地日期 YYYYMMDD（记忆 id 里的人类可读段）。 */
function ymd(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 建一个 store。**不做任何异步 IO**：全是同步小文件，简单可预测。
 * @param {{dir:string, log?:object, maxEventsBeforeCompact?:number}} opts
 */
export function createStore({ dir, log = console, maxEventsBeforeCompact = 5000 } = {}) {
  const root = String(dir || '').trim()
  if (!root) throw new Error('long-memory: 记忆目录为空')
  ensureDir(root)
  const eventFile = path.join(root, EVENT_FILE)
  const snapFile = path.join(root, SNAPSHOT)
  const revDir = path.join(root, REVISIONS)

  /** id → 视图条目 { memory, recallAt, recallCount, forgottenAt, forgetReason } */
  const view = new Map()
  let lastEventTs = 0
  let replayOffset = 0 // 已回放进来的字节数（避开重复回放）
  const watermarks = {} // scope → 上次实际喂给模型的最新一条消息 ts
  let lastOrganizeAt = 0
  let lastOrganizeResult = null
  let lastError = ''
  let events = 0
  /** 上次回放时发现文件末尾有“写到一半的残行”（下一个 append 要先补换行）。 */
  let tailBroken = false

  const abs = (p) => path.join(root, p)

  // ── 回放 ────────────────────────────────────────────────────────────────
  function applyEvent(ev, { count = true } = {}) {
    if (!ev || typeof ev !== 'object') return
    const at = Number(ev.at) || 0
    if (at > lastEventTs) lastEventTs = at
    if (count) events += 1
    if (ev.op === 'add' && ev.memory && ev.memory.id) {
      view.set(String(ev.memory.id), {
        memory: { ...ev.memory },
        recallAt: Number(ev.memory.lastRecalledAt) || 0,
        recallCount: Number(ev.memory.recallCount) || 0,
        forgottenAt: Number(ev.memory.forgottenAt) || 0,
        forgetReason: String(ev.memory.forgetReason || ''),
      })
      return
    }
      const id = String(ev.id || '')
      if (!id) return
      if (ev.op === 'purge') { view.delete(id); return }
      const row = view.get(id)
      if (!row) return
      if (ev.op === 'recall') {
      row.recallAt = Math.max(row.recallAt, at)
      row.recallCount += 1
      row.memory.lastRecalledAt = row.recallAt
      row.memory.recallCount = row.recallCount
    } else if (ev.op === 'forget') {
      row.forgottenAt = at || Date.now()
      row.forgetReason = String(ev.reason || '')
      row.memory.forgottenAt = row.forgottenAt
      row.memory.forgetReason = row.forgetReason
    } else if (ev.op === 'restore') {
      row.forgottenAt = 0
      row.forgetReason = ''
      row.memory.forgottenAt = 0
      row.memory.forgetReason = ''
    } else if (ev.op === 'boost') {
      const v = Number(ev.importance)
      if (Number.isFinite(v)) row.memory.importance = Math.max(0, Math.min(1, v))
      if (Array.isArray(ev.tags) && ev.tags.length) row.memory.tags = ev.tags.slice(0, 12).map(String)
    }
  }

  /** 从字节 offset 开始按行回放；半行（写到一半崩了）跳过并记住断点。 */
  function replayFrom(offset) {
    let buf = null
    try { buf = fs.readFileSync(eventFile) } catch { replayOffset = 0; return }
    if (!(offset > 0)) offset = 0
    // 末尾不带换行的那段 = 写到一半的记录，整段跳过；下一个 append 会把它接成一条坏行，
    // **必须从它开头重新算断点**，否则新写的记录会跟着半行一起被跳过（静默丢数据）。
    let body = buf.toString('utf8')
    if (body.length && !body.endsWith('\n')) {
      tailBroken = true
      const cut = body.lastIndexOf('\n')
      body = cut >= 0 ? body.slice(0, cut + 1) : ''
    }
    const start = Math.min(offset, Buffer.byteLength(body, 'utf8'))
    const tail = Buffer.from(body, 'utf8').subarray(start).toString('utf8')
    replayOffset = start + Buffer.byteLength(tail, 'utf8')
    for (const line of tail.split('\n')) {
      const t = stripBom(line).trim()
      if (!t) continue
      try {
        applyEvent(JSON.parse(t))
      } catch {
        // 坏行（写到一半）→ 跳过，不炸整个库；下次 compact 会把坏行洗掉
        try { log.warn?.(`[long-memory] 跳过一行坏事件（长度 ${t.length}）`) } catch { /* ignore */ }
      }
    }
  }

  function load() {
    let snap = null
    try { snap = JSON.parse(stripBom(fs.readFileSync(snapFile, 'utf8'))) } catch { snap = null }
    if (snap && Array.isArray(snap.memories)) {
      for (const m of snap.memories) {
        if (!m || !m.id) continue
        view.set(String(m.id), {
          memory: { ...m },
          recallAt: Number(m.lastRecalledAt) || 0,
          recallCount: Number(m.recallCount) || 0,
          forgottenAt: Number(m.forgottenAt) || 0,
          forgetReason: String(m.forgetReason || ''),
        })
      }
      for (const [k, v] of Object.entries(snap.watermarks || {})) watermarks[k] = Number(v) || 0
      lastOrganizeAt = Number(snap.lastOrganizeAt) || 0
      lastOrganizeResult = snap.lastOrganizeResult || null
      lastError = String(snap.lastError || '')
      replayFrom(Number(snap.eventBytes) || 0)
    } else {
      view.clear()
      replayFrom(0)
    }
    // 历史事件数只用于“要不要 compact”的判断，粗略即可
    if (events === 0) events = view.size
  }

  function snapshot() {
    const list = [...view.values()].map((r) => r.memory)
    const payload = {
      version: 1,
      savedAt: Date.now(),
      eventBytes: replayOffset,
      memories: list,
      watermarks,
      lastOrganizeAt,
      lastOrganizeResult,
      lastError,
    }
    writeJsonFileSync(snapFile, payload)
  }

  function append(ev) {
    const line = `${JSON.stringify(ev)}\n`
    // 上一段是写到一半的残行（没换行结尾）→ 先补换行把它关成一整行坏行，
    // 否则新事件会粘上去、跟着残行一起被判成坏行（静默丢数据）。
    if (tailBroken) {
      fs.appendFileSync(eventFile, '\n')
      replayOffset += 1
      tailBroken = false
    }
    fs.appendFileSync(eventFile, line)
    replayOffset += Buffer.byteLength(line, 'utf8')
    events += 1
    lastEventTs = Math.max(lastEventTs, Number(ev.at) || 0)
  }

  load()

  /** 提升重要性并（可选）补标签：一个事件同时记两件事，回放时也一起生效。 */
  function boostEntry(id, importance, tags) {
    const row = view.get(String(id))
    if (!row) return false
    const v = Math.max(0, Math.min(1, Number(importance)))
    const ev = { op: 'boost', id: String(id), at: Date.now(), ...(Number.isFinite(v) ? { importance: v } : {}) }
    if (Array.isArray(tags) && tags.length) ev.tags = tags.slice(0, 12).map(String)
    append(ev)
    if (Array.isArray(tags) && tags.length) row.memory.tags = ev.tags
    applyEvent(ev)
    return true
  }

  // 先回收旧事件流（体积回收），再写快照：顺序反了会把“被压缩掉的字节数”当成回放起点，快照之后的事件就丢了。
  function saveNow() {
    try { compactImpl() } catch (e) { log.warn?.(`[long-memory] 压缩失败（不影响读写）: ${e?.message || e}`) }
    snapshot()
  }

  /** 归档旧事件流：把当前视图重写成一对新的 {快照, jsonl}，事件数归零（体积回收）。 */
  function compactImpl() {
    if (events < maxEventsBeforeCompact) return { ok: true, compacted: false }
    try {
      backupImpl('compact')
      // 先把当前视图 → 新的 jsonl（一记忆一行 add），再写快照指向它的末尾
      const tmp = path.join(root, `${EVENT_FILE}.tmp-${process.pid}`)
      let size = 0
      const fd = fs.openSync(tmp, 'w')
      try {
        for (const r of view.values()) {
          const line = `${JSON.stringify({ op: 'add', at: Date.now(), memory: r.memory })}\n`
          fs.writeSync(fd, line)
          size += Buffer.byteLength(line, 'utf8')
        }
      } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, eventFile)
      replayOffset = size
      events = view.size
      snapshot()
      return { ok: true, compacted: true, entries: view.size }
    } catch (e) {
      return { ok: false, compacted: false, error: String(e?.message || e) }
    }
  }

  /** 硬删前的整库备份（`.revisions/book-<时间戳>.json`，最多留 KEEP_REVISIONS 份）。 */
  function backupImpl(tag = 'manual') {
    try {
      ensureDir(revDir)
      const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)
      writeJsonFileSync(path.join(revDir, `book-${ts}.json`), {
        tag, savedAt: Date.now(), memories: [...view.values()].map((r) => r.memory), watermarks,
      })
      const files = fs.readdirSync(revDir).filter((n) => n.startsWith('book-')).sort()
      while (files.length > KEEP_REVISIONS) {
        const f = files.shift()
        try { fs.unlinkSync(path.join(revDir, f)) } catch { /* ignore */ }
      }
      return true
    } catch (e) {
      try { log.warn?.(`[long-memory] 备份失败: ${e.message}`) } catch { /* ignore */ }
      return false
    }
  }

  const api = {
    dir: root,
    /** 当前全部条目（含已遗忘；含内部 recall 状态）。返回浅拷贝，别改内部对象。 */
    all() {
      return [...view.values()].map((r) => ({ ...r.memory, _recallAt: r.recallAt, _recallCount: r.recallCount }))
    },
    get(id) {
      const r = view.get(String(id))
      return r ? { ...r.memory, _recallAt: r.recallAt, _recallCount: r.recallCount } : null
    },
    size(predicate) {
      const rows = [...view.values()].map((r) => r.memory)
      return typeof predicate === 'function' ? rows.filter(predicate).length : rows.length
    },

    /**
     * 新增一条记忆。同作用域内“文本几乎一样”的视为重复 → 合并（提高重要性、补标签），返回 {merged:true}。
     * @param {object} m 已校验的记忆对象（不含 id 也行，这里补）
     */
    add(m) {
      const at = Number(m.createdAt) || Date.now()
      const scope = String(m.scope || m.key || '')
      if (!scope) throw new Error('记忆缺少作用域 scope')
      // 去重：同作用域、未遗忘、文本归一后相同（先做便宜的相等比较，再交给调用方做相似合并）
      const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
      for (const r of view.values()) {
        if (r.forgottenAt) continue
        if (String(r.memory.scope || '') !== scope) continue
        if (norm(r.memory.text) === norm(m.text)) {
          const imp = Math.max(Number(r.memory.importance) || 0, Number(m.importance) || 0)
          const tags = [...new Set([...(r.memory.tags || []), ...(Array.isArray(m.tags) ? m.tags : [])])]
          boostEntry(r.memory.id, imp, tags)
          return { ok: true, merged: true, id: r.memory.id }
        }
      }
      const id = String(m.id || `m_${ymd(at)}_${String(new Date(at).getHours()).padStart(2, '0')}${String(new Date(at).getMinutes()).padStart(2, '0')}${String(new Date(at).getSeconds()).padStart(2, '0')}_${rid()}`)
      const memory = {
        id,
        key: String(m.key || scope),
        kind: String(m.kind || (scope.startsWith('group:') ? 'group' : 'private')),
        scope,
        text: String(m.text || '').trim(),
        importance: Math.max(0, Math.min(1, Number(m.importance) || 0.5)),
        memoryType: String(m.memoryType || 'fact'),
        tags: Array.isArray(m.tags) ? m.tags.slice(0, 12).map(String) : [],
        entities: Array.isArray(m.entities) ? m.entities.slice(0, 8) : [],
        sourceMsgIds: Array.isArray(m.sourceMsgIds) ? m.sourceMsgIds.slice(0, 40) : [],
        createdAt: at,
        lastRecalledAt: 0,
        recallCount: 0,
        forgottenAt: 0,
        forgetReason: '',
        origin: String(m.origin || 'organize'), // organize（自动整理）| manual（模型 remember）| user（控制台/命令）
      }
      if (!memory.text) throw new Error('记忆正文为空')
      append({ op: 'add', at: Date.now(), memory })
      applyEvent({ op: 'add', memory, at: Date.now() })
      return { ok: true, merged: false, id }
    },

    /** 记账“这条被想起过”（重置宽限）。批量传 id 数组。 */
    markRecalled(ids, at = Date.now()) {
      const out = []
      for (const id of ids || []) {
        if (!view.has(String(id))) continue
        const ev = { op: 'recall', id: String(id), at }
        append(ev)
        applyEvent(ev)
        out.push(String(id))
      }
      return out
    },

    forget(id, reason = '衰减') {
      if (!view.has(String(id))) return false
      const ev = { op: 'forget', id: String(id), at: Date.now(), reason }
      append(ev); applyEvent(ev)
      return true
    },

    restore(id) {
      if (!view.has(String(id))) return false
      const ev = { op: 'restore', id: String(id), at: Date.now() }
      append(ev); applyEvent(ev)
      return true
    },

    boost(id, importance) {
      if (!view.has(String(id))) return false
      const v = Math.max(0, Math.min(1, Number(importance)))
      if (!Number.isFinite(v)) return false
      const ev = { op: 'boost', id: String(id), importance: v, at: Date.now() }
      append(ev); applyEvent(ev)
      return true
    },

    /** 硬删一条（控制台 purge）：先备份库，再追加 purge 事件。 */
    purge(id) {
      if (!view.has(String(id))) return false
      backupImpl('purge')
      const ev = { op: 'purge', id: String(id), at: Date.now() }
      append(ev); applyEvent(ev)
      try { saveNow() } catch { /* 快照失败不影响事件流 */ }
      return true
    },

    // ── 水位 / 整理账 ──
    watermarkOf(scope) { return Number(watermarks[String(scope)]) || 0 },
    setWatermark(scope, ts) {
      const v = Number(ts)
      if (!(v > 0)) return
      watermarks[String(scope)] = v
      try { snapshot() } catch { /* ignore */ }
    },
    recordOrganize({ at = Date.now(), result = null, error = '' } = {}) {
      lastOrganizeAt = at
      lastOrganizeResult = result
      lastError = String(error || '')
      try { snapshot() } catch { /* ignore */ }
    },
    statsOrganize() {
      return { lastOrganizeAt, lastResult: lastOrganizeResult, lastError }
    },

    /** 当前视图落成快照（按需调用：写完一轮整理后）。 */
    save() { saveNow() },

    /** 硬删前的整库备份（`.revisions/book-<时间戳>.json`，最多留 KEEP_REVISIONS 份）。 */
    /** 导出（md / json）文本。 */
    exportText(format = 'md') {
      const rows = [...view.values()].map((r) => r.memory).filter((m) => String(m.text || '').trim())
      rows.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
      if (format === 'json') return JSON.stringify(rows, null, 2)
      const lines = ['# 长期记忆导出', '', `共 ${rows.length} 条`, '']
      let lastScope = ''
      for (const m of rows) {
        if (m.scope !== lastScope) {
          lastScope = m.scope
          lines.push('', `## ${lastScope}`, '')
        }
        const mark = Number(m.forgottenAt) > 0 ? '（已遗忘）' : ''
        const imp = Number(m.importance || 0).toFixed(2)
        lines.push(`- [${m.id}] (${new Date(m.createdAt).toISOString().slice(0, 10)}｜重要 ${imp}${mark}) ${String(m.text).replace(/\s+/g, ' ')}`)
      }
      return lines.join('\n') + '\n'
    },

    /** 导入：接受 exportText('json') 的数组；返回 {added, skipped}。 */
    importJson(text) {
      let list = []
      try { list = JSON.parse(String(text || '')) } catch { throw new Error('导入内容不是合法 JSON') }
      if (!Array.isArray(list)) throw new Error('导入内容必须是记忆数组')
      let added = 0
      const skipped = []
      for (const m of list) {
        try {
          if (!m || !String(m.text || '').trim()) { skipped.push('空正文'); continue }
          const r = api.add({ ...m, origin: 'import' })
          if (!r.merged) added += 1
        } catch (e) { skipped.push(String(e?.message || e)) }
      }
      try { snapshot() } catch { /* ignore */ }
      return { added, skipped: skipped.slice(0, 20) }
    },

    /** 给控制台“为什么会被想起来”用的分项。 */
    diagnose(id) {
      const r = view.get(String(id))
      if (!r) return null
      return { memory: r.memory, recallAt: r.recallAt, recallCount: r.recallCount }
    },

    /** `.bak` 风格的整库备份（换配置/换作用域前手动置位用）。 */
    backupFile(tag = 'bak') {
      try { return backupFileSync(snapFile, tag) } catch { return '' }
    },

    /** 测试/控制台用：当前目录下有哪些文件。 */
    files() {
      try {
        return fs.readdirSync(root).map((n) => {
          const st = fs.statSync(path.join(root, n))
          return { name: n, bytes: st.isFile() ? st.size : 0, isDir: st.isDirectory() }
        })
      } catch { return [] }
    },
  }

  // 导出前统一把 api 交回去：方法之间不互相 `this.xxx` 调用，避免解构后静默失效。
  return api
}

export { EVENT_FILE, SNAPSHOT, REVISIONS }
