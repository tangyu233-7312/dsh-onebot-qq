import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startSidecar } from './sidecar-fixture.mjs'

test('HTTP /config 原子保存合法 JSON，只更新允许项，后续请求仍能处理', async t => {
  const s = await startSidecar(t)
  const result = await s.request('/config', { subtitle: false, subtitleMaxChars: 1200, host: 'attacker.invalid' })
  assert.equal(result.ok, true)
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'sidecar.config.json'), 'utf8'))
  assert.equal(saved.subtitle, false)
  assert.equal(saved.subtitleMaxChars, 1200)
  assert.equal(saved.host, '127.0.0.1', '请求不能改监听地址')
  assert.equal((await s.request('/read', {})).code, 'bad_request')
})

test('默认配置 QQ CDN 可读取；内网和伪后缀域名拒绝', async t => {
  const s = await startSidecar(t, { defaults: true })
  const result = await s.request('/read', { url: 'https://multimedia.nt.qq.com.cn/fixture.mp4' })
  assert.equal(result.ok, true, JSON.stringify(result))
  for (const url of ['http://127.0.0.1/private', 'https://qq.com.attacker.invalid/video']) {
    assert.equal((await s.request('/read', { url })).code, 'denied', url)
  }
})
