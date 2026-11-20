// Child fixture: replace expensive external boundaries, never sidecar logic.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const listen = http.Server.prototype.listen
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send?.({ port: this.address().port }))
  // Also cover fallback DEFAULTS without using the production port.
  args[0] = 0
  return listen.apply(this, args)
}
childProcess.execFile = (command, args, options, callback) => {
  try {
    let stdout = ''
    if (args.includes('-show_entries')) {
      const file = args.at(-1)
      const seconds = /video-(\d+)\.mp4/.exec(file)?.[1] || 60
      stdout = String(seconds)
    } else if (args.includes('-frames:v')) {
      const file = args[args.indexOf('-y') + 1]
      fs.writeFileSync(file, Buffer.from([255, 216, 255, 217]))
    } else if (args.includes('-J')) {
      stdout = JSON.stringify({ title: 'fixture', duration: 60, extractor: 'Bilibili' })
    } else if (args.includes('--version')) {
      stdout = 'fixture'
    } else if (args.includes('-o')) {
      const template = args[args.indexOf('-o') + 1]
      const file = template.replace('%(id)s', 'fixture').replace('%(ext)s', 'mp4')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'fixture video')
      if ((args.includes('--write-subs') || args.includes('--write-auto-subs')) && args.includes('--cookies')) {
        fs.writeFileSync(file.replace(/\.mp4$/, '.ai-zh.srt'),
          '1\n00:00:01,000 --> 00:00:03,000\n字幕测试内容\n\n2\n00:01:01,000 --> 00:01:03,000\n结尾字幕\n')
      }
      stdout = file
    } else throw new Error('Unexpected external command: ' + args.join(' '))
    const stderr = args.includes('--write-subs') && !args.includes('--cookies')
      ? 'Subtitles are only available when logged in' : ''
    queueMicrotask(() => callback(null, stdout, stderr))
  } catch (error) { queueMicrotask(() => callback(error, '', error.message)) }
  return { kill() {} }
}
syncBuiltinESMExports()
globalThis.fetch = async () => new Response(Buffer.from('fixture remote video'))
await import('./server.mjs')
