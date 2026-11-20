import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const ROOT = path.join(import.meta.dirname, '..')
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

function makeShellReact({ shell, page = [] }) {
  let mode = 'other'
  let shellStore = shell.slice()
  let shellIdx = 0
  let pageStore = page.slice()
  let pageIdx = 0
  const components = new Map()
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
  mk.__component = (key, render) => {
    const saved = { mode, pageStore, pageIdx }
    if (!components.has(key)) components.set(key, [])
    mode = 'page'; pageStore = components.get(key); pageIdx = 0
    try { return render() } finally {
      mode = saved.mode; pageStore = saved.pageStore; pageIdx = saved.pageIdx
    }
  }
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
  const requests = []
  const ctx = { connection: { rpc: { call: async (...args) => {
    requests.push(args)
    return { ok: true, value: {} }
  } } } }
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
  const expand = (node, key = 'root') => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((n, i) => expand(n, key + '/' + (n?.props?.key ?? i)))
    if (typeof node.type === 'function') {
      return expand(react.__component(key + ':' + node.type.name, () => node.type(node.props || {})), key + '/body')
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, key + '/children') } }
  }
  react.__page()
  let tree = pageEl.type(pageEl.props || {})
  react.__other()
  tree = expand(tree)
  if (click) {
    const btn = findElement(tree, (n) => n.type === 'button' && typeof n.props.onClick === 'function' && click.test(textOfNode(n)))
    assert.ok(btn, '页面上没找到按钮：' + click)
    btn.props.onClick()
    react.__page()
    tree = pageEl.type(pageEl.props || {})
    react.__other()
    tree = expand(tree)
  }
  return { tree, page, requests, renderShell() {
    react.__shell()
    const shell = ShellComp({ ctx })
    react.__other()
    return shell
  } }
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
    if (typeof x.type === 'function') return walk(x.type(x.props || {}))
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


export { makeShellReact, loadClient, renderClientPage, walkElements, findElement, textOfNode, countInputs, bootSchema }
