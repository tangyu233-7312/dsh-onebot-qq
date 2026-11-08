/**
 * test/audit-data-admin.test.js — 表情包采集 / 群记忆 / 控制面（schema / store / 8 端点）。
 *
 * 迁移自旧 `audit-data-admin.test.js`：保留行为级断言；删除旧 admin-api / client.js 源码内容、
 * standalone 接管、站点 config 继承等旧实现专属用例（改测新 admin/* 实现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectSchema, readValue, writeValue, collectModules } from '../admin/schema.js'
import { runDiagnostics, maskQq, sanitizeUrl, formatTime } from '../admin/diagnostics.js'
import { createConfigStore } from '../admin/store.js'
import { createAdminEndpoints } from '../admin/endpoints.js'
import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent } from './helpers.mjs'

const quiet = () => ({ info() {}, warn() {}, error() {}, debug() {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, opts = {}) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false }, ...(opts.pacing || {}) },
      ...(opts.config || {}),
    },
  })
  t.after(() => h.dispose())
  return h
}

// ─────────────────────────────────────────────────────────────────────────────
// 控制面 schema / read / write
// ─────────────────────────────────────────────────────────────────────────────

test('collectSchema：控件齐全（核心 + 插件）、9 个模块、动作列表、每个控件有 key/value', async (t) => {
  const h = await boot(t)
  const schema = collectSchema(h.kernel, h.raw)
  assert.ok(Array.isArray(schema.controls) && schema.controls.length >= 60, `控件数=${schema.controls.length}`)
  assert.ok(Array.isArray(schema.groups) && schema.groups.length > 0)
  assert.ok(schema.modules.length >= 9, '内置子插件都应在 modules 里')
  assert.ok(Array.isArray(schema.actions), '应有动作列表')
  for (const c of schema.controls) {
    assert.ok(c.key && typeof c.key === 'string')
    for (const f of ['group', 'type', 'label']) assert.ok(f in c, `控件缺 ${f}`)
    // 契约：info 是纯说明块（没有 value/不可写），其余控件必须有 value
    if (c.type === 'info') assert.ok(typeof c.text === 'string' && c.text.length > 0, `info 控件 ${c.key} 应有 text`)
    else assert.ok('value' in c, `控件 ${c.key} 应有 value`)
  }
  // 插件项 key 形如 <id>.<field>
  const pluginControls = schema.controls.filter((c) => c.plugin)
  assert.ok(pluginControls.length > 0)
  // 插件项默认 key=<id>.<field>；映射到别的配置路径（生图凭据）的会带 mapped 标记
  assert.ok(pluginControls.every((c) => c.key.startsWith(`${c.plugin}.`) || c.mapped === true))
})

test('collectModules：on 跟随配置；停用插件（plugins[id]=false）仍出现在列表但 loaded=false', async (t) => {
  const h = await boot(t, { config: { plugins: { stickers: false } } })
  const modules = collectModules(h.kernel, h.raw)
  assert.ok(modules.length >= 9)
  const stickers = modules.find((m) => m.id === 'stickers')
  assert.ok(stickers)
  assert.equal(stickers.loaded, false, 'plugins[id]=false → 未加载')
  assert.ok(stickers.key, '模块应有开关 key')
})

test('readValue / writeValue：核心项按 scale 换算、插件项原样存；非法键/类型/范围拒绝', async (t) => {
  const h = await boot(t)
  const raw = JSON.parse(JSON.stringify(h.raw))
  // 核心项：minGapMs 面板单位分钟，scale=60000
  const w = writeValue(h.kernel, 'pacing.reply.minGapMs', 10, raw)
  assert.equal(w.value, 10)
  assert.equal(w.stored, 600000, '面板 10 分钟 → 存 600000ms')
  assert.equal(readValue(h.kernel, 'pacing.reply.minGapMs', raw), 10)

  // 插件项：group-memory.maxBytes 原样存（面板单位 = 存储单位，不乘 scale）
  const w2 = writeValue(h.kernel, 'group-memory.maxBytes', 30000, raw)
  assert.equal(w2.value, 30000)
  assert.equal(readValue(h.kernel, 'group-memory.maxBytes', raw), 30000)

  assert.throws(() => writeValue(h.kernel, 'unknown.evilKey', 1, raw), /白名单/)
  assert.throws(() => writeValue(h.kernel, 'outbound.quoteAfterMsgs', 'abc', raw), /整数/)
  assert.throws(() => writeValue(h.kernel, 'group-welcome.mode', 'nope', raw), /可选项|未知/)
})

test('createConfigStore.update：落盘（备份 + 原子写）+ kernel.reloadConfig 热重载；reload 失败自动回滚', async (t) => {
  const h = await boot(t)
  const store = createConfigStore({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet() })
  const before = store.read()
  const res = await store.update((raw) => {
    raw.pacing.reply.hourlyMax = 9
    raw.pluginConfig['gate-wake'] = { ...(raw.pluginConfig['gate-wake'] || {}), groupFollowUpMs: 30000 }
  }, { what: 'test-update' })
  assert.equal(res.ok, true)
  assert.ok(res.backup, '应生成备份文件')
  const onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(onDisk.pacing.reply.hourlyMax, 9)
  assert.equal(h.kernel.runtime.pacing.reply.hourlyMax, 9, '热重载后 runtime 已更新')
  assert.equal(before.pacing.reply.hourlyMax !== 9, true)

  // reload 失败 → 回滚文件内容
  const snapshot = fs.readFileSync(h.configPath, 'utf8')
  h.kernel.reloadConfig = async () => {
    throw new Error('reload boom')
  }
  await assert.rejects(
    () => store.update((raw) => { raw.pacing.reply.hourlyMax = 11 }, { what: 'rollback-test' }),
    /回滚|失败/,
  )
  assert.equal(fs.readFileSync(h.configPath, 'utf8'), snapshot, '回滚后文件恢复原状')
})

test('8 端点：schema / status / set / module 正常返回；非法键返回 {ok:false} 不 throw', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const schema = await endpoints.handle('schema', {})
  assert.equal(schema.ok, true)
  assert.ok(Array.isArray(schema.controls))

  const status = await endpoints.handle('status', {})
  assert.equal(status.ok, true)
  assert.ok(status.health, 'status 应带 health')

  const set = await endpoints.handle('set', { key: 'pacing.reply.hourlyMax', value: 8 })
  assert.equal(set.ok, true)
  const onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(onDisk.pacing.reply.hourlyMax, 8)

  const module = await endpoints.handle('module', { id: 'stickers', on: false })
  assert.equal(module.ok, true)
  assert.equal(h.kernel.plugins.find((p) => p.id === 'stickers').cfg.enabled, false, '模块开关热生效')

  const bad = await endpoints.handle('set', { key: 'unknown.evilKey', value: 1 })
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /白名单/)
})

test('schema（新手引导）：protocol enum / 模型 suggestions / info 控件 / 4 个可见动作', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const schema = await endpoints.handle('schema', {})
  assert.equal(schema.ok, true)

  const proto = schema.controls.find((c) => c.key === 'credentials.gptImage.protocol')
  assert.ok(proto, '应有生图协议控件')
  assert.equal(proto.type, 'enum')
  assert.deepEqual(proto.options.map((o) => o.value).sort(), ['openai-chat', 'openai-images'].sort())
  assert.equal(proto.value, 'openai-images', '默认协议 openai-images')

  const model = schema.controls.find((c) => c.key === 'credentials.gptImage.model')
  assert.ok(Array.isArray(model.suggestions) && model.suggestions.length > 0, '模型控件应带 suggestions')

  const infos = schema.controls.filter((c) => c.type === 'info')
  assert.ok(infos.length >= 2, `应有图文说明控件（info），实际 ${infos.length}`)

  for (const id of ['onebot-check', 'onebot-reconnect', 'imagegen-check']) {
    assert.ok(schema.actions.some((a) => a.id === id), `actions 应包含 ${id}`)
  }

  // info 是纯说明块：没有 value，readValue 返回 undefined、writeValue 抛错
  const info = infos[0]
  assert.equal('value' in info, false)
  assert.equal(readValue(h.kernel, info.key, h.raw), undefined)
  assert.throws(() => writeValue(h.kernel, info.key, 'x', JSON.parse(JSON.stringify(h.raw))), /说明块|不能写/)
  // suggestions 只给"中转站模型名"：本地模型名**故意不给**，因为每套本地服务能跑的模型都不一样，
  // 写死建议列表等于把插件绑在某一个人的部署上（2026-11-07 决定）。本地模型靠「🔍 读取本机可用模型」现查。
  const withSuggestions = schema.controls.filter((c) => Array.isArray(c.suggestions))
  assert.deepEqual(withSuggestions.map((c) => c.key), ['credentials.gptImage.model'])
  const localModelCtrl = schema.controls.find((c) => c.key === 'imagegen.localModel')
  assert.ok(localModelCtrl, '本地模型名控件应存在')
  assert.equal(localModelCtrl.suggestions, undefined, '本地模型名不能带写死的建议列表')
  assert.equal(localModelCtrl.default, '', '本地模型名默认空，不预设任何模型')
})

test('status（新手引导）：meta / onboarding 6 项 / onebot / imagegen（绝不回显 key）', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const st = await endpoints.handle('status', {})
  assert.equal(st.ok, true)

  assert.ok(st.meta, 'status 应有 meta')
  for (const f of ['version', 'dataDir', 'configPath', 'configReady', 'platform', 'node']) {
    assert.ok(f in st.meta, `meta 缺 ${f}`)
  }
  assert.equal(st.meta.dataDir, h.dataDir)
  assert.equal(st.meta.configReady, true, '有 adminQq 的配置 → configReady=true')

  assert.ok(Array.isArray(st.onboarding) && st.onboarding.length === 6, 'onboarding 6 项（2026-11-08 加了可选的语气守卫）')
  assert.deepEqual(st.onboarding.map((o) => o.id), ['config', 'adminQq', 'onebot', 'persona', 'imagegen', 'toneGuard'])
  for (const item of st.onboarding) {
    for (const f of ['id', 'label', 'ok', 'required', 'hint']) assert.ok(f in item, `onboarding 项缺 ${f}`)
  }
  assert.equal(st.onboarding.find((o) => o.id === 'adminQq').ok, true)
  assert.equal(st.onboarding.find((o) => o.id === 'onebot').ok, false, '未连接 → ❌')
  assert.equal(st.onboarding.find((o) => o.id === 'imagegen').required, false, '生图是可选项')
  // 语气守卫：没填判定接口时它是「未启用」—— 必须在总览看得见，但不能算必填失败
  const tgItem = st.onboarding.find((o) => o.id === 'toneGuard')
  assert.equal(tgItem.required, false, '语气守卫是可选项')
  assert.equal(tgItem.ok, false, '没填判定接口 → 总览显示未启用')
  assert.match(String(tgItem.hint), /未填|未启用/, '要说清怎么开起来')

  assert.ok(st.onebot && 'wsUrl' in st.onebot && 'wsTokenSet' in st.onebot && 'linked' in st.onebot)
  assert.ok(st.imagegen && 'configured' in st.imagegen && 'protocol' in st.imagegen)
  const imagegenJson = JSON.stringify(st.imagegen)
  assert.equal(typeof st.imagegen.apiKeySet, 'boolean', '只报 apiKeySet，不回显 key 本身')
  assert.doesNotMatch(imagegenJson, /"apiKey":\s*"/, 'imagegen 状态里 apiKey 只能是布尔（envOverride 标记），不能回显值')
  assert.equal(imagegenJson.includes('REPLACE_ME'), false, '不回显任何 key 值')
  assert.equal(JSON.stringify(st.onebot).includes('wsToken":'), false, 'onebot 状态不回显 token')
})

test('待配置模式：set 保存成功并热应用其余配置（pending 标记、不自动连接）；默认人设已自动投递；补上 adminQq 后 configReady=true', async (t) => {
  const h = await bootKernel({
    config: {
      adminQq: 0, // 只缺这一项（onebot 地址用测试占位、非空）→ 待配置模式
      pacing: { merge: { enabled: false } },
    },
  })
  t.after(() => h.dispose())
  assert.equal(h.kernel.configReady, false, '缺 adminQq → 待配置模式')
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  // 统计 reload 调用：证明 pending 分支也走了热重载（不是只落盘）
  let reloadCalls = 0
  const origReload = h.kernel.reloadConfig.bind(h.kernel)
  h.kernel.reloadConfig = async (...args) => {
    reloadCalls += 1
    return origReload(...args)
  }

  const st = await endpoints.handle('status', {})
  assert.equal(st.meta.configReady, false)
  assert.equal(st.onboarding.find((o) => o.id === 'adminQq').ok, false)

  // 普通设置：成功保存到磁盘；内核 pending reload 会把「除 adminQq 以外」的配置热应用（不自动连接）
  const set = await endpoints.handle('set', { key: 'pacing.reply.hourlyMax', value: 9 })
  assert.equal(set.ok, true)
  assert.equal(set.pending, true, '待配置模式的保存应标记 pending')
  assert.match(String(set.message), /待配置模式/)
  assert.equal(h.kernel.runtime.pacing.reply.hourlyMax, 9, 'pending 模式下其余配置也要热应用（协议端地址同理）')
  assert.equal(h.kernel.configReady, false, '仍处于待配置模式')
  const onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(onDisk.pacing.reply.hourlyMax, 9, '磁盘上已经保存')

  // 协议端地址同样要即时进 adapter（否则新手向导「先填地址→测试连接」会连旧地址）
  const reloadCallsBefore = reloadCalls
  const wsSet = await endpoints.handle('set', { key: 'onebot.wsUrl', value: 'ws://127.0.0.1:4599' })
  assert.equal(wsSet.ok, true, JSON.stringify(wsSet))
  assert.equal(wsSet.pending, true)
  assert.ok(reloadCalls > reloadCallsBefore, 'pending 分支也必须调用 reloadConfig（只落盘不热应用是错的）')
  assert.equal(h.kernel.runtime.onebot.wsUrl, 'ws://127.0.0.1:4599', 'pending reload 应热应用 runtime')
  assert.equal(h.kernel.onebot.wsUrl, 'ws://127.0.0.1:4599', 'pending 模式下 协议端地址也要进 adapter（测试连接用新地址）')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(h.kernel.onebot.health().linked, false, '待配置模式仍不自动连接')

  // 安装即用：待配置模式下启动时也已自动投递默认人设并写回 activePersona
  assert.equal(
    JSON.parse(fs.readFileSync(h.configPath, 'utf8')).pluginConfig['persona-voice'].activePersona,
    '蓝色大肥鱼',
    '启动即自动投递默认人设（无需手动点按钮）',
  )
  assert.ok(fs.existsSync(path.join(h.dataDir, 'workspace', 'AGENTS.local.md')), '默认人设已投递到工作区')

  // 最后一步：补上 adminQq → 正常保存 + 热重载 + configReady=true
  const ready = await endpoints.handle('set', { key: 'adminQq', value: ADMIN_QQ })
  assert.equal(ready.ok, true, JSON.stringify(ready))
  assert.equal(ready.pending, false, '填完 adminQq 后不再 pending')
  assert.equal(h.kernel.configReady, true)
  assert.equal(h.kernel.runtime.adminQq, ADMIN_QQ)
  assert.equal(h.kernel.runtime.pacing.reply.hourlyMax, 9, '之前的待配置保存这次一起热重载')
})

test('安装即用：kernel 启动自动投递默认人设（文件 + 投递 + activePersona）；persona-init 动作已移除', async (t) => {
  const h = await boot(t) // 全新数据目录
  for (const f of ['AGENTS.local.md', 'lines.txt', 'wake.txt']) {
    assert.ok(fs.existsSync(path.join(h.dataDir, 'workspace', f)), `workspace 应有 ${f}`)
  }
  for (const f of ['蓝色大肥鱼.md', '蓝色大肥鱼.lines.txt', '蓝色大肥鱼.wake.txt']) {
    assert.ok(fs.existsSync(path.join(h.dataDir, 'personas', f)), `personas 应有 ${f}`)
  }
  const onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(onDisk.pluginConfig['persona-voice'].activePersona, '蓝色大肥鱼')

  // 控制台不再提供「创建默认人设」按钮/动作
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const gone = await endpoints.handle('action', { id: 'persona-init' })
  assert.equal(gone.ok, false)
  assert.match(String(gone.error), /未知动作/)
})

test('action imagegen-check：未配置逐项提示；合法配置 GET /models 404 只给提示仍算通过', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const empty = await endpoints.handle('action', { id: 'imagegen-check' })
  assert.equal(empty.ok, false, '没填凭据 → 不通过')
  assert.ok(Array.isArray(empty.checks) && empty.checks.length === 5, '协议/地址/模型/Key/备用接口')
  assert.ok(empty.checks.some((c) => c.name === '备用接口' && c.ok), '备用接口是可选，空着算通过')
  assert.ok(empty.checks.some((c) => c.name === 'API 地址' && !c.ok))
  assert.match(String(empty.error), /生图配置不完整/)

  // 合法配置 + 假上游：/models 404 → 仍通过（只给提示）
  const h2 = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      credentials: { gptImage: { protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'REPLACE_ME', model: 'gpt-image-2' } },
    },
  })
  t.after(() => h2.dispose())
  const originalFetch = globalThis.fetch
  let fetched = ''
  globalThis.fetch = async (url) => {
    fetched = String(url)
    return new Response('not found', { status: 404 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const endpoints2 = createAdminEndpoints({ kernel: h2.kernel, configPath: h2.configPath, dataDir: h2.dataDir, log: quiet(), ops: null })
  const ok = await endpoints2.handle('action', { id: 'imagegen-check' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(fetched, 'https://example.invalid/v1/models')
  assert.ok(ok.checks.every((c) => c.ok), '五项配置检查都应通过')
  assert.match(String(ok.advice), /404|提示/, '404 只给提示不算失败')
})

test('action onebot-check / onebot-reconnect：未连接返回可读结果（不 throw）', async (t) => {
  const h = await boot(t) // autoConnect:false → 未连接
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const check = await endpoints.handle('action', { id: 'onebot-check' })
  assert.equal(check.ok, false)
  assert.match(String(check.error), /未连接/)
  assert.ok(String(check.message).length > 0)

  const rec = await endpoints.handle('action', { id: 'onebot-reconnect' })
  assert.equal(rec.ok, true, '重连动作本身不 throw')
  assert.equal(typeof rec.linked, 'boolean')
})

test('group 端点：ignore add/remove 写实例配置并热重载', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const add = await endpoints.handle('group', { kind: 'ignore', op: 'add', group_id: GROUP_ID })
  assert.equal(add.ok, true)
  let onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  const gw = onDisk.pluginConfig['gate-wake'] || {}
  const ignored = (gw.ignoreGroups || []).map(String)
  assert.ok(ignored.includes(String(GROUP_ID)), `ignoreGroups=${JSON.stringify(gw.ignoreGroups)}`)

  const remove = await endpoints.handle('group', { kind: 'ignore', op: 'remove', group_id: GROUP_ID })
  assert.equal(remove.ok, true)
  onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal((onDisk.pluginConfig['gate-wake']?.ignoreGroups || []).map(String).includes(String(GROUP_ID)), false)

  const kw = await endpoints.handle('group', { kind: 'keywords', op: 'add', group_id: '*', value: '小助手' })
  assert.equal(kw.ok, true)
  onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.ok(String(onDisk.pluginConfig['gate-wake']?.keywords || '').includes('小助手'))
})

test('persona 端点：list / switch（投递文件 + 同步配置）', async (t) => {
  const h = await boot(t)
  const personaDir = path.join(h.dataDir, 'personas')
  fs.mkdirSync(personaDir, { recursive: true })
  fs.writeFileSync(path.join(personaDir, '_default.lines.txt'), '## poke\n底池\n')
  fs.writeFileSync(path.join(personaDir, 'tester.md'), '# 测试人设\n')
  fs.writeFileSync(path.join(personaDir, 'tester.lines.txt'), '## poke\n专属\n')
  fs.writeFileSync(path.join(personaDir, 'tester.wake.txt'), '小助手\n')
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })

  const list = await endpoints.handle('persona', { op: 'list' })
  assert.equal(list.ok, true)
  assert.ok(list.personas.some((p) => p.name === 'tester'), JSON.stringify(list.personas))

  const sw = await endpoints.handle('persona', { op: 'switch', name: 'tester' })
  assert.equal(sw.ok, true)
  assert.ok(fs.existsSync(path.join(h.dataDir, 'workspace', 'AGENTS.local.md')), '人设投递文件已写')
  for (const f of ['lines.txt', 'wake.txt']) assert.ok(fs.existsSync(path.join(h.dataDir, 'workspace', f)), `投递 ${f}`)
  const after = await endpoints.handle('persona', { op: 'list' })
  assert.equal(after.current, 'tester', '切换后当前人设 = tester')
  assert.ok(String(sw.message || '').includes('tester'), '返回可读提示')
})

test('ops 未配置：memory refresh 走内置积累器（不再要求 ops）/ action selfcheck 等降级不 throw', async (t) => {
  const h = await boot(t)
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  // 群记忆积累已内置到插件（shared.memoryAccumulate），没有 ops 也能跑：
  // 未确认 → 返回 needsConfirm；确认后 → 交给内置积累器（本测试只验证路由，不真跑模型）
  const ask = await endpoints.handle('memory', { op: 'refresh' })
  assert.equal(ask.ok, true)
  assert.equal(ask.needsConfirm, true)
  for (const [ep, payload] of [
    ['action', { id: 'selfcheck' }],
    ['action', { id: 'cleanup-tmp' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await endpoints.handle(ep, payload)
    assert.equal(r.ok, false, `${ep} ${payload.id} 应降级`)
    assert.match(String(r.error), /未配置/)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 表情包采集（协议字段判据 / GIF 魔数 / 尺寸闸 / 只在群里收）
// ─────────────────────────────────────────────────────────────────────────────

function stickerMessage({ messageId = 2001, subType = 1, file, group = true } = {}) {
  const raw = {
    post_type: 'message',
    message_type: group ? 'group' : 'private',
    user_id: MEMBER_QQ,
    message_id: messageId,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [{ type: 'image', data: { file, sub_type: subType, summary: '[动画表情]' } }],
  }
  if (group) raw.group_id = GROUP_ID
  return raw
}

test('表情包采集：sub_type=1 入协议判据、按大小写文件；sub_type=0 普通图不收', async (t) => {
  const h = await boot(t, {
    config: {
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: true, dir: 'qq-stickers', skipGif: true, collectGroupsOnly: true, collect: true },
      },
    },
  })
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-stk-src-'))
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2048, 1)])
  const stickerFile = path.join(srcDir, 'sticker.png')
  fs.writeFileSync(stickerFile, png)
  const normalFile = path.join(srcDir, 'normal.png')
  fs.writeFileSync(normalFile, png)

  await emitRaw(h.kernel, stickerMessage({ messageId: 2001, subType: 1, file: stickerFile }))
  await emitRaw(h.kernel, stickerMessage({ messageId: 2002, subType: 0, file: normalFile }))
  await sleep(150)
  const indexFile = path.join(h.dataDir, 'qq-stickers', 'index.json')
  assert.ok(fs.existsSync(indexFile), '表情库索引应创建')
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const items = index.items || index.stickers || []
  assert.equal(items.length, 1, `只收协议判据命中的表情：${JSON.stringify(items).slice(0, 200)}`)
})

test('表情包采集：GIF 魔数跳过（扩展名改成 .png 也挡）', async (t) => {
  const h = await boot(t, {
    config: {
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: true, dir: 'qq-stickers', skipGif: true, collectGroupsOnly: true, collect: true },
      },
    },
  })
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-stk-gif-'))
  const gifFile = path.join(srcDir, 'fake.png')
  fs.writeFileSync(gifFile, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(2048, 1)]))
  await emitRaw(h.kernel, stickerMessage({ messageId: 2003, subType: 1, file: gifFile }))
  await sleep(150)
  const indexFile = path.join(h.dataDir, 'qq-stickers', 'index.json')
  const items = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).items || [] : []
  assert.equal(items.length, 0, 'GIF 按魔数跳过')
})

// ─────────────────────────────────────────────────────────────────────────────
// 群记忆（指针注入 / read_memory / 只读）
// ─────────────────────────────────────────────────────────────────────────────

test('群记忆：首轮给指针不贴正文；文件未变 0 字符；更新后重提示；read_memory 剥记账注释', async (t) => {
  const memDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-mem-')), 'qq-memory')
  fs.mkdirSync(memDir, { recursive: true })
  const memFile = path.join(memDir, `${GROUP_ID}.md`)
  fs.writeFileSync(memFile, `# 群记忆\n## 唤醒与对话风格\n- 简短回话 <!-- n=3 d=2026-10-15 -->\n## 群里的人\n- **群友(${MEMBER_QQ})**：爱聊\n`)
  const h = await boot(t, {
    config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, 'group-memory': { enabled: true, dir: 'qq-memory' } } },
  })
  // 用相对 dataDir 的默认目录：把 fixture 放进 dataDir/qq-memory
  fs.mkdirSync(path.join(h.dataDir, 'qq-memory'), { recursive: true })
  fs.copyFileSync(memFile, path.join(h.dataDir, 'qq-memory', `${GROUP_ID}.md`))

  await emitRaw(h.kernel, groupAtEvent({ text: '第一句', messageId: 3001 }))
  await waitFor(() => h.ctx._prompts[0], { label: '首轮' })
  const p0 = h.ctx._prompts[0].content[0].text
  assert.ok(p0.includes('[本群记忆'), '首轮注入记忆指针')
  assert.equal(p0.includes('简短回话'), false, '记忆正文绝不直接贴进 prompt')

  await emitRaw(h.kernel, groupAtEvent({ text: '第二句', messageId: 3002 }))
  await waitFor(() => h.ctx._prompts[1], { label: '第二轮' })
  assert.equal(h.ctx._prompts[1].content[0].text.includes('[本群记忆'), false, '文件未变 → 0 字符指针')

  // 更新文件 → 重提示
  fs.appendFileSync(path.join(h.dataDir, 'qq-memory', `${GROUP_ID}.md`), '- 新增一条\n')
  await emitRaw(h.kernel, groupAtEvent({ text: '第三句', messageId: 3003 }))
  await waitFor(() => h.ctx._prompts[2], { label: '第三轮' })
  assert.ok(h.ctx._prompts[2].content[0].text.includes('[本群记忆已更新'), '文件变化后给"已更新"提示')

  const tool = h.ctx._registeredTools.get('mcp__qq__read_memory')
  const res = await tool.execute({ target: `group:${GROUP_ID}` })
  const text = typeof res === 'string' ? res : JSON.stringify(res)
  assert.ok(text.includes('爱聊'), 'read_memory 返回正文')
  assert.equal(text.includes('<!-- n=3'), false, '剥掉记账注释')
  await assert.rejects(() => tool.execute({ target: 'group:../etc/passwd' }), /target|群号/)
})

// ─────────────────────────────────────────────────────────────────────────────
// 运维诊断（diagnose）：一键诊断 → 脱敏报告落盘 → 可交给 DSH 本体修复
// 契约：诊断报告的小节顺序与 admin/diagnostics.js 的输出保持一致
// ─────────────────────────────────────────────────────────────────────────────

/** 诊断检查项字段的公共校验（B 实现后按契约固定）。 */
function assertDiagnoseShape(result, { label = 'diagnose' } = {}) {
  assert.equal(result.ok, true, `${label} 应返回 ok:true（业务失败也不 throw）`)
  assert.ok(Array.isArray(result.checks) && result.checks.length >= 8, `${label} 应有 ≥8 个检查项`)
  for (const c of result.checks) {
    assert.ok(typeof c.id === 'string' && c.id, `${label} 检查项缺 id`)
    assert.ok(typeof c.label === 'string' && c.label, `${label} ${c.id} 缺 label`)
    assert.equal(typeof c.ok, 'boolean', `${label} ${c.id}.ok 应为布尔`)
    assert.ok('required' in c, `${label} ${c.id} 缺 required`)
    assert.equal(typeof c.detail, 'string', `${label} ${c.id}.detail 应为字符串`)
  }
  const ids = result.checks.map((c) => c.id)
  for (const id of ['config', 'adminQq', 'dsh', 'tools', 'onebot', 'persona', 'dirs', 'runtime']) {
    assert.ok(ids.includes(id), `${label} 应包含检查项 ${id}（实际：${ids.join(',')}）`)
  }
  assert.ok(result.summary && typeof result.summary === 'object', `${label} 应有 summary`)
  for (const f of ['pass', 'fail', 'warn']) assert.equal(typeof result.summary[f], 'number', `summary.${f} 应为数字`)
  assert.equal(typeof result.summary.text, 'string', 'summary.text 应为字符串')
  assert.equal(typeof result.report, 'string', `${label} 应有 report 正文`)
  assert.ok(result.report.includes('交给 DSH 本体修复'), '报告应含「交给 DSH 本体修复」小节')
  assert.ok(result.report.includes('## 检查结果'), '报告应含检查结果表')
  assert.equal(typeof result.fixPrompt, 'string', `${label} 应有 fixPrompt`)
  if (result.reportPath) {
    assert.ok(result.fixPrompt.includes(result.reportPath), 'fixPrompt 应包含报告路径')
    assert.match(result.fixPrompt, /修复/, 'fixPrompt 应是给 DSH 的修复提示词')
  }
}

