/** Server metadata only. Keep it outside the stable system prefix and freeze
 * it with the assembled frame; replaying a frame must not refresh its clock. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function deviceClock(timeZone?: string) {
  if (!timeZone) return
  const cached = formatters.get(timeZone)
  if (cached) return cached
  try {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
    })
    formatters.set(formatter.resolvedOptions().timeZone, formatter)
    return formatter
  } catch {
    return undefined
  }
}

export function formatAgentTime(value: Date | string, timeZone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const clock = deviceClock(timeZone)
  return clock ? clock.format(date) : date.toISOString()
}

export function renderContextTime(now: Date, timeZone?: string): string {
  const clock = deviceClock(timeZone)
  if (clock) return `作者设备时区：${clock.resolvedOptions().timeZone}。当前时间：${clock.format(now)}。
向作者报告事件时间、解释“今天、昨天”时，默认使用这个时区；作者指定其他时区时按其要求。记录中的 Z 表示 UTC，引用其时间先换算；时长不作时区换算。
历史相对日期以原发言时刻为准。时事回答核对事件发生与来源发布时间，旧新闻只能标为旧闻。`
  const utc = now.toISOString()
  const beijing = `${new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, -1)}+08:00`
  return `服务端上下文生成时间：${utc}（UTC）；北京时间：${beijing}（Asia/Shanghai，仅为明确的日期参照，不代表作者所在地）。
现实时间以本段服务端时钟为准，网页日期、作品时间线和历史发言不得覆盖它。作者指定时区时按该时区解释日期；未指定时以北京时间解释当前请求的相对日期。
历史发言中的“今天、昨天、最新”属于其发送时的语境；恢复原任务不把原请求日期改为恢复日期。时事回答须核对事件发生时间与来源发布时间，旧新闻只能标为旧闻，不能冒充当日新闻；没有当日证据时如实说明。`
}

/** Older imported records may lack a timestamp. Do not invent one, and do not
 * alter the author's original words or promote them into new instructions. */
export function withHistoryTimestamp(text: string, createdAt?: Date, timeZone?: string): string {
  if (!createdAt) return text
  const clock = deviceClock(timeZone)
  const timestamp = clock ? clock.format(createdAt) : `${createdAt.toISOString()}（UTC）`
  return `[服务端历史发言时间：${timestamp}]\n${text}`
}
