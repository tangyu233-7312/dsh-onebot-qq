/**
 * test/audit-console-groups.test.js — 控制台分组命名与「高级」折叠标记。
 * 锁定：回话细节 → 消息设置；回话模式 → 主动接话；回话模式·高级 不再单独成页，
 * 进阶项用 `advanced: true` 标出来，由前端「高级」按钮决定显示/收起。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel } from './helpers.mjs'
import { collectSchema } from '../admin/schema.js'

async function schemaOf(t) {
  const h = await bootKernel({})
  t.after(() => h.dispose?.())
  return collectSchema(h.kernel, h.raw)
}

test('分组命名：消息设置 / 主动接话；旧页名不再出现', async (t) => {
  const schema = await schemaOf(t)
  const groups = schema.groups.map((g) => g.name)
  assert.ok(groups.includes('消息设置'), '应有「消息设置」页')
  assert.ok(groups.includes('主动接话'), '应有「主动接话」页')
  for (const old of ['回话细节', '回话模式', '回话模式·高级']) {
    assert.equal(groups.includes(old), false, `旧分组名不应再出现：${old}`)
  }
})

test('主动接话：基础项不带 advanced，进阶项全部带 advanced', async (t) => {
  const schema = await schemaOf(t)
  const all = schema.controls.filter((c) => c.group === '主动接话')
  const basic = all.filter((c) => !c.advanced)
  const adv = all.filter((c) => c.advanced)
  assert.ok(basic.some((c) => c.key === 'pacing.reply.enabled'))
  assert.equal(basic.some((c) => c.key.startsWith('pacing.reply.weights.')), false, '语境权重必须折叠')
  // 不写死进阶项数量（新增项不该让测试红）：只要求确实折叠了一批、且都归在 pacing.reply 下
  assert.ok(adv.length >= 15, `进阶项至少 15 个，实际 ${adv.length}`)
  assert.ok(adv.every((c) => c.key.startsWith('pacing.reply.')))
})

test('消息设置：原回话细节 4 项 + 合批 6 项都在同一页', async (t) => {
  const schema = await schemaOf(t)
  const keys = schema.controls.filter((c) => c.group === '消息设置').map((c) => c.key)
  for (const k of [
    'outbound.replyMaxLength', 'outbound.longForwardThreshold', 'outbound.longForwardChunkSize', 'outbound.quoteAfterMsgs',
    'pacing.merge.enabled', 'pacing.merge.windowMs', 'pacing.merge.windowActiveMs', 'pacing.merge.activeGapMs',
    'pacing.merge.maxWaitMs', 'pacing.merge.skipIfSlowMs',
  ]) assert.ok(keys.includes(k), `消息设置应含 ${k}`)
})

test('「其他」页：权限 / 门禁 / 文件 / 发图 / 头像 五组的控件统一并进来，且有详细悬停解释', async (t) => {
  const schema = await schemaOf(t)
  const names = schema.groups.map((g) => g.name)
  for (const g of ['权限', '门禁', '文件', '发图', '头像']) {
    assert.equal(names.includes(g), false, g + ' 不应再单独成页')
    assert.equal(schema.controls.some((c) => c.group === g), false, g + ' 的控件应改为挂在「其他」')
  }
  assert.ok(names.includes('其他'), '应有「其他」页')
  const other = schema.controls.filter((c) => c.group === '其他')
  for (const key of [
    'gate-wake.adminQq', 'gate-wake.ignoreGroups', 'gate-wake.groupUserBlocklist',
    'gate-wake.groupUserAllowlist', 'gate-wake.allowedUsers',
    'file-transfer.uploadDir', 'file-transfer.imageWhitelist',
    'imagegen.avatarDir', 'imagegen.avatarCacheHours',
  ]) assert.ok(other.some((c) => c.key === key), '其他页应含 ' + key)
  for (const c of other.filter((x) => x.type !== 'info')) {
    assert.ok(String(c.hint || '').trim().length >= 40, c.key + ' 的悬停解释太短')
  }
  assert.ok(other.some((c) => c.type === 'info' && String(c.text).includes('门禁')), '其他页顶部应有分组说明')
})

test('句池 / 唤醒：各自成页（persona-voice / gate-wake 一对一）', async (t) => {
  const schema = await schemaOf(t)
  assert.deepEqual(schema.personaGroups, [], '不再折叠进总览：两者各自成页')
  const names = schema.groups.map((g) => g.name)
  assert.ok(names.includes('句池') && names.includes('唤醒'), '应有「句池」「唤醒」两页')
  const want = {
    '句池': ['persona-voice.enabled', 'persona-voice.personaDir', 'persona-voice.activePersona', 'persona-voice.quoteEnforce'],
    '唤醒': ['gate-wake.enabled', 'gate-wake.pokeBack', 'gate-wake.keywords', 'gate-wake.callAck'],
  }
  for (const g of Object.keys(want)) {
    for (const k of want[g]) {
      const c = schema.controls.find((x) => x.key === k)
      assert.ok(c, k + " 应可见")
      assert.equal(c.group, g, k + ' 应在「' + g + '」页')
    }
  }
  const pv = schema.controls.filter((c) => c.plugin === 'persona-voice')
  assert.ok(pv.every((c) => c.group === '句池'), pv.map((c) => c.key + ':' + c.group).join(','))
  const gw = schema.controls.filter((c) => c.plugin === 'gate-wake')
  assert.ok(gw.every((c) => c.group === '唤醒' || c.group === '其他'), gw.map((c) => c.key + ':' + c.group).join(','))
})

test('所有可见开关都带鼠标悬停解释（hint 非空）', async (t) => {
  const schema = await schemaOf(t)
  const missing = schema.controls
    .filter((c) => c.type !== 'info' && !String(c.hint || '').trim())
    .map((c) => c.key)
  assert.deepEqual(missing, [], `这些开关缺少悬停解释：${missing.join(', ')}`)
})

test('引用拦截开关在「句池」页（persona-voice 一对一），标签/解释写明作用', async (t) => {
  const schema = await schemaOf(t)
  const q = schema.controls.find((c) => c.key === 'persona-voice.quoteEnforce')
  assert.ok(q, 'quoteEnforce 应仍可见')
  assert.equal(q.group, '句池', '应归到句池页（persona-voice 一对一）')
  assert.match(String(q.label), /不引用/, '标签应说明「不引用刚触发回复的那条消息」')
  assert.ok(String(q.hint).includes('引用门槛'), '解释里应带「引用门槛」这个上下游关系')
  assert.equal(schema.groups.some((g) => g.name === '回话'), false, '「回话」页应已并入消息设置')
})

test('文件与图片页：行为类开关都在同一页；目录 / 白名单在「其他」页', async (t) => {
  const schema = await schemaOf(t)
  const keys = schema.controls.filter((c) => c.group === '文件与图片').map((c) => c.key)
  for (const k of [
    'file-transfer.enabled', 'file-transfer.downloadPolicy', 'file-transfer.maxFileMB',
    'file-transfer.maxFilesPerMsg', 'file-transfer.keepDays',
  ]) assert.ok(keys.includes(k), '文件与图片页应含 ' + k)
  for (const k of ['file-transfer.uploadDir', 'file-transfer.imageWhitelist']) {
    assert.equal(keys.includes(k), false, k + ' 应移到「其他」页')
    assert.ok(schema.controls.some((c) => c.key === k && c.group === '其他'), k + ' 应在其他页')
  }
  for (const g of ['文件', '发图', '头像']) {
    assert.equal(schema.groups.some((x) => x.name === g), false, g + ' 不应单独成页')
  }
})

test('文案里不再引用已删除的页面名（所有提示/说明都指向现有页）', async (t) => {
  const schema = await schemaOf(t)
  const BAD = /「权限」页|「工具」页|「留档」页|「DSH 连接」|「登录」页|「回话」页|「文件」页|「发图」页|「头像」页/
  const bad = []
  for (const c of schema.controls) {
    const text = `${c.hint || ''}\n${c.text || ''}`
    const m = text.match(BAD)
    if (m) bad.push(`${c.key} → ${m[0]}`)
  }
  assert.deepEqual(bad, [], `仍有旧页面引用：${bad.join(' / ')}`)
})

test('表情包「自动打标」不暴露（内核暂无看图能力，避免死开关）', async (t) => {
  const schema = await schemaOf(t)
  assert.equal(schema.controls.some((c) => c.key === 'stickers.tagging'), false)
})

test('「能力」页已拆：gate-wake 归「唤醒」、commands 归「群聊」', async (t) => {
  const schema = await schemaOf(t)
  assert.equal(schema.groups.some((g) => g.name === '能力'), false, '「能力」页不应再出现')
  const byKey = (k) => schema.controls.find((c) => c.key === k)
  assert.equal(byKey('commands.enabled').group, '群聊')
  assert.equal(byKey('gate-wake.enabled').group, '唤醒')
  assert.equal(byKey('gate-wake.pokeBack').group, '唤醒')
  const keys = schema.controls.filter((c) => c.group === '群聊').map((c) => c.key)
  assert.ok(keys.includes('adminQq'), '群聊页原有核心项保留')
  assert.ok(keys.includes('outbound.groupContextCount'), '群聊页原有核心项保留')
})

test('「生图」页 1:1：非说明控件全归 imagegen（凭据已从核心拆进生图）', async (t) => {
  const schema = await schemaOf(t)
  const list = schema.controls.filter((c) => c.group === '生图')
  assert.ok(list.length >= 10, list.length + " 个控件")
  const bad = list.filter((c) => c.type !== 'info' && c.plugin !== 'imagegen').map((c) => c.key + ':' + (c.plugin || 'core'))
  assert.deepEqual(bad, [], bad.join(","))
  for (const k of ['credentials.gptImage.protocol', 'credentials.gptImage.baseUrl', 'credentials.gptImage.model', 'credentials.gptImage.apiKey']) {
    const c = schema.controls.find((x) => x.key === k)
    assert.ok(c, k + " 应仍在生图页")
    assert.equal(c.plugin, 'imagegen', k + ' 应归 imagegen')
    if (k.endsWith('apiKey')) assert.equal(c.secret, true, 'API Key 应脱敏')
  }
  assert.equal(schema.controls.filter((c) => c.key === 'credentials.gptImage.apiKey').length, 1, '凭据控件不应重复')
})

test('表情包页：有「收表情（会写索引）」开关（默认关）+ 实时数量说明', async (t) => {
  const schema = await schemaOf(t)
  const c = schema.controls.find((x) => x.key === 'stickers.collect')
  assert.ok(c, '应有 stickers.collect 开关')
  assert.equal(c.group, '表情包')
  assert.equal(c.type, 'bool')
  assert.equal(c.default, false, '默认关（库只读）')
  assert.ok(String(c.hint).includes('默认关'), '解释里要写明默认关')
  const info = schema.controls.find((x) => x.key === 'info.stickers')
  assert.ok(info, '表情包页应有实时概况行')
  assert.match(String(info.text), /当前表情库：\d+ 张/, '概况要带数量')
  assert.match(String(info.text), /收表情（会写索引）：(开|关)/)
})

test('群聊页「入站条数上限」：标签写明是上限、解释讲清"只给最后 N 条"与 token 代价', async (t) => {
  const schema = await schemaOf(t)
  const c = schema.controls.find((x) => x.key === 'outbound.groupContextCount')
  assert.ok(c, '控件应存在')
  assert.equal(c.group, '群聊')
  assert.equal(c.label, '入站条数上限', '标签统一叫「入站条数上限」')
  const hint = String(c.hint || '')
  assert.ok(hint.includes('最多'), '解释要说明"最多"（上限语义）')
  assert.ok(hint.includes('丢弃'), '解释要说明超过上限时更早的会被丢弃')
  assert.ok(hint.includes('token'), '解释要提到 token 代价')
  assert.equal(c.min, 0)
  assert.equal(c.max, 50)
})

test('控制台命名：协议端页签名是「OneBot 连接」，且不再残留旧实现名', async (t) => {
  const schema = await schemaOf(t)
  const groups = schema.groups.map((g) => g.name)
  assert.ok(groups.includes('OneBot 连接'), '应有「OneBot 连接」页')
  // 全量 schema 里不该再出现旧实现名（守卫用例：正则里保留旧名正是为了检测它不再出现）
  const dump = JSON.stringify(schema)
  assert.equal(/NapCat|napcat/i.test(dump), false, '旧实现名不应再出现在 schema 里')
  // 运维页两个按钮：名字与 id 都是 OneBot
  const ids = new Map(schema.actions.map((a) => [a.id, a.label]))
  assert.equal(ids.get('onebot-check'), '🔌 测试 OneBot 连接')
  assert.equal(ids.get('onebot-reconnect'), '↻ 重新连接 OneBot')
})
