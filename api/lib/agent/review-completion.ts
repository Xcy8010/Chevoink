import { generateTextCompletion } from '../ai-service.js'
import { DataAccessError } from '../prisma.js'
import { env } from '../../config/env.js'
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
      if (!consumeTextRequestRecovery(error, system, content, options)) throw error
      await beforeRecovery?.()
      signal.throwIfAborted()
      // Recovery shares the original deadline and model; it cannot buy more time.
      // An empty completion is transient, not truncation: retry once on the same
      // review budget instead of escalating it.
      const empty = error.code === 'AI_PROVIDER_EMPTY_RESPONSE'
      const recoverySystem = `${system}\n响应恢复：重新检查完整输入，只输出一个完整 JSON 对象。相同事实或相同证据的问题合并一次，使用简短 explanation/suggestion；不复制整段正文、审查过程或旧输出，不将 JSON 对象再次编码成字符串。完整检查所有要求，不能省略真实问题来缩短输出。`
      const result = await generateTextCompletion(recoverySystem, content, {
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

/** Classify the existing review deadline without retrying or extending it. */
export async function runReviewStep<T>(authorSignal: AbortSignal, reviewSignal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  try {
    authorSignal.throwIfAborted()
    reviewSignal.throwIfAborted()
    const result = await operation()
    authorSignal.throwIfAborted()
    reviewSignal.throwIfAborted()
    return result
  } catch (error) {
    authorSignal.throwIfAborted()
    if (reviewSignal.aborted) throw new DataAccessError(504, 'AI_PROVIDER_TIMEOUT', '检查响应未在等待时间内完成，正文和已收到的报告保留。')
    throw error
  }
}
