import { generateTextCompletion } from '../ai-service.js'
import { DataAccessError } from '../prisma.js'
import { env } from '../../config/env.js'

export const REVIEW_MAX_OUTPUT_TOKENS = 16_384
const RECOVERY_MAX_OUTPUT_TOKENS = 32_768

/** Only a provider-confirmed output ceiling permits this separately billed,
 * bounded recovery. Unknown responses, transport errors and cancellation never
 * redispatch here. The caller still validates the complete report and revision. */
export async function generateReviewCompletion(
  system: string,
  content: string,
  options: Omit<Parameters<typeof generateTextCompletion>[2], 'maxOutputTokens'>,
  beforeRecovery?: () => Promise<void>,
) {
  options.signal?.throwIfAborted()
  const originalSignal = options.signal
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), Math.min(env.aiTextTimeoutMs, 180_000))
  const signal = originalSignal ? AbortSignal.any([originalSignal, deadline.signal]) : deadline.signal
  options = { ...options, signal }
  try {
    try {
      const result = await generateTextCompletion(system, content, { ...options, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS })
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof DataAccessError) || error.code !== 'AI_PROVIDER_OUTPUT_LIMIT') throw error
      await beforeRecovery?.()
      signal.throwIfAborted()
      // Recovery shares the original deadline and model; it cannot buy more time.
      const result = await generateTextCompletion(system, content, {
        ...options, action: `${options.action}OutputRecovery`, maxOutputTokens: RECOVERY_MAX_OUTPUT_TOKENS,
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
