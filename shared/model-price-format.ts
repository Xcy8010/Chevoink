import type { CreditModelOption } from './contracts/credits.js'

export const formatModelPrice = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 15 })

export function modelPriceOptionText(model: CreditModelOption): string {
  const current = model.multiplier === 0 ? model.freePromotion ? '限时免费' : '免费' : formatModelPrice(model.multiplier) + 'x'
  const base = model.baseMultiplier ?? model.multiplier
  return model.activity?.name ? model.activity.name + ' · ' + (base > model.multiplier ? '原' + formatModelPrice(base) + 'x → ' : '') + current : current
}
