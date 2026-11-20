// Explicit discovery works on Node 22+ and every shell; helpers are not tests.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
const files = fs.readdirSync(new URL('test/', root)).filter(name => name.endsWith('.test.js')).sort()
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files.map(name => 'test/' + name)], {
  cwd: root, stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
