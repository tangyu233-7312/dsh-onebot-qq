/**
 * test/integration.test.js — 全链路集成：装配 / 唯一出站口 / 入站协调 / 可选兼容网关 / 插件隔离。
 *
 * 迁移自旧 `integration.test.js`：删除 dsh-ops-gate 外部插件、旧 admin 热改、站点 :3971 端口写死等用例；
 * 真 OneBot WS 全链路见 `test/e2e.test.js`。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent } from './helpers.mjs'

/** 用一次性连接发 GET（不用 undici fetch：keep-alive 连接会让测试进程不退出）。 */
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: { connection: 'close' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('http timeout')))
  })
}

async function freePort() {
  const srv = net.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

const cleanups = []
after(async () => {
  for (const fn of cleanups) {
    try {
      await fn()
    } catch {
      /* ignore */
    }
  }
})

test('1. 全量装配：子插件 / 原生工具 / 命令全部注册 + 单例（重复 apply 返回同一 kernel）', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  // 不写死数量：新增子插件不该让测试红
  const wantPlugins = ['gate-wake', 'commands', 'file-transfer', 'persona-voice', 'group-welcome',
    'imagegen', 'link-parser', 'stickers', 'long-memory']
  const loadedIds = h.kernel.plugins.map((p) => p.id)
  for (const id of wantPlugins) assert.ok(loadedIds.includes(id), `子插件 ${id} 应被自动发现并加载`)
  assert.equal(h.kernel.plugins.length, h.kernel.pluginDefs.length, '发现的插件全部加载（无静默跳过）')
  assert.equal(h.kernel.pluginErrors.size, 0, `零加载错误：${[...h.kernel.pluginErrors.keys()].join(',')}`)
  assert.ok(h.kernel.pluginDefs.length >= wantPlugins.length, 'pluginDefs 至少含内置插件')
  // 原生工具只查「关键工具都在、数量不低于预期」，新增工具不该让测试红
  for (const name of ['send_message', 'recall', 'send_image', 'generate_image', 'avatar', 'send_sticker',
    'sticker_catalog', 'remember', 'recall_memory', 'memory_status']) {
    assert.ok(h.kernel.toolDefs.has(name), `应注册原生工具 ${name}`)
  }
  assert.ok(h.kernel.toolDefs.size >= 9, `原生工具至少 9 个，实际 ${[...h.kernel.toolDefs.keys()].join(',')}`)
  // 命令数量不写死（/qzone、/空间 是空间日记加的），只查关键命令都在
  assert.ok(h.kernel.commands.size >= 7, `命令至少 7 个，实际 ${[...h.kernel.commands.keys()].join(',')}`)
  for (const cmd of ['help', 'status', 'reset', 'resetall', 'cancel', 'history', 'quota']) {
    assert.ok(h.kernel.commands.has(cmd), `应注册 /${cmd}`)
  }
  const again = await h.kernel.constructor // 保持断言 API 形状
  assert.equal(again, h.kernel.constructor)
  // 单例：直接复用同一 ctx 再 apply
  const { apply } = await import('../index.js')
  await apply(h.ctx, { dataDir: h.dataDir, autoConnect: false })
  assert.equal(h.ctx.get('qqBot')?.kernel, h.kernel, '重复 apply 复用同一 kernel（单例）')
})

test('2. 唯一出站口 deliver：先抽 [AT:] 再六项脱敏；主人私聊豁免；长文卡片失败降级', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  h.kernel.onebot.resolveMemberByName = async (_gid, name) => (name === '奶茶' ? 123456789 : null)

  const r1 = await h.kernel.deliver(
    `group:${GROUP_ID}`,
    '[AT:奶茶] [AT:qq=888888] 服务器 198.51.100.42:8444 密码 abc12345 群号 987654321',
  )
  assert.deepEqual(r1.ats.sort(), [888888, 123456789].sort(), '[AT:] 在脱敏前提取')
  assert.ok(!r1.text.includes('198.51.100.42'), 'IP 脱敏')
  assert.ok(!r1.text.includes('8444'), '端口脱敏')
  assert.ok(!r1.text.includes('987654321'), '9 位 QQ/群号脱敏')
  assert.ok(h.sent.at(-1).wire.includes('[CQ:at,qq=123456789]'))

  const r2 = await h.kernel.deliver(`private:${ADMIN_QQ}`, '服务器 198.51.100.42:8444 群号 987654321')
  assert.ok(r2.text.includes('198.51.100.42:8444'), '主人私聊豁免脱敏')

  const longText = '这是一段测试长文，用来验证超过阈值时自动打包为合并转发卡片。'.repeat(16)
  const r3 = await h.kernel.deliver(`group:${GROUP_ID}`, longText)
  assert.equal(r3.mode, 'forward', '超阈值走合并转发卡片')
  h.kernel.onebot.sendForward = async () => {
    throw new Error('mock forward error')
  }
  const r4 = await h.kernel.deliver(`group:${GROUP_ID}`, longText)
  assert.equal(r4.mode, 'forward-fallback', '卡片失败降级普通分段')
})

