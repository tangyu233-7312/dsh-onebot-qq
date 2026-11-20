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


test('切换全文/骨架模式真正改写 profile 模板，保留其余指令与备份', async t => {
  const plugin = (await import('../plugins/persona-version/index.js')).default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-prompt-mode-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dataDir = path.join(dir, 'data')
  const profile = path.join(dir, 'profiles', 'web')
  const personas = path.join(dataDir, 'personas')
  fs.mkdirSync(personas, { recursive: true }); fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(personas, 'fixture.md'), '# fixture persona\n唯一的人设正文')
  const target = path.join(profile, 'cordis.patch.yml')
  const template = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  fs.writeFileSync(target, template)
  const cfg = { enabled: true, promptFull: true }
  const bot = { cfg, core: { dataDir, paths: { personaDir: personas, workspaceDir: path.join(dataDir, 'workspace') } },
    personaLabel: 'fixture', shared: {}, registerTool() {}, currentTurn: () => null,
    log: { info() {}, warn() {}, error() {}, debug() {} } }
  plugin.setup(bot)
  const full = fs.readFileSync(target, 'utf8')
  assert.match(full, /唯一的人设正文/)
  cfg.promptFull = false; plugin.setup(bot)
  const skeleton = fs.readFileSync(target, 'utf8')
  assert.doesNotMatch(skeleton, /唯一的人设正文/)
  assert.match(skeleton, /read_persona/)
  const outside = s => s.replace(/# >>> persona-body:begin >>>[\s\S]*?# <<< persona-body:end <<</, '')
  assert.equal(outside(skeleton), outside(template), '生成区外不得改写')
  const backups = fs.readdirSync(profile).filter(f => f.startsWith('cordis.patch.yml.bak-'))
  assert.ok(backups.length > 0)
})
