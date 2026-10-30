/**
 * test/audit-voice-ui.test.js — 语音插件的控制台结构（2026-10-30）
 *
 * 用户要求：语音输出 / 唱歌 / 曲库 不该各占一个页签，它们本来就是同一个菜单。
 * 现在归到「语音与唱歌」一页，靠 section 分区折叠；「启用这个子插件」那个多余的总开关删掉
 * （三个分区各自有 ttsEnabled / singEnabled / autoLibrary）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import plugin from '../plugins/voice/index.js'

const schema = plugin.configSchema

test('三个分区合并成「语音与唱歌」一页（不再各占一个页签）', () => {
  const groups = new Set(Object.values(schema).map((v) => v.group))
  for (const g of ['语音输出', '唱歌', '曲库']) {
    assert.equal(groups.has(g), false, g + ' 不该再作为独立 group（那会多开一个页签）')
  }
  assert.ok(groups.has('语音与唱歌'), '合并后的页名')
})

test('同一页里靠 section 保持分区可读', () => {
  const secs = new Set(Object.values(schema).filter((v) => v.group === '语音与唱歌').map((v) => v.section))
  for (const s of ['语音输出', '唱歌', '曲库']) assert.ok(secs.has(s), '缺 section: ' + s)
})

test('多余的「启用这个子插件」总开关已删（分区各自有开关）', () => {
  assert.equal(schema.enabled, undefined, '不该再有插件级 enabled 开关')
  assert.ok(schema.ttsEnabled, '语音输出有自己的开关')
  assert.ok(schema.singEnabled, '唱歌有自己的开关')
  assert.ok(schema.autoLibrary, '曲库有自己的开关')
})

test('运维分区仍是独立 group（它不是功能，是依赖配置）', () => {
  const ops = Object.values(schema).filter((v) => v.group === '运维')
  assert.ok(ops.length >= 3, 'Python 路径 / RVC 目录 / Key 这些还在运维页')
})
