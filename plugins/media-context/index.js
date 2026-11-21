/** 控制台配置；缓存和入站素材装配由内核统一管理。 */
export default {
  id: 'media-context', title: '历史看图与图片缓存', order: 42,
  configSchema: {
    enabled: { type: 'bool', default: true, group: '文件与图片', section: '群聊历史图片',
      label: '历史看图与媒体缓存', hint: '总开关。空间写作仍使用原文字素材，不附加图片。' },
    groupEnabled: { type: 'bool', default: true, group: '文件与图片', section: '群聊历史图片',
      label: '普通群聊读取历史图片', hint: '在现有群上文窗口里附加少量原图，附发送者和消息时间；以前看过也照常重新投递。' },
    proactiveEnabled: { type: 'bool', default: true, group: '文件与图片', section: '群聊历史图片',
      label: '主动接话读取历史图片', hint: '让主动开口轮看到群友最近发的图；看懂后仍可选择不发言。' },
    maxMedia: { type: 'int', default: 2, min: 1, max: 8, group: '文件与图片', section: '群聊历史图片',
      label: '每轮最多几个历史媒体', hint: '按完整文件去重，默认2个。重复发送的同图只附一次，保留各发送者记录。' },
    gifFrames: { type: 'int', default: 2, min: 2, max: 8, group: '文件与图片', section: '群聊历史图片',
      label: '历史 GIF 每个抽几帧', hint: '默认2帧作概览；不改变当前直接发图或引用GIF的原有帧数设置。' },
    maxFrames: { type: 'int', default: 4, min: 1, max: 16, group: '文件与图片', section: '群聊历史图片',
      label: '历史图片总画面上限', hint: '静图算1张，GIF每帧算1张。当前图片优先，历史只使用剩余额度。' },
    turnMaxFrames: { type: 'int', default: 12, min: 4, max: 48, group: '文件与图片', section: '群聊历史图片',
      label: '整轮画面预算目标', hint: '当前消息已有很多图片时缩减历史附图；不会为凑此数截断当前消息的图片。' },
    cacheEnabled: { type: 'bool', default: true, group: '文件与图片', section: '图片缓存（群聊与私聊）',
      label: '保留收到的图片原件', hint: '后台下载原图，真正需要看动图时才抽帧；缓存命中仍照常把本轮选中的图片交给模型。' },
    cacheHours: { type: 'int', default: 24, min: 1, max: 168, unit: '小时', group: '文件与图片', section: '图片缓存（群聊与私聊）',
      label: '图片保留时间', hint: '默认24小时，到期后等待每日清理。用户再次发送会刷新期限，模型读取缓存不续期；正常连续运行时，磁盘实际保留约24～48小时。' },
    cacheCleanupTime: { type: 'str', default: '23:50', group: '文件与图片', section: '图片缓存（群聊与私聊）',
      label: '每日清理时间（北京时间）', hint: '每天只检查一次，删除超过保留期的原图和帧。格式HH:mm，默认23:50；无效值按23:50执行。只设到点定时器，不频繁轮询；重启后等待下一次清理。' },
    cacheMaxMb: { type: 'int', default: 1024, min: 1, max: 16384, unit: 'MB', group: '文件与图片', section: '图片缓存（群聊与私聊）',
      label: '缓存磁盘容量上限', hint: '默认1024MB，指独立media-cache文件夹的磁盘占用，不是常驻内存。达到上限时新图仍可聊天处理，但明确记录无法留存；不提前删除未过期图片。' },
    cacheStatus: { type: 'info', group: '文件与图片', section: '图片缓存（群聊与私聊）', label: '当前缓存状态',
      text: (kernel) => {
        const s = kernel.shared?.mediaCache?.stats?.()
        if (!s) return '缓存未就绪'
        const last = kernel.shared?.historyImageStatus
        return '原件 ' + s.objects + ' 个，消息关联 ' + s.records + ' 条，磁盘占用 ' + (s.bytes / 1048576).toFixed(1)
          + '/' + (s.maxBytes / 1048576).toFixed(0) + 'MB；原图命中 ' + s.hits + '，抽帧命中 ' + s.frameHits
          + '；待下载 ' + (s.queued + s.running) + '；每日 ' + s.cleanupTime + '（北京时间）清理过期文件'
          + (s.lastError ? '。最近异常：' + s.lastError : '')
          + (last ? '\n上轮历史：候选 ' + last.candidates + '，加载 ' + last.media + ' 个媒体/' + last.frames + ' 张画面，未读取 ' + last.skipped : '')
      } },
  },
  setup() {},
}