test('action diagnose（正常配置）：返回 checks/summary/report/reportPath/fixPrompt，报告落盘且脱敏', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(dataDir, d), { recursive: true })
  const h = await bootKernel({
    dataDir,
    config: {
      adminQq: ADMIN_QQ,
      onebot: {
        wsUrl: 'ws://127.0.0.1:3001',
        wsToken: 'super-secret-token',
        httpUrl: 'http://127.0.0.1:3000',
        httpToken: 'super-secret-token',
      },
      credentials: { gptImage: { protocol: 'openai-images', baseUrl: 'https://example.invalid/v1', apiKey: 'super-secret-api-key', model: 'gpt-image-2' } },
    },
  })
  t.after(() => h.dispose())
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  // 人设项：启动时已自动投递默认人设（安装即用），无需手动动作

  const result = await endpoints.handle('action', { id: 'diagnose' })
  assertDiagnoseShape(result)

  // 报告落盘：<dataDir>/reports/diagnose-YYYYMMDD-HHmmss.md
  assert.ok(result.reportPath, '正常配置下 reportPath 应非空')
  assert.ok(path.resolve(result.reportPath).startsWith(path.resolve(h.dataDir)), '报告应在数据目录内')
  assert.match(path.basename(result.reportPath), /^diagnose-\d{8}-\d{6}\.md$/, '报告文件名应为 diagnose-<时间>.md')
  assert.ok(fs.existsSync(result.reportPath), '报告文件应存在')
  const fileBody = fs.readFileSync(result.reportPath, 'utf8')
  assert.ok(fileBody.includes('交给 DSH 本体修复'), '落盘报告应含「交给 DSH 本体修复」')
  assert.ok(fileBody.includes('## 检查结果'), '落盘报告应含检查结果')

  // 脱敏：token / apiKey 原值绝不出现（报告/提示词/检查项/落盘文件都不行）
  const allText = [result.report, result.fixPrompt, JSON.stringify(result.checks), fileBody].join('\n')
  for (const secret of ['super-secret-token', 'super-secret-api-key']) {
    assert.equal(allText.includes(secret), false, `报告链里不得出现密钥原值：${secret}`)
  }
  // 主人 QQ 打码（前2+****+后2），不出现完整号码
  assert.equal(result.report.includes(String(ADMIN_QQ)), false, '报告不得出现完整 QQ 号')
  assert.match(result.report, /\*{4}/, '报告里的 QQ/selfId 应打码（含 ****）')

  // required=false 的失败只算 ⚠️，不算 ❌
  const requiredFailed = result.checks.filter((c) => !c.ok && c.required !== false).length
  const optionalFailed = result.checks.filter((c) => !c.ok && c.required === false).length
  assert.equal(result.summary.fail, requiredFailed, 'summary.fail 只统计必填项失败')
  assert.ok(result.summary.warn >= optionalFailed, 'summary.warn 应覆盖可选项失败')

  // 关键检查项语义：配置/工具/运行信息通过；协议端未连接应为 fail（不是 throw）
  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]))
  assert.equal(byId.config.ok, true)
  assert.equal(byId.adminQq.ok, true)
  assert.equal(byId.tools.ok, true)
  assert.equal(byId.runtime.ok, true)
  assert.equal(byId.onebot.ok, false, '没连协议端 → onebot 项 fail')
  assert.match(String(byId.onebot.detail), /未连接|协议端/)
})

