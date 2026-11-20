import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import http from 'node:http'
import { createAdminHost } from '../admin/host.js'

test('控制台 HTTP：回环、本机网卡和额外 Host 可用；陌生 Host 被拒绝', async t => {
  const previous = process.env.QQ_CONSOLE_ALLOWED_HOSTS
  process.env.QQ_CONSOLE_ALLOWED_HOSTS = 'console.example.invalid'
  t.after(() => {
    if (previous === undefined) delete process.env.QQ_CONSOLE_ALLOWED_HOSTS
    else process.env.QQ_CONSOLE_ALLOWED_HOSTS = previous
  })
  let handler
  const logs = []
  const host = await createAdminHost({
    ctx: { webServer: { register(route) { handler = route.handler } } },
    kernel: {}, ops: {}, log: { info(message) { logs.push(message) }, warn() {} },
  })
  t.after(() => host.dispose())
  assert.ok(handler, '公开宿主入口应注册 HTTP handler')
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const locals = Object.values(os.networkInterfaces()).flat().filter(x => x?.family === 'IPv4').map(x => x.address)
  for (const name of ['localhost', '127.0.0.1', ...new Set(locals), 'console.example.invalid', 'unknown.example.invalid']) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/qq-console/unknown', method: 'POST', headers: { host: name }, agent: false }, res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      request.on('error', reject)
      request.end('{}')
    })
    assert.equal(response.status, name.startsWith('unknown.') ? 403 : 200, name)
    if (response.status === 200) assert.equal(JSON.parse(response.body).result.value.ok, false, '未知端点干净返回业务错误')
    else assert.ok(logs.some(message => message.includes('拒绝 Host=' + name)), '拒绝请求应留下可诊断的日志')
  }
})
