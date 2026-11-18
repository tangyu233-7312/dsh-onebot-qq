/**
 * audit-sidecar-config — 侧车配置文件的自保：写出去的东西必须能被读回来
 *
 * 为什么单独一个用例：2026-11-18 线上出现「机器人看不了群里**直接发的视频**，但 B 站链接照常能看」。
 * 根因是 `writeConfig()` 结尾写成了 `'\\n'`（字面反斜杠 + 字母 n），控制台每保存一次
 * 「链接解析」设置，`sidecar.config.json` 就变成**非法 JSON**；侧车下次启动整份退回 DEFAULTS，
 * 而 DEFAULTS 的 allowedHosts 当时只有 B 站三个域名 → QQ CDN（multimedia.nt.qq.com.cn）
 * 被判「域名不在白名单」。所以这里钉三件事：
 *   ① 写配置不夹带字面 `\n`，产物一定是合法 JSON；
 *   ② 退回 DEFAULTS 时 QQ 直发视频的域名还得在，退化不能把主链路一起带走；
 *   ③ 站点配置本身合法、且含 QQ CDN 域名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SIDECAR = path.join(import.meta.dirname, '..', 'sidecar', 'server.mjs')
const CFG_FILE = path.join(import.meta.dirname, '..', 'sidecar', 'sidecar.config.json')
const src = fs.readFileSync(SIDECAR, 'utf8')

/** 从源码里抠出 writeConfig 的真实实现，用内存 fs 跑一遍（不落盘） */
function runWriteConfig(next) {
  const body = src.match(/function writeConfig\(next\) \{[\s\S]*?\n\}/)
  assert.ok(body, '源码里应该有 writeConfig')
  const written = new Map()
  const fakeFs = {
    writeFileSync: (p, text) => written.set(p, text),
    renameSync: (p, dest) => written.set(dest, written.get(p)),
  }
  const fakePath = { join: (...p) => p.join('/') }
  const fn = new Function('fs', 'path', 'HERE', 'process', `${body[0]}; return writeConfig`)(// eslint-disable-line no-new-func
    fakeFs, fakePath, '/sidecar', { pid: 4321 })
  fn(next)
  const target = '/sidecar/sidecar.config.json'
  assert.ok(written.has(target), '应该写到 sidecar.config.json')
  return written.get(target)
}

test('writeConfig 写出的配置是合法 JSON（不许夹带字面 \\n）', () => {
  const text = runWriteConfig({ port: 3972, allowedHosts: ['bilibili.com'] })
  assert.doesNotThrow(() => JSON.parse(text), '产物必须能被 JSON.parse —— 否则侧车启动会整份退回默认值')
  assert.ok(text.endsWith('\n'), '结尾只该有一个真换行')
  assert.ok(!/\\\\n$/.test(text), '结尾不许是字面反斜杠 + n')
})

test('源码里没有 "\\n" 这种双反斜杠写法残留（这次的真凶）', () => {
  assert.doesNotMatch(src, /JSON\.stringify\([^)]*\)\s*\+\s*'\\\\n'/, "别再写成 '\\\\n'")
  assert.match(src, /JSON\.stringify\(next, null, 4\) \+ '\\n'/, "应该是 '\\n'")
})

test('退回 DEFAULTS 时 QQ 直发视频的域名仍在白名单里', () => {
  const block = src.match(/allowedHosts: \[([\s\S]*?)\],/)
  assert.ok(block, 'DEFAULTS 里应有 allowedHosts')
  const hosts = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  // multimedia.nt.qq.com.cn 靠后缀 'nt.qq.com.cn' 命中
  assert.ok(hosts.includes('nt.qq.com.cn'), '默认值必须含 nt.qq.com.cn（QQ 直发视频的 CDN）')
  assert.ok(hosts.includes('qq.com'), '默认值必须含 qq.com')
  for (const h of ['bilibili.com', 'b23.tv', 'bili2233.cn']) assert.ok(hosts.includes(h), 'B 站域名别丢：' + h)
  // 后缀匹配语义：确认 multimedia.nt.qq.com.cn 真的能被放行
  const host = 'multimedia.nt.qq.com.cn'
  assert.ok(hosts.some((d) => host === d || host.endsWith('.' + d)), 'multimedia.nt.qq.com.cn 应被判为允许')
})

test('站点配置 sidecar.config.json 合法且含 QQ CDN', () => {
  const raw = fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')
  const cfg = JSON.parse(raw) // 抛错就说明文件坏了
  const hosts = cfg.allowedHosts || []
  const host = 'multimedia.nt.qq.com.cn'
  assert.ok(hosts.some((d) => host === d || host.endsWith('.' + d)), '站点配置也要能放行 QQ 直发视频')
})
