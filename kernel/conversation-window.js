/** Reply-driven, per-person conversation windows. Silence never schedules a model call. */
export function createConversationWindow({ config, clock = Date.now, log = console }) {
  const windows = new Map()
  const buffers = new Map()
  const epochs = new Map()
  let generation = 0
  let stopped = false
  const keyOf = (chat, user) => `${chat}/${user}`
  /** 窗口上限（毫秒）。2026-11-25：原来写死 120000，玩家把面板填大也会被悄悄夹到 2 分钟。 */
  const MAX_WINDOW_MS = 600000
  const settings = () => config?.() || {}
  /**
   * 面板值（秒）→ 毫秒。
   *
   * 2026-11-25 统一口径：`gate-wake.groupFollowUpMs` **按秒存、按秒读**，这里只做 ×1000。
   * 老配置（存的是毫秒，如 10000）由 gate-wake 的 `migrateConfig` 在装配前折成秒（→ 10），
   * 所以这里**不再保留「≥1000 当毫秒」的猜测分支**：
   *   · 那种猜测会让面板填 600 变成 600 毫秒、填 99999 变成 99 秒，永远猜不准；
   *   · 迁移已经在一个地方做完，两处都猜就会互相打架。
   */
  const duration = () => {
    const c = settings()
    if (c.enabled === false) return 0
    const sec = Number(c.groupFollowUpMs ?? 60)
    if (!Number.isFinite(sec) || sec <= 0) return 0
    return Math.min(MAX_WINDOW_MS, Math.round(sec * 1000))
  }
  function prune() {
    for (const [key, w] of windows) if (w.until <= clock()) windows.delete(key)
  }

  /**
   * 诊断日志（2026-11-25 加）。
   *
   * 为什么要有：这套窗口原来**全程 debug 级**，而线上不设 QQ_BOT_DEBUG = 一条都看不到。
   * 结果「群里不回话」时完全无法判断到底是窗口没开、开给了别人、还是过期了。
   * 现在关键节点打 info，但**按 chat 限频**（同一群每 30 秒最多一条），避免窗口期内每条消息刷一行。
   */
  const LOG_GAP_MS = 30000
  const lastLogAt = new Map()
  function diag(chatKey, msg, { force = false } = {}) {
    try {
      const k = String(chatKey || '')
      const t = clock()
      const last = lastLogAt.get(k) || 0
      if (!force && t - last < LOG_GAP_MS) return
      lastLogAt.set(k, t)
      log.info(`[接话窗口] ${msg}`)
    } catch { /* 日志失败绝不影响主流程 */ }
  }

  function open(chat, user, cached = {}) {
    const ms = duration()
    if (stopped || !ms || !String(chat).startsWith('group:') || !/^\d+$/.test(String(user))) return
    prune()
    const key = keyOf(chat, user)
    windows.set(key, { until: clock() + ms, ...cached })
    // Expired entries are removed on access; the bound also protects a busy public bot.
    while (windows.size > 2000) windows.delete(windows.keys().next().value)
    diag(chat, `开窗口 ${key} ${Math.round(ms / 1000)}s（到此 ${new Date(clock() + ms).toTimeString().slice(0, 8)}）`, { force: true })
  }
  function capture(ev) {
    if (stopped || !duration() || !ev?.isGroup || ev.wake || ev.stopped) return false
    prune()
    const key = keyOf(ev.chatKey, ev.sender?.qq)
    const window = windows.get(key)
    if (!window) {
      // 只有"本群确实有别人的窗口"时才值得提示一句，否则每句闲聊都会刷
      const anyone = [...windows.keys()].some((k) => k.startsWith(`${ev.chatKey}/`))
      if (anyone) diag(ev.chatKey, `未命中 ${key}（此人在窗口外，或窗口已过期）`)
      return false
    }
    ev.wake = { kind: 'followup' }
    ev._scratch.followUpWindow = window
    ev._scratch.followUpEpoch = epochs.get(ev.chatKey) || 0
    ev._scratch.followUpGeneration = generation
    if (!ev.replyToId && window.replyToId) ev.replyToId = window.replyToId
    if (window.images?.length) ev.images.push(...window.images)
    // A bare-call cache belongs only to the first supplement. The window itself stays open.
    delete window.replyToId
    delete window.images
    const left = Math.max(0, Math.round((window.until - clock()) / 1000))
    diag(ev.chatKey, `命中 ${key}（剩 ${left}s）→ 进模型由它判断是否接话`, { force: true })
    return true
  }
  function current(ev) {
    if (stopped || !duration()) return false
    const w = ev?._scratch?.followUpWindow
    // Admission was checked at arrival. Preparation may finish after the deadline.
    return !!w && !w.cancelled && ev._scratch.followUpGeneration === generation
      && ev._scratch.followUpEpoch === (epochs.get(ev.chatKey) || 0)
  }
  async function flush(chat, user) {
    const key = keyOf(chat, user)
    const slot = buffers.get(key)
    if (!slot) return
    buffers.delete(key)
    clearTimeout(slot.timer)
    const events = slot.events.filter(current)
    if (events.length) await slot.run(events)
  }
  function submit(ev, run) {
    if (!current(ev)) return
    const key = keyOf(ev.chatKey, ev.sender.qq)
    const slot = buffers.get(key) || { events: [], firstAt: clock(), run, timer: null }
    slot.events.push(ev)
    slot.run = run
    clearTimeout(slot.timer)
    const configured = Number(settings().followUpDebounceMs ?? 1000)
    const wait = Math.max(0, Math.min(Number.isFinite(configured) ? configured : 1000, 3000 - (clock() - slot.firstAt)))
    buffers.set(key, slot)
    slot.timer = setTimeout(() => {
      flush(ev.chatKey, ev.sender.qq).catch((e) => log.error(`[接话窗口] ${e.stack || e.message}`))
    }, wait)
    slot.timer.unref?.()
  }
  function hasOpen(chat) {
    if (stopped || !duration()) return false
    prune()
    const prefix = `${chat}/`
    return [...windows.keys(), ...buffers.keys()].some((key) => key.startsWith(prefix))
  }
  function clear(chat) {
    if (chat != null) epochs.set(chat, (epochs.get(chat) || 0) + 1)
    else { generation++; epochs.clear() }
    const prefix = chat == null ? '' : `${chat}/`
    for (const [key, w] of windows) if (key.startsWith(prefix)) { w.cancelled = true; windows.delete(key) }
    for (const [key, slot] of buffers) if (key.startsWith(prefix)) {
      clearTimeout(slot.timer)
      for (const ev of slot.events) ev._scratch.followUpWindow.cancelled = true
      buffers.delete(key)
    }
  }
  function noteReply(rec) {
    const turn = rec.turnCtx
    // 2026-11-25：**为什么没续期**要能查到。原来是静默 return，线上永远看不出窗口为什么没开。
    // 逐条判据分开记，限频 30 秒，避免正常刷屏。
    const skip = (why) => {
      const where = rec.target || turn?.chatKey || '-'
      diag(where, `未续期（${why}）→ 此人窗口不会打开`)
      return undefined
    }
    if (!rec.conversationReply) return skip('这条不是对话回复（可能是内部 [不发] 或媒体）')
    if (!turn) return skip('拿不到本轮上下文 turnCtx')
    if (turn._submissionFailed) return skip('本轮提交失败')
    if (!turn.isGroup) return undefined // 私聊没有窗口，静默即可
    if (!['at', 'quote', 'keyword', 'followup'].includes(turn.wakeKind)) return skip(`wakeKind=${turn.wakeKind} 不在可续期范围`)
    if (!duration()) return skip('窗口已关闭（groupFollowUpMs=0 或插件停用）')
    if (!Array.isArray(turn.participants) || !turn.participants.length) return skip('本轮没有可识别的参与者')
    // Only a delivered reply renews the windows. An internal [不发] answer cannot.
    for (const qq of turn.participants || []) open(rec.target, qq)
    return undefined
  }
  return { open, capture, current, submit, flush, hasOpen, clear, noteReply,
    stop() { stopped = true; clear() },
  }
}
