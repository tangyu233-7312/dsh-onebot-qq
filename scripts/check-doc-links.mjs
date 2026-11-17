#!/usr/bin/env node
/** 检查 Markdown 行内本地链接的目标文件；跳过代码和网络链接，不请求网络或校验锚点。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputs = process.argv.slice(2)
const docs = new Set()
function collect(file) {
  const stat = fs.statSync(file)
  if (stat.isDirectory()) {
    for (const item of fs.readdirSync(file)) {
      if (['.git', 'node_modules'].includes(item)) continue
      collect(path.join(file, item))
    }
  } else if (file.endsWith('.md')) docs.add(file)
}

try {
  for (const input of inputs.length ? inputs : ['README.md', 'CHANGELOG.md', 'docs', 'examples']) {
    collect(path.resolve(ROOT, input))
  }
  if (!docs.size) throw new Error('未找到 Markdown 文档')
  let links = 0
  let errors = 0
  for (const file of docs) {
    let fence = null
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      const marker = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/)
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
        continue
      }
      if (marker) { fence = marker[1]; continue }
      const text = line.replace(/(\x60+).*?\1/g, '')
      for (const match of text.matchAll(/\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
        const raw = match[1].replace(/^<|>$/g, '')
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) continue
        const target = decodeURIComponent(raw.split(/[?#]/)[0])
        if (!target) continue
        links++
        if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
          errors++
          console.error(path.relative(ROOT, file) + ':' + (index + 1) + ': 本地链接目标不存在')
        }
      }
    }
  }
  console.error('[check-doc-links] 文档 ' + docs.size + '，本地链接 ' + links + '，坏链 ' + errors + '（不含锚点及引用式链接）')
  process.exitCode = errors ? 1 : 0
} catch (error) {
  console.error('[check-doc-links] 检查失败：' + error.message)
  process.exitCode = 1
}
