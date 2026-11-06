import { z } from 'zod'
import { imageQualityConfigSchema } from './image-model.js'

/** Sum the numbers' decimal representations without binary floating-point rounding. */
export function sumWeightedRouteWeights(weights: readonly number[]): string {
  const numericTotal = weights.reduce((sum, weight) => sum + weight, 0)
  if (!Number.isFinite(numericTotal)) return String(numericTotal)
  const decimals = weights.map(weight => {
    const [mantissa, exponent = '0'] = weight.toString().split('e')
    const [integer, fraction = ''] = mantissa.split('.')
    return { coefficient: BigInt(integer + fraction), scale: fraction.length - Number(exponent) }
  })
  const scale = decimals.reduce((scale, decimal) => Math.max(scale, decimal.scale), 0)
  const total = decimals.reduce((sum, decimal) => sum + decimal.coefficient * 10n ** BigInt(scale - decimal.scale), 0n)
  const sign = total < 0n ? '-' : ''
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0')
  return sign + (scale ? (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '') : digits)
}

export const weightedRouteCandidateInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1),
  weight: z.number().min(0).max(100),
  enabled: z.boolean().optional(),
  imageQuality: imageQualityConfigSchema.optional(),
  provider: z.string().trim().min(1),
  modelName: z.string().trim().min(1),
  baseUrl: z.string().trim().url().refine(value => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }, '线路须使用不含认证参数的 HTTP(S) 地址'),
  apiKey: z.string().optional(),
}).strict()
export const weightedRoutesInputSchema = z.object({
  primaryWeight: z.number().min(0).max(100),
  candidates: z.array(weightedRouteCandidateInputSchema),
}).strict().superRefine((value, context) => {
  if (value.candidates.length && sumWeightedRouteWeights([value.primaryWeight, ...value.candidates.filter(route => route.enabled !== false).map(route => route.weight)]) !== '100') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '主配置与启用候选线路的权重之和须为 100', path: ['primaryWeight'] })
  }
  for (const [index, route] of value.candidates.entries()) if (route.imageQuality?.defaultValue && !route.imageQuality.supportedValues.includes(route.imageQuality.defaultValue)) context.addIssue({ code: 'custom', path: ['candidates', index, 'imageQuality'], message: '默认图片质量须包含在此线路支持值中' })
}).transform(value => value.candidates.length ? value : { primaryWeight: 100, candidates: [] })

export type WeightedRouteCandidateInput = z.infer<typeof weightedRouteCandidateInputSchema>
export type WeightedRoutesInput = z.infer<typeof weightedRoutesInputSchema>
export type WeightedRoutesStored = { primaryWeight: number; candidates: Array<Omit<WeightedRouteCandidateInput, 'id' | 'apiKey'> & { id: string; apiKeyCiphertext: string }> }
export type WeightedRoutesView = { primaryWeight: number; candidates: Array<Omit<WeightedRouteCandidateInput, 'id' | 'apiKey'> & { id: string; apiKeyConfigured: boolean }> }
export const weightedRouteSelectionSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('primary') }),
  z.object({ source: z.literal('candidate'), candidateId: z.string() }),
])
export type WeightedRouteSelection = z.infer<typeof weightedRouteSelectionSchema>
