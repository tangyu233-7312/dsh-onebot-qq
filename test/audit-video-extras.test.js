/**
 * test/audit-video-extras.test.js — B 站简介/章节/评论进 prompt（2026-11-10）
 *
 * 背景：字幕要登录（B 站限制），所以默认给的是**不需要登录**的文字线索：简介 / 分P章节 / 热门评论。
 * 这里只验插件侧行为：会不会去要、拿到后怎么塞进 hint、开关关了会不会闭嘴。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootKernel } from './helpers.mjs'

const mergeOff = { pacing: { merge: { enabled: false } } }

async function runWith(extrasCfg, extrasPayload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-extras-'));
  const frame = path.join(dir, 'f.jpg');
  fs.writeFileSync(frame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const h = await bootKernel({
    config: {
      ...mergeOff,
      pluginConfig: {
        'link-parser': { enabled: false },
        'video-link-read': { sidecarUrl: 'http://sidecar.invalid', ...extrasCfg },
      },
    },
  });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ u, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      async json() {
        if (u.endsWith('/extras')) return extrasPayload;
        return { ok: true, platform: 'bilibili', title: '测试视频', durationSec: 120, frames: [{ path: frame, sec: 30 }] };
      },
    };
  };
  const ev = {
    chatKey: 'group:1', isGroup: true, groupId: '1', messageId: 1,
    text: '看看 https://www.bilibili.com/video/BV1GJ411x7h7',
    rawText: '看看 https://www.bilibili.com/video/BV1GJ411x7h7', cards: [], rawSegments: [],
    imageParts: [], hint: [], _scratch: Object.create(null), mentionedSelf: true,
    wake: { kind: 'at' }, sender: { qq: 10001 },
  };
  const pipeline = h.kernel.pipeline;
  const origin = pipeline.run.bind(pipeline);
  let captured = null;
  pipeline.run = async (e, terminal) => { captured = e; return origin(e, terminal); };
  h.kernel.onebot.handlers.forEach(() => {});
  // 直接跑 before-turn：hook 是按插件注册的，这里用事件喂进去太绕，改用钩子表
  const list = (h.kernel.pipeline.stages.get('before-turn') || []).filter((s) => s.pluginId === 'video-link-read');
  try {
    for (const s of list) await s.fn(ev);
  } finally {
    globalThis.fetch = realFetch;
    h.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ev, calls, captured };
}

const PAYLOAD = {
  ok: true, platform: 'bilibili', title: '测试视频',
  desc: '这是简介，讲的是抽帧看不出来的背景',
  chapters: ['第一段：开场', '第二段：正文'],
  comments: [{ user: 'a', text: '这视频笑死我了', likes: 12 }],
  danmaku: ['哈哈哈', '前方高能'],
};

test('EXTRAS 默认去要简介/章节/评论，并塞进 hint', async () => {
  const { ev, calls } = await runWith({}, PAYLOAD);
  assert.ok(calls.some((c) => c.u.endsWith('/extras')), '应该请求 /extras')
  const joined = ev.hint.join('\n');
  assert.match(joined, /这是简介/, '简介要进来');
  assert.match(joined, /第一段：开场/, '章节要进来');
  assert.match(joined, /这视频笑死我了/, '评论要进来');
  assert.match(joined, /不是画面内容/, '要标明这些不是画面');
  assert.doesNotMatch(joined, /哈哈哈/, '弹幕默认不进');
})

test('EXTRAS 打开弹幕后才会带上弹幕样本', async () => {
  const { ev } = await runWith({ extrasDanmaku: true }, PAYLOAD);
  assert.match(ev.hint.join('\n'), /哈哈哈/, '开了就要带上弹幕');
})

test('EXTRAS 关掉后完全不请求 /extras', async () => {
  const { calls } = await runWith({ extras: false }, PAYLOAD);
  assert.equal(calls.some((c) => c.u.endsWith('/extras')), false);
})