test('action diagnose（待配置模式 adminQq=0）：仍成功并落盘；config/adminQq 为 ⚠️/❌', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-pending-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(dataDir, d), { recursive: true })
  const h = await bootKernel({ dataDir, config: { adminQq: 0 } })
  t.after(() => h.dispose())
  assert.equal(h.kernel.configReady, false, '前置：待配置模式')
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })

  const result = await endpoints.handle('action', { id: 'diagnose' })
  assertDiagnoseShape(result)
  assert.ok(result.reportPath, '待配置模式也应落盘报告')
  assert.ok(fs.existsSync(result.reportPath))
  assert.ok(fs.readFileSync(result.reportPath, 'utf8').includes('交给 DSH 本体修复'))

  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]))
  // adminQq 未填 → 该项不通过
  assert.equal(byId.adminQq.ok, false, 'adminQq 未填 → 该项不通过')
  // config 项：待配置模式应体现为 ⚠️（而不是直接说"配置文件坏"）——容许 ok:true+待配置说明，或 ok:false+warning 语义
  const configText = `${byId.config.detail} ${byId.config.advice || ''}`
  assert.ok(byId.config.ok === false || /待配置/.test(configText), `config 项应提示待配置：${configText}`)
  assert.ok(result.summary.warn + result.summary.fail >= 1, '待配置模式至少应有一条 ⚠️/❌')
  // 报告里也应有"待配置"的可见线索（config 或 adminQq 的 detail 抄进报告）
  assert.match(result.report, /待配置|adminQq/, '报告应提示缺 adminQq / 待配置模式')
})

