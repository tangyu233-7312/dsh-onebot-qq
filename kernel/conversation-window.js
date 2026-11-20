/** Reply-driven, per-person conversation windows. Silence never schedules a model call. */
export function createConversationWindow({ config, clock = Date.now, log = console }) {
  const windows = new Map()
  const buffers = new Map()
  const epochs = new Map()
  let generation = 0
  let stopped = false
  const keyOf = (chat, user) => `${chat}/${user}`
  const settings = () => config?.() || {}
  const duration = () => {
    const c = settings()
    if (c.enabled === false) return 0
    const value = Number(c.groupFollowUpMs ?? 10000)
    return Number.isFinite(value) && value > 0 ? Math.min(120000, value < 1000 ? value * 1000 : value) : 0
  }
  function prune() {
    for (const [key, w] of windows) if (w.until <= clock()) windows.delete(key)
  }
  function open(chat, user, cached = {}) {
    const ms = duration()
    if (stopped || !ms || !String(chat).startsWith('group:') || !/^\d+$/.test(String(user))) return
    prune()
    const key = keyOf(chat, user)
    windows.set(key, { until: clock() + ms, ...cached })
    // Expired entries are removed on access; the bound also protects a busy public bot.
    while (windows.size > 2000) windows.delete(windows.keys().next().value)
  }
  function capture(ev) {
    if (stopped || !duration() || !ev?.isGroup || ev.wake || ev.stopped) return false
    prune()
    const window = windows.get(keyOf(ev.chatKey, ev.sender?.qq))
    if (!window) return false
    ev.wake = { kind: 'followup' }
    ev._scratch.followUpWindow = window
    ev._scratch.followUpEpoch = epochs.get(ev.chatKey) || 0
    ev._scratch.followUpGeneration = generation
    if (!ev.replyToId && window.replyToId) ev.replyToId = window.replyToId
    if (window.images?.length) ev.images.push(...window.images)
    // A bare-call cache belongs only to the first supplement. The window itself stays open.
    delete window.replyToId
    delete window.images
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
    if (!rec.conversationReply || !turn || turn._submissionFailed || !turn.isGroup || !['at', 'quote', 'keyword', 'followup'].includes(turn.wakeKind)) return
    // Only a delivered reply renews the windows. An internal [不发] answer cannot.
    for (const qq of turn.participants || []) open(rec.target, qq)
  }
  return { open, capture, current, submit, flush, hasOpen, clear, noteReply,
    stop() { stopped = true; clear() },
  }
}
