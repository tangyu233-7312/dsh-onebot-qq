/**
 * test/long-memory-admin.test.js — 「记忆」页的后端契约（控制台 RPC 端点 mem + schema 控件）。
 *
 * 盯三件事：
 *   ① 控件都在 schema 里、key 是扁平 `long-memory.<字段>`、secret 字段不回显明文；
 *   ② 端点 mem 的每个 op 都能用（status/list/get/forget/restore/boost/export/import/organize/testLlm）；
 *   ③ 破坏性 op 要 confirm / 有备份；插件没加载时如实报错，不假装成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, ADMIN_QQ } from './helpers.mjs'
import { createAdminEndpoints } from '../admin/endpoints.js'
import { collectSchema } from '../admin/schema.js'

async function boot(t) {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'long-memory': { autoOrganize: false } } } })
  const api = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: { warn() {}, info() {}, debug() {}, error() {} } })
  t.after(() => h.dispose())
  return { h, api, lm: h.kernel.shared.longMemory }
}

test('schema：「记忆」页控件齐全，扁平 key，Key 不回显', async (t) => {
  const { h } = await boot(t)
  const schema = collectSchema(h.kernel, h.raw)
  const mine = schema.controls.filter((c) => c.plugin === 'long-memory')
  assert.ok(mine.length >= 20, `控件数=${mine.length}`)
  for (const c of mine) assert.match(c.key, /^long-memory\.[A-Za-z0-9]+$/, `key 要是扁平段：${c.key}`)
  const keys = mine.map((c) => c.field)
  for (const want of ['privateAll', 'privateInclude', 'groupsMode', 'groupsInclude', 'llmBaseUrl', 'llmApiKey', 'llmModel', 'orgainzePrompt'.replace('orgainze', 'organize'), 'topK', 'graceDays']) {
    assert.ok(keys.includes(want), `缺少控件 ${want}`)
  }
  const secret = mine.find((c) => c.field === 'llmApiKey')
  assert.equal(secret.secret, true, 'API Key 必须按 secret 处理')
  // group 落在「记忆」或「记忆（高级）」两页
  assert.ok(mine.every((c) => c.group === '记忆' || c.group === '记忆（高级）'))
  const info = schema.controls.find((c) => c.plugin === 'long-memory' && c.type === 'info')
  // info 块是纯说明（schema 聚合不换算它），它的“现状”由 `mem.status` 在页面上现算
  assert.equal(info, undefined)
})

test('mem：status / list / get / forget / restore / boost / export / import 全走通', async (t) => {
  const { api, lm } = await boot(t)
  const scope = `private:${ADMIN_QQ}`
  const s0 = await api.handle('mem', { op: 'status' })
  assert.equal(s0.ok, true)
  assert.equal(s0.entries, 0)
  assert.equal(s0.llm.configured, false, '没填接口时如实说未配置')

  const add = lm.store.add({ scope, text: '主人喜欢下雨天', importance: 0.7, tags: ['天气'] })
  const list = await api.handle('mem', { op: 'list' })
  assert.equal(list.ok, true)
  assert.equal(list.total, 1)
  assert.equal(list.items[0].id, add.id)

  const q = await api.handle('mem', { op: 'list', q: '下雨' })
  assert.equal(q.filtered, 1)
  const q0 = await api.handle('mem', { op: 'list', q: '不存在的词' })
  assert.equal(q0.filtered, 0)

  const one = await api.handle('mem', { op: 'get', id: add.id })
  assert.equal(one.ok, true)
  assert.ok(one.score && typeof one.score.score === 'number', '要给出“为什么会被想起来”的分项')

  assert.equal((await api.handle('mem', { op: 'forget', id: add.id })).ok, true)
  assert.equal((await api.handle('mem', { op: 'list' })).total, 0, '忘掉后默认列表里看不到')
  assert.equal((await api.handle('mem', { op: 'list', forgotten: true })).total, 1, '勾选“看已遗忘的”能看到')
  assert.equal((await api.handle('mem', { op: 'restore', id: add.id })).ok, true)

  assert.equal((await api.handle('mem', { op: 'boost', id: add.id, importance: 0.95 })).ok, true)
  assert.equal(lm.store.get(add.id).importance, 0.95)
  assert.equal((await api.handle('mem', { op: 'boost', id: add.id, importance: 3 })).ok, false, '越界要拒绝')

  const ex = await api.handle('mem', { op: 'export', format: 'json' })
  assert.equal(ex.ok, true)
  const im = await api.handle('mem', { op: 'import', text: JSON.stringify([{ scope, text: '饭点到了要吃饭', importance: 0.4 }]) })
  assert.equal(im.ok, true)
  assert.equal(im.added, 1)
  assert.equal(lm.store.size(), 2)
})

test('mem：purge 先备份；organize 要 confirm；没配接口时 organize 如实失败', async (t) => {
  const { api, lm } = await boot(t)
  const scope = `private:${ADMIN_QQ}`
  const add = lm.store.add({ scope, text: '这条要被彻底删除', importance: 0.5 })
  const p = await api.handle('mem', { op: 'purge', id: add.id })
  assert.equal(p.ok, true)
  assert.equal(lm.store.get(add.id), null)
  const files = lm.store.files()
  assert.ok(files.some((f) => f.name === '.revisions'), '彻底删除前要落备份目录')

  const noConfirm = await api.handle('mem', { op: 'organize' })
  assert.equal(noConfirm.ok, false, '没 confirm 不许花 token')
  const r = await api.handle('mem', { op: 'organize', confirm: true })
  assert.equal(r.ok, true)
  // 没有留档 → 没有要处理的会话；即便有也不会成功（接口没配）
  assert.ok(r.result && Array.isArray(r.result.failed))

  const test1 = await api.handle('mem', { op: 'testLlm' })
  assert.equal(test1.ok, false)
  assert.match(String(test1.reason || ''), /没填全/)
})

test('mem：未知 op 明确报错；插件没加载时不假装成功', async (t) => {
  const { h, api } = await boot(t)
  assert.equal((await api.handle('mem', { op: 'nope' })).ok, false)
  delete h.kernel.shared.longMemory
  const r = await api.handle('mem', { op: 'status' })
  assert.equal(r.ok, false)
  assert.match(String(r.error || ''), /没加载/)
})

test('schema 的 set 能热写存储范围（改完下一轮注入就按新范围走）', async (t) => {
  const { h, api, lm } = await boot(t)
  const r = await api.handle('set', { key: 'long-memory.groupsMode', value: 'list' })
  assert.equal(r.ok, true, String(r.error || ''))
  const r2 = await api.handle('set', { key: 'long-memory.groupsInclude', value: ['20001'] })
  assert.equal(r2.ok, true, String(r2.error || ''))
  // 热改：插件的 cfg 由控制台原地同步；这里直接断言运行时读到的值变了
  await new Promise((res) => setTimeout(res, 50))
  const plug = h.kernel.plugins.find((p) => (p.id || p.plugin?.id) === 'long-memory')
  assert.equal(String(plug.cfg.groupsMode), 'list')
  assert.deepEqual(plug.cfg.groupsInclude.map(String), ['20001'])
  assert.equal(lm.scopeAllowed('group:20001'), true)
  assert.equal(lm.scopeAllowed('group:99999'), false)
})
