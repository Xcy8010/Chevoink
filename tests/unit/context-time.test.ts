import { describe, expect, it } from 'vitest'
import { renderContextTime, withHistoryTimestamp } from '../../api/lib/agent/context-time.js'

describe('server context time', () => {
  it.each([
    ['Asia/Shanghai', '2026-11-27T03:25:42Z', '2026-11-27 11:25:42', '+08:00'],
    ['America/Los_Angeles', '2026-11-27T03:25:42Z', '2026-11-26 19:25:42', '-08:00'],
    ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01 01:30:00', '-04:00'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01 01:30:00', '-05:00'],
    ['Asia/Kathmandu', '2026-11-27T03:25:42Z', '2026-11-27 09:10:42', '+05:45'],
  ])('uses the device clock %s at %s for current and historical speech', (zone, iso, local, offset) => {
    const instant = new Date(iso)
    for (const text of [renderContextTime(instant, zone), withHistoryTimestamp('原话', instant, zone)]) {
      expect(text).toContain(local)
      expect(text.replaceAll('−', '-')).toContain(offset)
    }
  })

  it('accepts older clients and unsupported timezone values', () => {
    const date = new Date('2026-11-27T03:25:42Z')
    expect(renderContextTime(date, 'invalid location')).toBe(renderContextTime(date))
  })

  it('binds UTC and the explicit Beijing date across midnight without claiming a user timezone', () => {
    const now = new Date('2026-10-31T16:02:03.456Z')
    const text = renderContextTime(now)
    expect(text).toContain('2026-10-31T16:02:03.456Z（UTC）')
    expect(text).toContain('2026-11-01T00:02:03.456+08:00')
    expect(text).toContain('不代表作者所在地')
    expect(text).toContain('旧新闻只能标为旧闻')
    expect(text).toContain('恢复原任务不把原请求日期改为恢复日期')
    expect(now.toISOString()).toBe('2026-10-31T16:02:03.456Z')
  })

  it('retains exact historical words and only uses their saved timestamp', () => {
    const original = '今天是10月30日？\n里面选哪个题材？'
    const result = withHistoryTimestamp(original, new Date('2026-11-01T01:00:00.000Z'))
    expect(result).toBe(`[服务端历史发言时间：2026-11-01T01:00:00.000Z（UTC）]\n${original}`)
    expect(withHistoryTimestamp(original)).toBe(original)
  })
})
