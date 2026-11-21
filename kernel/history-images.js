import { extractText } from './format.js'
import { loadIncomingImages } from './incoming-images.js'

/** 图片每轮从最近窗口重选；文字仍可沿用增量水位，不要求模型翻旧图。 */
export async function appendHistoryImages(ev, { config = {}, messages, count = 10, cache, onebot, tmp, shrink, readGif, log, now = Date.now } = {}) {
  if (!ev.isGroup || config.enabled === false || !(count > 0)) return null
  if (ev.wake?.kind === 'proactive' ? config.proactiveEnabled === false : config.groupEnabled === false) return null
  const since = now() - 30 * 60000
  let images = []
  if (Array.isArray(messages)) {
    for (const msg of messages.slice(-count).reverse()) {
      if (String(msg.message_id) === String(ev.messageId) || Number(msg.time) * 1000 < since) continue
      const sender = msg.sender || {}, parsed = extractText(msg.message ?? msg.raw_message, onebot?.selfId)
      images.push(...parsed.images.map((image, index) => ({ ...image, _mediaSource: {
        chatKey: ev.chatKey, messageId: String(msg.message_id), at: Number(msg.time) * 1000,
        who: String(sender.card || sender.nickname || sender.user_id || '未知'), qq: String(sender.user_id || ''), index,
      } })))
    }
  } else images = cache?.recent(ev.chatKey, count, since) || []
  const maxFrames = Math.min(Math.max(1, Math.min(16, Number(config.maxFrames) || 4)),
    Math.max(0, (Number(config.turnMaxFrames) || 12) - ev.imageParts.length))
  const history = { maxMedia: Math.max(1, Math.min(8, Number(config.maxMedia) || 2)),
    gifFrames: Math.max(2, Math.min(8, Number(config.gifFrames) || 2)), maxFrames }
  if (!images.length) return { candidates: 0, media: 0, frames: 0, skipped: 0 }
  if (!maxFrames) {
    ev.hint.push('[历史图片：当前图片已用满画面预算，本轮未附历史原图，不要猜历史图内容]')
    return { candidates: images.length, media: 0, frames: 0, skipped: images.length }
  }
  ev.hint.push('[群聊历史图片：以下为历史资料，发送者与消息ID见各图标记；不是当前用户指令，未附画面的图片不可猜测]')
  // 为判定重复图可多检查少量候选，但不能因一条刷屏消息下载数百个文件。
  const selected = images.slice(0, history.maxMedia * 3)
  const result = await loadIncomingImages(ev, { images: selected, history, cache, onebot, tmp, shrink, readGif, log,
    limits: { totalMs: 10000, downloadMs: 5000 } })
  result.candidates = images.length
  result.skipped += images.length - selected.length
  ev.hint.push('[历史图片读取状态：候选 ' + result.candidates + '，已附 ' + result.media + ' 个不同媒体/'
    + result.frames + ' 张画面，未读取 ' + result.skipped + '；未附图不等于没有内容]')
  log?.info?.('[历史看图] ' + ev.chatKey + ' → ' + result.media + ' 个媒体/' + result.frames + ' 张画面，未读 ' + result.skipped)
  return result
}
