/**
 * test/audit-video-subtitle.test.js — B 站字幕进 prompt（2026-11-10）
 *
 * 背景：以前只看抽帧，8~11 帧里偶尔扫到一点屏幕字幕；现在侧车用 yt-dlp 把字幕轨也下下来，
 * 转成「[mm:ss] 文本」交给模型。这里盯解析与截断两件事（不跑 yt-dlp/ffmpeg）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { srtToLines, subtitleText } from '../sidecar/subtitle.mjs'

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '今天讲一下 <i>DeepSeek</i> 的新模型',
  '',
  '2',
  '00:01:05,500 --> 00:01:08,000',
  '它的上下文窗口有一百万 token',
  '',
  '3',
  '01:02:03,000 --> 01:02:05,000',
  '最后总结一下',
].join('\n')

test('SUBTITLE srt → [mm:ss] 行，去标签、时间戳正确', () => {
  const rows = srtToLines(SRT)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].line, '[00:01] 今天讲一下 DeepSeek 的新模型')
  assert.equal(rows[1].line, '[01:05] 它的上下文窗口有一百万 token')
  assert.equal(rows[2].line, '[62:03] 最后总结一下')
})

test('SUBTITLE 超过上限时按时间均匀截段（保开头与结尾）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-srt-'))
  const file = path.join(dir, 'x.zh.srt')
  const many = []
  for (let i = 0; i < 500; i += 1) {
    const s = i;
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    many.push(String(i + 1), `${mm}:${ss},000 --> ${mm}:${ss},900`, '这一句是第 ' + i + ' 句，内容要够长才能触发截断逻辑，再补一些字。', '');
  }
  fs.writeFileSync(file, many.join('\n'), 'utf8')
  const full = subtitleText([file], 100000)
  assert.ok(full.chars > 10000, '不截断时应该有上万字')
  const cut = subtitleText([file], 2000)
  assert.ok(cut.chars <= 2000, '截断后不超过上限，实际 ' + cut.chars)
  assert.equal(cut.truncated, true)
  assert.match(cut.text, /第 0 句/, '开头要保住')
})

test('SUBTITLE 没有字幕文件时安静返回空', () => {
  assert.deepEqual(subtitleText([], 6000), { text: '', chars: 0, lines: 0 })
  assert.equal(subtitleText(['/nope/x.srt'], 6000).text, '')
})
