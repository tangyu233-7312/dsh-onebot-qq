/**
 * test/audit-qzone.test.js — QQ 空间日记子插件（order 62）
 *
 * 覆盖三条最容易回归的行为：
 *   · **"不写"绝不进空间**：skip_qzone 一次都不调协议端；post_qzone 收到"不写"正文时拒绝
 *   · **配额**：每会话每天上限；跨会话互不干扰
 *   · **配图**：拒绝表情包库里的文件（防污染固定图库）
 *
 * 打桩方式：直接替掉 kernel.onebot.sendQzoneMsg，不碰真实协议端。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootKernel, GROUP_ID, ADMIN_QQ } from './helpers.mjs'
import QZONE from '../plugins/qzone/index.js'

const GROUP_KEY = `group:${GROUP_ID}`
const PRIVATE_KEY = `private:${ADMIN_QQ}`

/** 起内核 + 给 sendQzoneMsg 打桩；返回调用记录 */
async function boot() {
  const env = await bootKernel({ config: { pluginConfig: { qzone: { enabled: true, dailyLimit: 1, nudgeHour: 0 } } } })
  const calls = []
  env.kernel.onebot.sendQzoneMsg = async (params) => {
    calls.push(params)
    return { ok: true }
  }
  const tool = (name) => env.ctx._registeredTools.get(`mcp__qq__${name}`)
  return { ...env, calls, tool }
}

test('qzone 插件已装配，三个工具都在', async () => {
  const { tool, dispose } = await boot()
  try {
    for (const name of ['post_qzone', 'skip_qzone', 'qzone_status']) {
      assert.ok(tool(name), `应注册 ${name}`)
    }
  } finally {
    dispose()
  }
})

test('skip_qzone 不发任何内容', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    const r = await tool('skip_qzone').execute({ target: GROUP_KEY, reason: '今天没啥好写的' })
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true)
    assert.equal(calls.length, 0, 'skip 不该调用协议端')
  } finally {
    dispose()
  }
})

test('post_qzone 正文是「不写」时拒绝（不发出去）', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    const r = await tool('post_qzone').execute({ target: GROUP_KEY, content: '今天不写' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /skip_qzone/)
    assert.equal(calls.length, 0, '被拦下时不该调用协议端')
  } finally {
    dispose()
  }
})

test('post_qzone 正常内容会发出去，且带内容与字数', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    const r = await tool('post_qzone').execute({ target: GROUP_KEY, content: '今天遇到一件小事。' })
    assert.equal(r.ok, true)
    assert.equal(r.posted, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].content, '今天遇到一件小事。')
    assert.equal(r.chars, '今天遇到一件小事。'.length)
  } finally {
    dispose()
  }
})

test('配额：同一会话当天第二条被拒', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    const first = await tool('post_qzone').execute({ target: GROUP_KEY, content: '第一条' })
    assert.equal(first.ok, true)
    const second = await tool('post_qzone').execute({ target: GROUP_KEY, content: '第二条' })
    assert.equal(second.ok, false)
    assert.match(second.reason, /今天已经写过/)
    assert.equal(calls.length, 1, '第二条不该发出去')
  } finally {
    dispose()
  }
})

test('配额是全账号的：一个群写过，私聊也发不出（空间只有一个）', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    assert.equal((await tool('post_qzone').execute({ target: GROUP_KEY, content: '群里的' })).ok, true)
    const second = await tool('post_qzone').execute({ target: PRIVATE_KEY, content: '私聊的' })
    assert.equal(second.ok, false, '全账号一天一条，换条线也不行')
    assert.equal(calls.length, 1)
  } finally {
    dispose()
  }
})

test('qzone_status 反映当天使用情况', async () => {
  const { tool, dispose } = await boot()
  try {
    const before = await tool('qzone_status').execute({ target: GROUP_KEY })
    assert.equal(before.used, 0)
    assert.equal(before.remaining, 1)
    await tool('post_qzone').execute({ target: GROUP_KEY, content: '写一条' })
    const after = await tool('qzone_status').execute({ target: GROUP_KEY })
    assert.equal(after.used, 1)
    assert.equal(after.remaining, 0)
  } finally {
    dispose()
  }
})

test('skip：工作区里调用才算「今天不写」', async () => {
  const { tool, dispose } = await boot()
  try {
    await tool('skip_qzone').execute({ target: 'desk', reason: '不想写' })
    const s = await tool('qzone_status').execute({ target: 'desk' })
    assert.equal(s.skippedToday, true)
    assert.equal(s.skipReason, '不想写')
    assert.equal(s.decided, true)
    assert.equal(s.used, 0)
  } finally {
    dispose()
  }
})

