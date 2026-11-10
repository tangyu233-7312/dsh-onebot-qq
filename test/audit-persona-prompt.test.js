/**
 * test/audit-persona-prompt.test.js — 人设怎么进系统提示词（2026-11-10）。
 *
 * 背景：QQ 线的 system prompt 由 cordis.patch.yml 里 preset-qq-chat 的 persona.prefix 决定，
 * 人设文件本身不会自动进去（2026-11-09 实测 8 条会话 system 里一个「本鱼」都没有）。
 * 这里盯四件事：
 *   ① 骨架在 prefix 里（自称/语尾/句末不挂句号/禁忌）—— 轻量、每轮不到 400 字；
 *   ② prefix 指向三个文件 + read_persona 工具名（否则模型不知道去哪读）；
 *   ③ read_persona 解析的是**当前生效**人设（跟着 .persona.json 走，不会读到别的人设）；
 *   ④ 只读、最多三份、不认任意路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { personaFilesForRead, readPersonaFile } from '../plugins/persona-version/index.js'

const root = path.join(import.meta.dirname, '..')

test('PERSONA-PROMPT prefix：骨架在、指向三个文件、会调 read_persona', () => {
  const yml = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  const i = yml.indexOf('prefix: |-')
  assert.ok(i > 0, 'cordis.patch.yml 里应有 persona prefix')
  const block = yml.slice(i, yml.indexOf('- id: agent-instructions', i))
  for (const must of ['本鱼', '句末不挂', '客服腔', 'read_persona', 'AGENTS.local.md', 'lines.txt', 'wake.txt']) {
    assert.ok(block.includes(must), 'prefix 里应提到：' + must)
  }
  // 轻量：骨架段落不能被写成整篇人设（全文走 read_persona）
  assert.ok(block.length < 2000, 'prefix 不应塞整篇人设，当前 ' + block.length + ' 字符')
})

test('PERSONA-PROMPT 控制台开关：默认「骨架模式」（promptFull = false）', async () => {
  const { defaultConfig } = await import('../kernel/config-store.js')
  const cfg = defaultConfig()
  // 开关属于「人设版本」页（persona-version 插件），不塞进 dsh 段
  assert.equal(cfg.dsh.personaPromptMode, undefined, 'dsh 段里不该再留这个键')
  const pv = (await import('../plugins/persona-version/index.js')).default
  assert.equal(pv.configSchema.promptFull.default, false, '控制台开关默认关 = 骨架模式')
  assert.ok(pv.configSchema.promptFull.group === '人设版本', '开关要放在「人设版本」页')
})

test('PERSONA-PROMPT read_persona 只认三份、跟着生效人设走、不认任意路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-'))
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ws-'))
  fs.writeFileSync(path.join(dir, '蓝色大肥鱼.md'), '# 大肥鱼\n自称本鱼', 'utf8')
  fs.writeFileSync(path.join(dir, '祀.md'), '# 祀\n自称本座', 'utf8')
  fs.writeFileSync(path.join(dir, '蓝色大肥鱼.lines.txt'), '在吗', 'utf8')
  fs.writeFileSync(path.join(dir, '蓝色大肥鱼.wake.txt'), '大肥鱼', 'utf8')
  fs.writeFileSync(path.join(dir, '祀.lines.txt'), '？', 'utf8')

  // 生效人设 = 蓝色大肥鱼（指针文件决定）
  fs.writeFileSync(path.join(ws, '.persona.json'), JSON.stringify({ name: '蓝色大肥鱼', mode: 'copy' }), 'utf8')
  const files = personaFilesForRead({ personaDir: dir, workspaceDir: ws, activeName: '', which: 'md' })
  assert.equal(files.name, '蓝色大肥鱼', '应解析成当前生效的人设')
  assert.ok(files.file.endsWith('蓝色大肥鱼.md'))
  assert.ok(!files.file.endsWith('祀.md'), '不能读到另一个人设')

  const r = readPersonaFile({ personaDir: dir, workspaceDir: ws, which: 'md', maxBytes: 10000 })
  assert.equal(r.ok, true)
  assert.match(r.text, /自称本鱼/)
  assert.equal(r.which, 'md')

  // lines / wake 跟着同一个人设
  assert.match(readPersonaFile({ personaDir: dir, workspaceDir: ws, which: 'lines' }).text, /在吗/)
  assert.match(readPersonaFile({ personaDir: dir, workspaceDir: ws, which: 'wake' }).text, /大肥鱼/)

  // 非法 which 一律回落 md，不认任意路径
  const bad = readPersonaFile({ personaDir: dir, workspaceDir: ws, which: '../../etc/passwd' })
  assert.equal(bad.which, 'md')
  assert.ok(!bad.text.includes('root:'))

  // 指针指向另一个存在的人设 → 读的就跟过去
  fs.writeFileSync(path.join(ws, '.persona.json'), JSON.stringify({ name: '祀', mode: 'copy' }), 'utf8')
  assert.match(readPersonaFile({ personaDir: dir, workspaceDir: ws }).text, /自称本座/)
})
