/**
 * sidecar/subtitle.mjs — 字幕解析（从 server.mjs 抽出来的独立模块，2026-11-10）
 *
 * 为什么单独成文件：server.mjs 是**启动即监听**的脚本（顶层 server.listen），import 它会把服务
 * 拉起来挂住测试进程。字幕解析是纯函数，抽出来谁都能用、也能单独测。
 */
import fs from 'node:fs'
import path from 'node:path'
/**
 * srt → 「[mm:ss] 文本」逐行。为什么带时间戳：模型说「第 3 分钟讲的是…」才对得上画面帧。
 * 兼容 B 站的纯文本 srt（有时没有序号行）、vtt 的 `WEBVTT` 头、以及 `<i>` 之类的标签。
 */
export function srtToLines(srt) {
  const raw = String(srt || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const out = []
  let t = 0
  for (const block of raw.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    if (/^WEBVTT/i.test(lines[0])) continue
    let timeIdx = lines.findIndex((l) => /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(l) || /\d{2}:\d{2}[,.]\d{3}\s*-->/.test(l))
    if (timeIdx < 0) continue
    const start = lines[timeIdx].split('-->')[0].trim()
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{3})$/.exec(start)
    if (m) t = (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3])
    const text = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const mm = String(Math.floor(t / 60)).padStart(2, '0')
    const ss = String(Math.floor(t % 60)).padStart(2, '0')
    out.push({ sec: t, line: `[${mm}:${ss}] ${text}` })
  }
  return out
}

/** 取字幕文本（超上限就按时间均匀抽段，保住「开头—中段—结尾」的骨架）。 */
export function subtitleText(files, maxChars = 6000) {
  const list = Array.isArray(files) ? files : []
  if (!list.length) return { text: '', chars: 0, lines: 0 }
  // 多个字幕文件（人工 + 自动）时优先取带 zh 的、再取最大的
  const picked = list.slice().sort((a, b) => {
    const za = /(^|[.\-])(zh|ai-zh)/i.test(path.basename(a)) ? 0 : 1
    const zb = /(^|[.\-])(zh|ai-zh)/i.test(path.basename(b)) ? 0 : 1
    return za - zb
  })[0]
  let rows = []
  try {
    const raw = fs.readFileSync(picked, 'utf8')
    rows = srtToLines(raw)
  } catch { return { text: '', chars: 0, lines: 0 } }
  if (!rows.length) return { text: '', chars: 0, lines: 0, file: picked }
  const joined = rows.map((r) => r.line).join('\n')
  if (joined.length <= maxChars) return { text: joined, chars: joined.length, lines: rows.length, file: picked };
  // 超长：按时间均匀取若干段，拼回「开头—中段—结尾」
  const want = Math.max(10, Math.floor(maxChars / (joined.length / rows.length)));
  const step = Math.max(1, Math.floor(rows.length / want));
  const picked2 = []
  for (let i = 0; i < rows.length; i += step) picked2.push(rows[i]);
  let text = picked2.map((r) => r.line).join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, chars: text.length, lines: rows.length, truncated: true, file: picked };
}
