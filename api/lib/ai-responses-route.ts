import type { ToolCallingProtocol } from '../../shared/contracts/index.js'

const alwaysResponses = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'])
const responsesWithReasoning = new Set(['gpt-6-sol', 'gpt-6-luna'])

function httpsEndpoint(value: string): URL | null {
  const url = URL.parse(value)
  return url?.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url : null
}

/** OpenAI's documented tool-call rules apply to the direct API and to the
 * corresponding verified model names on the known OpenAI-compatible gateway.
 * A verified capability also supports provider aliases and other HTTPS APIs.
 * https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters */
export function resolveResponsesEndpoint(input: {
  model: string
  baseUrl?: string | null
  reasoningEffort: string
  reasoningParameterMode?: 'native' | 'omit'
  toolCallingProtocol?: ToolCallingProtocol | null
}): string | null {
  if (!input.baseUrl || input.toolCallingProtocol === 'chat') return null
  const url = httpsEndpoint(input.baseUrl)
  if (!url) return null
  const basePath = url.pathname.replace(/\/+$/, '')
  if (input.toolCallingProtocol !== 'responses') {
    if (basePath !== '/v1') return null
    const official = url.origin === 'https://api.openai.com'
    const yunshu = url.origin === 'https://yunshu.chevolink.com'
    const nativeNone = input.reasoningEffort === 'none' && input.reasoningParameterMode !== 'omit'
    if (!(official && (alwaysResponses.has(input.model) || responsesWithReasoning.has(input.model) && !nativeNone)
      || yunshu && input.model === 'gpt-6.1-terra')) return null
  }
  return url.origin + basePath + '/responses'
}

/** A supplier can reject before executing. Its error text never chooses a URL. */
export function requiresResponsesToolProtocol(status: number, message: unknown): boolean {
  if ((status !== 400 && status !== 422) || typeof message !== 'string') return false
  const text = message.slice(0, 1500)
  if (!/\b(?:function(?:s| calls?)?|tools?)\b/i.test(text)) return false
  const responses = '(?:the\\s+)?(?:OpenAI\\s+)?(?:/v1/responses\\b|Responses\\s+API\\b)'
  if (new RegExp('\\b(?:not|never|cannot|can\'t)\\s+use\\s+' + responses, 'i').test(text)) return false
  return new RegExp('\\b(?:use|switch to|requires?|only available (?:in|via|on)|supported only (?:in|via|on))\\s+' + responses, 'i').test(text)
}

/** These fields come from the hash-verified, server-encoded request snapshot. */
export function isResponsesToolRequest(endpoint: unknown, body: { model?: unknown; input?: unknown; stream?: unknown } | undefined): boolean {
  return typeof endpoint === 'string' && Boolean(httpsEndpoint(endpoint)?.pathname.endsWith('/responses'))
    && typeof body?.model === 'string' && Array.isArray(body.input) && body.stream === true
}

export function providerRequestOutputLimit(request: {
  endpoint?: unknown
  body?: { model?: unknown; input?: unknown; stream?: unknown; max_output_tokens?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown }
} | undefined): unknown {
  const body = request?.body
  return isResponsesToolRequest(request?.endpoint, body)
    ? body?.max_output_tokens
    : body?.max_completion_tokens ?? body?.max_tokens
}
