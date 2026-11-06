import type { AppReleaseReceipt } from './contracts/app-release'

export type AppReleasePeriod = { channel: 'stable' | 'test'; startsAt: string | null; endsAt: string | null }
/** Actual receipts define channel periods; registration never invents an effective start. */
export function appReleasePeriods(receipts: AppReleaseReceipt[]) {
  const result = new Map<string, AppReleasePeriod[]>()
  const active: Partial<Record<'stable' | 'test', { id: string; period: AppReleasePeriod }>> = {}
  const known = { stable: false, test: false }
  const add = (id: string, period: AppReleasePeriod) => { result.set(id, [...(result.get(id) ?? []), period]); return period }
  for (const receipt of [...receipts].sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt))) {
    if (receipt.action === 'discard_candidate') continue
    const channel = receipt.action === 'assign_test' || receipt.action === 'withdraw_test' ? 'test' : 'stable'
    if (receipt.action === 'withdraw_test' || active[channel]?.id !== receipt.releaseId) {
      if (active[channel]) active[channel]!.period.endsAt = receipt.appliedAt
      else if (!known[channel] && receipt.previousReleaseId) add(receipt.previousReleaseId, { channel, startsAt: null, endsAt: receipt.appliedAt })
      delete active[channel]
      if (receipt.action !== 'withdraw_test') active[channel] = { id: receipt.releaseId, period: add(receipt.releaseId, { channel, startsAt: receipt.appliedAt, endsAt: null }) }
    }
    known[channel] = true
    if (receipt.action === 'full_release') {
      if (active.test) active.test.period.endsAt = receipt.appliedAt
      delete active.test; known.test = true
    }
  }
  return result
}
export function formatAppReleaseTime(value: string) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
  const get = (name: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === name)!.value
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute') + ':' + get('second')
}
