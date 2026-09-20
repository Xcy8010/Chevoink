import { randomBytes, randomInt } from 'node:crypto'
import sharp from 'sharp'
import { Agent, fetch } from 'undici'
import type { ModelReasoningEffort } from '../../shared/contracts/index.js'
import { DataAccessError } from './prisma.js'
import { parsePublicHttpUrl, publicEgressLookup, readBoundedPublicBody } from './public-http.js'

type CheckStatus = 'verified' | 'unsupported' | 'unconfirmed'
export type CustomModelCapabilityValidation = {
  reasoningEfforts: ModelReasoningEffort[]
  defaultReasoningEffort: ModelReasoningEffort
  visionEnabled: boolean
  reasoningParameterMode: 'native' | 'omit'
  outputTokenParameter: 'max_tokens' | 'max_completion_tokens'
  thinkingEnabled: boolean
  capabilityValidation: {
    version: 1
    checkedAt: string
    text: 'verified'
    reasoning: 'parameter_accepted' | 'parameter_unsupported'
    vision: CheckStatus
    tools: CheckStatus
    requests: number
  }
}
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const invalidResponse = () => new DataAccessError(502, 'CUSTOM_MODEL_INVALID_RESPONSE', '模型未返回可核验的测试响应，请检查兼容接口和模型名称。')

/** A generic 400 is not evidence of an unsupported capability. Never infer
 * support from model/provider names, auth errors, rate limits or network errors. */
function explicitlyUnsupported(payload: JsonObject, field: RegExp): boolean {
  const error = object(payload.error)
  const parameter = typeof error.param === 'string' ? error.param : ''
  const message = typeof error.message === 'string' ? error.message : ''
  return field.test(`${parameter} ${message}`) && /unsupported|not support|does not support|not allowed|not permitted|invalid|unknown|unrecognized|not available|不支持|无效|不允许/i.test(message + ' ' + String(error.code ?? ''))
}

function messageOf(payload: JsonObject): { message: JsonObject; finish: unknown } {
  const choice = object(Array.isArray(payload.choices) ? payload.choices[0] : undefined)
  return { message: object(choice.message), finish: choice.finish_reason }
}

/** At most 7 tiny synthetic requests. No manuscript, usage billing or external
 * tools are involved; these calls use only the supplied account/endpoint/model.
 * "parameter_accepted" means the endpoint accepted the tested setting, not a
 * guarantee that an opaque compatible gateway actually varies its thinking. */
