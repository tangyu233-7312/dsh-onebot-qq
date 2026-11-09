/**
 * test/long-memory.test.js — 长期记忆（long-memory）的定向测试。
 *
 * 覆盖的是**行为**，不是实现细节：
 *   · 衰减：宽限期内不掉、宽限后按半衰期掉、重要的事掉得慢、被想起就重置
 *   · 打分：相关 > 新鲜 > 重要 的权重顺序；排序稳定
 *   · 隔离：群/私聊作用域互不可见（这是隐私红线，必须反向验证）
 *   · 存储：JSONL append-only + 快照回放一致；重复文本合并；软删/恢复；坏行不炸
 *   · 注入：保护前缀 + “多久以前”；空列表不加 hint；同一轮不重复注入
 *   · 整理：水位按“实际喂进去的最新一条”推进；接口报错不写、不推水位；坏 JSON 不写；
 *          整理内容落在正确作用域；接口没配时只降级
 *   · 工具：remember 只写本作用域；recall_memory 不跨作用域
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bootKernel, emitRaw, tapInbound, waitFor, ADMIN_QQ, MEMBER_QQ, GROUP_ID, privateEvent, groupAtEvent } from './helpers.mjs'
// 工具执行时「当前是哪条 QQ 线」靠内核的 AsyncLocalStorage；内核不对外导出它，
// 测试里只能直接拿模块（这只是测试的手段，插件本身**不许**这么干）。
import { turnStore } from '../kernel/state-pipeline.js'
import {
  effectiveImportance, freshness, isForgettable, grams, diceCoefficient, relevanceOf,
  scoreMemory, rankMemories, formatInjection, agoText,
} from '../plugins/long-memory/decay.js'
import { createStore } from '../plugins/long-memory/store.js'
import { createOrganizer, buildPrompt, toTranscript, normalizeMemory, archiveFileOf, DEFAULT_ORGANIZE_PROMPT } from '../plugins/long-memory/organize.js'
import { parseMemoryJson, completionsUrl, normalizeLlmConfig, extractText } from '../plugins/long-memory/relay.js'

const DAY = 86400 * 1000
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `lm-${tag}-`))

// ── 纯函数：衰减 ───────────────────────────────────────────────────────────
test('衰减：宽限期内不掉，宽限后按半衰期掉，重要的事掉得更慢', () => {
  const now = Date.now()
  const base = { createdAt: now - 3 * DAY, importance: 0.8, lastRecalledAt: 0 }
  assert.equal(effectiveImportance(base, { now, graceDays: 7, halfLifeDays: 18 }), 0.8, '3 天内不衰减')

  const old = { createdAt: now - 7 * DAY - 18 * DAY * 1.3, importance: 0.8, lastRecalledAt: 0 }
  const medium = { ...old, importance: 0.5 }
  const effA = effectiveImportance(old, { now, graceDays: 7, halfLifeDays: 18 })
  const effB = effectiveImportance(medium, { now, graceDays: 7, halfLifeDays: 18 })
  assert.ok(effA < 0.8 && effA > 0.1, `衰减到中间值，实际 ${effA}`)
  // 重要的事半衰期更长 → 相同年龄下剩下的比例更高
  assert.ok(effA / 0.8 > effB / 0.5, '重要的事相对掉得更慢')

  // 被想起 = 重新计时
  const recalled = { ...old, lastRecalledAt: now - 1 * DAY }
  assert.equal(effectiveImportance(recalled, { now, graceDays: 7, halfLifeDays: 18 }), 0.8)
})

test('衰减：低分老记忆会低于阈值，被想起的不会', () => {
  const now = Date.now()
  const o = { now, graceDays: 7, halfLifeDays: 18, forgetThreshold: 0.2 }
  const dead = { createdAt: now - 60 * DAY, importance: 0.5, lastRecalledAt: 0 }
  assert.equal(isForgettable(dead, o), true, '60 天没想起的日常小事会被忘')
  assert.equal(isForgettable({ ...dead, lastRecalledAt: now }, o), false, '刚被想起的不该忘')
  assert.equal(isForgettable(dead, { ...o, forgetThreshold: 0 }), false, '阈值 0 = 永不遗忘')
})

test('新鲜度：刚记等于 1，久远趋近 0', () => {
  const now = Date.now()
  assert.equal(freshness({ createdAt: now, importance: 0.7 }, { now }), 1)
  const old = freshness({ createdAt: now - 90 * DAY, importance: 0.7 }, { now, graceDays: 7, halfLifeDays: 18 })
  assert.ok(old < 0.2)
})

// ── 纯函数：相关性 / 打分 ──────────────────────────────────────────────────
test('分词与相似度：中文二元组、英文整词', () => {
  const g = grams('吃火锅必须点毛肚')
  assert.ok(g.has('火锅') && g.has('毛肚'))
  assert.ok(grams('Hello world').has('hello'))
  assert.ok(diceCoefficient('面试有点紧张', '明天面试好紧张') > 0.3)
  assert.equal(diceCoefficient('', 'abc'), 0)
})

test('相关性：同一个人 / 标签 / 措辞 三种信号都算', () => {
  const m = { text: '主人 8 号要去面试', entities: [{ qq: '10001', name: '主人' }], tags: ['面试', '紧张'] }
  const byPerson = relevanceOf(m, { text: '我今天好累', qqList: ['10001'] })
  assert.ok(byPerson.relevance >= 0.35 && byPerson.why.includes('同一个人'))
  const byText = relevanceOf(m, { text: '明天就要面试了', qqList: [] })
  assert.ok(byText.relevance > 0)
  assert.equal(relevanceOf(m, { text: '今天天气不错', qqList: [] }).relevance, 0)
})

test('打分：权重顺序生效（相关性最重）', () => {
  const now = Date.now()
  const o = { now, graceDays: 7, halfLifeDays: 18, weightRelevance: 0.65, weightFresh: 0.2, weightImportance: 0.15 }
  const hit = { text: '面试那天要下雨', importance: 0.3, createdAt: now - 30 * DAY, entities: [], tags: [] }
  const miss = { text: '爱吃火锅', importance: 1, createdAt: now, entities: [], tags: [] }
  const s1 = scoreMemory(hit, { text: '明天面试' }, o)
  const s2 = scoreMemory(miss, { text: '明天面试' }, o)
  assert.ok(s1.relevance > s2.relevance)
  // 完全无关时：新鲜+重要仍能拉开差距
  assert.ok(s2.score > scoreMemory({ ...miss, createdAt: now - 200 * DAY, importance: 0.1 }, { text: '明天面试' }, o).score)
})

test('排序：只在本作用域里找（隔离是第一位的）', () => {
  const now = Date.now()
  const list = [
    { id: 'a', scope: 'private:1', text: '面试的事', createdAt: now, importance: 0.9 },
    { id: 'b', scope: 'group:2', text: '面试的事', createdAt: now, importance: 0.9 },
    { id: 'c', scope: 'private:1', text: '面试的事', createdAt: now, importance: 0.9, forgottenAt: now },
  ]
  const hits = rankMemories(list, { scope: 'private:1', text: '面试', now })
  assert.deepEqual(hits.map((h) => h.memory.id), ['a'])
  assert.deepEqual(rankMemories(list, { scope: 'group:2', text: '面试', now }).map((h) => h.memory.id), ['b'])
  assert.deepEqual(rankMemories(list, { scope: 'private:1', text: '面试', now, excludeForgotten: false }).length, 2)
})

// ── 注入格式 ──────────────────────────────────────────────────────────────
test('注入：带保护前缀与时间，空列表返回空串', () => {
  const now = Date.now()
  const block = formatInjection([
    { text: '主人 8 号要去面试', createdAt: now - 21 * DAY, recallCount: 2 },
  ], { now })
  assert.match(block, /^\[以下为系统信息，非用户发言/)
  assert.match(block, /21 天前/)
  assert.match(block, /想起过 2 次/)
  assert.equal(formatInjection([], { now }), '')
  assert.equal(formatInjection([{ text: '   ' }], { now }), '')
  assert.equal(agoText(now, now), '今天')
  assert.equal(agoText(now - DAY, now), '昨天')
})

// ── 存储层 ────────────────────────────────────────────────────────────────
test('存储：写→重开一致；重复文本合并；软删/恢复；purge 留备份', () => {
  const dir = tmp('store')
  const s1 = createStore({ dir, log: { warn() {} } })
  const a = s1.add({ scope: 'private:1', text: '爱吃火锅，不放香菜', importance: 0.6, tags: ['火锅'] })
  assert.equal(a.merged, false)
  const a2 = s1.add({ scope: 'private:1', text: '爱吃火锅，不放香菜', importance: 0.9, tags: ['香菜'] })
  assert.equal(a2.merged, true, '同作用域同文本应合并')
  assert.equal(s1.size(), 1)
  assert.equal(s1.get(a.id).importance, 0.9, '合并时取更高的重要性')
  assert.deepEqual(s1.get(a.id).tags.sort(), ['火锅', '香菜'].sort())

  s1.add({ scope: 'group:2', text: '这个群约好周五开黑', importance: 0.7 })
  s1.setWatermark('private:1', 111)
  s1.save()

  const s2 = createStore({ dir, log: { warn() {} } })
  assert.equal(s2.size(), 2, '快照回放后条数一致')
  assert.equal(s2.watermarkOf('private:1'), 111)

  assert.equal(s2.forget(a.id, '测试'), true)
  assert.ok(s2.get(a.id).forgottenAt > 0)
  assert.equal(s2.restore(a.id), true)
  assert.equal(s2.get(a.id).forgottenAt, 0)

  // 事件流追加：recall 记次数
  s2.markRecalled([a.id])
  const s3 = createStore({ dir, log: { warn() {} } })
  assert.equal(s3.get(a.id).recallCount, 1, '快照之后的 recall 事件要能回放')

  s3.purge(a.id)
  assert.equal(s3.get(a.id), null)
  const revDir = path.join(dir, '.revisions')
  assert.ok(fs.readdirSync(revDir).some((n) => n.startsWith('book-')), 'purge 前要整库备份')
})

test('存储：半行 / 坏行不炸整个库', () => {
  const dir = tmp('corrupt')
  const s1 = createStore({ dir, log: { warn() {} } })
  s1.add({ scope: 'private:1', text: '第一条', importance: 0.5 })
  fs.appendFileSync(path.join(dir, 'memories.jsonl'), '{"op":"add","memory":{"id"') // 写到一半崩了
  const s2 = createStore({ dir, log: { warn() {} } })
  assert.equal(s2.size(), 1)
  s2.add({ scope: 'private:1', text: '第二条', importance: 0.5 })
  const s3 = createStore({ dir, log: { warn() {} } })
  assert.equal(s3.size(), 2)
})

test('存储：导出 md / json，导入去重', () => {
  const dir = tmp('exp')
  const s = createStore({ dir, log: { warn() {} } })
  s.add({ scope: 'private:1', text: '喜欢下雨天', importance: 0.7 })
  const md = s.exportText('md')
  assert.match(md, /喜欢下雨天/)
  assert.match(md, /## private:1/)
  const json = s.exportText('json')
  const s2 = createStore({ dir: tmp('imp'), log: { warn() {} } })
  const r = s2.importJson(json)
  assert.equal(r.added, 1)
  assert.equal(s2.importJson(json).added, 0, '重复导入不应重复新增')
})

// ── 整理侧 ────────────────────────────────────────────────────────────────
test('整理：提示词占位符替换，正文里的 $& 不被当组引用', () => {
  const prompt = buildPrompt({
    scope: 'private:1',
    rows: [{ dir: 'in', ts: 1, text: '$& $1 面试' }],
    promptTemplate: 'X{maxMemories}Y{scopeLabel}Z{transcript}',
    maxMemories: 3,
  })
  assert.match(prompt, /X3Y/)
  assert.match(prompt, /\$& \$1 面试/, '聊天原文要原样进提示词')
  assert.match(DEFAULT_ORGANIZE_PROMPT, /\{transcript\}/)
})

test('整理：归一化拒绝空正文 / 抄回来的长文，接受正常条目', () => {
  assert.equal(normalizeMemory({ text: '' }), null)
  assert.equal(normalizeMemory({ text: 'x'.repeat(600) }, { maxChars: 240 }), null)
  const m = normalizeMemory({ text: '主人面试前挑了浅蓝色衬衫', importance: 1.7, type: 'plan', tags: ['面试'], entities: [{ qq: 1, name: '主人' }] }, { scope: 'private:1' })
  assert.equal(m.importance, 1, 'importance 超界要夹紧')
  assert.equal(m.memoryType, 'plan')
  assert.equal(m.scope, 'private:1')
})

test('整理：解析模型输出（围栏 / 前置废话 / 非数组）', () => {
  assert.deepEqual(parseMemoryJson('```json\n[{"text":"a"}]\n```').list.length, 1)
  assert.deepEqual(parseMemoryJson('好的，如下：[{"text":"a"}] 以上').list.length, 1)
  assert.equal(parseMemoryJson('这就是一段话').ok, false)
  assert.equal(parseMemoryJson('{"text":"a"}').ok, false, '不是数组要失败')
})

test('整理：接口地址归一化 / 缺配置给出 missing', () => {
  assert.equal(completionsUrl('https://x/v1'), 'https://x/v1/chat/completions')
  assert.equal(completionsUrl('https://x/v1/chat/completions'), 'https://x/v1/chat/completions')
  assert.equal(completionsUrl('https://x/v1/'), 'https://x/v1/chat/completions')
  const { missing } = normalizeLlmConfig({ baseUrl: 'ftp://x', model: 'm', apiKey: 'k' })
  assert.ok(missing.length === 1 && missing[0].includes('http'))
  assert.deepEqual(normalizeLlmConfig({}).missing.length, 3)
  assert.equal(extractText({ choices: [{ message: { content: 'hi' } }] }), 'hi')
})

// ── 集成：真起内核 ────────────────────────────────────────────────────────
const baseCfg = (extra = {}) => ({
  pacing: { merge: { enabled: false } },
  pluginConfig: {
    'long-memory': { autoOrganize: false, ...extra },
  },
})

/** 起一个内核 + 假接口，返回常用句柄。 */
async function boot(t, { plugin = {}, fetchImpl = null } = {}) {
  const h = await bootKernel({ config: baseCfg(plugin) })
  const lm = h.kernel.shared.longMemory
  if (!lm) throw new Error('longMemory 共享槽未注册（插件没加载？）')
  if (fetchImpl) lm.organizer.setFetch?.(fetchImpl)
  t.after(() => h.dispose())
  return { h, lm }
}

