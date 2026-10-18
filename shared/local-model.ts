/** Local targets are never fetched by the cloud API. No DNS names, metadata,
 * credentials in URLs, redirects or unspecified interfaces are accepted. */
export const localModelProviders = ['local-openai', 'local-lmstudio', 'local-ollama'] as const
export function isLocalModelProvider(provider: string): boolean {
  return (localModelProviders as readonly string[]).includes(provider)
}
export function normalizeLocalModelUrl(value: string): string {
  const raw = /^https?:\/\/(\[::1\]|[^/:?#]+)(?::([0-9]{1,5}))?(\/[^?#]*)?$/i.exec(value)
  if (!raw || /[\s%\\]/.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw[3] ?? '')) throw new Error('请填写本机或明确的局域网 IP 模型地址。')
  const url = new URL(value)
  const host = raw[1].replace(/^\[|\]$/g, '').toLowerCase()
  const parts = host.split('.').map(Number)
  const ipv4 = parts.length === 4 && parts.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === host.split('.')[i])
  const privateV4 = ipv4 && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['localhost', '127.0.0.1', '::1'].includes(host) && !privateV4 || /%|\\/.test(url.pathname)) throw new Error('请填写本机或明确的局域网 IP 模型地址。')
  if (host === 'localhost') url.hostname = '127.0.0.1'
  return url.toString().replace(/\/+$/, '')
}
export type LocalConnectorSetup = { version: 1; server: string; token: string; provider: string; model: string; baseUrl: string; contextWindowTokens: number }
