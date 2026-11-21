import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bootKernel } from './helpers.mjs'
import { collectSchema } from '../admin/schema.js'

let h, schema
before(async () => {
  h = await bootKernel({})
  schema = collectSchema(h.kernel, h.raw)
})
after(() => h?.dispose())

test('控制台导航：关键设置能在对应业务页找到，旧独立页不再分散入口', () => {
  const locations = [
    ['outbound.replyMaxLength', '人设与语气', '消息设置'],
    ['pacing.merge.enabled', '人设与语气', '消息设置'],
    ['persona-voice.quoteEnforce', '人设与语气', '句池'],
    ['gate-wake.keywords', '人设与语气', '唤醒'],
    ['gate-wake.groupFollowUpMs', '人设与语气', '唤醒'],
    ['gate-wake.adminQq', '其他'],
    ['commands.enabled', '群聊'],
    ['file-transfer.uploadDir', '文件与图片', '开关与收件目录'],
    ['file-transfer.imageWhitelist', '文件与图片', '发图'],
    ['file-read.uploadDir', '文件与图片', '读文件（read_file）'],
    ['media-context.groupEnabled', '文件与图片', '群聊历史图片'],
    ['media-context.cacheHours', '文件与图片', '图片缓存（群聊与私聊）'],
    ['media-context.cacheCleanupTime', '文件与图片', '图片缓存（群聊与私聊）'],
    ['device-time.enabled', '其他', '设备时间'],
    ['credentials.gptImage.apiKey', '生图'],
  ]
  for (const [key, group, section] of locations) {
    const matches = schema.controls.filter(c => c.key === key)
    assert.equal(matches.length, 1, key + ' 入口应唯一')
    assert.equal(matches[0].group, group, key)
    if (section) assert.equal(matches[0].section, section, key)
  }
  const groups = schema.groups.map(g => g.name)
  for (const old of ['回话细节', '回话模式', '消息设置', '唤醒', '能力', 'OneBot 连接']) {
    assert.equal(groups.includes(old), false, old)
  }
})

test('控制台可操作性：控件有帮助，凭据不重复，隐藏功能不作为可写开关暴露', () => {
  assert.deepEqual(schema.controls.filter(c => c.type !== 'info' && !c.hint?.trim()).map(c => c.key), [])
  assert.equal(schema.controls.find(c => c.key === 'credentials.gptImage.apiKey').secret, true)
  assert.equal(schema.controls.some(c => c.key === 'stickers.tagging'), false)
  assert.equal(schema.controls.some(c => c.key.includes('continuation')), false)
  const info = schema.controls.find(c => c.key === 'info.fileStore')
  assert.ok(info.text.includes('read_file'))
  assert.ok(/[\\/]/.test(info.text), '收件位置应给出实际路径')
})
