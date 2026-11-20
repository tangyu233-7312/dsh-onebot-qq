import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderClientPage, walkElements, textOfNode, bootSchema } from './client-fixture.mjs'

test('业务页显示各自的操作；点击重置先显示确认而不直接执行', async t => {
  const schema = await bootSchema(t)
  for (const [group, labels, reset] of [
    ['空间日记（看自己）', ['立刻让它回顾一次', '重置今日空间额度'], /重置今日空间额度/],
    ['自己找视频看', ['立刻看一个', '重置视频额度'], /重置视频额度/],
  ]) {
    const { tree, renderShell, requests } = renderClientPage({ tab: 'group:' + group, schema, click: reset })
    const buttons = []
    walkElements(tree, el => { if (el.type === 'button') buttons.push(textOfNode(el)) })
    for (const label of labels) assert.ok(buttons.some(s => s.includes(label)), group + ': ' + label)
    const confirm = schema.actions.find(a => reset.test(a.label)).confirm
    assert.ok(confirm?.title)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(textOfNode(renderShell()).includes(confirm.title), '点击后应进入确认弹窗')
    assert.equal(requests.some(args => args.some(value => value?.confirm === true)), false, '确认前不得发起实际重置')
  }
})
