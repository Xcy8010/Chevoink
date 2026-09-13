import { createHash } from 'node:crypto'
import { getModelTierRuntime } from '../credits.js'
import { DataAccessError } from '../prisma.js'
import type { ModelReasoningEffort } from '../../../shared/contracts/index.js'

/** The selection is supplied by the current composer, never inferred from the
 * most recently edited BYOK configuration. Provider secrets remain server-only. */
export type ImportModelSelection =
  | { kind: 'basic' }
  | { kind: 'custom'; customModelId: string; reasoningEffort?: ModelReasoningEffort }

export type ImportModelRoute = {
  kind: 'basic' | 'custom'
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
  const effort = selection.kind === 'custom' ? selection.reasoningEffort ?? 'low' : 'low'
  // getModelTierRuntime enforces ownership, enabled state and supported efforts.
  // Do not catch its failure and retry against another paid provider.
  const runtime = await getModelTierRuntime(selection.kind === 'custom' ? 'custom' : 'basic',
    userId, selection.kind === 'custom' ? selection.customModelId : undefined, effort)
  if (runtime.reasoningEffort !== effort || !runtime.reasoningEfforts.includes(effort)) {
    throw new DataAccessError(409, 'IMPORT_REASONING_UNSUPPORTED', '此模型不支持本次识别的思考强度，请重新选择后确认。')
  }
  if (options.needsVision && !runtime.visionEnabled) {
    throw new DataAccessError(409, 'IMPORT_VISION_REQUIRED', '本次模型不支持图片识别，可使用本地 OCR 或另行选择视觉模型并确认费用。')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    userId, selection, provider: runtime.provider, modelName: runtime.modelName,
    baseUrl: runtime.baseUrl, effort, vision: runtime.visionEnabled,
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
