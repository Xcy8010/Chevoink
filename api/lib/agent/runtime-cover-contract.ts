import { z } from 'zod'
import { FIXED_NOVEL_COVER_SIZE } from '../../../shared/contracts/index.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolResult } from './tools/types.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const coverWorkSchema = z.object({ version: z.literal(1), novelId: z.string().min(1), title: z.string(), displayTitle: z.string().nullable(),
  prompt: z.string().min(4), count: z.number().int().min(1).max(2), size: z.literal(FIXED_NOVEL_COVER_SIZE),
  assetIds: z.array(z.string().uuid()).min(1).max(2), tariff: z.literal('image_call_6000_v1'), amountMilli: z.literal(6000),
  route: z.object({ provider: z.string().min(1), modelName: z.string().min(1), baseUrl: z.string().min(1), providerMode: z.string() }).strict(),
}).strict().refine(value => value.assetIds.length === value.count && new Set(value.assetIds).size === value.count)
export type CoverWork = z.infer<typeof coverWorkSchema>
export const coverChildSchema = z.object({ version: z.literal(1), parentInputHash: hash, workHash: hash,
  chargeKey: z.string(), usageLogId: z.string(), request: z.unknown() }).strict()
export function coverRequest(work: CoverWork) {
  return runtimeJson({ endpoint: work.route.baseUrl, body: { model: work.route.modelName, prompt: work.prompt, size: work.size, n: work.count } }).value
}
export const coverUnitSchema = z.object({ operationId: z.string(), parentOperationId: z.string(), attemptId: z.string(),
  parentInputHash: hash, requestHash: hash, resultHash: hash, debitId: z.string(), chargeKey: z.string(),
  tariff: z.literal('image_call_6000_v1'), chargedMilli: z.literal(6000), units: z.literal(1),
  outcome: z.enum(['images', 'empty', 'rejected', 'invalid']) }).strict()
export const coverUnitUsage = { source: 'fixed_unit', promptTokens: null, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null } as const

/** Never re-embed provider base64 in a bounded operation/cursor receipt. */
export function coverProjection(images: Array<{ id: string; imageUrl: string }>): ToolResult {
  const usable = images.filter(image => image.imageUrl.length <= 8192 && !image.imageUrl.startsWith('data:'))
  if (usable.length !== images.length) return { outcome: 'failed', failureCode: 'COVER_STORAGE_PENDING',
    output: `封面候选已保存：${images.map(image => `coverAssetId ${image.id}`).join('；')}。图片存储尚未完成；保留原候选及原响应，不能据此重新生成。可对原 coverAssetId 使用 view_image 核验，存储恢复仅处理这些候选。`,
    summary: '封面候选已保存，图片存储待恢复' }
  return { output: `已生成 ${images.length} 张封面候选图：${images.map((image, index) => `候选${index + 1}：coverAssetId ${image.id}，候选图 url ${image.imageUrl}`).join('；')}。接下来先对每张候选调用 view_image 校验画面、构图和书名标题文字，再用 ask_user 询问作者选择，经确认后用 cover_apply 应用。`,
    summary: `生成 ${images.length} 张封面候选`, display: { kind: 'coverImages', images: images.map(image => ({ id: image.id, url: image.imageUrl })) } }
}
