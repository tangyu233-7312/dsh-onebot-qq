/**
 * test/audit-console-host.test.js — 控制台 Host 白名单（2026-10-30）
 *
 * 线上两次踩同一个坑：NAS 上手改过 admin/host.js 的 IP 白名单，一重装就被覆盖，
 * 表现是「设置 → QQ 控制台 → 读取失败 transport failure / HTTP 403」。
 * 现在改成自动收集本机网卡地址，这条测试盯着「不要再退回只认回环」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.join(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(root, 'admin', 'host.js'), 'utf8')

test('Host 白名单不能只有回环（NAS 上用局域网 IP 访问会 403）', () => {
  assert.match(src, /networkInterfaces\(\)/, '要靠网卡枚举自动收集，而不是手写 IP')
  assert.match(src, /allowedConsoleHosts/, '要有统一的名单函数')
})

test('允许额外配置的 Host（反代 / 跨网段）', () => {
  assert.match(src, /QQ_CONSOLE_ALLOWED_HOSTS/, '要留一个环境变量口子')
})

test('403 时要留日志（不然只能靠猜）', () => {
  assert.match(src, /拒绝 Host=/, '拒绝时打一行日志')
})

test('不要把具体 IP 写死在源码里', () => {
  const ips = [...src.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0])
  const hardcoded = ips.filter((ip) => !/^(127\.0\.0\.1|0\.0\.0\.0|255\.|10\.0\.2\.)/.test(ip))
  assert.deepEqual(hardcoded, [], '写死 IP 换网络就坏：' + hardcoded.join(','))
})