test('3. 入站协调：黑名单拦截不写留档；纯 @ callAck + 接续窗口；/help 零 token', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: {
        'gate-wake': { adminQq: ADMIN_QQ, groupUserBlocklist: `${GROUP_ID}:${MEMBER_QQ}`, groupFollowUpMs: 5000 },
        'persona-voice': { splitReplyEnabled: false },
      },
    },
  })
  t.after(() => h.dispose())

  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    message_id: 10,
    sender: { user_id: MEMBER_QQ, nickname: '黑名单用户' },
    message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '你好' } }],
  })
  assert.equal(h.ctx._prompts.length, 0, '黑名单用户不触发模型')

  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: 50002,
    message_id: 11,
    sender: { user_id: 50002, nickname: '路人甲' },
    message: [{ type: 'at', data: { qq: '999999' } }],
  })
  await waitFor(() => h.sent.length === 1, { label: '纯 @ 罐头话' })
  assert.equal(h.ctx._prompts.length, 0, '纯 @ 不进模型（零 token）')
  assert.ok(h.sent[0].wire.includes('[CQ:reply,id=11]'), 'callAck 引用呼叫消息')

  await emitRaw(h.kernel, {
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP_ID,
    user_id: 50002,
    message_id: 12,
    sender: { user_id: 50002, nickname: '路人甲' },
    message: [{ type: 'text', data: { text: '今天天气怎么样' } }],
  })
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: '接续窗口补正文进模型' })
  assert.ok(prompt.content[0].text.includes('[接上条]'), '接续窗口 prompt 带 [接上条]')

  // /help 不进模型、经 deliver 出站
  const beforePrompts = h.ctx._prompts.length
  const beforeSent = h.sent.length
  await emitRaw(h.kernel, groupAtEvent({ text: '/help', messageId: 13 }))
  await waitFor(() => h.sent.length > beforeSent, { label: '/help 回复' })
  assert.equal(h.ctx._prompts.length, beforePrompts, '/help 不进模型')
  assert.ok(h.sent.at(-1).wire.includes('/status'), '/help 动态列出命令')
})

test('4. 可选兼容网关：compatServer=true 监听动态端口（/health、/send）；端口占用只降级不崩', async (t) => {
  const port = await freePort()
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } } },
    bundle: { compatServer: true, compatPort: port },
  })
  t.after(() => h.dispose())
  await waitFor(async () => {
    try {
      return (await httpGetJson(`http://127.0.0.1:${port}/health`)).status === 200
    } catch {
      return false
    }
  }, { label: 'compat 网关监听' })
  const { body: health } = await httpGetJson(`http://127.0.0.1:${port}/health`)
  assert.equal(health.ok, true)
  assert.ok('onebotLinked' in health)

  // 第二个实例撞同一端口 → EADDRINUSE 只记日志（并跑模式），内核照常可用
  const h2 = await bootKernel({
    config: { pacing: { merge: { enabled: false } } },
    bundle: { compatServer: true, compatPort: port },
  })
  t.after(() => h2.dispose())
  assert.ok(h2.kernel, '端口被占用也能装配成功（兼容层降级）')
  // 不等 listen 落定：卸载时必须由 compat-server.close() 处理 pending listen（防迟到监听占端口）
})

test('5. 插件隔离：plugins[id]=false 完全不加载，其余插件与工具不受影响', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      plugins: { stickers: false },
      pluginConfig: { 'persona-voice': { splitReplyEnabled: false } },
    },
  })
  t.after(() => h.dispose())
  // 基准数：同样的配置但不停用任何插件 → 停用 1 个应当正好少 1 个
  const base = await bootKernel({ config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'persona-voice': { splitReplyEnabled: false } } } })
  t.after(() => base.dispose())
  assert.equal(h.kernel.plugins.length, base.kernel.plugins.length - 1, '停用 1 个插件 → 少加载 1 个')
  assert.equal(h.kernel.pluginErrors.size, 0)
  assert.ok(h.kernel.pluginDefs.find((d) => d.id === 'stickers')?.disabled, 'pluginDefs 标记 disabled')
  assert.ok(h.kernel.toolDefs.has('send_message'), '核心工具仍在')
  assert.equal(h.kernel.toolDefs.has('send_sticker'), false, '停用插件的工具不注册')
})
