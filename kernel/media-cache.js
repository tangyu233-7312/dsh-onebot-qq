/** 原件/抽帧结果的内容寻址缓存。只省下载和预处理，不代表已投递模型。 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readJsonFile, writeJsonFileSync } from '../platform/atomic.js'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const validHash = (value) => /^[a-f0-9]{64}$/.test(String(value || ''))

export function mediaSource(ev, image, index = 0) {
  const source = image._mediaSource || {}
  return {
    chatKey: String(ev.chatKey || ''), messageId: String(source.messageId ?? ev.messageId ?? ''),
    index: Number(source.index ?? index), at: Number(source.at ?? ev.time) || Date.now(),
    who: String(source.who ?? (ev.sender?.card || ev.sender?.name || '')),
    qq: String(source.qq ?? ev.sender?.qq ?? ''),
  }
}

export function createMediaCache({ dir, config = () => ({}), log = console, now = Date.now } = {}) {
  const objectsDir = path.join(dir, 'objects'), indexFile = path.join(dir, 'index.json')
  let db = { records: {}, objects: {} }, closed = false, running = 0, lastWarning = 0
  let cleanupTimer, nextCleanupAt = 0, lastCleanupAt = 0
  const pending = new Map(), queue = []
  const counters = { hits: 0, misses: 0, frameHits: 0, refused: 0, lastError: '' }
  const enabled = () => config().enabled !== false && config().cacheEnabled !== false
  const ttl = () => Math.max(1, Math.min(168, Number(config().cacheHours) || 24)) * 3600000
  const maxBytes = () => Math.max(1, Number(config().cacheMaxMb) || 1024) * 1048576
  const cleanupTime = () => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(config().cacheCleanupTime || ''))
    ? config().cacheCleanupTime : '23:50'
  const live = (row) => row && now() - Number(row.at) < ttl()
  const fileOf = (name) => {
    if (!/^[a-f0-9]{64}(?:-[a-f0-9]{64}-\d+)?\.bin$/.test(String(name))) throw new Error('无效缓存文件名')
    return path.join(objectsDir, name)
  }
  try {
    const saved = readJsonFile(indexFile)
    if (saved?.records && saved?.objects && !Array.isArray(saved.records) && !Array.isArray(saved.objects)) {
      db.records = Object.fromEntries(Object.entries(saved.records)
        .filter(([id, row]) => validHash(id) && row && validHash(row.hash) && /^(group|private):\d+$/.test(row.chatKey)))
      for (const [hash, item] of Object.entries(saved.objects)) {
        if (!validHash(hash) || !item || !Number.isFinite(item.bytes)) continue
        const variants = {}
        for (const [key, frames] of Object.entries(item.variants || {})) {
          if (!validHash(key) || !Array.isArray(frames)) continue
          if (frames.every((f, i) => f && f.file === hash + '-' + key + '-' + i + '.bin')) variants[key] = frames
        }
        db.objects[hash] = { bytes: item.bytes, variants }
      }
    }
  } catch { /* 首次启动无索引；损坏索引不影响正常收图 */ }
  const persist = () => {
    try { writeJsonFileSync(indexFile, db, { mode: 0o600 }) }
    catch { warn('媒体缓存索引写入失败，聊天仍按原路径处理') }
  }
  function warn(message) {
    counters.lastError = message
    if (now() - lastWarning > 60000 || !lastWarning) { lastWarning = now(); log.warn?.(message) }
  }
  const usage = () => Object.values(db.objects).reduce((total, item) => total + (Number(item.bytes) || 0)
    + Object.values(item.variants || {}).reduce((n, frames) => n + frames.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0), 0), 0)

  function sweep() {
    lastCleanupAt = now()
    let changed = false
    for (const [id, row] of Object.entries(db.records)) {
      if (!live(row)) { delete db.records[id]; changed = true }
    }
    const referenced = new Set(Object.values(db.records).map((row) => row.hash))
    for (const [hash, item] of Object.entries(db.objects)) {
      if (referenced.has(hash) || !validHash(hash)) continue
      const names = [hash + '.bin', ...Object.values(item.variants || {}).flat().map((f) => f.file)]
      for (const name of names) { try { fs.unlinkSync(fileOf(name)) } catch { /* 只清本缓存登记的过期产物 */ } }
      delete db.objects[hash]; changed = true
    }
    if (changed) persist()
  }
  const idOf = (source, image) => sha(JSON.stringify([source.chatKey, source.messageId, source.index, image._forwardLabels || []]))
  const referenceOf = (image) => sha(JSON.stringify([String(image.file || ''), String(image.url || '')]))

  function find(source, image) {
    if (image._cacheRecord) {
      const row = db.records[image._cacheRecord]
      return live(row) && row.chatKey === source.chatKey ? row : null
    }
    const row = db.records[idOf(source, image)]
    if (live(row) && row.chatKey === source.chatKey) return row
    if (!image.file && !image.url) return null
    const ref = referenceOf(image)
    return Object.values(db.records).find((r) => live(r) && r.chatKey === source.chatKey && r.reference === ref) || null
  }
  function link(source, image, hash) {
    if (!live(source) || !validHash(hash)) return false
    const id = idOf(source, image)
    const prior = db.records[id], reference = referenceOf(image)
    const at = Math.max(Number(prior?.at) || 0, source.at)
    if (prior && prior.hash === hash && prior.at === at && prior.reference === reference
      && prior.who === source.who && prior.qq === source.qq) return false
    db.records[id] = { ...source, at, hash, reference }
    return true
  }

  async function load(ev, image, index, loader) {
    const source = mediaSource(ev, image, index)
    const id = idOf(source, image)
    const read = () => {
      const row = find(source, image)
      if (!row || !db.objects[row.hash]) return null
      try {
        const bytes = fs.readFileSync(fileOf(row.hash + '.bin'))
        if (sha(bytes) !== row.hash) return null
        // at 来自原消息；模型读取历史不刷新 24h，用户重新发送才会带来更晚的 at。
        if (!image._cacheRecord && link(source, image, row.hash)) persist()
        counters.hits++
        return { bytes, hash: row.hash, file: fileOf(row.hash + '.bin'), cached: true }
      } catch { return null }
    }
    if (enabled()) {
      const hit = read()
      if (hit) return hit
      if (pending.has(id)) {
        try { await pending.get(id) } catch { /* 后台预取失败时，当前读取仍按自己的限制重新尝试 */ }
        const hit = read()
        if (hit) return hit
      }
    }
    const work = (async () => {
      counters.misses++
      const bytes = await loader()
      const hash = sha(bytes)
      if (enabled() && !closed && live(source)) {
        try {
          if (db.objects[hash] || usage() + bytes.length <= maxBytes()) {
            fs.mkdirSync(objectsDir, { recursive: true })
            // 走到下载分支说明未命中：即使索引仍在，也要修复丢失/损坏的原件。
            fs.writeFileSync(fileOf(hash + '.bin'), bytes, { mode: 0o600 })
            db.objects[hash] ||= { bytes: bytes.length, variants: {} }
            link(source, image, hash); persist()
            return { bytes, hash, file: fileOf(hash + '.bin'), cached: true }
          }
          counters.refused++; warn('媒体缓存容量不足：本图照常处理但未留存，不提前删除24小时内图片')
        } catch { warn('媒体缓存写入失败：本图照常处理但未留存') }
      }
      return { bytes, hash, file: '', cached: false }
    })()
    pending.set(id, work)
    try { return await work } finally { if (pending.get(id) === work) pending.delete(id) }
  }

  function own(chatKey, hash) {
    return enabled() && Object.values(db.records).some((r) => live(r) && r.chatKey === chatKey && r.hash === hash)
  }
  function getFrames(chatKey, hash, params) {
    if (!own(chatKey, hash)) return null
    const frames = db.objects[hash]?.variants?.[sha(JSON.stringify(params))]
    if (!frames) return null
    try {
      const result = frames.map((frame) => ({ ...frame, data: fs.readFileSync(fileOf(frame.file)).toString('base64') }))
      counters.frameHits++; return result
    } catch { return null }
  }
  function saveFrames(chatKey, hash, params, parts) {
    if (!own(chatKey, hash) || closed) return
    const key = sha(JSON.stringify(params)), item = db.objects[hash]
    if (item.variants[key]) return
    const size = parts.reduce((n, p) => n + Buffer.byteLength(p.data, 'base64'), 0)
    if (usage() + size > maxBytes()) { counters.refused++; warn('媒体缓存容量不足：GIF本轮可读，但抽帧结果未缓存'); return }
    const written = []
    try {
      const frames = parts.map((part, i) => {
        const file = hash + '-' + key + '-' + i + '.bin', data = Buffer.from(part.data, 'base64')
        fs.writeFileSync(fileOf(file), data, { mode: 0o600 })
        written.push(file)
        return { file, mediaType: part.mediaType, sec: part.sec, bytes: data.length }
      })
      item.variants[key] = frames; persist()
    } catch {
      for (const file of written) { try { fs.unlinkSync(fileOf(file)) } catch { /* 只回收本次未完成写入 */ } }
      warn('GIF抽帧缓存写入失败，后续可能需要重新抽帧')
    }
  }

  function enqueue(ev, resolver) {
    if (!enabled() || closed) return
    // 入队时立即快照，避免后续引用/转发展开改变事件图片列表和来源。
    for (const [index, original] of (ev.images || []).slice(0, 20).entries()) {
      if (queue.length >= 100) { counters.refused++; warn('媒体缓存下载队列已满，部分新图未留存'); break }
      const image = { ...original, _mediaSource: mediaSource(ev, original, index) }
      const snapshot = { chatKey: ev.chatKey, messageId: ev.messageId, time: ev.time, sender: { ...ev.sender } }
      queue.push(() => load(snapshot, image, index, () => resolver(image)))
    }
    drain()
  }
  function drain() {
    while (!closed && running < 2 && queue.length) {
      const task = queue.shift(); running++
      Promise.resolve().then(task).catch(() => warn('部分入站图片下载失败，未保存24小时缓存'))
        .finally(() => { running--; drain() })
    }
  }
  async function idle() {
    while (running || queue.length || pending.size) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  function recent(chatKey, count, since) {
    return Object.entries(db.records).filter(([, r]) => live(r) && r.chatKey === chatKey && r.at >= since)
      .sort((a, b) => b[1].at - a[1].at).slice(0, count)
      .map(([id, row]) => ({ _cacheRecord: id, _mediaSource: row }))
  }
  function stats() {
    return { ...counters, bytes: usage(), records: Object.values(db.records).filter(live).length,
      objects: Object.keys(db.objects).length, queued: queue.length, running, maxBytes: maxBytes(), hours: ttl() / 3600000,
      cleanupTime: cleanupTime(), nextCleanupAt, lastCleanupAt }
  }
  function scheduleCleanup() {
    clearTimeout(cleanupTimer)
    if (closed) return
    const stamp = now(), offset = 8 * 3600000
    const date = new Date(stamp + offset), [hour, minute] = cleanupTime().split(':').map(Number)
    nextCleanupAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute) - offset
    if (nextCleanupAt <= stamp) nextCleanupAt += 24 * 3600000
    // 一次只安排下一次北京时间到点执行；不扫描轮询，重启也不额外扫描。
    cleanupTimer = setTimeout(() => {
      try { sweep() } finally { scheduleCleanup() }
    }, nextCleanupAt - stamp)
    cleanupTimer.unref?.()
  }
  scheduleCleanup()
  return { load, getFrames, saveFrames, enqueue, recent, stats, idle, sweep, scheduleCleanup,
    close() { closed = true; queue.length = 0; clearTimeout(cleanupTimer); persist() } }
}
