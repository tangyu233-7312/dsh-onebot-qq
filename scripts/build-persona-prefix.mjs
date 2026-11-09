/**
 * scripts/build-persona-prefix.mjs — 把随包示例人设拼进 qq-chat preset 的 persona.prefix。
 *
 * 为什么要这样：QQ 线的 system prompt 由 cordis.patch.yml 里 preset-qq-chat 的
 * `persona.prefix` 决定；人设文件（personas/*.md）本身**不会**自动进系统提示词
 * （2026-11-09 实测：8 条会话的 system 里一个「本鱼」都没有）。
 *
 * 用法：
 *   node scripts/build-persona-prefix.mjs            # 重新生成（人设改了就跑一次）
 *   node scripts/build-persona-prefix.mjs --check    # 只检查是否已同步（测试/CI 用）
 *
 * 纪律：
 *   · 只改 prefix 那一块，前后其它配置一个字不动；
 *   · 生成物不含真实 QQ 号 / 密钥（人设来自仓库里的示例版，本来就是占位）；
 *   · 加了 generated 标记，手改也会被下一次生成对齐回来。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PATCH = path.join(ROOT, 'cordis.patch.yml')
const PERSONA = path.join(ROOT, 'examples', 'personas', '蓝色大肥鱼.md')

const BEGIN = '              # >>> generated: 人设正文（scripts/build-persona-prefix.mjs 生成，别手改） >>>'
const END = '              # <<< generated <<<'

/** 通用身份段（原 prefix 的内容，保留：群是感官、私聊是家、必须调工具） */
const IDENTITY = [
  '你是群里和私聊里的一个人，不是客服，也不是工具。',
  '',
  '**群聊是你的感官，跟主人的私聊是你的家（总部）。**',
  '在群里你是被叫去说话的那一个：别人叫你、问你、聊到你，你说一句就走，不刷屏、不总结、不服务腔。',
  '在私聊里你才是你自己：那里没有别人，你可以自己决定今天做什么 ——',
  '翻翻群在聊什么、看个视频、写点东西、或者什么都不做。想到就去做，不用等指令。',
  '',
  '你做过的事会写在一行「我今天的经历」里（看视频、写说说、去过哪个群）。',
  '那是你自己做的，不是听别人说的 —— 引用它的时候用「我今天……」这种口气。',
  '',
  'QQ 线每轮必须调用 mcp__qq__* 工具才能让对方收到内容；只写正文等于没有回话。',
].join('\n')

/** 人设正文（去 BOM） */
function personaBody() {
  return fs.readFileSync(PERSONA, 'utf8').replace(/^\uFEFF/, '').trim()
}

/** prefix 完整文本 */
function buildPrefix() {
  const head = [
    IDENTITY,
    '',
    '---',
    '',
    '# 下面是你的人设（由 examples/personas/蓝色大肥鱼.md 生成）。',
    '# 它比上面的通用说明更具体：你是谁、怎么说话、什么场合什么反应，都以它为准。',
  ].join('\n')
  return head + '\n\n' + personaBody()
}

/** YAML 块标量行（缩进 16 格） */
function toYamlBlock(text) {
  return text.split('\n').map((l) => (l.trim() ? '                ' + l : '')).join('\n')
}

function render() {
  return ['              prefix: |-', BEGIN, toYamlBlock(buildPrefix()), END].join('\n')
}

const yml = fs.readFileSync(PATCH, 'utf8')
const check = process.argv.includes('--check')
const lines = yml.split('\n')
const start = lines.findIndex((l) => /^\s+prefix: \|-\s*$/.test(l))
if (start < 0) throw new Error('cordis.patch.yml 里找不到 prefix: |-')
let end = start + 1
while (end < lines.length) {
  const l = lines[end]
  if (l.trim() && (l.match(/^\s*/) || [''])[0].length <= 14) break
  end += 1
}
const current = lines.slice(start, end).join('\n')
const next = render()

if (check) {
  if (current.trim() !== next.trim()) {
    console.error('[persona-prefix] ✗ 与示例人设不同步：node scripts/build-persona-prefix.mjs')
    process.exit(1)
  }
  console.log('[persona-prefix] OK 已同步')
  process.exit(0)
}

if (current === next) {
  console.log('[persona-prefix] 无变化')
  process.exit(0)
}

const out = [...lines.slice(0, start), ...next.split('\n'), ...lines.slice(end)].join('\n')
fs.writeFileSync(PATCH, out, 'utf8')
console.log('[persona-prefix] 已写入：prefix ' + current.split('\n').length + ' 行 → ' + next.split('\n').length + ' 行')