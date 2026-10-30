import type { WeightedRouteSelection, WeightedRoutesStored } from '../../shared/contracts/model-weighted-routes.js'
import { decryptSecret } from './secret-box.js'
import { DataAccessError } from './prisma.js'

type RoutingRuntime = { tier: string; provider: string; modelName: string | null; baseUrl: string | null; apiKey: string | null;
  weightedRoutes?: WeightedRoutesStored; weightedRoute?: WeightedRouteSelection }

/** Resolve a previously admitted choice. Recovery never draws again. */
export function resolveWeightedModelRuntime<T extends RoutingRuntime>(runtime: T, selection?: WeightedRouteSelection): T {
  if (!selection || runtime.tier === 'custom') return runtime
  if (selection.source === 'primary') return { ...runtime, weightedRoute: selection }
  const candidate = runtime.weightedRoutes?.candidates.find(route => route.id === selection.candidateId)
  if (!candidate) throw new DataAccessError(409, 'MODEL_TIER_UNAVAILABLE', '原供应商线路已不可用。')
  return { ...runtime, provider: candidate.provider, modelName: candidate.modelName, baseUrl: candidate.baseUrl,
    apiKey: decryptSecret(candidate.apiKeyCiphertext), weightedRoute: selection }
}

/** The caller retains this actual runtime through the complete logical reply,
 * including tools and internal retries. An empty new pool is the legacy path. */
export function selectWeightedModelRuntime<T extends RoutingRuntime>(runtime: T, random: () => number = Math.random): T {
  const config = runtime.weightedRoutes
  if (runtime.tier === 'custom' || runtime.weightedRoute || !config?.candidates.length) return runtime
  const point = random() * 100
  let boundary = config.primaryWeight
  if (point < boundary) return resolveWeightedModelRuntime(runtime, { source: 'primary' })
  for (const route of config.candidates) {
    boundary += route.weight
    if (point < boundary) return resolveWeightedModelRuntime(runtime, { source: 'candidate', candidateId: route.id })
  }
  return resolveWeightedModelRuntime(runtime, { source: 'candidate', candidateId: config.candidates.at(-1)!.id })
}

/** Actual route identity only: credentials and endpoint URLs never enter logs. */
export function weightedRouteEvidence(selection: WeightedRouteSelection | undefined, provider: string, model: string, physicalRouteId?: string) {
  return selection ? { weightedRoute: { ...selection, provider, model,
    ...(physicalRouteId ? { physicalRouteId } : {}) } } : undefined
}
