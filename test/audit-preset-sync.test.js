/**
 * test/audit-preset-sync.test.js — preset 示例必须与随包声明保持一致（2026-10-30）
 *
 * 踩过：根 cordis.patch.yml 的系统提示词改成「群是感官，私聊是自我」之后，
 * examples/presets/qq-chat.patch.yml 里还是旧的「You are a QQ chat assistant」。
 * 手动安装（不用 bundle）的人会拿到旧人格 —— 两边必须同步。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const prefixOf = (text) => {
  const m = text.match(/\n\s+prefix: \|-([\s\S]*?)(?=\n\s+-\s|\n\s{0,4}\S)/)
  return m ? m[1].trim() : ''
}

test('examples/presets 的 prefix 与根 cordis.patch.yml 一致', () => {
  const a = prefixOf(read('cordis.patch.yml'))
  const b = prefixOf(read('examples/presets/qq-chat.patch.yml'))
  assert.ok(a.length > 0, '根文件里要有 prefix')
  assert.equal(b, a, '两边系统提示词分叉了：改一边要同步另一边')
})

test('系统提示词的核心口径没被改掉（群是感官、私聊是自我）', () => {
  const p = prefixOf(read('cordis.patch.yml'))
  assert.match(p, /你的家/, '私聊是家')
  assert.match(p, /我今天的经历/, '跨会话流水账那一行')
})
