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
})
export type ImageQualityConfig = z.infer<typeof imageQualityConfigSchema>
