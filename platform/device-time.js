/** 只读设备系统时钟，所有时区转换均在本机完成。 */
function localParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return { date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute + ':' + parts.second,
    offset: parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace(/^GMT/, '') }
}

export function beijingTime(ms) {
  const p = localParts(ms, 'Asia/Shanghai')
  return p.date + ' ' + p.time + ' +08:00'
}

export function readDeviceTime(ms = Date.now()) {
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const device = localParts(ms, deviceTimeZone)
  return { ok: true, source: '设备系统时钟（未联网）', unixMs: ms,
    beijingTime: beijingTime(ms), timeZone: 'Asia/Shanghai', utcOffset: '+08:00',
    weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date(ms)),
    utc: new Date(ms).toISOString(), deviceTimeZone,
    deviceTime: device.date + ' ' + device.time + ' ' + device.offset }
}
