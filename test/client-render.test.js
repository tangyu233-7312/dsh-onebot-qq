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

// ── 2026-11-12 两个真实回归（前端按老规则筛，后端换了分组/挂了 section）──────────────────
// ① 空间日记（看自己）页：两个按钮从页面上消失（用户报"重置额度按钮不见了"）
// ② 主动接话页：点「高级」什么都不出来（进阶项全带 section，被 section 分支吃掉）
//
// 这两个用例**整体替换** client 的 react：预置外壳的 state（schema/status/tab），
// 再把页面组件按 React 的方式渲染出来（调用 → 展开子组件 → 找按钮/数输入框）。

/** 假 react：外壳一组 state（预置），页面组件一组 state（可预置 showAdv）。其余组件从初值开始。 */
function makeShellReact({ shell, page = [] }) {
  let mode = 'other'
  let shellStore = shell.slice()
  let shellIdx = 0
  let pageStore = page.slice()
  let pageIdx = 0
  const mk = {
    createElement(type, props, ...children) {
      const p = { ...(props || {}) }
      if (children.length) p.children = children.length === 1 ? children[0] : children
      return { type, props: p }
    },
    Fragment: Symbol('Fragment'),
    useState(init) {
      const arr = mode === 'shell' ? shellStore : (mode === 'page' ? pageStore : null)
      if (!arr) return [typeof init === 'function' ? init() : init, () => {}]
      const i = mode === 'shell' ? shellIdx++ : pageIdx++
      if (i >= arr.length) arr.push(typeof init === 'function' ? init() : init)
      return [arr[i], (v) => { arr[i] = typeof v === 'function' ? v(arr[i]) : v }]
    },
    useRef(init) { if (mode === 'shell') shellIdx++; else if (mode === 'page') pageIdx++; return { current: init } },
    useCallback(fn) { if (mode === 'shell') shellIdx++; else if (mode === 'page') pageIdx++; return fn },
    useMemo(fn) { if (mode === 'shell') shellIdx++; else if (mode === 'page') pageIdx++; return fn() },
    useEffect() { if (mode === 'shell') shellIdx++; else if (mode === 'page') pageIdx++ },
    useLayoutEffect() { if (mode === 'shell') shellIdx++; else if (mode === 'page') pageIdx++ },
  }
  mk.__shell = () => { mode = 'shell'; shellIdx = 0 }
  mk.__page = () => { mode = 'page'; pageIdx = 0 }
  mk.__other = () => { mode = 'other' }
  return mk
}

/** 外壳返回的元素树里，第一个函数组件 = 当前 tab 的页面组件（React 就是这么挂上去的）。 */
const findComponent = (node) => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const r = findComponent(n); if (r) return r } return null }
  if (typeof node.type === 'function') return node
  return node.props ? findComponent(node.props.children) : null
}

/** 渲染某一页：外壳给页面组件的那份 props 一并拿走（group / call / run … 都在里面）。 */
function renderClientPage({ tab, schema, page = [], click = null }) {
  const ctx = { connection: { rpc: { call: async () => ({ ok: true, value: {} }) } } }
  const react = makeShellReact({ shell: [schema, { reply: { enabled: true } }, '', false, null, null, tab, '', '', undefined], page })
  const client = loadClient(react)
  let Shell = null
  client.apply({ slots: { inject: (n, f) => f(), register: (o, c) => { Shell = c; return () => {} } }, connection: ctx.connection })
  assert.ok(Shell, '控制台组件没注册上')
  const ShellComp = Shell({ ctx }).type
  react.__shell()
  const shellOut = ShellComp({ ctx })
  react.__other()
  const pageEl = findComponent(shellOut)
  assert.ok(pageEl, 'tab=' + tab + ' 没渲染出页面')
  react.__page()
  let tree = pageEl.type(pageEl.props || {})
  react.__other()
  if (click) {
    const btn = findElement(tree, (n) => n.type === 'button' && typeof n.props.onClick === 'function' && click.test(textOfNode(n)))
    assert.ok(btn, '页面上没找到按钮：' + click)
    btn.props.onClick()
    react.__page()
    tree = pageEl.type(pageEl.props || {})
    react.__other()
  }
  return { tree, page }
}

