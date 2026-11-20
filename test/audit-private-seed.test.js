import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bootKernel, tmpDir } from './helpers.mjs'
import { flushPacing, MIN } from './pacing-fixture.mjs'

for (const [name, history, expected] of [['有历史', true, 1], ['没有历史', false, 0]]) {
  test('重启私聊基线：' + name, async t => {
    const dataDir = tmpDir('seed')
    const arch = path.join(dataDir, 'logs', 'qq_chat')
    fs.mkdirSync(arch, { recursive: true })
    if (history) fs.writeFileSync(path.join(arch, 'private_10001.jsonl'), JSON.stringify({
      dir: 'in', ts: Date.now() - 5 * 60 * MIN, sender: { qq: 10001, name: 'master' }, text: 'hi',
    }) + '\n')
    const h = await bootKernel({ dataDir, config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { reply: { enabled: true, quietEnabled: false, privateEnabled: true,
        privateFriendsOnly: false, privateQqs: [10001], privateColdSilenceMs: 2 * 60 * MIN, silenceEnabled: false } },
    } })
    t.after(() => h.dispose())
    h.kernel.pacing.tickNow(); await flushPacing()
    assert.equal(h.ctx._prompts.length, expected, '旧历史能恢复冷场，无历史从开机算起')
  })
}
