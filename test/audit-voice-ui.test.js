/**
 * test/audit-voice-ui.test.js — 语音插件的控制台结构（2026-10-30）
 *
 * 用户要求：语音输出 / 唱歌 / 曲库 不该各占一个页签，它们本来就是同一个菜单。
 * 现在归到「语音与唱歌」一页，靠 section 分区折叠；「启用这个子插件」那个多余的总开关删掉
 * （三个分区各自有 ttsEnabled / singEnabled / autoLibrary）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import plugin from '../plugins/voice/index.js'

const root = path.join(import.meta.dirname, '..')

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

test('运维项也在这个页里（2026-10-30 从独立页签改成 section）', () => {
  // 原来 voice 的运维项（Python 路径 / RVC 目录 / Key / 音色模型）单独占「运维」页，
  // 用户要在两个页签之间来回找 —— 实测「音色模型文件名」根本找不到。
  // 现在它们和功能项同页，靠 section: '运维' 分成小块。
  const ops = Object.values(schema).filter((v) => v.section === '运维')
  assert.ok(ops.length >= 4, 'Python 路径 / RVC 目录 / Key / 音色模型 都在「运维」小节里')
  for (const k of ['ttsPython', 'rvcPython', 'rvcDir', 'singModel', 'apiKey']) {
    assert.ok(schema[k], '缺配置项：' + k)
    assert.equal(schema[k].section, '运维', k + ' 应归「运维」小节')
    assert.equal(schema[k].group, '语音与唱歌', k + ' 应在本页（不要另开页签）')
  }
})

test('音色模型名可配（不写死具体模型）', () => {
  const m = schema.singModel
  assert.ok(m, '要有 singModel 配置项')
  assert.equal(m.default, '', '默认留空 = 自动扫 voice-models/*.pth')
  // 源码里不许出现具体模型名（那是用户自己训练的，进公开仓库不合适）
  const src = fs.readFileSync(path.join(root, 'plugins', 'voice', 'index.js'), 'utf8')
  // 断言里也不写具体名字（否则等于自己泄露）。要守的是：源码不许把某个 .pth 写死。
  assert.equal(/\.pth['"]/.test(src), false, '源码里不该出现字面 .pth 文件名（应走 singModel / 自动扫目录）')
})