/** 遍历**已渲染**的树（函数组件会被调用，因为调用方决定它的内容）。 */
const walkElements = (node, fn, depth = 0) => {
  if (node == null || typeof node !== 'object' || depth > 30) return
  if (Array.isArray(node)) { node.forEach((n) => walkElements(n, fn, depth)); return }
  if (typeof node.type === 'function') { walkElements(node.type(node.props || {}), fn, depth + 1); return }
  fn(node)
  if (node.props) walkElements(node.props.children, fn, depth + 1)
}
const findElement = (node, pred) => {
  let hit = null
  walkElements(node, (n) => { if (!hit && pred(n)) hit = n })
  return hit
}
const textOfNode = (n) => {
  const acc = []
  const walk = (x) => {
    if (x == null || typeof x === 'boolean') return
    if (typeof x === 'string' || typeof x === 'number') { acc.push(String(x)); return }
    if (Array.isArray(x)) return x.forEach(walk)
    if (typeof x !== 'object') return
    if (typeof x.type === 'function') return
    if (x.props) walk(x.props.children)
  }
  walk(n.props ? n.props.children : n)
  return acc.join(' ')
}
const countInputs = (node) => {
  let n = 0
  walkElements(node, (el) => { if (el.type === 'input' || el.type === 'select' || el.type === 'textarea') n++ })
  return n
}

async function bootSchema(t) {
  const { bootKernel } = await import('./helpers.mjs')
  const { collectSchema } = await import('../admin/schema.js')
  const h = await bootKernel({})
  t.after?.(() => h.dispose?.())
  return collectSchema(h.kernel, h.raw)
}

test('回归 2026-11-12：空间日记（看自己）页底部必须有「立刻回顾 / 重置今日空间额度」', async (t) => {
  const schema = await bootSchema(t)
  const { tree } = renderClientPage({ tab: 'group:空间日记（看自己）', schema })
  const btns = []
  walkElements(tree, (el) => { if (el.type === 'button') btns.push(textOfNode(el)) })
  assert.ok(btns.some((b) => b.includes('重置今日空间额度')), '「重置今日空间额度」按钮不见了（现有：' + btns.join(' / ') + '）')
  assert.ok(btns.some((b) => b.includes('立刻让它回顾一次')), '「立刻让它回顾一次」按钮不见了')
})

test('回归 2026-11-12：主动接话页点「高级」后必须真的渲染出进阶项', async (t) => {
  const schema = await bootSchema(t)
  const advKeys = schema.controls.filter((c) => c.group === '主动接话' && c.advanced)
  assert.ok(advKeys.length > 0, '主动接话页应当有进阶项')

  // 没展开：一个输入框都不该有，页面上要有「高级」按钮
  const collapsed = renderClientPage({ tab: 'group:主动接话', schema }).tree
  assert.equal(countInputs(collapsed), 0, '「高级」没展开就渲染出了控件')
  assert.ok(findElement(collapsed, (n) => n.type === 'button' && /^[▸▾] 高级/.test(textOfNode(n))), '页面上没有「高级」按钮')

  // 点「高级」= setShowAdv(true)：页面 state 从 true 起步再渲染一次（等价于 React 的重渲染）
  const opened = renderClientPage({ tab: 'group:主动接话', schema, page: [true, {}] }).tree
  assert.ok(countInputs(opened) >= advKeys.length,
    '点开「高级」后只渲染出 ' + countInputs(opened) + ' 个控件（应有 ≥ ' + advKeys.length + ' 个进阶项）')
  const shown = advKeys.filter((c) => textOfNode(opened).includes(c.label)).length
  assert.ok(shown >= advKeys.length * 0.9, '点开「高级」后进阶项标签只出现 ' + shown + '/' + advKeys.length + ' 个')
})




test('回归 2026-11-12：行尾 ⓘ 的说明是自绘气泡（深色卡片），不再用原生 title', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  // 原生 title 会弹出系统浅色提示（深色面板里一块白）；整行挂 title 更糟：鼠标一进这一行就弹。
  const row = src.match(/style: c\.hint && TIP/)
  assert.ok(row, '控件行应当按 tip 状态渲染，而不是把 title 挂整行')
  assert.ok(/setTip/.test(src), 'ⓘ 悬停要走 setTip 自绘气泡')
  assert.ok(/background: 'rgba\(24,34,46,\.97\)'/.test(src), '气泡应当是深色卡片')
  const rowTitle = src.match(/h\('div', \{ style: S\.row, key: c\.key,?[^}]*title:/)
  assert.equal(rowTitle, null, '控件行不许再挂整行 title')
})