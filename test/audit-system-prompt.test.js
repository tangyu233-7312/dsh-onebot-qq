import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('随包会话指令告知模型真实出站与按需读人设工具', () => {
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const agents = fs.readFileSync(new URL('../examples/qq-lines/AGENTS.md', import.meta.url), 'utf8')
  assert.match(patch, /read_persona/)
  assert.match(agents, /mcp__qq__send_message/)
  assert.match(patch, /AGENTS\.local\.md/)
})
