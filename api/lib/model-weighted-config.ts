import { randomUUID } from 'node:crypto'
import { weightedRoutesInputSchema, type WeightedRoutesInput, type WeightedRoutesStored, type WeightedRoutesView } from '../../shared/contracts/model-weighted-routes.js'
import { encryptSecret } from './secret-box.js'
import { DataAccessError } from './prisma.js'

export function readWeightedRoutes(metadata: unknown): WeightedRoutesStored | undefined {
  if (!metadata || typeof metadata !== 'object' || !('weightedRoutes' in metadata)) return undefined
  const stored = metadata.weightedRoutes as WeightedRoutesStored
  if (!stored || !Array.isArray(stored.candidates)) throw new DataAccessError(409, 'MODEL_ROUTES_INVALID', '权重线路配置无效。')
  const parsed = weightedRoutesInputSchema.safeParse({ primaryWeight: stored.primaryWeight, candidates: stored.candidates.map(({ apiKeyCiphertext: _secret, ...route }) => route) })
  if (!parsed.success || stored.candidates.some(route => !route.id || !route.apiKeyCiphertext)) throw new DataAccessError(409, 'MODEL_ROUTES_INVALID', '权重线路配置无效。')
  return stored
}
export function presentWeightedRoutes(metadata: unknown): WeightedRoutesView | undefined {
  const stored = readWeightedRoutes(metadata)
  return stored ? { primaryWeight: stored.primaryWeight, candidates: stored.candidates.map(route => ({
    id: route.id, label: route.label, weight: route.weight, provider: route.provider,
    ...(route.enabled !== undefined ? { enabled: route.enabled } : {}), ...(route.imageQuality ? { imageQuality: route.imageQuality } : {}),
    modelName: route.modelName, baseUrl: route.baseUrl, apiKeyConfigured: Boolean(route.apiKeyCiphertext),
  })) } : undefined
}
export function saveWeightedRoutes(input: WeightedRoutesInput, metadata: unknown): WeightedRoutesStored {
  const ids = input.candidates.flatMap(route => route.id ? [route.id] : [])
  if (new Set(ids).size !== ids.length) throw new DataAccessError(400, 'MODEL_ROUTES_INVALID', '权重线路编号不能重复。')
  const previous = new Map(readWeightedRoutes(metadata)?.candidates.map(route => [route.id, route]) ?? [])
  return { primaryWeight: input.candidates.length ? input.primaryWeight : 100, candidates: input.candidates.map(route => {
    const old = route.id ? previous.get(route.id) : undefined
    const key = route.apiKey?.trim()
    const apiKeyCiphertext = key ? encryptSecret(key) : old?.apiKeyCiphertext
    if (!apiKeyCiphertext) throw new DataAccessError(400, 'MODEL_CONFIG_INCOMPLETE', '新增线路必须填写 API Key。')
    return { id: old?.id ?? randomUUID(), label: route.label, weight: route.weight, provider: route.provider,
      modelName: route.modelName, baseUrl: route.baseUrl, apiKeyCiphertext,
      ...(route.enabled !== undefined ? { enabled: route.enabled } : {}), ...(route.imageQuality ? { imageQuality: route.imageQuality } : {}) }
  }) }
}
