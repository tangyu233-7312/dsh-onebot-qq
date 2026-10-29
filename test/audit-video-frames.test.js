/**
 * audit-video-frames — 动态抽帧：短视频 8 帧、长视频 11 帧
 *
 * 为什么按时长走：10 分钟的片子 8 帧够概括，11 分钟以上会开始漏内容；
 * 而 1 分钟的小视频抽 11 帧纯属浪费（相邻帧几乎一样）。
 * 阈值与帧数都在控制台可调，侧车只按实际时长选一个并卡硬上限。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SIDECAR = path.join(import.meta.dirname, '..', 'sidecar', 'server.mjs')
const src = fs.readFileSync(SIDECAR, 'utf8')

test('侧车有动态抽帧函数，阈值/帧数都从请求来', () => {
  assert.match(src, /function pickFrames\(durSec, \{ frames, framesLong, framesSplitSec \}\)/)
  assert.match(src, /const want = Number\(durSec\) > split \? long : short/)
  assert.match(src, /Math\.min\(HARD_CAP_FRAMES, want\)/, '要有硬上限，别让人填 999')
})

test('extractFrames 按实际时长选帧数，不再只用请求里的固定值', () => {
  assert.match(src, /const n = pickFrames\(duration, \{ frames, framesLong, framesSplitSec \}\)/)
  assert.doesNotMatch(src, /const n = Math\.max\(1, Math\.min\(HARD_CAP_FRAMES, Number\(frames\) \|\| CFG\.maxFrames\)\)/)
})

test('调用处把三个参数都传进去了', () => {
  assert.match(src, /frames: LIM\.frames,\s*\n\s*framesLong: body\.framesLong,\s*\n\s*framesSplitSec: body\.framesSplitSec,/)
})

test('两个视频插件都带上默认规则（8 / 11 / 600 秒）', async () => {
  for (const p of ['video-read', 'video-link-read']) {
    const m = (await import('../plugins/' + p + '/index.js')).default
    assert.equal(m.configSchema.frames.default, 8, p + ' 短视频帧数')
    assert.equal(m.configSchema.framesLong.default, 11, p + ' 长视频帧数')
    assert.equal(m.configSchema.framesSplitSec.default, 600, p + ' 分界秒数')
  }
})

test('请求体把规则传给侧车', () => {
  for (const p of ['video-read', 'video-link-read']) {
    const s = fs.readFileSync(path.join(import.meta.dirname, '..', 'plugins', p, 'index.js'), 'utf8')
    assert.match(s, /framesLong: Number\(cfg\(\)\.framesLong\) \|\| 11/, p + ' 应传 framesLong')
    assert.match(s, /framesSplitSec: Number\(cfg\(\)\.framesSplitSec\) \|\| 600/, p + ' 应传 framesSplitSec')
  }
})

// ── 纯逻辑复刻（侧车是独立脚本，直接 eval 那段函数）──
test('pickFrames 的判定：<=10 分钟 8 帧，>10 分钟 11 帧', () => {
  const CFG = { maxFrames: 12 }
  const HARD_CAP_FRAMES = 24
  const pickFrames = (durSec, { frames, framesLong, framesSplitSec }) => {
    const short = Number(frames) > 0 ? Math.round(Number(frames)) : CFG.maxFrames
    const long = Number(framesLong) > 0 ? Math.round(Number(framesLong)) : short
    const split = Number(framesSplitSec) > 0 ? Number(framesSplitSec) : 600
    const want = Number(durSec) > split ? long : short
    return Math.max(1, Math.min(HARD_CAP_FRAMES, want))
  }
  const rule = { frames: 8, framesLong: 11, framesSplitSec: 600 }
  assert.equal(pickFrames(30, rule), 8, '30 秒')
  assert.equal(pickFrames(599, rule), 8, '9:59')
  assert.equal(pickFrames(600, rule), 8, '正好 10:00 → 还是短的（> 才切）')
  assert.equal(pickFrames(601, rule), 11, '10:01 → 长的')
  assert.equal(pickFrames(676, rule), 11, '11:16（就是那条被拒过的）')
  assert.equal(pickFrames(3600, rule), 11, '1 小时')
  // 硬上限 & 缺省
  assert.equal(pickFrames(3600, { frames: 8, framesLong: 999 }), 24, '超上限被压到 24')
  assert.equal(pickFrames(100, { frames: 0, framesLong: 0, framesSplitSec: 0 }), 12, '没传就用配置默认')
})
