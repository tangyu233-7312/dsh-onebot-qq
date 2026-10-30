/**
 * test/audit-private-gap.test.js — 私聊「两次之间至少隔多久」只能有一项（2026-10-30）
 *
 * 踩过：同时存在 privateMinGapMs（分钟）和 privateMinHourGap（小时），代码取更严的那个。
 * 用户在控制台改了 60 分钟，实际仍按 2 小时走 —— 「改了没生效」最难查的一类。
 * 现在合并成 privateMinGapMs 一项，这条测试盯着别再拆开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { collectSchema } from '../admin/schema.js'
import { bootKernel, tmpDir } from './helpers.mjs'

const root = path.join(import.meta.dirname, '..')

test('控制台「私聊主动接话」里只有一个间隔项', async () => {
  const env = await bootKernel({ dataDir: tmpDir('gap'), config: { archive: { enabled: false } } })
  try {
    const s = collectSchema(env.kernel, { pacing: { reply: {} } })
    const priv = (s.controls || []).filter((c) => c.group === '主动接话' && c.section === '私聊主动接话')
    const gaps = priv.filter((c) => /MinGap|MinHourGap|间隔/.test(c.key + c.label))
    assert.equal(gaps.length, 1, '间隔只能有一项，实际：' + gaps.map((g) => g.key).join(','))
    assert.match(gaps[0].key, /privateMinGapMs$/, '保留分钟那一项')
  } finally { env.dispose() }
})

test('源码里不再有 privateMinHourGap 的读取', () => {
  const src = fs.readFileSync(path.join(root, 'kernel', 'pacing.js'), 'utf8')
  // 注释里可以提到，但代码里不能读取
  const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//'))
  const hits = codeLines.filter((l) => l.includes('privateMinHourGap'))
  assert.deepEqual(hits, [], '还在读 privateMinHourGap：' + hits.join(' | '))
})

test('默认 60 分钟（不是 3 小时也不是 2 小时）', async () => {
  const env = await bootKernel({ dataDir: tmpDir('gap2'), config: { archive: { enabled: false } } })
  try {
    const s = collectSchema(env.kernel, { pacing: { reply: {} } })
    const item = (s.controls || []).find((c) => c.key === 'pacing.reply.privateMinGapMs')
    assert.ok(item, '这一项必须存在')
    assert.equal(item.default, 3600000, '默认 1 小时')
    assert.equal(item.scale, 60000, '面板按分钟显示')
  } finally { env.dispose() }
})
