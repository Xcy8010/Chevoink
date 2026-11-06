import { z } from 'zod'

export const IMAGE_QUALITY_OPTIONS = [
  { value: 'auto', label: '自动' }, { value: 'low', label: '低' },
  { value: 'medium', label: '中' }, { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }, { value: 'max', label: '最高' },
] as const

/** Upstream quality values are declared independently of provider/model aliases. */
export const imageQualityConfigSchema = z.object({
  supportedValues: z.array(z.string().trim().min(1)),
  defaultValue: z.string().trim().min(1).nullable(),
}).refine(value => value.defaultValue === null || value.supportedValues.includes(value.defaultValue), '默认图片质量须包含在支持值中')
export type ImageQualityConfig = z.infer<typeof imageQualityConfigSchema>

export type PublicImageModel = {
  label: string; available: boolean; publicDescription: string; publicFeatures: string[]
  basePerCallCredits: number; perCallCredits: number; baseMultiplier: number; multiplier: number; discountRatio: number | null
  activity: import('./credits.js').CreditModelOption['activity']
}
