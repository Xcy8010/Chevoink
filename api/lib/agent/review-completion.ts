import { generateTextCompletion } from '../ai-service.js'
import { DataAccessError } from '../prisma.js'
import { env } from '../../config/env.js'

export const REVIEW_MAX_OUTPUT_TOKENS = 16_384
const RECOVERY_MAX_OUTPUT_TOKENS = 32_768

/** Only a provider-confirmed failure (output ceiling or empty completion)
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
  const originalSignal = options.signal
  const deadline = new AbortController()
  // 等待上限跟随 env 配置：思考型模型（MiMo 等）单次检查可接近 4 分钟，
  // 挂死连接由流式静默看门狗（aiTextStreamIdleMs）提前释放，不再叠加更短的硬帽
  const timer = setTimeout(() => deadline.abort(), env.aiTextTimeoutMs)
  const signal = originalSignal ? AbortSignal.any([originalSignal, deadline.signal]) : deadline.signal
  options = { ...options, signal }
  try {
    try {
      const result = await generateTextCompletion(system, content, { ...options, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, boundedReview: true })
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof DataAccessError) || !['AI_PROVIDER_OUTPUT_LIMIT', 'AI_PROVIDER_EMPTY_RESPONSE'].includes(error.code)) throw error
      await beforeRecovery?.()
      signal.throwIfAborted()
      // Recovery shares the original deadline and model; it cannot buy more time.
      // An empty completion is transient, not truncation: retry once on the same
      // review budget instead of escalating it.
      const empty = error.code === 'AI_PROVIDER_EMPTY_RESPONSE'
      const result = await generateTextCompletion(system, content, {
        ...options, action: `${options.action}${empty ? 'EmptyRecovery' : 'OutputRecovery'}`,
        maxOutputTokens: empty ? REVIEW_MAX_OUTPUT_TOKENS : RECOVERY_MAX_OUTPUT_TOKENS, boundedReview: true,
      })
      signal.throwIfAborted()
      return result
    }
  } catch (error) {
    originalSignal?.throwIfAborted()
    if (deadline.signal.aborted) throw new DataAccessError(504, 'AI_PROVIDER_TIMEOUT', '本次质量或连续性检查已达等待上限，已中止模型请求；检查未完成，已保存正文保留。')
    throw error
  } finally { clearTimeout(timer) }
}
