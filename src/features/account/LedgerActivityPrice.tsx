import type { CreditLedgerItem } from '../../../shared/contracts'
import { formatModelPrice } from '../../../shared/model-price-format'
export default function LedgerActivityPrice({ item }: { item: CreditLedgerItem }) {
 const activity = item.activity
 if (!activity) return null
 const base = item.baseMultiplier ?? item.multiplier
 const price = base === item.multiplier ? formatModelPrice(item.multiplier)+'x' : formatModelPrice(base)+'x → '+formatModelPrice(item.multiplier)+'x'
 const time = new Intl.DateTimeFormat('zh-CN', { timeZone: activity.timezone, month:'2-digit', day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false }).format(new Date(activity.admittedAt))
 return <p className="mt-1 break-words text-xs leading-5 text-[var(--text-tertiary)]">{activity.name ?? '正常价格'} · {price} · <time dateTime={activity.admittedAt}>{time}</time>（{activity.timezone}）</p>
}