test('action diagnose：协议端未连接只让 onebot 项 fail，绝不 throw；可选能力只降级 ⚠️', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-offline-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(dataDir, d), { recursive: true })
  const h = await bootKernel({ dataDir, config: { adminQq: ADMIN_QQ } }) // autoConnect:false，且无 fake 协议端
  t.after(() => h.dispose())
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })

  const result = await endpoints.handle('action', { id: 'diagnose' })
  assertDiagnoseShape(result)
  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]))
  assert.equal(byId.onebot.ok, false)
  // 可选项（生图未配置）只能是 warn，不参与 fail
  const imagegen = byId.imagegen
  if (imagegen) assert.equal(imagegen.required, false, '生图是可选检查项')
  assert.equal(result.summary.fail, result.checks.filter((c) => !c.ok && c.required !== false).length)
})

test('action diagnose：Agent preset 存在/不存在/宿主无服务（agentPresets）三种判定', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-preset-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(dataDir, d), { recursive: true })
  const h = await bootKernel({ dataDir, config: { adminQq: ADMIN_QQ, dsh: { agentPreset: 'qq-chat' } } })
  t.after(() => h.dispose())
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })

  // ① 宿主提供 agentPresets 且 preset 存在 → agentPreset 项 ✅
  const origGet = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'agentPresets' ? { list: async () => [{ id: 'standard' }, { id: 'qq-chat' }] } : origGet(name))
  const okRes = await endpoints.handle('action', { id: 'diagnose' })
  const okCheck = okRes.checks.find((c) => c.id === 'agentPreset')
  assert.ok(okCheck, 'diagnose 应包含 agentPreset 检查项')
  assert.equal(okCheck.ok, true)
  assert.match(okCheck.detail, /存在/)

  // ② preset 不存在 → 该项 fail（必填项），带可读建议
  const rawFile = path.join(h.dataDir, 'config.json')
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'))
  raw.dsh = { ...(raw.dsh || {}), agentPreset: 'missing-preset' }
  fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 4)}\n`)
  await h.kernel.reloadConfig()
  const badRes = await endpoints.handle('action', { id: 'diagnose' })
  const badCheck = badRes.checks.find((c) => c.id === 'agentPreset')
  assert.equal(badCheck.ok, false)
  assert.match(badCheck.detail, /不存在/)
  assert.deepEqual(badCheck.required, true, 'agentPreset 是必填检查项')
  assert.ok(badCheck.advice.length > 0, '应给出修复建议')

  // ③ 宿主没有 agentPresets 服务 → 不判失败（ok:true，detail 说明无法校验）
  //    注意：新版夹具默认提供 agentPresets（对齐现网 bundle 随包声明），这里显式模拟「没有」。
  h.ctx.get = (name) => (name === 'agentPresets' ? undefined : origGet(name))
  raw.dsh.agentPreset = 'qq-chat'
  fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 4)}\n`)
  await h.kernel.reloadConfig()
  const noSvcRes = await endpoints.handle('action', { id: 'diagnose' })
  const noSvcCheck = noSvcRes.checks.find((c) => c.id === 'agentPreset')
  assert.equal(noSvcCheck.ok, true, '宿主无 agentPresets 服务时不应判 ❌')
  assert.match(noSvcCheck.detail, /无法校验|未提供/)
})

