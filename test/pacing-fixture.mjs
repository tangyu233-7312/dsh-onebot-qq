import { createPacing } from '../kernel/pacing.js'
import { ChatState } from '../kernel/state-pipeline.js'

export const MIN = 60000
export const localAt = (hour, minute = 0) => new Date(2026, 9, 29, hour, minute).getTime()
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
export const flushPacing = () => new Promise(resolve => setImmediate(resolve))

export function setupPacing(t, options = {}) {
  let now = options.now ?? localAt(12)
  const state = new ChatState({ log: quiet })
  for (const [key, values] of Object.entries(options.seed || {})) Object.assign(state.get(key), values)
  const fired = []
  const p = createPacing({ state, clock: () => now, log: options.log || quiet, dataDir: options.dataDir || '' })
  p.apply({ reply: {
    enabled: true, silenceEnabled: false, quietEnabled: false,
    privateEnabled: options.privateEnabledOn !== false, privateFriendsOnly: true,
    privateColdSilenceMs: 120 * MIN, privateHourlyMax: 1,
    privateMaxPerDay: 3, privateMinGapMs: 180 * MIN, ...options.reply,
  } })
  p.start({
    onProactiveTurn: async input => { fired.push(input) },
    isBusy: options.isBusy || (() => false),
    friendList: async () => {
      if (options.friendThrows) throw new Error('fixture friend list unavailable')
      return (options.friends || [10001, 10002]).map(user_id => ({ user_id }))
    },
  })
  t?.after(() => p.stop())
  if (!options.timers) p.stop()
  return { p, state, fired, advance(ms) { now += ms }, setNow(ms) { now = ms }, now: () => now }
}
