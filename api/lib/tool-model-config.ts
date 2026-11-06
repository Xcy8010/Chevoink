import { readModelActivities } from '../../shared/model-activity.js'
import { prisma } from './prisma.js'
import { resolveSystemModelConfig } from './model-lifecycle.js'
import { decryptSecret } from './secret-box.js'
import type { WebToolProtocol } from '../../shared/contracts/web-tool.js'
import { imageQualityConfigSchema, type ImageQualityConfig } from '../../shared/contracts/image-model.js'
import { readWeightedRoutes } from './model-weighted-config.js'
import type { WeightedRoutesStored } from '../../shared/contracts/model-weighted-routes.js'
import { admitImagePrice, type ImagePrice } from './billing/image-price.js'
import { readModelRoutes } from './model-route-config.js'

export type ToolModelKey = 'tool:image-generation' | 'tool:image-vision' | 'tool:web-search' | 'tool:web-fetch'
export type ToolModelRuntime = { weightedRoutes?: WeightedRoutesStored; imagePrice?: ImagePrice; provider: string; modelName: string; baseUrl: string; apiKey: string; routes?: Array<{ id: string; provider: string; modelName: string; baseUrl: string; apiKey: string; imageQuality?: ImageQualityConfig }>; imageQuality?: ImageQualityConfig; webToolProtocol?: WebToolProtocol; modelConfigId?: string; modelConfigRevision?: number }

const cache = new Map<ToolModelKey, { expiresAt: number; value: ToolModelRuntime | null }>()

export class ToolModelConfigurationError extends Error {
  constructor(readonly code: string, readonly configurationMessage?: string) { super(code); this.name = 'ToolModelConfigurationError' }
}

export function clearToolModelRuntimeCache(): void { cache.clear() }

/** Web tools fail explicitly on unavailable/incomplete enabled config; absent config preserves legacy fallback. */
export async function getToolModelRuntime(key: ToolModelKey): Promise<ToolModelRuntime | null> {
  const cached = cache.get(key)
  if (key !== 'tool:image-generation' && cached && cached.expiresAt > Date.now()) {
    if (!cached.value?.modelConfigId) return cached.value
    const current = await prisma.aiModelConfig.findUnique({ where: { id: cached.value.modelConfigId }, select: { archivedAt: true, revision: true } })
    if (current && !current.archivedAt && current.revision === cached.value.modelConfigRevision) return cached.value
    cache.delete(key)
  }
  let record = await prisma.aiModelConfig.findFirst({ where: { key, ownerUserId: null, archivedAt: null, enabled: true } }).catch(() => {
    if (key === 'tool:web-search' || key === 'tool:web-fetch' || key === 'tool:image-generation') throw new ToolModelConfigurationError('TOOL_CONFIG_UNAVAILABLE')
    return null
  })
  if (record?.archivedById) record = await resolveSystemModelConfig(key)
  if (!record) {
    const original = await prisma.aiModelConfig.findFirst({ where: { key, ownerUserId: null } })
    if (original?.archivedAt || original?.archivedById) record = await resolveSystemModelConfig(key)
    if (key === 'tool:image-generation' && original && !record) throw new ToolModelConfigurationError('TOOL_CONFIG_UNAVAILABLE')
  }
  if ((key === 'tool:web-search' || key === 'tool:web-fetch' || key === 'tool:image-generation') && record &&
    (record.modelName === 'unconfigured' || !record.baseUrl || !record.apiKeyCiphertext)) {
    throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE')
  }
  const metadata = record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {}
  if (key === 'tool:image-generation' && record) {
    const pool = readWeightedRoutes(metadata)
    const available = [{ baseUrl: record.baseUrl, key: record.apiKeyCiphertext, weight: pool?.primaryWeight ?? 100 },
      ...(pool?.candidates ?? []).filter(route => route.enabled !== false && route.weight > 0).map(route => ({ baseUrl: route.baseUrl, key: route.apiKeyCiphertext, weight: route.weight }))]
    for (const route of available.filter(route => route.weight > 0)) {
      let url: URL
      try { url = new URL(route.baseUrl ?? '') } catch { throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE') }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !route.key) throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE')
    }
    if (metadata.imageQuality && !imageQualityConfigSchema.safeParse(metadata.imageQuality).success) throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE')
  }
  const value = record && record.modelName !== 'unconfigured' && record.baseUrl && record.apiKeyCiphertext
    ? { ...(key === 'tool:image-generation' ? { weightedRoutes: readWeightedRoutes(metadata), ...(readModelActivities(record.metadata) ? { imagePrice: admitImagePrice(record) } : {}) } : {}), ...(record.id ? { modelConfigId: record.id, modelConfigRevision: record.revision } : {}), provider: record.provider, modelName: record.modelName, baseUrl: record.baseUrl, apiKey: decryptSecret(record.apiKeyCiphertext),
        ...((key === 'tool:web-search' || key === 'tool:web-fetch') && metadata.webToolProtocol !== undefined ? { webToolProtocol: metadata.webToolProtocol as WebToolProtocol } : {}),
        ...(key === 'tool:image-generation' && metadata.imageQuality ? { imageQuality: metadata.imageQuality as ImageQualityConfig } : {}),
        ...(key === 'tool:image-generation' ? { routes: readModelRoutes(metadata).filter(route => route.enabled).map(route => ({
          id: route.id, provider: route.provider, modelName: route.modelName, baseUrl: route.baseUrl, apiKey: decryptSecret(route.apiKeyCiphertext), ...(route.imageQuality ? { imageQuality: route.imageQuality } : {}),
        })) } : {}) }
    : null
  cache.set(key, { expiresAt: Date.now() + 30_000, value })
  return value
}
