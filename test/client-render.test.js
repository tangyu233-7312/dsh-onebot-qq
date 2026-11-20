import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeShellReact, loadClient, renderClientPage, findElement, textOfNode, countInputs, bootSchema } from './client-fixture.mjs'

test('控制台能注册到设置入口，数据未到时能显示加载状态', () => {
  const react = makeShellReact({ shell: [] })
  const client = loadClient(react)
  let registration
  const ctx = {
    slots: { inject: (_, fn) => fn(), register: (options, component) => { registration = { options, component } } },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  }
  client.apply(ctx)
  assert.equal(registration.options.label(), 'QQ 控制台')
  const element = registration.component({ ctx })
  react.__shell()
  const tree = element.type(element.props)
  react.__other()
  assert.match(textOfNode(tree), /读取中|加载中/)
})

test('主动接话高级设置点击后真正显示；入群欢迎页面可展开渲染', async t => {
  const schema = await bootSchema(t)
  const collapsed = renderClientPage({ tab: 'group:主动接话', schema }).tree
  assert.equal(countInputs(collapsed), 0)
  const opened = renderClientPage({ tab: 'group:主动接话', schema, click: /^[▸▾] 高级/ }).tree
  const advanced = schema.controls.filter(c => c.group === '主动接话' && c.advanced)
  assert.ok(advanced.length > 0)
  assert.ok(countInputs(opened) >= advanced.length)
  for (const c of advanced) assert.ok(textOfNode(opened).includes(c.label), c.key)
  const welcome = renderClientPage({ tab: 'group:群聊', schema, click: /入群欢迎/ }).tree
  assert.ok(findElement(welcome, n => n.type === 'input' || n.type === 'textarea'))
})
