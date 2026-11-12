import { parsePublicHttpUrl } from './public-http.js'
import { ToolModelConfigurationError, type ToolModelRuntime } from './tool-model-config.js'

export { requestPublicProviderJson as requestWebTool } from './public-http.js'

export type WebToolOperation = 'search' | 'fetch'

/** Explicit protocol wins; only known legacy supplier names imply a protocol. */
export function resolveWebToolProtocol(config: Pick<ToolModelRuntime, 'provider' | 'webToolProtocol'>, operation?: WebToolOperation): import('../../shared/contracts/web-tool.js').WebToolProtocol {
  const protocol = config.webToolProtocol !== undefined ? config.webToolProtocol : config.provider.trim().toLowerCase()
  if (protocol !== 'deepseek' && protocol !== 'bocha') throw new ToolModelConfigurationError('WEB_TOOL_PROVIDER_UNSUPPORTED', '网页工具协议：请选择 deepseek 或 bocha。')
  if (operation === 'fetch' && protocol !== 'deepseek') throw new ToolModelConfigurationError('WEB_TOOL_PROVIDER_UNSUPPORTED', '网页工具协议：Fetch 仅支持 deepseek。')
  return protocol
}

/** Tools accept their own root or exact endpoint; chat paths are never inferred. */
export function webToolEndpoint(config: ToolModelRuntime, operation: WebToolOperation): string {
  const protocol = resolveWebToolProtocol(config, operation)
  if (!config.apiKey.trim()) throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE', 'API Key：请填写网页工具密钥。')
  if (!config.modelName.trim() || config.modelName === 'unconfigured') throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE', '模型 ID：请填写网页工具配置标识。')
  let url: URL
  try { url = parsePublicHttpUrl(config.baseUrl) } catch { throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', 'Base URL：请填写安全的公共 HTTPS 地址，不得包含凭据、查询参数、片段或自定义端口。') }
  if (url.search || new URL(config.baseUrl).hash) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', 'Base URL：请填写安全的公共 HTTPS 地址，不得包含凭据、查询参数、片段或自定义端口。')
  const path = url.pathname.replace(/\/+$/, '')
  if (protocol === 'deepseek') {
    if (!['', '/v1', `/v1/tools/${operation}`].includes(path)) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', `Base URL：端点类型错误，请使用根地址、/v1 或 /v1/tools/${operation}，不能使用聊天或另一网页工具端点。`)
    url.pathname = `/v1/tools/${operation}`
  } else {
    if (!['', '/v1', '/v1/web-search'].includes(path)) throw new ToolModelConfigurationError('WEB_TOOL_ENDPOINT_INVALID', 'Base URL：Bocha Search 请使用根地址、/v1 或 /v1/web-search。')
    url.pathname = '/v1/web-search'
  }
  return url.href
}