test('diagnose 脱敏工具：maskQq / sanitizeUrl / formatTime', () => {
  // QQ 掩码：前2 + **** + 后2；长度<5 全 ***
  assert.equal(maskQq(12345678), '12****78')
  assert.equal(maskQq('12345678'), '12****78')
  assert.equal(maskQq('123'), '***')
  assert.equal(maskQq(''), '（空）', '空值给可读占位，不是 ***')
  // URL：去 userinfo、凭据类 query 值替换成 ***、保留其余参数
  const u = sanitizeUrl('ws://user:pass@example.invalid:3001/ws?token=abc&access_token=def&secret=ghi&foo=y')
  assert.equal(u.includes('user:pass'), false, '不能带 userinfo')
  assert.equal(u.includes('abc') || u.includes('def') || u.includes('ghi'), false, '凭据参数值必须替换')
  assert.ok(u.includes('foo=y'), '普通 query 参数保留')
  assert.ok(u.includes('example.invalid') && u.includes('/ws'), 'scheme/host/path 保留便于排障')
  assert.equal(sanitizeUrl('not a url'), '<非法 URL>')
  // 时间格式 YYYY-MM-DD HH:mm:ss（本地时区）
  const ms = new Date(2026, 9, 20, 8, 55, 12).getTime()
  assert.equal(formatTime(ms), '2026-10-20 08:55:12')
})