test('skip：在任何对话里说的「不写」都算数（2026-10-30 改语义）', async () => {
  // 以前只有 desk（空间工作区）里说的才真的生效，家里说的不算 —— 正是"割裂"的一种。
  // 现在它在私聊/群里说「今天不写」，就是真的不写。
  const { tool, dispose } = await boot()
  try {
    const r = await tool('skip_qzone').execute({ target: GROUP_KEY, reason: '这会儿不想写' })
    assert.equal(r.global, true)
    const s = await tool('qzone_status').execute({ target: GROUP_KEY })
    assert.equal(s.skippedToday, true, '说的不写要算数')
    assert.equal(s.decided, true)
  } finally {
    dispose()
  }
})

test('skip：target 留空 = 当前对话（家里直接说不用带参数）', async () => {
  const { tool, dispose } = await boot()
  try {
    const r = await tool('skip_qzone').execute({ reason: '今天没什么想记的' })
    assert.equal(r.ok, true)
    assert.equal(r.global, true)
  } finally {
    dispose()
  }
})

test('配图：默认允许引用表情包库（只读，不改库）', async () => {
  const { tool, calls, dataDir, dispose } = await boot()
  try {
    const stickerDir = path.join(dataDir, 'qq-stickers')
    fs.mkdirSync(stickerDir, { recursive: true })
    const sticker = path.join(stickerDir, '1-abc.png')
    fs.writeFileSync(sticker, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const r = await tool('post_qzone').execute({
      target: GROUP_KEY, content: '带图的一条', images: [sticker],
    })
    assert.equal(r.ok, true, '表情包库是只读引用，不该被拦')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].images[0], fs.realpathSync(sticker))
  } finally {
    dispose()
  }
})

test('配图：allowStickers=false 时拒绝表情包库', async () => {
  const env = await bootKernel({
    config: { pluginConfig: { qzone: { enabled: true, dailyLimit: 1, nudgeHour: 0, allowStickers: false } } },
  })
  const calls = []
  env.kernel.onebot.sendQzoneMsg = async (p) => { calls.push(p); return { ok: true } }
  const tool = (n) => env.ctx._registeredTools.get(`mcp__qq__${n}`)
  try {
    const stickerDir = path.join(env.dataDir, 'qq-stickers')
    fs.mkdirSync(stickerDir, { recursive: true })
    const sticker = path.join(stickerDir, '2-abc.png')
    fs.writeFileSync(sticker, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = await tool('post_qzone').execute({ target: GROUP_KEY, content: '带图的一条', images: [sticker] })
    assert.equal(r.ok, false)
    assert.match(r.reason, /表情包/)
    assert.equal(calls.length, 0)
  } finally {
    env.dispose()
  }
})

test('配图：不存在的路径直接被拒', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    const r = await tool('post_qzone').execute({
      target: GROUP_KEY, content: '带图的一条', images: ['/definitely/not/here.png'],
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不存在/)
    assert.equal(calls.length, 0)
  } finally {
    dispose()
  }
})

test('配图：合法路径会作为 images 传给协议端', async () => {
  const { tool, calls, dataDir, dispose } = await boot()
  try {
    const okDir = path.join(dataDir, 'qzone-imgs')
    fs.mkdirSync(okDir, { recursive: true })
    const pic = path.join(okDir, 'diary.png')
    fs.writeFileSync(pic, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const r = await tool('post_qzone').execute({ target: GROUP_KEY, content: '配一张图', images: pic })
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].images.length, 1)
    assert.equal(calls[0].images[0], fs.realpathSync(pic))
  } finally {
    dispose()
  }
})