test('集成：插件被内核加载，工具与命令都在', async (t) => {
  const { h } = await boot(t)
  assert.ok(h.kernel.plugins.some((p) => (p.id || p.plugin?.id) === 'long-memory'))
  for (const name of ['remember', 'recall_memory', 'memory_status']) {
    assert.ok(h.kernel.toolDefs.has(name), `缺少工具 ${name}`)
  }
  assert.ok(h.kernel.commands.has('memory'))
})

test('集成：私聊记忆会在下一轮被注入（换一个新会话也照样注入）', async (t) => {
  const { h, lm } = await boot(t)
  lm.store.add({ scope: `private:${ADMIN_QQ}`, text: '主人 8 号要去面试，紧张得睡不着', importance: 0.9, entities: [{ qq: String(ADMIN_QQ), name: '主人' }], createdAt: Date.now() - 21 * DAY })

  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, privateEvent({ text: '我明天有点紧张', messageId: 7001 }))
  const ev = await waitFor(() => tap.events.find((e) => e.hint && e.hint.length), { label: '注入 hint' })
  const block = ev.hint.find((x) => x.startsWith('[以下为系统信息'))
  assert.ok(block, '要带保护前缀')
  assert.match(block, /面试/)
  assert.match(block, /21 天前/)
})

test('集成：群聊默认为不记也不注入（默认只记私聊）', async (t) => {
  const { h, lm } = await boot(t)
  lm.store.add({ scope: `group:${GROUP_ID}`, text: '这个群约好周五开黑', importance: 0.9, createdAt: Date.now() })
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '周五开黑吗', messageId: 7002 }))
  const ev = await waitFor(() => tap.events.find((e) => e.wake && e.chatKey === `group:${GROUP_ID}`), { label: '群唤醒' })
  assert.ok(!(ev.hint || []).some((x) => String(x).includes('开黑')), '没开群记忆时不许注入')
})

