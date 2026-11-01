import { createHash } from 'node:crypto'
/** Only the response projection is redacted. Append-only audit evidence is never rewritten. */
export function presentAdminAuditDetail(value: unknown): Record<string, unknown> {
  const publicFields = new Set(['requestTokens','responseTokens','totalTokens','inputTokens','outputTokens','cacheHitTokens','cacheMissTokens','contextWindowTokens','outputTokenParameter','apiKeyConfigured'])
  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(redact)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([key]) => publicFields.has(key) || !/password|secret|token|credential|api.?key|cipher|content|body|prompt|message/i.test(key)).map(([key,item]) => {
      if (/base.?url|endpoint.?url/i.test(key) && typeof item === 'string') {
        try { const url = new URL(item); return [key,{origin:url.origin,pathFingerprint:createHash('sha256').update(url.pathname).digest('hex')}] }
        catch { return [key,'[地址已隐藏]'] }
      }
      return [key,redact(item)]
    }))
    return input
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? redact(value) as Record<string,unknown> : {}
}
