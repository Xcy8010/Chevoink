/** Server-owned review output contract. Capabilities are endpoint/model specific;
 * a provider label or a similarly named model on a proxy is not proof of support.
 * https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/structured-output
 */
export type ReviewResponseFormat = 'json_object'

const MIMO_JSON_MODELS = new Set([
  'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed',
  'mimo-v2.5-pro', 'mimo-v2.5',
])

export function supportsReviewJsonObject(baseUrl: string, model: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && url.hostname === 'api.xiaomimimo.com'
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/$/, '') === '/v1' && MIMO_JSON_MODELS.has(model)
  } catch { return false }
}

export function reviewResponseFormatPayload(format: ReviewResponseFormat | undefined, baseUrl: string, model: string) {
  return format === 'json_object' && supportsReviewJsonObject(baseUrl, model)
    ? { response_format: { type: 'json_object' as const } } : {}
}