test('diagnose：now 注入 → generatedAt 与报告文件名可确定性断言', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-now-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(dataDir, d), { recursive: true })
  const h = await bootKernel({ dataDir, config: { adminQq: ADMIN_QQ } })
  t.after(() => h.dispose())
  const store = createConfigStore({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet() })
  const fixed = new Date(2026, 9, 20, 8, 55, 12).getTime()
  const r = await runDiagnostics({ kernel: h.kernel, store, log: quiet(), now: fixed })
  assert.equal(r.ok, true)
  assert.equal(r.generatedAt, '2026-10-20 08:55:12')
  assert.equal(path.basename(r.reportPath), 'diagnose-20261020-085512.md', '文件名由注入时间决定')
  assert.ok(r.report.includes('2026-10-20 08:55:12'), '报告正文含生成时间')
  assert.ok(fs.existsSync(r.reportPath))
})

test('diagnose：报告落盘失败 → reportPath 为空、报告含失败提示、fixPrompt 退化为"贴正文"', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-wfail-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const h = await bootKernel({ dataDir: root, config: { adminQq: ADMIN_QQ } })
  t.after(() => h.dispose())
  // 把 paths.dataDir 指到一个「文件」上：reports 子目录必然建不出来
  const notADir = path.join(root, 'not-a-dir')
  fs.writeFileSync(notADir, 'x')
  h.kernel.paths = { ...h.kernel.paths, dataDir: notADir }
  const store = createConfigStore({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet() })
  const r = await runDiagnostics({ kernel: h.kernel, store, log: quiet(), now: Date.now() })
  assert.equal(r.ok, true, '落盘失败也不 throw')
  assert.equal(r.reportPath, '', '落盘失败 → reportPath 为空')
  assert.match(r.report, /报告落盘失败/, '报告正文应有落盘失败提示')
  assert.ok(r.report.includes('交给 DSH 本体修复'), '仍应保留"交给 DSH"小节')
  assert.match(r.fixPrompt, /未能落盘|贴给 DSH|正文/, 'fixPrompt 应退化为"贴正文给 DSH"')
})

test('diagnose：老内核缺 checkOneBot / checkAgentPreset → 降级不判 ❌（不 throw）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-diag-oldkernel-'))
  for (const d of ['workspace', 'personas', 'state', 'logs/qq_chat']) fs.mkdirSync(path.join(dataDir, d), { recursive: true })
  const h = await bootKernel({ dataDir, config: { adminQq: ADMIN_QQ, dsh: { agentPreset: 'qq-chat' } } })
  t.after(() => h.dispose())
  delete h.kernel.checkOneBot
  delete h.kernel.checkAgentPreset
  const store = createConfigStore({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet() })
  const r = await runDiagnostics({ kernel: h.kernel, store, log: quiet() })
  assert.equal(r.ok, true)
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]))
  assert.equal(byId.agentPreset.ok, true, '缺 checkAgentPreset → 降级为通过（无法校验）')
  assert.match(String(byId.agentPreset.detail), /无法校验|未提供校验能力/)
  assert.equal(byId.onebot.ok, false, '缺 checkOneBot → 回退 health，未连接仍 fail（但不 throw）')
  assert.match(String(byId.onebot.detail), /未连接/)
})

