import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderClientPage, textOfNode, countInputs, bootSchema } from './client-fixture.mjs'

test('语音、唱歌和曲库共用一个页面，展开后能修改运维配置', async t => {
  const schema = await bootSchema(t)
  const page = renderClientPage({ tab: 'group:语音与唱歌', schema }).tree
  for (const section of ['语音输出', '唱歌', '曲库']) assert.ok(textOfNode(page).includes(section), section)
  const opened = renderClientPage({ tab: 'group:语音与唱歌', schema, click: /运维/ }).tree
  assert.ok(countInputs(opened) > countInputs(page))
  assert.ok(textOfNode(opened).includes(schema.controls.find(c => c.key === 'voice.singModel').label))
})
