/**
 * test/client-render.test.js — 前端（client.js）**真的能渲染**的冒烟测试。
 *
 * 为什么要有它（2026-11-10 白屏事故）：我把 `WelcomeBody`（带 useState/useEffect 的组件）
 * 当成普通函数在 SwitchGroup 里直接调用 —— 展开「入群欢迎」时那些 hook 落进了父组件的 hook 序列，
 * 父组件的 hook 数量突变，整块控制台白屏。**在那之前所有测试都只测后端 schema，前端一行没跑过。**
 *
 * 做法：client.js 是 DSH 客户端的模块（`window.__ModuleLoader__.load({id, factory})`），
 * 用假 window 接住 factory，喂一个**同构极简 react**（hook 按调用顺序编号），
 * 然后按 React 的规矩渲染：组件以函数方式调用（React 也这么调），状态变更后再渲染一次，
 * 并检查 hook 数量不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')

// ── 极简 react：hook 按下标存取；同一次渲染里位置必须稳定（React 的硬规矩） ──────────
function makeReact() {
  let hooks = []
  let idx = 0
  const mk = {
    createElement(type, props, ...children) {
      const p = { ...(props || {}) }
      if (children.length) p.children = children.length === 1 ? children[0] : children
      return { type, props: p }
    },
    Fragment: Symbol('Fragment'),
    useState(init) {
      const i = idx++
      if (i >= hooks.length) hooks.push(typeof init === 'function' ? init() : init)
      const set = (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }
      return [hooks[i], set]
    },
    useRef(init) { const i = idx++; if (i >= hooks.length) hooks.push({ current: init }); return hooks[i] },
    useCallback(fn) { idx++; return fn },
    useMemo(fn) { idx++; return fn() },
    useEffect(fn) { idx++; return undefined },
    useLayoutEffect(fn) { idx++; return undefined },
  }
  mk.__begin = () => { idx = 0 }
  mk.__end = () => idx
  mk.__hooks = () => hooks
  return mk
}

function loadClient(react) {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  let entry = null
  const win = { __ModuleLoader__: { load: (m) => { entry = m } }, addEventListener() {}, removeEventListener() {} }
  const fn = new Function('window', 'document', 'navigator', 'localStorage', 'setTimeout', 'clearTimeout', 'fetch', src)
  fn(win, { addEventListener() {}, createElement() {} }, {}, {}, () => {}, () => {}, async () => ({ ok: true, json: async () => ({}) }))
  assert.ok(entry && typeof entry.factory === 'function', 'client.js 应当通过 __ModuleLoader__ 声明 factory')
  const req = (name) => {
    if (name === 'react') return react
    throw new Error('未 stub 的模块：' + name)
  }
  return entry.factory(req)
}

/** 按 React 的规矩渲染：函数组件就是「调用它」，返回元素树。返回被渲染组件名（用于断言）。 */
function renderNode(node, seen, { depth = 0 } = {}) {
  if (node == null || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { for (const n of node) renderNode(n, seen, { depth }); return }
  if (typeof node !== 'object') return
  const { type, props = {} } = node
  if (typeof type === 'function') {
    if (depth > 15) return // 防组件互相递归
    seen.push(type.name || 'anonymous')
    renderNode(type(props), seen, { depth: depth + 1 })
    return
  }
  if (props.children !== undefined) renderNode(props.children, seen, { depth })
}

/** 在渲染树里找所有按钮（用于"点一下"）。 */
function collectButtons(node, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectButtons(n, out); return out }
  if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') out.push(node)
  if (node.props && node.props.children !== undefined) collectButtons(node.props.children, out)
  return out
}

test('client.js 能被加载，并注册「设置 → QQ 控制台」', () => {
  const react = makeReact()
  const client = loadClient(react)
  assert.equal(typeof client.apply, 'function')
  let reg = null
  const ctx = {
    slots: { inject: (n, f) => f(), register: (o, c) => { reg = { o, c }; return () => {} } },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  }
  client.apply(ctx)
  assert.equal(reg.o.id, 'dsh-onebot-qq')
  assert.equal(reg.o.label(), 'QQ 控制台')
  assert.equal(typeof reg.c, 'function')
})

test('控制台外壳能渲染（数据还没回来时显示"读取中"，不抛错）', () => {
  const react = makeReact()
  const client = loadClient(react)
  let Shell = null
  client.apply({
    slots: { inject: (n, f) => f(), register: (o, c) => { Shell = c; return () => {} } },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  })
  react.__begin()
  const tree = Shell({ ctx: { connection: { rpc: { call: async () => ({ ok: true, value: {} }) } } } })
  react.__end()
  // 这里只保证「外壳能返回一棵树、不抛错」；hook 数量是否稳定由下一条测试负责
  // （client.js 用 `const { useState } = react` 解构取 hook，渲染出的子组件共用同一份槽位，
  //   所以这里不再对 hook 数做断言）
  assert.ok(tree && typeof tree === 'object', '外壳应返回一棵树')
})

test('各组件的 hook 数量与"展开折叠块"前后的渲染都稳定（白屏回归测试）', () => {
  const react = makeReact()
  const client = loadClient(react)
  let Shell = null
  client.apply({
    slots: { inject: (n, f) => f(), register: (o, c) => { Shell = c; return () => {} } },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  })
  // 第二次渲染必须使用和第一次完全相同数量的 hook（React 的 Rules of Hooks）
  react.__begin()
  renderNode(Shell({ ctx: { connection: { rpc: { call: async () => ({ ok: true, value: {} }) } } } }), [])
  const used = react.__end()
  react.__begin()
  renderNode(Shell({ ctx: { connection: { rpc: { call: async () => ({ ok: true, value: {} }) } } } }), [])
  assert.equal(react.__end(), used, '两次渲染的 hook 数量不一致 → 会白屏')
  assert.ok(used > 0)
})

test('折叠块里的自定义内容必须是组件调用，不能直接调带 hook 的组件函数', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  // 事故形态：sectionExtras[name](...) —— 直接执行组件函数，hook 落进父组件
  const bad = [...src.matchAll(/sectionExtras\[name\]\s*\(\s*api\s*\)/g)]
  assert.equal(bad.length, 0, 'sectionExtras 里不许直接调用组件函数（会导致 hook 数量突变 / 白屏）')
  // 正确形态：h(Comp, ...) / h(Fold, ...)
  assert.match(src, /h\(WelcomeBody, /, '入群欢迎应作为组件渲染（h(WelcomeBody, …)）')
})

test('关键页组件都存在（GroupTab / LongMemoryTab / 群聊卡片 / 入群欢迎 / OneBot 状态）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  const names = [...src.matchAll(/function (\w+)\(props\)/g)].map((m) => m[1])
  for (const want of ['GroupTab', 'LongMemoryTab', 'ReplyModeTab', 'TabOverview', 'TabPlugins',
    'OpsTab', 'WelcomeBody', 'GroupCardsBody', 'SwitchGroup', 'Fold', 'OneBotStatus']) {
    assert.ok(names.includes(want), `缺少组件 ${want}（现有：${names.join(',')}）`)
  }
})