test('秘密字段：set 响应/日志/状态都不回显明文；config.json 落盘为 0600', async (t) => {
  const h = await bootKernel({ config: { adminQq: ADMIN_QQ } })
  t.after(() => h.dispose())
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })

  const secret = 'SUPER_SECRET_TOKEN_123'
  const set = await endpoints.handle('set', { key: 'onebot.wsToken', value: secret })
  assert.equal(set.ok, true, JSON.stringify(set))
  assert.equal(set.secret, true)
  assert.equal(set.configured, true)
  assert.equal(JSON.stringify(set).includes(secret), false, 'set 响应不得回显秘密字段明文')
  assert.equal(String(set.message).includes(secret), false, 'set 消息不得回显秘密字段明文')

  // schema/status 里只能看到“已配置”，看不到明文
  const schema = await endpoints.handle('schema', {})
  const status = await endpoints.handle('status', {})
  assert.equal(JSON.stringify(schema).includes(secret), false, 'schema 不得回显秘密字段明文')
  assert.equal(JSON.stringify(status).includes(secret), false, 'status 不得回显秘密字段明文')
  const cfg = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(cfg.onebot.wsToken, secret, '磁盘上应保存真实值')

  // 配置与备份都应是 0600（Windows 无 chmod 语义，跳过）
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(h.configPath).mode & 0o777, 0o600, 'config.json 应为 0600')
    const baks = fs.readdirSync(path.dirname(h.configPath)).filter((n) => n.startsWith(path.basename(h.configPath) + '.bak-console-'))
    assert.ok(baks.length >= 1, '应生成备份')
    assert.equal(fs.statSync(path.join(path.dirname(h.configPath), baks[0])).mode & 0o777, 0o600, '备份也应为 0600')
  }
})

test('WAKE-P 人设自带唤醒词可从控制台删除（写回 personas/<人设>.wake.txt）', async (t) => {
  const h = await bootKernel({})
  t.after(() => h.dispose?.())
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const src0 = h.kernel.shared.readWakeWords.source()
  assert.ok(src0.wakeFile, '默认人设应有 wake 文件')
  const file = src0.wakeFile
  assert.ok(fs.readFileSync(file, 'utf8').includes('大肥鱼'))

  const r = await endpoints.handle('group', { kind: 'keywords', op: 'remove', group_id: '*', value: '大肥鱼', source: 'persona' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(String(r.message), /已从人设文件删除/)

  const after = fs.readFileSync(file, 'utf8')
  assert.equal(after.split(/\r?\n/).some((l) => l.trim() === '大肥鱼'), false, '词行应被删掉')
  assert.ok(after.includes('#'), '注释行原样保留')
  const src1 = h.kernel.shared.readWakeWords.source()
  assert.deepEqual(src1.persona, [], '人设词表应清空')
})

test('WAKE-P2 人设唤醒词只允许删除；删不存在的词给友好错误', async (t) => {
  const h = await bootKernel({})
  t.after(() => h.dispose?.())
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const add = await endpoints.handle('group', { kind: 'keywords', op: 'add', group_id: '*', value: '新词', source: 'persona' })
  assert.equal(add.ok, false)
  assert.match(String(add.error), /只支持删除/)
  const miss = await endpoints.handle('group', { kind: 'keywords', op: 'remove', group_id: '*', value: '不存在的词', source: 'persona' })
  assert.equal(miss.ok, false)
  assert.match(String(miss.error), /没有「不存在的词」/)
})
// ─────────────────────────────────────────────────────────────────────────────
// 群记忆控制台修复（2026-10-23）：并发 CAS / 写入上限 / dir 逃逸 / 唤醒词脏键
// ─────────────────────────────────────────────────────────────────────────────

async function memoryHarness(t, cfg = {}) {
  const h = await boot(t, {
    config: {
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ },
        'group-memory': { enabled: true, dir: 'qq-memory', ...cfg },
      },
    },
  })
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  const memDir = path.join(h.dataDir, 'qq-memory')
  fs.mkdirSync(memDir, { recursive: true })
  return { h, endpoints, memDir }
}

test('群记忆控制台：save 带 ifMtime 时拒绝陈旧覆盖（积累器刚写过）', async (t) => {
  const { h, endpoints, memDir } = await memoryHarness(t)
  const file = path.join(memDir, `${GROUP_ID}.md`)
  fs.writeFileSync(file, '# 群记忆\n## 唤醒与对话风格\n- 旧\n')
  const read = await endpoints.handle('memory', { op: 'read', group_id: GROUP_ID })
  assert.equal(read.ok, true)
  assert.ok(Number(read.mtimeMs) > 0, 'read 应返回 mtimeMs 供前端做 CAS')

  await sleep(20)
  fs.writeFileSync(file, '# 群记忆\n## 唤醒与对话风格\n- 积累器刚写的新内容\n')
  const conflict = await endpoints.handle('memory', {
    op: 'save', group_id: GROUP_ID, content: read.content, ifMtime: read.mtimeMs,
  })
  assert.equal(conflict.ok, false)
  assert.match(String(conflict.error), /已被更新/)
  assert.match(fs.readFileSync(file, 'utf8'), /积累器刚写的新内容/, '冲突时不能覆盖新内容')

  const fresh = await endpoints.handle('memory', { op: 'read', group_id: GROUP_ID })
  const saved = await endpoints.handle('memory', {
    op: 'save', group_id: GROUP_ID, content: '# 群记忆\n## 唤醒与对话风格\n- 手改\n', ifMtime: fresh.mtimeMs,
  })
  assert.equal(saved.ok, true)
  const revs = fs.readdirSync(path.join(memDir, '.revisions'))
  assert.ok(revs.length >= 1, '保存前应留旧版备份')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, '主文件权限应为 0600')
  }
})

test('群记忆控制台：save 上限跟随 maxBytes（避免保存成功但模型读不到）', async (t) => {
  const { endpoints } = await memoryHarness(t, { maxBytes: 1000 })
  const body = `# 群记忆\n## 群里的人\n- ${'很长的内容'.repeat(400)}\n`
  assert.ok(Buffer.byteLength(body, 'utf8') > 1000)
  const r = await endpoints.handle('memory', { op: 'save', group_id: GROUP_ID, content: body })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /超过单篇读取上限/)
})

test('群记忆控制台：setcfg 不允许把 dir 改到数据目录之外', async (t) => {
  const { endpoints } = await memoryHarness(t)
  const bad = await endpoints.handle('memory', { op: 'setcfg', key: 'group-memory.dir', value: '../evil' })
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /数据目录内/)
})

test('群记忆控制台：唤醒词里的非群号数字键不会让 list 整页崩掉', async (t) => {
  const h = await boot(t, {
    config: {
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ, keywords: '123：太短\n456789：正常群' },
        'group-memory': { enabled: true, dir: 'qq-memory' },
      },
    },
  })
  const endpoints = createAdminEndpoints({ kernel: h.kernel, configPath: h.configPath, dataDir: h.dataDir, log: quiet(), ops: null })
  fs.mkdirSync(path.join(h.dataDir, 'qq-memory'), { recursive: true })
  fs.writeFileSync(path.join(h.dataDir, 'qq-memory', '456789.md'), '# 群记忆\n## 唤醒与对话风格\n- x\n')
  const r = await endpoints.handle('memory', { op: 'list' })
  assert.equal(r.ok, true)
  const ids = (r.groups || []).map((g) => g.group_id)
  assert.ok(ids.includes('456789'))
  assert.equal(ids.includes('123'), false, '非 4–12 位数字键应被忽略')
})