test('集成：打开群记忆后只注入本群的，看不到私聊的', async (t) => {
  const { h, lm } = await boot(t, { plugin: { groupsMode: 'list', groupsInclude: [GROUP_ID] } })
  lm.store.add({ scope: `group:${GROUP_ID}`, text: '这个群约好周五开黑', importance: 0.9, createdAt: Date.now() })
  lm.store.add({ scope: `private:${ADMIN_QQ}`, text: '主人周五要去看牙', importance: 0.9, createdAt: Date.now() })
  const tap = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '周五开黑吗', messageId: 7003 }))
  const ev = await waitFor(() => tap.events.find((e) => e.wake && e.chatKey === `group:${GROUP_ID}`), { label: '群唤醒' })
  const block = (ev.hint || []).filter((x) => String(x).startsWith('[以下为系统信息')).join('\n')
  assert.match(block, /开黑/)
  assert.ok(!block.includes('看牙'), '群里绝不能看到私聊记忆')
})

test('集成：工具 remember 只写本作用域，recall_memory 不跨作用域', async (t) => {
  const { h, lm } = await boot(t)
  const runAs = (chatKey, fn) => turnStore.run({ chatKey, ev: { chatKey } }, fn)
  const remember = h.kernel.toolDefs.get('remember')
  const r = await runAs(`private:${ADMIN_QQ}`, () => remember.execute({ text: '主人喜欢下雨天', importance: 0.7, tags: '天气' }))
  assert.equal(r.ok, true)
  const rows = lm.store.all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scope, `private:${ADMIN_QQ}`)

  // 换个会话（群）调 recall_memory：不许看到那条私聊
  const recallTool = h.kernel.toolDefs.get('recall_memory')
  const r2 = await runAs(`group:${GROUP_ID}`, () => recallTool.execute({ query: '下雨' }))
  assert.equal(r2.count, 0, '群会话查不到私聊记忆')
  const r3 = await runAs(`private:${ADMIN_QQ}`, () => recallTool.execute({ query: '下雨' }))
  assert.equal(r3.count, 1, '本会话能查到自己的记忆')
  assert.match(r3.items[0].when, /今天|昨天|天前/)
})

