import { imagePriceSchema } from '../billing/image-price.js'
import { z } from 'zod'
import { FIXED_NOVEL_COVER_SIZE } from '../../../shared/contracts/index.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolResult } from './tools/types.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const coverRouteSchema = z.object({ modelConfigId: z.string().min(1).max(64).optional(), modelConfigRevision: z.number().int().positive().optional(),
  routeId: z.string().uuid().optional(), provider: z.string().min(1), modelName: z.string().min(1), baseUrl: z.string().min(1), providerMode: z.string(), quality: z.string().optional() }).strict()
const coverCommonSchema = z.object({ novelId: z.string().min(1), title: z.string(), displayTitle: z.string().nullable(),
  prompt: z.string().min(4), count: z.number().int().min(1).max(2), size: z.literal(FIXED_NOVEL_COVER_SIZE),
  assetIds: z.array(z.string().uuid()).min(1).max(2),
  route: coverRouteSchema,
  fallbackRoutes: z.array(coverRouteSchema).min(1).max(7).optional(),
}).strict()
export const coverWorkSchema = z.discriminatedUnion('version', [
  coverCommonSchema.extend({ version: z.literal(1), tariff: z.literal('image_call_6000_v1'), amountMilli: z.literal(6000) }),
  coverCommonSchema.extend({ version: z.literal(2), tariff: z.literal('image_call_scheduled_v2'), amountMilli: z.number().int().nonnegative(), price: imagePriceSchema }),
]).refine(value => value.assetIds.length === value.count && new Set(value.assetIds).size === value.count && (value.version === 1 || value.price.amountMilli === value.amountMilli))
export type CoverWork = z.infer<typeof coverWorkSchema>
export const coverChildSchema = z.object({ version: z.literal(1), parentInputHash: hash, workHash: hash,
  routeIndex: z.number().int().min(1).max(7).optional(), chargeKey: z.string(), usageLogId: z.string(), request: z.unknown() }).strict()
export function coverRouteWork(work: CoverWork, index: number): CoverWork {
  const route = index === 0 ? work.route : work.fallbackRoutes?.[index - 1]
  if (!route) throw new Error('封面备用线路不属于原请求。')
  return index === 0 ? work : { ...work, route }
}
export const coverChargeKey = (parentId: string, index: number) => `image:${parentId}${index ? `:route:${index}` : ''}`
export function coverRequest(work: CoverWork) {
  return runtimeJson({ endpoint: work.route.baseUrl, body: { model: work.route.modelName, prompt: work.prompt, size: work.size, n: work.count,
    ...(work.route.quality !== undefined ? { quality: work.route.quality } : {}) } }).value
}
const coverUnitCommonSchema = z.object({ operationId: z.string(), parentOperationId: z.string(), attemptId: z.string(),
  parentInputHash: hash, requestHash: hash, resultHash: hash, debitId: z.string(), chargeKey: z.string(),
  units: z.literal(1),
  outcome: z.enum(['images', 'empty', 'rejected', 'invalid']) }).strict()
export const coverUnitSchema = z.discriminatedUnion('tariff', [
  coverUnitCommonSchema.extend({ tariff: z.literal('image_call_6000_v1'), chargedMilli: z.literal(6000) }),
  coverUnitCommonSchema.extend({ tariff: z.literal('image_call_scheduled_v2'), chargedMilli: z.number().int().min(0).max(2147483647) }),
])
export const coverUnitUsage = { source: 'fixed_unit', promptTokens: null, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null } as const

/** Never re-embed provider base64 in a bounded operation/cursor receipt. */
export function coverProjection(images: Array<{ id: string; imageUrl: string }>): ToolResult {
  const usable = images.filter(image => image.imageUrl.length <= 8192 && !image.imageUrl.startsWith('data:'))
  if (usable.length !== images.length) return { outcome: 'failed', failureCode: 'COVER_STORAGE_PENDING',
    output: `封面候选已保存：${images.map(image => `coverAssetId ${image.id}`).join('；')}。图片存储尚未完成；保留原候选及原响应，不能据此重新生成。可对原 coverAssetId 使用 view_image 核验，存储恢复仅处理这些候选。`,
    summary: '封面候选已保存，图片存储待恢复' }
  return { output: `已生成 ${images.length} 张封面候选图：${images.map((image, index) => `候选${index + 1}：coverAssetId ${image.id}，候选图 url ${image.imageUrl}`).join('；')}。接下来先对每张候选调用 view_image 校验画面、构图和书名标题文字，再用 ask_user 让作者选图。图片选项填写对应的 coverAssetId，留一个「暂不应用」选项；按作者选择用 cover_apply 应用已有 ID。`,
    summary: `生成 ${images.length} 张封面候选`, display: { kind: 'coverImages', images: images.map(image => ({ id: image.id, url: image.imageUrl })) } }
}
