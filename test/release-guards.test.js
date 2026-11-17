import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-release-guard-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(path.join(ROOT, 'scripts', script), path.join(root, 'scripts', script))
  return root
}

function run(root, script, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: os.tmpdir(), encoding: 'utf8',
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

test('tracked guard covers Python and unusual extensions without printing credentials', (t) => {
  const script = 'check-no-secrets.mjs'
  const root = fixture(t, script)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const sentinel = ['local', 'guard', 'sentinel', '1234'].join('-')
  fs.writeFileSync(path.join(root, 'helper.py'), 'password = ' + JSON.stringify(sentinel))
  fs.writeFileSync(path.join(root, 'snapshot.unusual'), 'token = ' + JSON.stringify(sentinel))
  execFileSync('git', ['add', '--', 'helper.py', 'snapshot.unusual'], { cwd: root })
  const result = run(root, script, ['--tracked'])
  assert.equal(result.status, 1)
  assert.match(result.output, /helper\.py/)
  assert.match(result.output, /snapshot\.unusual/)
  assert.ok(!result.output.includes(sentinel))
})

test('tracked guard accepts documented placeholders and npm check:secrets script names', (t) => {
  const script = 'check-no-secrets.mjs'
  const root = fixture(t, script)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  fs.writeFileSync(path.join(root, 'helper.py'), 'password = "YOUR_PRIVATE_PASSWORD"')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    'check:secrets': 'node scripts/check-no-secrets.mjs',
  } }))
  execFileSync('git', ['add', '--', 'helper.py', 'package.json'], { cwd: root })
  assert.equal(run(root, script, ['--tracked']).status, 0)
})

test('doc link check ignores examples and URLs, resolves encoded filenames, fails real missing targets', (t) => {
  const script = 'check-doc-links.mjs'
  const root = fixture(t, script)
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', '有 空格.md'), '# 目标\n')
  const source = [
    '[目标](有%20空格.md#锚点)', '[网络](https://example.invalid/missing)',
    '~~~js', '[示例](missing-in-code.md)', '~~~~',
    String.fromCharCode(96) + '[内联](missing-inline.md)' + String.fromCharCode(96),
  ].join('\n')
  const file = path.join(root, 'docs', 'README.md')
  fs.writeFileSync(file, source)
  assert.equal(run(root, script, ['docs']).status, 0)
  fs.appendFileSync(file, '\n[真的坏链](missing.md)\n')
  assert.equal(run(root, script, ['docs']).status, 1)
})

test('doc link check fails when asked to inspect an empty directory', (t) => {
  const script = 'check-doc-links.mjs'
  const root = fixture(t, script)
  fs.mkdirSync(path.join(root, 'empty'))
  assert.equal(run(root, script, ['empty']).status, 1)
})