export async function validateCustomModelCapabilities(input: {
  provider: string
  modelName: string
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
}): Promise<CustomModelCapabilityValidation> {
  let endpoint: URL
  try {
    const base = parsePublicHttpUrl(input.baseUrl)
    if (base.search || !input.modelName.trim() || !input.apiKey.trim() || /[\r\n]/.test(input.apiKey)) throw new Error('invalid')
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/chat/completions`
    endpoint = base
  } catch { throw new DataAccessError(400, 'CUSTOM_MODEL_URL_INVALID', '请填写有效的公网 HTTPS 模型接口地址、模型名称和 API Key。') }
  const total = new AbortController()
  const totalTimer = setTimeout(() => total.abort(), 50_000)
  const signal = input.signal ? AbortSignal.any([input.signal, total.signal]) : total.signal
  const dispatcher = new Agent({ connections: 1, pipelining: 1, maxHeaderSize: 16384,
    connect: { lookup: publicEgressLookup, timeout: 8000 }, headersTimeout: 12_000, bodyTimeout: 12_000 })
  let requests = 0
  let outputTokenParameter: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'
  let outputParameterConfirmed = false
  // An explicitly chosen protocol is a candidate to test, not inferred model
  // capability. The persisted flag reproduces the actual successful wire shape.
  let thinkingEnabled = input.provider.trim().toLowerCase() === 'deepseek'
  const cancellation = () => input.signal?.aborted
    ? new DataAccessError(409, 'CUSTOM_MODEL_VALIDATION_CANCELLED', '模型验证已取消，未保存能力配置。')
    : new DataAccessError(504, 'CUSTOM_MODEL_VALIDATION_TIMEOUT', '模型验证超时，请稍后重试；未将超时判为能力不支持。')
  const rawProbe = async (body: JsonObject): Promise<{ status: number; payload: JsonObject }> => {
    if (signal.aborted) throw cancellation()
    if (requests >= 7) throw new DataAccessError(409, 'CUSTOM_MODEL_VALIDATION_LIMIT', '本次模型验证已达到请求上限，请稍后重试。')
    requests++
    const attempt = new AbortController()
    const attemptTimer = setTimeout(() => attempt.abort(), 12_000)
    const requestSignal = AbortSignal.any([signal, attempt.signal])
    let response: Awaited<ReturnType<typeof fetch>> | undefined
    try {
      response = await fetch(endpoint, { method: 'POST', dispatcher, redirect: 'manual', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify({ model: input.modelName, stream: false, [outputTokenParameter]: 256,
          ...(thinkingEnabled ? { thinking: { type: 'enabled' } } : {}), ...body }) })
      if (response.status >= 300 && response.status < 400) throw new DataAccessError(400, 'CUSTOM_MODEL_REDIRECT_REJECTED', '模型接口发生重定向，请直接填写最终接口地址。')
      if ([401, 403].includes(response.status)) throw new DataAccessError(400, 'CUSTOM_MODEL_AUTH_FAILED', '模型认证失败，请检查 API Key、账号权限和模型访问权限。')
      if (response.status === 429) throw new DataAccessError(429, 'CUSTOM_MODEL_RATE_LIMITED', '模型账号暂时限流或额度不足，请稍后重试或检查供应商账号。')
      if (response.status >= 500 || response.status === 408) throw new DataAccessError(503, 'CUSTOM_MODEL_PROVIDER_UNAVAILABLE', '模型服务暂时不可用，请稍后重试；未更改能力判断。')
      const bytes = await readBoundedPublicBody(response, 64 * 1024)
      if (requestSignal.aborted) throw cancellation()
      let payload: JsonObject
      try { payload = object(JSON.parse(bytes.toString('utf8'))) } catch { throw invalidResponse() }
      if (!Object.keys(payload).length || (response.ok && payload.error)) throw invalidResponse()
      if (!response.ok && ![400, 422].includes(response.status)) throw new DataAccessError(400, 'CUSTOM_MODEL_REQUEST_REJECTED', '模型接口拒绝测试请求，请检查接口地址和模型名称。')
      if (response.ok) outputParameterConfirmed = true
      return { status: response.status, payload }
    } catch (error) {
      if (requestSignal.aborted) throw cancellation()
      if (error instanceof DataAccessError) throw error
      throw new DataAccessError(502, 'CUSTOM_MODEL_CONNECTION_FAILED', '无法安全连接模型接口或读取响应，请检查公网地址及网络后重试。')
    } finally {
      clearTimeout(attemptTimer)
      await response?.body?.cancel().catch(() => undefined)
    }
  }
  const probe = async (body: JsonObject) => {
    // Each protocol option can change at most once; every attempt, including
    // replacements, uses the same global seven-call/time limit.
    for (;;) {
      const result = await rawProbe(body)
      const message = object(result.payload.error).message
      if (!outputParameterConfirmed && thinkingEnabled && [400, 422].includes(result.status)
        && explicitlyUnsupported(result.payload, /\bthinking\b/i)) {
        thinkingEnabled = false
        continue
      }
      if (!outputParameterConfirmed && outputTokenParameter === 'max_tokens' && [400, 422].includes(result.status)
        && explicitlyUnsupported(result.payload, /\bmax_tokens\b/i)
        && typeof message === 'string' && /\bmax_completion_tokens\b/.test(message)) {
        outputTokenParameter = 'max_completion_tokens'
        continue
      }
      return result
    }
  }
  const token = randomBytes(8).toString('hex')
  const messages = [{ role: 'user', content: `Reply with exactly this token and nothing else: ${token}` }]
  const verifyText = (payload: JsonObject) => {
    const { message } = messageOf(payload)
    const text = typeof message.content === 'string' ? message.content : ''
    return text.trim() === token
  }
  const acceptedTruncatedThinking = (payload: JsonObject) => {
    const { message, finish } = messageOf(payload)
    if (finish !== 'length') return false
    const reasoning = message.reasoning_content ?? message.reasoning
    const usage = object(payload.usage)
    const validUsage = [usage.prompt_tokens, usage.completion_tokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      && typeof usage.completion_tokens === 'number' && usage.completion_tokens > 0
    // Opaque reasoning models need not expose their private reasoning channel.
    // This is parameter admission only, never evidence of a verified text reply.
    return validUsage || (typeof reasoning === 'string' && reasoning.trim().length > 0)
  }
  try {
    const reasoningEfforts: ModelReasoningEffort[] = []
    let textVerified = false
    for (const effort of ['high', 'medium', 'low', 'max'] as const) {
      const result = await probe({ messages, reasoning_effort: effort })
      const nonceVerified = verifyText(result.payload)
      if (result.status >= 200 && result.status < 300 && (nonceVerified || acceptedTruncatedThinking(result.payload))) {
        reasoningEfforts.push(effort)
        textVerified ||= nonceVerified
      }
      else if (![400, 422].includes(result.status) || !explicitlyUnsupported(result.payload, /reasoning[_ -]?effort/i)) throw invalidResponse()
    }
    const reasoningParameterMode = reasoningEfforts.length ? 'native' : 'omit'
    if (!textVerified) {
      const result = await probe({ messages })
      if (result.status < 200 || result.status >= 300 || !verifyText(result.payload)) throw invalidResponse()
      textVerified = true
    }
    if (!reasoningEfforts.length) reasoningEfforts.push('none')
    const defaultReasoningEffort = reasoningEfforts[0]
    const effortOrder: ModelReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    reasoningEfforts.sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))
    // Use the cheapest confirmed setting for optional capability probes.
    const probeEffort = reasoningEfforts.includes('low') ? 'low' : defaultReasoningEffort
    const reasoning = reasoningParameterMode === 'native' ? { reasoning_effort: probeEffort } : {}
    let vision: CheckStatus = 'unconfirmed'
    let tools: CheckStatus = 'unconfirmed'
    const optionalProbe = async (body: JsonObject, field: RegExp, verify: (payload: JsonObject) => boolean): Promise<CheckStatus> => {
      if (input.signal?.aborted) throw cancellation()
      if (signal.aborted || requests >= 7) return 'unconfirmed'
      try {
        const result = await probe({ ...reasoning, ...body })
        if (result.status >= 200 && result.status < 300) return verify(result.payload) ? 'verified' : 'unconfirmed'
        return explicitlyUnsupported(result.payload, field) ? 'unsupported' : 'unconfirmed'
      } catch {
        if (input.signal?.aborted) throw cancellation()
        return 'unconfirmed'
      }
    }
    const palette = [
      ['red', '#ff0000'], ['green', '#00a000'], ['blue', '#0000ff'], ['yellow', '#ffff00'],
      ['black', '#000000'], ['white', '#ffffff'], ['orange', '#ff8800'], ['purple', '#800080'],
    ] as const
    const remainingColors = [...palette]
    const colors = Array.from({ length: 4 }, () => remainingColors.splice(randomInt(remainingColors.length), 1)[0])
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="32">${colors.map(([, color], index) => `<rect x="${index * 32}" y="0" width="32" height="32" fill="${color}"/>`).join('')}</svg>`
    const png = await sharp(Buffer.from(svg)).png().toBuffer()
    vision = await optionalProbe({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'Read the four colored squares from left to right. Reply only with four lowercase English color names separated by commas. Allowed colors: red, green, blue, yellow, black, white, orange, purple.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
    ] }] }, /image|vision|multimodal|图片|视觉/i, payload => {
      const content = messageOf(payload).message.content
      return typeof content === 'string' && content.trim().toLowerCase().replace(/\s/g, '') === colors.map(([name]) => name).join(',')
    })
    tools = await optionalProbe({ messages: [{ role: 'user', content: `Call capability_probe with token ${token}. Do not respond with prose.` }],
      tools: [{ type: 'function', function: { name: 'capability_probe', description: 'Synthetic validation only; no external action.',
        parameters: { type: 'object', properties: { token: { type: 'string', enum: [token] } }, required: ['token'], additionalProperties: false } } }],
    }, /tools?|function|工具|函数/i, payload => {
      const calls = messageOf(payload).message.tool_calls
      if (!Array.isArray(calls) || calls.length !== 1) return false
      const call = object(object(calls[0]).function)
      if (call.name !== 'capability_probe' || typeof call.arguments !== 'string') return false
      try { return object(JSON.parse(call.arguments)).token === token } catch { return false }
    })
    if (input.signal?.aborted) throw cancellation()
    return { reasoningEfforts, defaultReasoningEffort, visionEnabled: vision === 'verified', reasoningParameterMode, outputTokenParameter, thinkingEnabled,
      capabilityValidation: { version: 1, checkedAt: new Date().toISOString(), text: 'verified',
        reasoning: reasoningParameterMode === 'native' ? 'parameter_accepted' : 'parameter_unsupported', vision, tools, requests } }
  } finally {
    clearTimeout(totalTimer)
    await dispatcher.destroy().catch(() => undefined)
  }
}
