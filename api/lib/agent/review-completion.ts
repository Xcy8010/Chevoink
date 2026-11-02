import { getModelTierRuntime } from '../credits.js'
import { selectWeightedModelRuntime } from '../model-weighted-routing.js'
import { generateTextCompletion } from '../ai-service.js'
import { DataAccessError } from '../prisma.js'
import { consumeTextRequestRecovery } from '../text-request-trace.js'

export const REVIEW_MAX_OUTPUT_TOKENS = 16_384
const RECOVERY_MAX_OUTPUT_TOKENS = 32_768

/** Only an ended output-ceiling/empty request with confirmed original billing
 * permits this separately billed, bounded recovery. Unknown responses,
 * transport errors and cancellation never redispatch here. The caller still
 * validates the complete report and revision. */
export async function generateReviewCompletion(
  system: string,
  content: string,
  options: Omit<Parameters<typeof generateTextCompletion>[2], 'maxOutputTokens'>,
  beforeRecovery?: () => Promise<void>,
) {
  options.signal?.throwIfAborted()
  const runtime = options.modelRuntime ?? (options.modelTier ? await getModelTierRuntime(options.modelTier, options.userId) : undefined)
  options = { ...options, responseFormat: 'json_object',
    ...(runtime && !options.authorizedRequest && !options.singlePhysicalRequest ? { modelRuntime: selectWeightedModelRuntime(runtime) } : {}) }
  try {
    const result = await generateTextCompletion(system, content, { ...options, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, boundedReview: true })
    options.signal?.throwIfAborted()
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!(error instanceof DataAccessError) || !['AI_PROVIDER_OUTPUT_LIMIT', 'AI_PROVIDER_EMPTY_RESPONSE'].includes(error.code)) throw error
    if (!consumeTextRequestRecovery(error, system, content, options)) throw error
    await beforeRecovery?.()
    options.signal?.throwIfAborted()
    // Recovery keeps the original author cancellation and selected model.
    // Each physical request enforces its own first-response and idle limits.
    // An empty completion is transient, not truncation: retry once on the same
    // review budget instead of escalating it.
    const empty = error.code === 'AI_PROVIDER_EMPTY_RESPONSE'
    const recoverySystem = `${system}\n响应恢复：重新检查完整输入，只输出一个完整 JSON 对象。相同事实或相同证据的问题合并一次，使用简短 explanation/suggestion；不复制整段正文、审查过程或旧输出，不将 JSON 对象再次编码成字符串。完整检查所有要求，不能省略真实问题来缩短输出。`
    const result = await generateTextCompletion(recoverySystem, content, {
      ...options, action: `${options.action}${empty ? 'EmptyRecovery' : 'OutputRecovery'}`,
      maxOutputTokens: empty ? REVIEW_MAX_OUTPUT_TOKENS : RECOVERY_MAX_OUTPUT_TOKENS, boundedReview: true,
    })
    options.signal?.throwIfAborted()
    return result
  }
}
