import { Agent, fetch as fetchWebTool, type Response as WebToolResponse } from 'undici'
import { parsePublicHttpUrl, publicEgressLookup } from './public-http.js'
import { ToolModelConfigurationError, type ToolModelRuntime } from './tool-model-config.js'

export type WebToolOperation = 'search' | 'fetch'

/** Tools accept their own root or exact endpoint; chat paths are never inferred. */
export function webToolEndpoint(config: ToolModelRuntime, operation: WebToolOperation): string {
  const provider = config.provider.trim().toLowerCase()
  if (!config.apiKey.trim()) throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE', 'API Key：请填写网页工具密钥。')
  if (!config.modelName.trim() || config.modelName === 'unconfigured') throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE', '模型 ID：请填写网页工具配置标识。')
  if (provider !== 'deepseek' && !(operation === 'search' && provider === 'bocha')) throw new ToolModelConfigurationError('WEB_TOOL_PROVIDER_UNSUPPORTED', operation === 'search' ? '供应商：仅支持 bocha、deepseek；渠道名称请填入显示名称。' : '供应商：Fetch 仅支持 deepseek；渠道名称请填入显示名称。')
  let url: URL
  try { url = parsePublicHttpUrl(config.baseUrl) } catch { throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', 'Base URL：请填写安全的公共 HTTPS 地址，不得包含凭据、查询参数、片段或自定义端口。') }
  if (url.search || new URL(config.baseUrl).hash) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', 'Base URL：请填写安全的公共 HTTPS 地址，不得包含凭据、查询参数、片段或自定义端口。')
  const path = url.pathname.replace(/\/+$/, '')
  if (provider === 'deepseek') {
    if (!['', '/v1', `/v1/tools/${operation}`].includes(path)) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', `Base URL：端点类型错误，请使用根地址、/v1 或 /v1/tools/${operation}，不能使用聊天或另一网页工具端点。`)
    url.pathname = `/v1/tools/${operation}`
  } else {
    if (!['', '/v1', '/v1/web-search'].includes(path)) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', 'Base URL：Bocha Search 请使用根地址、/v1 或 /v1/web-search。')
    url.pathname = '/v1/web-search'
  }
  return url.href
}

/** Socket DNS is checked and pinned; credentials cannot follow a redirect. */
export async function requestWebTool(endpoint: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<{ response: WebToolResponse; close: () => Promise<void> }> {
  parsePublicHttpUrl(endpoint)
  signal.throwIfAborted()
  const dispatcher = new Agent({ connections: 1, maxHeaderSize: 16384, allowH2: false, connect: { lookup: publicEgressLookup, timeout: 8000 } })
  try {
    // Keep fetch and its dispatcher on the same Undici protocol. Node 22's
    // built-in fetch embeds Undici 6; the installed Agent uses Undici 8.
    const response = await fetchWebTool(endpoint, {
      dispatcher, method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { response, close: async () => {
      try { if (response.body && !response.body.locked) await response.body.cancel() } finally { await dispatcher.destroy() }
    } }
  } catch (error) { await dispatcher.destroy(); throw error }
}
