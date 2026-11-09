/**
 * test/e2e.test.js — 端到端：假协议端（HTTP + 正向 WS）→ 入站五阶段 → mock 模型回合 → 原生工具 → 出站。
 *
 * 覆盖：
 *   1. 全量装配（9 个子插件自动发现、工具/命令注册、单例）
 *   2. 群消息 @ 本机 → 唤醒 → mock 模型调 `mcp__qq__send_message` → 假协议端 收到（六项脱敏生效）
 *   3. 主人私聊 → 脱敏豁免（配置里的 adminQq 私聊保留敏感信息）
 *   4. `/help` 命令零 token 拦截（不进模型、直接经 deliver 出站）
 *   5. 会话映射落盘（state/sessions.json）
 *
 * 端口全部 listen(0) 动态分配；无 QQ、无网络依赖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, Config } from '../index.js'
import { createConfigStore } from '../admin/store.js'
import { createFakeOneBot } from './fake-onebot.mjs'
import { createMockCtx as createSharedMockCtx } from './helpers.mjs'

const ADMIN_QQ = 10001
const GROUP_ID = 20001

function tmpDir(tag = 'e2e') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqbot-${tag}-`))
}

function writeInstanceConfig(dataDir, onebotUrls, overrides = {}) {
  const raw = {
    version: 2,
    adminQq: ADMIN_QQ,
    onebot: {
      wsUrl: onebotUrls.wsUrl,
      wsToken: '',
      httpUrl: onebotUrls.httpUrl,
      httpToken: '',
    },
    dsh: { agentPreset: '', qqWorkspacePath: 'workspace', sessionsFile: 'state/sessions.json' },
    outbound: { replyMaxLength: 3000, longForwardThreshold: 400, longForwardChunkSize: 800, quoteAfterMsgs: 3 },
    archive: { enabled: false, dir: 'logs/qq_chat' },
    toolPrefix: 'mcp__qq__',
    plugins: {},
    pluginConfig: {
      // 关掉需要外部服务/副作用大的能力，其余保持默认（验证自动发现）
      'link-parser': { enabled: false },
      'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
      ...(overrides.pluginConfig || {}),
    },
    ...overrides,
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(raw, null, 4))
}

async function waitFor(fn, { timeoutMs = 8000, label = '条件' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('e2e：假协议端 全链路（装配 / 群@入站→模型→工具→出站脱敏 / 私聊豁免 / 命令零token / 会话落盘）', async (t) => {
  const fake = createFakeOneBot({ selfId: 999999, adminQq: ADMIN_QQ, groupId: GROUP_ID })
  const urls = await fake.start()
  const dataDir = tmpDir('e2e')
  writeInstanceConfig(dataDir, urls)

  const ctx = createSharedMockCtx()
  // 先注册清理，再 apply：任何断言失败都不会留下假协议端 / 内核（否则测试进程不退出）
  t.after(async () => {
    for (const dispose of ctx._effects) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    await fake.close()
  })
  await apply(ctx, { dataDir, autoConnect: true, compatServer: false })
  const kernel = ctx.get('qqBot')?.kernel
  assert.ok(kernel, 'apply 后应有 qqBot 服务（Cordis 语义：apply 不返回对象）')

  // ── 1. 装配与注册 ────────────────────────────────────────────
  assert.ok(kernel.plugins.length >= 9, '至少 9 个内置子插件全部自动发现并加载')
    for (const id of ['gate-wake', 'commands', 'file-transfer', 'persona-voice', 'group-welcome',
      'imagegen', 'link-parser', 'stickers', 'long-memory']) {
      assert.ok(kernel.plugins.some((p) => p.id === id), `子插件 ${id} 应被加载`)
    }
  assert.equal(kernel.pluginErrors.size, 0, `插件加载不应有错误：${[...kernel.pluginErrors.keys()].join(',')}`)
  const toolNames = [...ctx._registeredTools.keys()]
  assert.ok(toolNames.includes('mcp__qq__send_message'), `应注册 send_message：${toolNames.join(',')}`)
  assert.ok(toolNames.includes('mcp__qq__recall'), '应注册 recall')
  assert.ok(toolNames.length >= 4, `工具数至少 4，实际 ${toolNames.length}`)
  assert.ok(kernel.commands.has('help'), '应注册 /help')

  // 等 WS 连上 + 登录信息就绪（selfId 由假协议端 的 get_login_info 提供）
  await fake.waitForClient()
  await waitFor(() => kernel.onebot.health().linked && kernel.onebot.selfId, { label: '协议端 WS 已连接/selfId' })
  const sendTool = ctx._registeredTools.get('mcp__qq__send_message')

  // ── 2. 群消息 @ 本机 → 唤醒 → mock 模型调工具 → 出站（脱敏）────
  ctx._prompts.length = 0
  fake.sent.length = 0
  ctx.setPromptHandler(async (req) => {
    // 模拟模型：只调一次发消息工具（带敏感内容，验证群聊出口脱敏）
    const sid = req.sessionId
    await sendTool.execute(
      { target: `group:${GROUP_ID}`, text: '回复：服务器 198.51.100.42:8444 密码 abc12345' },
      { agent: { session: { id: sid } } },
    )
  })
  assert.ok(fake.pushEvent(fake.groupMessage({ text: '你好，介绍一下你自己', atSelf: true, messageId: 5001 })) > 0, '应推送到已连接的 WS')

  const promptReq = await waitFor(() => ctx._prompts[0], { label: '群消息触发模型回合' })
  const promptText = promptReq.content[0].text
  assert.ok(promptText.includes('介绍一下你自己'), 'prompt 应包含用户正文')
  assert.ok(promptText.includes(`[QQ会话 group:${GROUP_ID}`) || promptText.includes(`group:${GROUP_ID}`), 'prompt 应带会话标识')
  assert.ok(promptText.includes(`(QQ:${ADMIN_QQ})`), `群消息说话人应带 QQ 号：${promptText}`)

  const sentGroup = await waitFor(() => fake.sent.find((s) => s.action === 'send_group_msg'), { label: '群发送' })
  const wire = String(sentGroup.params.message)
  assert.ok(wire.includes('回复：'), 'QQ 收到模型要发的内容')
  assert.ok(!wire.includes('198.51.100.42'), `群聊出口应脱敏 IP：${wire}`)
  assert.ok(!wire.includes('8444'), `群聊出口应脱敏端口：${wire}`)
  assert.ok(!wire.includes('abc12345'), `群聊出口应脱敏密码：${wire}`)
  assert.ok(sentGroup.params.group_id === GROUP_ID || String(sentGroup.params.group_id) === String(GROUP_ID))

  // ── 3. 主人私聊：出口脱敏唯一豁免 ────────────────────────────
  ctx._prompts.length = 0
  fake.sent.length = 0
  ctx.setPromptHandler(async (req) => {
    await sendTool.execute(
      { target: `private:${ADMIN_QQ}`, text: '私聊原样：198.51.100.42:8444' },
      { agent: { session: { id: req.sessionId } } },
    )
  })
  fake.pushEvent(fake.privateMessage({ text: '在吗', messageId: 6001 }))
  await waitFor(() => ctx._prompts[0], { label: '私聊触发模型回合' })
  const sentPrivate = await waitFor(() => fake.sent.find((s) => s.action === 'send_private_msg'), { label: '私聊发送' })
  assert.ok(String(sentPrivate.params.message).includes('198.51.100.42:8444'), '主人私聊豁免脱敏')

  // ── 4. `/help`：零 token 拦截（不进模型）+ 经 deliver 出站 ─────
  ctx._prompts.length = 0
  fake.sent.length = 0
  ctx.setPromptHandler(async () => {})
  fake.pushEvent(fake.groupMessage({ text: '/help', messageId: 5002 }))
  const sentHelp = await waitFor(() => fake.sent.find((s) => s.action === 'send_group_msg'), { label: '/help 回复' })
  assert.ok(String(sentHelp.params.message).includes('/status'), '/help 应列出已注册命令')
  assert.equal(ctx._prompts.length, 0, '/help 不进模型（零 token）')

  // ── 5. 会话映射落盘（state/sessions.json）────────────────────
  const mapFile = path.join(dataDir, 'state', 'sessions.json')
  const mapping = await waitFor(() => (fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : null), {
    label: '会话映射落盘',
  })
  assert.ok(mapping[`group:${GROUP_ID}`], '群会话映射应落盘')
  assert.ok(mapping[`private:${ADMIN_QQ}`], '私聊会话映射应落盘')
})

test('e2e：缺 adminQq → 待配置模式（控制台/工具可用、不连协议端）；控制台写入后 configReady=true 并自动连接', async (t) => {
  const fake = createFakeOneBot({ selfId: 999999, adminQq: ADMIN_QQ, groupId: GROUP_ID })
  const urls = await fake.start()
  const dataDir = tmpDir('e2e-pending')
  writeInstanceConfig(dataDir, urls, { adminQq: 0 })
  const ctx = createSharedMockCtx()
  t.after(async () => {
    for (const dispose of ctx._effects) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    await fake.close()
  })

  await apply(ctx, { dataDir, autoConnect: true, compatServer: false })
  const kernel = ctx.get('qqBot')?.kernel
  assert.ok(kernel, '待配置模式也应装配成功（不再整行激活失败）')
  assert.equal(kernel.configReady, false, '缺 adminQq → configReady=false')
  assert.ok(kernel.version, 'kernel.version 可用')
  assert.ok(kernel.paths?.defaultPersonaDir, 'kernel.paths.defaultPersonaDir 可用')
  assert.equal(kernel.plugins.length, kernel.pluginDefs.length, '插件全部加载（发现数 == 加载数）')
  assert.equal(kernel.pluginErrors.size, 0)
  assert.ok(ctx._registeredTools.has('mcp__qq__send_message'), '工具已注册（控制台/工具可用）')
  assert.ok(kernel.commands.has('help'), '命令已注册')

  // 不连协议端：等一拍再确认没有 WS 客户端 / health 未连接
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(fake.clientCount, 0, '待配置模式不应发起 OneBot 连接')
  assert.equal(kernel.onebot.health().linked, false)
  const checkBefore = await kernel.checkOneBot()
  assert.equal(checkBefore.ok, false, '未连接时 checkOneBot 返回 ok:false')
  assert.match(String(checkBefore.error), /未连接/)

  // 模拟控制台写配置：config store = 备份 + 原子写 + reloadConfig（真实写入路径）
  const store = createConfigStore({ kernel, configPath: kernel.configPath, dataDir, log: { info() {}, warn() {}, error() {}, debug() {} } })
  const saved = await store.update((raw) => {
    raw.adminQq = ADMIN_QQ
  }, { what: 'onboarding:adminQq' })
  assert.equal(saved.ok, true)
  assert.equal(kernel.configReady, true, '配置就绪后 configReady=true')
  await fake.waitForClient(8000)
  await waitFor(() => kernel.onebot.health().linked, { label: '配置就绪后自动连接协议端' })
  const checkAfter = await kernel.checkOneBot()
  assert.equal(checkAfter.ok, true, '连接后 checkOneBot 走 get_login_info 实测')
  assert.equal(checkAfter.selfId, 999999)
})

test('e2e：待配置模式下 reload 先热应用 协议端地址（不连接），补 adminQq 后自动连接', async (t) => {
  const fake = createFakeOneBot({ selfId: 999999, adminQq: ADMIN_QQ, groupId: GROUP_ID })
  const fakeUrls = await fake.start()
  const dataDir = tmpDir('e2e-pending-reload')
  // 初始：协议端地址是占位死地址（非空，合法），只缺 adminQq → 待配置模式
  writeInstanceConfig(dataDir, { wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' }, { adminQq: 0 })
  const ctx = createSharedMockCtx()
  t.after(async () => {
    for (const dispose of ctx._effects) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    await fake.close()
  })
  await apply(ctx, { dataDir, autoConnect: true, compatServer: false })
  const kernel = ctx.get('qqBot')?.kernel
  assert.ok(kernel)
  assert.equal(kernel.configReady, false)
  assert.equal(kernel.onebot.wsUrl, 'ws://127.0.0.1:1', '初始地址是占位死地址')

  // 第 2 步：用户先填 协议端地址（仍缺 adminQq）→ reload 应热应用地址、保持待配置、不连接
  const rawFile = path.join(dataDir, 'config.json')
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'))
  raw.onebot.wsUrl = fakeUrls.wsUrl
  raw.onebot.httpUrl = fakeUrls.httpUrl
  fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 4)}\n`)
  const r = await kernel.reloadConfig()
  assert.equal(r.ok, true)
  assert.equal(r.pending, true, '只缺 adminQq 的 reload 应返回 pending 而不是抛错')
  assert.equal(r.configReady, false, '仍缺 adminQq → configReady=false')
  assert.deepEqual(r.pendingErrors, ['adminQq 未配置：请在实例配置里填主人 QQ（必填项，无默认）'])
  assert.equal(kernel.onebot.wsUrl, fakeUrls.wsUrl, '待配置模式也热应用 协议端地址')
  assert.equal(kernel.onebot.httpUrl, fakeUrls.httpUrl)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(fake.clientCount, 0, '待配置模式不自动连接协议端')

  // 第 3 步：补上 adminQq → reload 返回就绪并自动连接
  raw.adminQq = ADMIN_QQ
  fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 4)}\n`)
  const r2 = await kernel.reloadConfig()
  assert.equal(r2.ok, true)
  assert.equal(r2.pending, false)
  assert.equal(r2.configReady, true)
  assert.equal(kernel.configReady, true)
  await fake.waitForClient(8000)
  await waitFor(() => kernel.onebot.health().linked, { label: '补 adminQq 后自动连接' })
  const check = await kernel.checkOneBot()
  assert.equal(check.ok, true)
})

test('e2e：配置缺失必填项（其它必填项也缺）→ apply 抛中文错误（不静默半启动）', async () => {
  const dataDir = tmpDir('e2e-badcfg')
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ version: 2, adminQq: 0, onebot: { wsUrl: '', httpUrl: '' } }, null, 2),
  )
  const ctx = createSharedMockCtx()
  await assert.rejects(
    () => apply(ctx, { dataDir, autoConnect: false, compatServer: false }),
    /QQ 机器人配置未就绪[\s\S]*adminQq/,
    '缺 adminQq 必须明确报错',
  )
  assert.equal(ctx.get('qqBot'), undefined, '失败时不应留下半装内核（无 qqBot 服务）')
})

test('e2e：单例保护（重复 apply 返回同一 kernel）', async () => {
  const fake = createFakeOneBot({ selfId: 999999, adminQq: ADMIN_QQ, groupId: GROUP_ID })
  const urls = await fake.start()
  const dataDir = tmpDir('e2e-single')
  writeInstanceConfig(dataDir, urls)
  const ctx = createSharedMockCtx()
  await apply(ctx, { dataDir, autoConnect: false, compatServer: false })
  const first = ctx.get('qqBot')?.kernel
  await apply(ctx, { dataDir, autoConnect: false, compatServer: false })
  assert.equal(ctx.get('qqBot')?.kernel, first, '重复 apply 应复用同一个 kernel（单例）')
  for (const dispose of ctx._effects) dispose()
  await fake.close()
})

// 显式引用 Config，保证（未来的）schema 改动能被测试感知
assert.equal(typeof Config, 'function')
