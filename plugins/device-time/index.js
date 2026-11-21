import { readDeviceTime, beijingTime } from '../../platform/device-time.js'

export default {
  id: 'device-time', title: '设备时间', order: 15,
  configSchema: {
    enabled: { type: 'bool', default: true, group: '其他', section: '设备时间', label: '读取当前设备时间',
      hint: '新增只读 get_current_time 工具，读取运行机器人的NAS/PC系统时钟；不联网校时，不修改设备时钟。聊天保留消息时间供对照。' },
  },
  setup(bot) {
    bot.registerTool('get_current_time', {
      description: '读取当前运行设备的准确系统时间，返回北京时间、星期、UTC、设备时区及Unix毫秒时间戳。'
        + '涉及现在几点、今天/昨天、星期、早晚问候或经过多久时应先调用，不要凭聊天节奏猜；'
        + '计算间隔必须对照消息接收时间，不能凭空还原旧消息时间。本工具不联网、不修改设备时钟。',
      parameters: {},
      async execute() {
        if (bot.cfg?.enabled === false) return { ok: false, reason: '设备时间工具已关闭' }
        return readDeviceTime()
      },
    })
    bot.shared.appendTimeHint = (ev) => {
      if (bot.cfg?.enabled === false || ev._scratch['device-time:hint']) return
      ev._scratch['device-time:hint'] = true
      const stamp = Number(ev.time) || Date.now()
      ev.hint.push('[' + (ev.messageId == null ? '本轮发起时间' : '本条消息时间') + '：' + beijingTime(stamp) + '；Unix毫秒=' + stamp
        + '。判断现在日期、几点、早晚或时间间隔时调用 get_current_time，对照消息时间，不要猜测]')
    }
  },
}
