import { generateTextCompletion } from '../ai-service.js'
import { DataAccessError } from '../prisma.js'

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
  try {
    return await generateTextCompletion(system, content, { ...options, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS })
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!(error instanceof DataAccessError) || error.code !== 'AI_PROVIDER_OUTPUT_LIMIT') throw error
    await beforeRecovery?.()
    options.signal?.throwIfAborted()
    // Same full input and model configuration, larger allowance; never consume
    // the previous partial JSON as a successful report or rewrite the manuscript.
    return generateTextCompletion(system, content, {
      ...options, action: `${options.action}OutputRecovery`, maxOutputTokens: RECOVERY_MAX_OUTPUT_TOKENS,
    })
  }
}
