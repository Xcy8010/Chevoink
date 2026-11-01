import { z } from 'zod'
import { novelImportModelSchema } from '../../../shared/contracts/novel-import.js'
import { serverModelTierSchema } from '../../../shared/contracts/model-tier.js'
import { createHash } from 'node:crypto'
import { getModelTierRuntime } from '../credits.js'
import { DataAccessError, prisma } from '../prisma.js'
import type { ModelReasoningEffort } from '../../../shared/contracts/index.js'
import type { NovelImportModelSelection } from '../../../shared/contracts/novel-import.js'

/** The selection is supplied by the current composer, never inferred from the
 * most recently edited BYOK configuration. Provider secrets remain server-only. */
export const storedImportModelSchema = z.union([novelImportModelSchema, z.object({ kind: z.literal('basic'),
  modelConfigId: z.string().min(1).max(64), modelConfigRevision: z.number().int().positive(), resolvedTier: serverModelTierSchema }).strict()])
export type ImportModelSelection = z.infer<typeof storedImportModelSchema>
export async function freezeBasicImportSelection(selection: NovelImportModelSelection): Promise<ImportModelSelection> {
  if (selection.kind !== 'basic') return selection
  try {
    const runtime = await getModelTierRuntime('basic', undefined, undefined, 'low')
    return runtime.modelConfigId && runtime.modelConfigRevision && runtime.tier !== 'custom'
      ? { kind: 'basic', modelConfigId: runtime.modelConfigId, modelConfigRevision: runtime.modelConfigRevision, resolvedTier: runtime.tier } : selection
  } catch (error) {
    // Local parsing remains available without an LLM. Its later optional request
    // still rejects an unavailable or archived selection before dispatch.
    if (error instanceof DataAccessError && error.code === 'MODEL_TIER_UNAVAILABLE') return selection
    throw error
  }
}

export type ImportModelRoute = {
  kind: 'basic' | 'builtin' | 'custom'
  customModelId: string | null
  modelName: string | null
  provider: string
  reasoningEffort: ModelReasoningEffort
  visionEnabled: boolean
  fingerprint: string
}

export async function resolveImportModelRoute(userId: string, selection: ImportModelSelection, options: {
  needsVision?: boolean
  expectedFingerprint?: string
} = {}) {
  if (!userId.trim()) throw new DataAccessError(401, 'UNAUTHORIZED', '请登录后使用导入识别。')
  if (selection.kind === 'custom' && !selection.customModelId.trim()) {
    throw new DataAccessError(400, 'CUSTOM_MODEL_REQUIRED', '请选择本次导入使用的自定义模型。')
  }
  if (selection.kind === 'basic') {
    const frozen = 'modelConfigId' in selection ? selection : null
    const original = await prisma.aiModelConfig.findFirst({ where: { ownerUserId: null, ...(frozen ? { id: frozen.modelConfigId } : { tier: 'basic' }) } })
    if (original?.archivedAt || frozen && (!original || original.revision !== frozen.modelConfigRevision)) throw new DataAccessError(409, 'IMPORT_MODEL_CHANGED', '原导入模型已归档或配置已变化，请重新选择并确认；未请求其他模型。')
  }
  const requestedEffort = selection.kind === 'basic' ? 'low' : selection.reasoningEffort ?? (selection.kind === 'custom' ? 'low' : 'medium')
  // getModelTierRuntime enforces ownership, enabled state and supported efforts.
  // Do not catch its failure and retry against another paid provider.
  const runtime = await getModelTierRuntime(selection.kind === 'custom' ? 'custom' : selection.kind === 'builtin' ? selection.modelTier : 'resolvedTier' in selection ? selection.resolvedTier : 'basic',
    userId, selection.kind === 'custom' ? selection.customModelId : undefined, requestedEffort)
  const effort = runtime.reasoningEffort
  if ((selection.kind === 'basic' && effort !== requestedEffort) || !runtime.reasoningEfforts.includes(effort)) {
    throw new DataAccessError(409, 'IMPORT_REASONING_UNSUPPORTED', '此模型不支持本次识别的思考强度，请重新选择后确认。')
  }
  if (options.needsVision && !runtime.visionEnabled) {
    throw new DataAccessError(409, 'IMPORT_VISION_REQUIRED', '本次模型不支持图片识别，可使用本地 OCR 或另行选择视觉模型并确认费用。')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    userId, selection, provider: runtime.provider, modelName: runtime.modelName,
    baseUrl: runtime.baseUrl, effort, vision: runtime.visionEnabled,
    reasoningParameterMode: runtime.reasoningParameterMode,
    outputTokenParameter: runtime.outputTokenParameter,
    thinkingEnabled: runtime.thinkingEnabled,
    contextWindowTokens: runtime.contextWindowTokens, tokenPrice: runtime.tokenPrice,
    multiplierBps: runtime.multiplierBps,
    // Credential changes invalidate approval without exposing the key in a DTO/log.
    credential: createHash('sha256').update(runtime.apiKey ?? '').digest('hex'),
  })).digest('hex')
  if (options.expectedFingerprint && options.expectedFingerprint !== fingerprint) {
    throw new DataAccessError(409, 'IMPORT_MODEL_CHANGED', '导入模型配置或价格已变化，请重新核对并确认费用。')
  }
  const route: ImportModelRoute = {
    kind: selection.kind, customModelId: selection.kind === 'custom' ? selection.customModelId : null,
    modelName: runtime.modelName, provider: runtime.provider, reasoningEffort: effort,
    visionEnabled: runtime.visionEnabled, fingerprint,
  }
  return { runtime, route }
}

export const IMPORT_STRUCTURE_BUDGET = Object.freeze({
  requestInput: 8000, requestOutput: 2000, jobInput: 40000, jobOutput: 8000,
})

/** Admission only: does not call a model or charge credits. Reservations must
 * subsequently be committed atomically against the persistent import job. */
export function assertImportStructureBudget(input: {
  estimatedInput: number
  maxOutput: number
  consumedInput: number
  consumedOutput: number
  reservedInput: number
  reservedOutput: number
  contextWindowTokens: number | null
}) {
  const counts = [input.estimatedInput, input.maxOutput, input.consumedInput,
    input.consumedOutput, input.reservedInput, input.reservedOutput]
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0) || input.maxOutput < 1) {
    throw new DataAccessError(400, 'IMPORT_BUDGET_INVALID', '导入识别预算无效。')
  }
  if (input.contextWindowTokens === null || !Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 1) {
    throw new DataAccessError(409, 'IMPORT_CONTEXT_UNKNOWN', '模型上下文上限尚未配置，请核对后再进行 AI 识别。')
  }
  const limit = IMPORT_STRUCTURE_BUDGET
  if (input.estimatedInput > limit.requestInput || input.maxOutput > limit.requestOutput
    || BigInt(input.consumedInput) + BigInt(input.reservedInput) + BigInt(input.estimatedInput) > BigInt(limit.jobInput)
    || BigInt(input.consumedOutput) + BigInt(input.reservedOutput) + BigInt(input.maxOutput) > BigInt(limit.jobOutput)
    || input.estimatedInput + input.maxOutput + 1024 > input.contextWindowTokens) {
    throw new DataAccessError(409, 'IMPORT_BUDGET_REQUIRED', '此次识别超出已确认的预算或模型上下文，请缩小范围或手动调整结构；原文未截断。')
  }
}
