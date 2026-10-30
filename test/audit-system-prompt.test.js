/**
 * test/audit-system-prompt.test.js — QQ 线的系统提示词（2026-10-30）
 *
 * 用户要把「家」（跟主人的私聊）当成它的总部：群里是感官，私聊是自我。
 * 系统提示词里必须说清这三件事，否则它会当成「客服在值班」：
 *   ① 家和群是两回事（私聊是家，群是被叫去的地方）
 *   ② 它可以自己决定做什么（不是每条都等指令）
 *   ③ 做过的事会写在「我今天的经历」那一行里（跨会话的自我）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const yml = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
const agents = fs.readFileSync(path.join(root, 'examples', 'qq-lines', 'AGENTS.md'), 'utf8')

test('系统提示词：说清「私聊是家、群是被叫去的地方」', () => {
  assert.match(yml, /私聊/, '要提到私聊')
  assert.match(yml, /家/, '要明说私聊是家')
  assert.match(yml, /总部/, '要明说私聊是总部/自我所在')
})

test('系统提示词：允许它自己决定，不是每条都等指令', () => {
  assert.match(yml, /自己决定|主动/, '要写「可以自己决定做什么」')
})

test('系统提示词：告诉它有「我今天的经历」这一行', () => {
  assert.match(yml, /我今天的经历/, '它得知道哪里看自己做过什么')
})

test('AGENTS.md 没被挤掉（人设以外的那部分行为纪律还在）', () => {
  assert.match(agents, /mcp__qq__send_message/)
  assert.match(agents, /主人/)
})
