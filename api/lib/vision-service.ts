import { env } from '../config/env.js'
import { DataAccessError, prisma } from './prisma.js'
import { setTimeout as delay } from 'node:timers/promises'
import { getToolModelRuntime, type ToolModelRuntime } from './tool-model-config.js'
import { readBoundedPublicBody } from './public-http.js'
import { currentGoalExecution, withoutGoalEffects } from './agent/goal-context.js'
import { assertGoalProviderAdmission, reserveGoalUsage, syncGoalLegacyUsage } from './agent/goal-budget.js'

/**
 * GLM-4.1V 视觉推理旁路（ds-vision-skill 模式）：
 * 像素只发给视觉模型，换回文字描述交给 DeepSeek 主模型；主模型上下文永远不进 base64。
 * 进程内信号量控制免费档并发（默认 4，留 1 缓冲），排队超时/请求超时/重试均有上限。
 */

class VisionRetryableError extends Error {}
type VisionScope = { userId: string; runId: string; signal: AbortSignal }

let inflight = 0
const waiters: Array<() => void> = []

function releaseSlot() {
  inflight -= 1
  const next = waiters.shift()
  if (next) {
    next()
  }
}

/** 获取并发槽位：排队超过 30s 视为视觉服务繁忙 */
function acquireSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  if (inflight < env.aiVisionMaxConcurrent) {
    inflight += 1
    return Promise.resolve(releaseSlot)
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(tryAcquire)
      if (index >= 0) {
        waiters.splice(index, 1)
      }
      reject(new DataAccessError(503, 'VISION_BUSY', '视觉服务繁忙（并发已满），请稍后再试。'))
      signal.removeEventListener('abort', abort)
    }, 30000)

    const tryAcquire = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      inflight += 1
      resolve(releaseSlot)
    }
    const abort = () => {
      clearTimeout(timer)
      const index = waiters.indexOf(tryAcquire)
      if (index >= 0) waiters.splice(index, 1)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    waiters.push(tryAcquire)
  })
}

function isRetryable(error: unknown): boolean {
  return error instanceof VisionRetryableError
}

async function requestOnce(image: { buffer: Buffer; mime: string }, question: string, configured: ToolModelRuntime | null, scope: VisionScope): Promise<string> {
  // 一律 base64 内联：规避 localhost/内网图片对智谱不可达的问题
  const dataUrl = `data:${image.mime};base64,${image.buffer.toString('base64')}`

  const baseUrl = configured?.baseUrl ?? env.aiVisionBaseUrl
  const apiKey = configured?.apiKey ?? env.aiVisionApiKey
  const modelName = configured?.modelName ?? env.aiVisionModel
  scope.signal.throwIfAborted()
  const startedAt = Date.now()
  // Separate vision calls are internal image usage, not another user token
  // charge. Null means unreported; never estimate tokens from the image bytes.
  const goal = currentGoalExecution()
  const observation = await withoutGoalEffects(() => prisma.aiUsageLog.create({ data: { userId: scope.userId, agentRunId: scope.runId,
    targetType: 'agentRun', targetId: scope.runId, providerType: 'image', providerMode: env.aiProviderMode,
    modelName, action: 'view_image', durationMs: 0, requestTokens: null, responseTokens: null,
    ...(goal ? { billingStatus: 'prepared', usageSource: 'unknown' } : {}) } }))
  let promptTokens: number | null = null, completionTokens: number | null = null
  let dispatched = false, rejected = false
  try {
  // This is only a conservative admission reservation, never billed or
  // recorded as observed tokens. The image provider's own usage is authoritative.
  await reserveGoalUsage(`legacy:${observation.id}`, 32768 + question.length + 4096)
  await assertGoalProviderAdmission()
  scope.signal.throwIfAborted()
  if (goal) await withoutGoalEffects(() => prisma.aiUsageLog.update({ where: { id: observation.id }, data: { billingStatus: 'pending_usage' } }))
  scope.signal.throwIfAborted()
  dispatched = true
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      ...(goal ? { max_tokens: 4096 } : {}),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.any([scope.signal, AbortSignal.timeout(env.aiVisionTimeoutMs)]),
  })

  rejected = [400, 401, 403, 404, 422, 429].includes(response.status)
  const body = (await readBoundedPublicBody(response, 2 * 1024 * 1024)).toString('utf8')
  let decoded: unknown
  try { decoded = JSON.parse(body) } catch {
    if (response.ok) throw new DataAccessError(502, 'VISION_ERROR', '视觉服务返回了无效响应。')
    decoded = {}
  }
  const payload = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {}
  const usage = payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage) ? payload.usage as Record<string, unknown> : {}
  const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null
  promptTokens = tokenCount(usage.prompt_tokens)
  completionTokens = tokenCount(usage.completion_tokens)

  if (response.status === 429 || response.status >= 500) {
    throw new VisionRetryableError(`视觉服务返回 ${response.status}`)
  }

  if (!response.ok) {
    throw new DataAccessError(
      502,
      'VISION_ERROR',
      `视觉服务请求失败（${response.status}）。`,
    )
  }

  const choices = Array.isArray(payload.choices) ? payload.choices as Array<{ message?: { content?: unknown } } | null> : []
  const content = choices[0]?.message?.content
  const description = typeof content === 'string' ? content.trim() : ''

  if (!description) {
    throw new DataAccessError(502, 'VISION_ERROR', '视觉服务未返回描述内容。')
  }

  return description
  } finally {
    try {
      await withoutGoalEffects(() => prisma.aiUsageLog.update({ where: { id: observation.id }, data: { requestTokens: promptTokens,
        responseTokens: completionTokens, durationMs: Math.min(2147483647, Date.now() - startedAt),
        ...(goal ? { billingStatus: !dispatched ? 'not_dispatched' : rejected ? 'provider_rejected'
          : promptTokens !== null && completionTokens !== null ? 'exempt' : 'pending_usage',
          usageSource: promptTokens !== null && completionTokens !== null ? 'reported' : 'unknown' } : {}) } }))
      if (goal) await syncGoalLegacyUsage(observation.id)
    } catch {
      // The pre-dispatch observation remains unknown, not zero. A telemetry
      // outage must not discard paid output or replace the provider's error.
      console.warn('[vision] Usage finalization failed; observation remains unknown', { observationId: observation.id })
    }
  }
}

/**
 * 把一张图片发给 GLM 视觉模型换回文字描述。
 * 未配置 key 时抛 503；429/5xx 退避 2s 重试 1 次；未知网络失败不盲目重试。
 */
export async function describeImageWithVision(
  image: { buffer: Buffer; mime: string },
  question: string,
  scope: VisionScope,
): Promise<string> {
  const configured = await getToolModelRuntime('tool:image-vision')
  if (!configured && !env.aiVisionApiKeyConfigured) {
    throw new DataAccessError(503, 'VISION_NOT_CONFIGURED', '视觉服务未配置（缺少 AI_VISION_API_KEY）。')
  }

  const release = await acquireSlot(scope.signal)

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await requestOnce(image, question, configured, scope)
      } catch (error) {
        if (!isRetryable(error) || attempt >= 1) {
          throw error
        }
        await delay(2000, undefined, { signal: scope.signal })
      }
    }
  } finally {
    release()
  }
}
