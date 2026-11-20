// Run the complete sidecar in a temporary process. Only external commands and
// remote downloads are replaced; HTTP, config, cache and files remain real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'

export async function startSidecar(t, { defaults = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-http-'))
  for (const file of ['server.mjs', 'subtitle.mjs']) {
    fs.copyFileSync(new URL('../sidecar/' + file, import.meta.url), path.join(dir, file))
  }
  if (!defaults) fs.writeFileSync(path.join(dir, 'sidecar.config.json'), JSON.stringify({
    port: 0, host: '127.0.0.1', maxSeconds: 7200,
  }))
  // Keep the source intact; instrument listening only to discover port 0.
  fs.copyFileSync(new URL('../scripts/test-fixtures/sidecar-runner.mjs', import.meta.url), path.join(dir, 'runner.mjs'))
  const child = fork(path.join(dir, 'runner.mjs'), [], {
    env: { ...process.env, TEMP: dir, TMP: dir }, silent: true,
  })
  let logs = ''
  child.stdout.on('data', c => { logs += c })
  child.stderr.on('data', c => { logs += c })
  t.after(async () => {
    if (child.exitCode === null) {
      const done = once(child, 'exit')
      child.kill()
      await done
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar startup timeout: ' + logs)), 10000)
    child.once('message', message => { clearTimeout(timer); resolve(message.port) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('sidecar exited ' + code + ': ' + logs)) })
  })
  const request = async (route, body = {}) => {
    const response = await fetch('http://127.0.0.1:' + port + route, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
    return response.json()
  }
  return { dir, request, file(seconds) {
    const file = path.join(dir, 'video-' + seconds + '.mp4')
    fs.writeFileSync(file, 'fixture video')
    return file
  } }
}
