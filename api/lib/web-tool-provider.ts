import { Agent } from 'undici'
import { parsePublicHttpUrl, publicEgressLookup } from './public-http.js'
import { ToolModelConfigurationError, type ToolModelRuntime } from './tool-model-config.js'

export type WebToolOperation = 'search' | 'fetch'

/** Tools accept their own root or exact endpoint; chat paths are never inferred. */
export function webToolEndpoint(config: ToolModelRuntime, operation: WebToolOperation): string {
  const provider = config.provider.trim().toLowerCase()
  if (!config.apiKey.trim() || !config.modelName.trim() || config.modelName === 'unconfigured') throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE')
  if (provider !== 'deepseek' && !(operation === 'search' && provider === 'bocha')) throw new ToolModelConfigurationError('WEB_TOOL_PROVIDER_UNSUPPORTED')
  let url: URL
  try { url = parsePublicHttpUrl(config.baseUrl) } catch { throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID') }
  if (url.search || new URL(config.baseUrl).hash) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID')
  const path = url.pathname.replace(/\/+$/, '')
  if (provider === 'deepseek') {
    if (!['', '/v1', `/v1/tools/${operation}`].includes(path)) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID')
    url.pathname = `/v1/tools/${operation}`
  } else {
    if (!['', '/v1', '/v1/web-search'].includes(path)) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID')
    url.pathname = '/v1/web-search'
  }
  return url.href
}

/** Socket DNS is checked and pinned; credentials cannot follow a redirect. */
export async function requestWebTool(endpoint: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<{ response: Response; close: () => Promise<void> }> {
  parsePublicHttpUrl(endpoint)
  signal.throwIfAborted()
  const dispatcher = new Agent({ connections: 1, maxHeaderSize: 16384, allowH2: false, connect: { lookup: publicEgressLookup, timeout: 8000 } })
  try {
    const response = await fetch(endpoint, {
      dispatcher, method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } as RequestInit & { dispatcher: Agent })
    return { response, close: async () => {
      try { if (response.body && !response.body.locked) await response.body.cancel() } finally { await dispatcher.destroy() }
    } }
  } catch (error) { await dispatcher.destroy(); throw error }
}