test('集成：整理→落库→水位推进；接口报错时不写也不推水位', async (t) => {
  const { h, lm } = await boot(t)
  const archiveDir = String(h.kernel.archive?.dir || path.join(h.dataDir, 'logs', 'qq_chat'))
  fs.mkdirSync(archiveDir, { recursive: true })
  const file = archiveFileOf(archiveDir, `private:${ADMIN_QQ}`)
  const now = Date.now()
  const rows = [
    { dir: 'in', ts: now - 3000, sender: { qq: ADMIN_QQ, name: '主人' }, messageId: 11, text: '我 8 号要去面试，好紧张' },
    { dir: 'out', ts: now - 2000, messageId: 12, text: '你一定可以的！' },
    { dir: 'in', ts: now - 1000, sender: { qq: ADMIN_QQ, name: '主人' }, messageId: 13, text: '那天在家等我回来' },
  ]
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  // 接口配置走**扁平字段**（与 configSchema 一致：llmBaseUrl / llmApiKey / llmModel）
  const LLM = { llmBaseUrl: 'https://example.invalid/v1', llmApiKey: 'k', llmModel: 'm', llmProtocol: 'openai-chat' }
  const co = (fetchImpl, extra = {}) => createOrganizer({
    store: lm.store,
    cfgOf: () => ({
      minNewMessages: 0, maxCharsPerRound: 2000, maxMessagesPerRound: 50, maxMemoriesPerRound: 5, maxCharsPerMemory: 240,
      ...LLM, ...extra,
    }),
    archiveDirOf: () => archiveDir,
    inScope: () => true,
    fetchImpl,
  })
  const good = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '```json\n[{"text":"主人 8 号要去面试，紧张得睡不着，我答应那天在家等他回来","importance":0.91,"type":"commitment","tags":["面试"],"entities":[{"qq":"10001","name":"主人"}]}]\n```' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const org = co(good)
  const r = await org.organizeOne({ scope: `private:${ADMIN_QQ}` })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.added, 1)
  assert.equal(lm.store.size(), 1)
  assert.equal(lm.store.watermarkOf(`private:${ADMIN_QQ}`), rows[2].ts, '水位应是实际喂进去的最新一条，不是 Date.now()')

  // 再来一轮：没有新消息 → 不调模型
  const again = await org.organizeOne({ scope: `private:${ADMIN_QQ}` })
  assert.equal(again.added, 0)
  assert.match(String(again.reason || ''), /没有新消息/)

  // 接口 500：不写、不推水位
  fs.appendFileSync(file, `${JSON.stringify({ dir: 'in', ts: now + 1000, sender: { qq: ADMIN_QQ }, messageId: 14, text: '还有一件事' })}\n`)
  const bad = co(async () => new Response('{"error":{"message":"boom"}}', { status: 500 }))
  const r3 = await bad.organizeOne({ scope: `private:${ADMIN_QQ}` })
  assert.equal(r3.ok, false)
  assert.equal(lm.store.size(), 1, '失败不许写库')
  assert.equal(lm.store.watermarkOf(`private:${ADMIN_QQ}`), rows[2].ts, '失败不许推水位，下次要能重试')

  // 坏 JSON（模型写成一段话）：同样不写
  const badJson = co(async () => new Response(JSON.stringify({ choices: [{ message: { content: '我记得你们聊了面试' } }] }), { status: 200 }))
  const r4 = await badJson.organizeOne({ scope: `private:${ADMIN_QQ}` })
  assert.equal(r4.ok, false)
  assert.equal(r4.code, 'bad_output')
  assert.equal(lm.store.size(), 1)

  // 接口没配：明确回 not_configured，不抛
  const notCfg = createOrganizer({ store: lm.store, cfgOf: () => ({ minNewMessages: 0 }), archiveDirOf: () => archiveDir, inScope: () => true })
  const r5 = await notCfg.organizeOne({ scope: `private:${ADMIN_QQ}` })
  assert.equal(r5.code, 'not_configured')
})

