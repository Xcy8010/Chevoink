import { randomUUID } from 'node:crypto'
import type { WeightedRoutesInput, WeightedRoutesStored, WeightedRoutesView } from '../../shared/contracts/model-weighted-routes.js'
import { encryptSecret } from './secret-box.js'
import { DataAccessError } from './prisma.js'

export function readWeightedRoutes(metadata: unknown): WeightedRoutesStored | undefined {
  return metadata && typeof metadata === 'object' && 'weightedRoutes' in metadata
    ? metadata.weightedRoutes as WeightedRoutesStored : undefined
}
export function presentWeightedRoutes(metadata: unknown): WeightedRoutesView | undefined {
  const stored = readWeightedRoutes(metadata)
  return stored ? { primaryWeight: stored.primaryWeight, candidates: stored.candidates.map(route => ({
    id: route.id, label: route.label, weight: route.weight, provider: route.provider,
    modelName: route.modelName, baseUrl: route.baseUrl, apiKeyConfigured: Boolean(route.apiKeyCiphertext),
  })) } : undefined
}
export function saveWeightedRoutes(input: WeightedRoutesInput, metadata: unknown): WeightedRoutesStored {
  const previous = new Map(readWeightedRoutes(metadata)?.candidates.map(route => [route.id, route]) ?? [])
  return { primaryWeight: input.candidates.length ? input.primaryWeight : 100, candidates: input.candidates.map(route => {
    const old = route.id ? previous.get(route.id) : undefined
    const key = route.apiKey?.trim()
    const apiKeyCiphertext = key ? encryptSecret(key) : old?.apiKeyCiphertext
    if (!apiKeyCiphertext) throw new DataAccessError(400, 'MODEL_CONFIG_INCOMPLETE', '新增线路必须填写 API Key。')
    return { id: old?.id ?? randomUUID(), label: route.label, weight: route.weight, provider: route.provider,
      modelName: route.modelName, baseUrl: route.baseUrl, apiKeyCiphertext }
  }) }
}