test('收表情开关（默认关=库只读）：不采集、不写索引；开了才收；控制台有开关和实时数量', async (t) => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-stk-off-'))
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2048, 1)])
  const stickerFile = path.join(srcDir, 'sticker.png')
  fs.writeFileSync(stickerFile, png)

  // ① 默认（不写 collect）= 关：发一张表情，不该产生索引
  const off = await boot(t, {
    config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, stickers: { enabled: true, dir: 'qq-stickers' } } },
  })
  const statsOff = off.kernel.shared?.stickerStats?.()
  assert.equal(statsOff?.collect, false, '没配 collect 时应按默认关')
  await emitRaw(off.kernel, stickerMessage({ messageId: 3001, subType: 1, file: stickerFile }))
  await sleep(150)
  assert.equal(fs.existsSync(path.join(off.dataDir, 'qq-stickers', 'index.json')), false, '关着时不得写索引')

  // ② 打开 collect = 收
  const on = await boot(t, {
    config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, stickers: { enabled: true, dir: 'qq-stickers', collect: true } } },
  })
  assert.equal(on.kernel.shared?.stickerStats?.().collect, true)
  await emitRaw(on.kernel, stickerMessage({ messageId: 3002, subType: 1, file: stickerFile }))
  await waitFor(() => fs.existsSync(path.join(on.dataDir, 'qq-stickers', 'index.json')), { label: '开 collect 后写索引' })
  const items = JSON.parse(fs.readFileSync(path.join(on.dataDir, 'qq-stickers', 'index.json'), 'utf8')).items || []
  assert.equal(items.length, 1, '开着时应收进 1 张')
  assert.equal(on.kernel.shared.stickerStats().count, 1, '统计数量跟着变')
})

/** 造一个最小表情库：items 各自带 tags，图片是真实存在的 2KB png（挑图要 existsSync 通过）。 */
function makeStickerLib(dataDir, items) {
  const dir = path.join(dataDir, 'qq-stickers')
  fs.mkdirSync(dir, { recursive: true })
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2048, 1)])
  const full = items.map((it, i) => {
    const file = `${it.id || i + 1}-test.png`
    fs.writeFileSync(path.join(dir, file), png)
    return {
      id: it.id || i + 1, hash: 'h' + (it.id || i + 1), file, summary: '[动画表情]',
      fromNick: 'test', fromUid: '1', ts: Date.now(), uses: 0, lastUsed: 0,
      tags: it.tags || [], tagged: Boolean((it.tags || []).length), blocked: false, seenCount: 1,
      desc: it.desc || '', use: it.use || '',
    }
  })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: full, nextId: full.length + 1 }))
  return dir
}

test('表情提示不吃脚手架标签：上下文里的「[群聊上文]」不能点名库里的「群聊」标签', async (t) => {
  const h = await boot(t, {
    // 掷骰概率的权威值在 pacing.reply.style（内核启动时同步覆盖插件 offerPercent）→ 测试里要设 1 才确定命中
    pacing: { reply: { style: { stickerProbability: 1 } } },
    config: {
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: true, dir: 'qq-stickers', offerPercent: 100, offerCooldownMs: 0 },
      },
    },
  })
  // 一张只带元标签「群聊」（旧库里的 #107 就是这种），一张正常情绪标签
  makeStickerLib(h.dataDir, [{ id: 107, tags: ['阴阳怪气', '装凶', '群聊'] }, { id: 45, tags: ['面无表情'] }])
  h.ctx.setPromptHandler(async () => {})
  const ev = groupAtEvent({ text: '随便说一句', messageId: 4001 })
  ev.message = [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '随便说一句' } }]
  await emitRaw(h.kernel, ev)
  await waitFor(() => h.ctx._prompts[0], { label: '进模型' })
  const prompt = h.ctx._prompts[0].content.map((c) => c.text).join('\n')
  assert.ok(!prompt.includes('sticker:"群聊"'), '不能用元标签「群聊」点名（它就是"总发同一张"的根因）')
  assert.ok(prompt.includes('[表情:'), '仍要有表情提示')
})

test('表情挑图轮换：同一个词连发两次不重复（只读模式不写索引也能轮换）', async (t) => {
  const h = await boot(t, {
    config: {
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ },
        stickers: { enabled: true, dir: 'qq-stickers', collect: false },
      },
    },
  })
  const dir = makeStickerLib(h.dataDir, [
    { id: 1, tags: ['无语'] }, { id: 2, tags: ['无语'] }, { id: 3, tags: ['无语'] }, { id: 4, tags: ['无语'] },
  ])
  const indexFile = path.join(dir, 'index.json')
  const before = fs.readFileSync(indexFile, 'utf8')
  const pick = h.kernel.shared.stickerSend
  const got = []
  for (let i = 0; i < 3; i += 1) {
    const r = await pick({ target: `group:${GROUP_ID}`, query: '无语' })
    assert.equal(r.ok, true)
    got.push(r.pick.id)
  }
  assert.equal(new Set(got).size, got.length, `连发三次应各不相同，实际 ${got.join(',')}`)
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before, '只读模式下不得写 index.json')
})

test('控制台数量跟着磁盘走：手删一张图 → 数量立刻 -1，并报"索引指向已删文件"', async (t) => {
  const h = await boot(t, {
    config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, stickers: { enabled: true, dir: 'qq-stickers' } } },
  })
  const dir = makeStickerLib(h.dataDir, [{ id: 1, tags: ['无语'] }, { id: 2, tags: ['得意'] }])
  assert.equal(h.kernel.shared.stickerStats().count, 2)
  assert.equal(h.kernel.shared.stickerStats().dead, 0)
  fs.unlinkSync(path.join(dir, '2-test.png'))
  const st = h.kernel.shared.stickerStats()
  assert.equal(st.count, 1, '删掉图后数量应变为 1')
  assert.equal(st.dead, 1, '要如实报出"索引里还有 1 条指向已删文件"')
})

test('索引只记标签：挑图结果不带 desc/use，关键词只按标签匹配', async (t) => {
  const h = await boot(t, {
    config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, stickers: { enabled: true, dir: 'qq-stickers', collect: false } } },
  })
  // 索引只留标签：即使旧字段（desc/use）还在，也不能再当匹配依据
  makeStickerLib(h.dataDir, [
    { id: 1, tags: ['无语'] },
    { id: 2, tags: ['摆烂'], desc: '无语到极点', use: '无语的时候发' },
  ])
  const pick = h.kernel.shared.stickerSend
  const hit = await pick({ target: `group:${GROUP_ID}`, query: '无语' })
  assert.equal(hit.ok, true)
  assert.equal(hit.pick.id, 1, '关键词只按标签匹配（#2 的 desc/use 里有"无语"也不该被命中）')
  assert.deepEqual(Object.keys(hit.pick).sort(), ['id', 'tags', 'untagged'], '挑图结果只带 id/tags/untagged')
})

test('删除不再写黑名单：清理手删条目只删索引条目，不生成 blocked-hashes.txt', async (t) => {
  const h = await boot(t, {
    config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ }, stickers: { enabled: true, dir: 'qq-stickers', collect: true } } },
  })
  const dir = makeStickerLib(h.dataDir, [{ id: 1, tags: ['无语'] }, { id: 2, tags: ['得意'] }])
  fs.unlinkSync(path.join(dir, '2-test.png')) // 手删一张图
  const r = await h.kernel.shared.stickerSend({ target: `group:${GROUP_ID}`, query: '#1' })
  assert.equal(r.ok, true)
  await sleep(150) // prune 在串行队列里跑，等它落盘
  assert.equal(fs.existsSync(path.join(dir, 'blocked-hashes.txt')), false, '不该再生成 blocked-hashes.txt')
  const items = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).items
  assert.deepEqual(items.map((i) => i.id), [1], '手删文件的那条应被清掉')
})