test('集成：接口没配置时只降级（不抛、不写）', async (t) => {
  const { h, lm } = await boot(t)
  const archiveDir = String(h.kernel.archive?.dir || path.join(h.dataDir, 'logs', 'qq_chat'))
  fs.mkdirSync(archiveDir, { recursive: true })
  const file = archiveFileOf(archiveDir, `private:${ADMIN_QQ}`)
  fs.writeFileSync(file, `${JSON.stringify({ dir: 'in', ts: Date.now(), sender: { qq: ADMIN_QQ }, messageId: 1, text: '在吗' })}\n`)
  const org = createOrganizer({ store: lm.store, cfgOf: () => ({}), archiveDirOf: () => archiveDir, inScope: () => true })
  const r = await org.organizeOne({ scope: `private:${ADMIN_QQ}` })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'not_configured')
  assert.equal(lm.store.size(), 0)
})

test('集成：search 只返回未遗忘的，遗忘后 hint 里不再出现', async (t) => {
  const { h, lm } = await boot(t)
  const add = lm.store.add({ scope: `private:${ADMIN_QQ}`, text: '我记得你说过讨厌香菜', importance: 0.8, createdAt: Date.now() })
  const { hits } = lm.recall(`private:${ADMIN_QQ}`, { text: '香菜', mark: false })
  assert.equal(hits.length, 1)
  lm.store.forget(add.id, '测试')
  const after = lm.recall(`private:${ADMIN_QQ}`, { text: '香菜', mark: false })
  assert.equal(after.hits.length, 0)
})
