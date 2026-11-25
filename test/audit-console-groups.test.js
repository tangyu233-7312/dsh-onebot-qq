import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bootKernel } from './helpers.mjs'
import { collectSchema, readValue } from '../admin/schema.js'

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

// ── 2026-11-25：「多久看一次」改分钟口径 ───────────────────
test('自己找视频看：间隔是分钟控件（能在面板上填 20 分钟）', () => {
  const c = schema.controls.find((x) => x.key === 'video-wander.everyMinutes')
  assert.ok(c, '面板上应有 video-wander.everyMinutes')
  assert.equal(c.unit, '分钟')
  assert.equal(c.default, 240)
  assert.ok(c.min <= 20 && c.max >= 20, '范围要允许 20 分钟（min=' + c.min + '）')
  assert.equal(schema.controls.some((x) => x.key === 'video-wander.everyHours'), false,
    '旧的整小时控件不该继续挂在面板上（会和分钟项冲突）')
})

test('自己找视频看：长视频分档两个控件在面板上（帧数 + 多长算长视频）', () => {
  const long = schema.controls.find((x) => x.key === 'video-wander.framesLong')
  const split = schema.controls.find((x) => x.key === 'video-wander.framesSplitMin')
  assert.ok(long, '面板应有「长视频抽几帧」')
  assert.ok(split, '面板应有「多长算"长视频"」')
  assert.equal(long.unit, '帧')
  assert.equal(long.default, 12)
  assert.ok(long.max >= 12, '上限要容得下 12 帧')
  assert.equal(split.unit, '分钟')
  assert.equal(split.default, 10)
  // 短视频那一项要改名，否则两栏都叫「抽几帧」分不清
  assert.equal(schema.controls.find((x) => x.key === 'video-wander.frames').label, '短视频抽几帧')
})

test('自己找视频看：没配过间隔时面板显示默认 240 分钟', () => {
  // 面板读的是内核 buildPluginCfg 的产物（storedValue 的回落值）：这条实例 raw 里没有
  // everyHours 也没有 everyMinutes，所以应是 schema 默认 240。
  const def = h.kernel.pluginDefs.find((d) => d.id === 'video-wander')
  assert.ok(def)
  assert.equal(def.cfg.everyMinutes, 240)
  assert.equal(readValue(h.kernel, 'video-wander.everyMinutes', h.raw), 240)
})

test('自己找视频看：老配置 everyHours=1 面板读成 60 分钟（走真实 readValue）', async () => {
  // 走完整装配：raw 里只写旧键，内核 buildPluginCfg 迁移后，面板必须读到 60 而不是 240。
  const h2 = await bootKernel({
    config: { pluginConfig: { 'video-wander': { enabled: true, everyHours: 1 } } },
  })
  try {
    assert.equal(readValue(h2.kernel, 'video-wander.everyMinutes', h2.raw), 60,
      '面板要显示迁移后的 60，不能退回默认 240')
  } finally { h2.dispose() }
})