test('协议端失败时如实返回 ok:false，且不记账', async () => {
  const { tool, kernel, dispose } = await boot()
  try {
    kernel.onebot.sendQzoneMsg = async () => ({ ok: false, msg: '协议端不支持' })
    const r = await tool('post_qzone').execute({ target: GROUP_KEY, content: '会失败的一条' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /协议端不支持/)
    // 失败的尝试不该占用当天额度
    const s = await tool('qzone_status').execute({ target: GROUP_KEY })
    assert.equal(s.used, 0)
  } finally {
    dispose()
  }
})

test('超长正文被截断而不是报错', async () => {
  const { tool, calls, dispose } = await boot()
  try {
    const long = '啊'.repeat(400) // 默认上限 300
    const r = await tool('post_qzone').execute({ target: GROUP_KEY, content: long })
    assert.equal(r.ok, true)
    assert.equal(r.chars, 300)
    assert.equal(calls[0].content.length, 300)
  } finally {
    dispose()
  }
})

// ── 额度持久化（跨重启）─────────────────────────────────────

test('额度落盘：写过之后 qzone-state.json 按天记录', async () => {
  const { tool, dataDir, dispose } = await boot()
  try {
    await tool('post_qzone').execute({ target: GROUP_KEY, content: '要落盘的一条' })
    const file = path.join(dataDir, 'qzone-state.json')
    assert.ok(fs.existsSync(file), '应有 qzone-state.json')
    const st = JSON.parse(fs.readFileSync(file, 'utf8'))
    const d = new Date()
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    assert.ok(st.days && st.days[key], '应有当天的记录')
    assert.equal(st.days[key].date, key)
    assert.equal(st.days[key].posted, 1)
    assert.equal(st.days[key].source, GROUP_KEY, '记下来源，方便排障')
  } finally {
    dispose()
  }
})

test('额度跨重启保留：卸载后用同一 dataDir 重装，配额仍然占着', async () => {
  const first = await boot()
  const { dataDir, tool, dispose } = first
  try {
    assert.equal((await tool('post_qzone').execute({ target: GROUP_KEY, content: '第一次' })).ok, true)
  } finally {
    dispose()
  }

  // 模拟重启：同一 dataDir 重新装配
  const env2 = await bootKernel({ dataDir, config: { pluginConfig: { qzone: { enabled: true, dailyLimit: 1, nudgeHour: 0 } } } })
  const calls2 = []
  env2.kernel.onebot.sendQzoneMsg = async (p) => { calls2.push(p); return { ok: true } }
  const tool2 = (n) => env2.ctx._registeredTools.get(`mcp__qq__${n}`)
  try {
    const s = await tool2('qzone_status').execute({ target: GROUP_KEY })
    assert.equal(s.used, 1, '重启后应记得已经写过 1 条')
    assert.equal(s.remaining, 0)
    const r = await tool2('post_qzone').execute({ target: GROUP_KEY, content: '重启后的第二条' })
    assert.equal(r.ok, false, '额度应该已经被占住')
    assert.equal(calls2.length, 0, '不该真的发出去')
  } finally {
    env2.dispose()
  }
})

test('skip 也落盘（重启后仍记得今天跳过过）', async () => {
  const first = await boot()
  const { dataDir, tool, dispose } = first
  try {
    await tool('skip_qzone').execute({ target: 'desk', reason: '没想写的' })
  } finally {
    dispose()
  }

  const env2 = await bootKernel({ dataDir, config: { pluginConfig: { qzone: { enabled: true, dailyLimit: 1, nudgeHour: 0 } } } })
  const tool2 = (n) => env2.ctx._registeredTools.get(`mcp__qq__${n}`)
  try {
    const s = await tool2('qzone_status').execute({ target: GROUP_KEY })
    assert.equal(s.skippedToday, true)
    assert.equal(s.used, 0, 'skip 不占发布额度')
  } finally {
    env2.dispose()
  }
})

// ── 控制台计数 ──────────────────────────────────────────────

test('控制台 info：没写时说明还没写，写过之后显示 N/M', async () => {
  const { tool, dispose } = await boot()
  try {
    let text = getQzoneInfoText()
    assert.match(text, /今日还没写/, `零条时应说明还没写，实际：${text.slice(0, 60)}`)

    await tool('post_qzone').execute({ target: GROUP_KEY, content: '计数测试' })
    text = getQzoneInfoText()
    assert.match(text, /今日已发 1\/1/, `写过之后应显示 1/1，实际：${text.slice(0, 60)}`)
    assert.match(text, /写了：计数测试/, '时间线里应带正文摘要')
  } finally {
    dispose()
  }
})

test('控制台 info：工作区里跳过之后显示「今天决定不写 + 理由」', async () => {
  const { tool, dispose } = await boot()
  try {
    await tool('skip_qzone').execute({ target: 'desk', reason: '今天没啥好记的' })
    const text = getQzoneInfoText()
    assert.match(text, /今日决定不写：今天没啥好记的/)
    assert.match(text, /没写：今天没啥好记的/, '时间线里也该有理由')
  } finally {
    dispose()
  }
})

/** 取插件 configSchema.info.text（它会走 getter，现算计数） */
function getQzoneInfoText() {
  return String(QZONE.configSchema.info.text)
}
