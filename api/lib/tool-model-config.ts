import { prisma } from './prisma.js'
import { resolveSystemModelConfig } from './model-lifecycle.js'
import { decryptSecret } from './secret-box.js'
import type { WebToolProtocol } from '../../shared/contracts/web-tool.js'
import type { ImageQualityConfig } from '../../shared/contracts/image-model.js'

export type ToolModelKey = 'tool:image-generation' | 'tool:image-vision' | 'tool:web-search' | 'tool:web-fetch'
export type ToolModelRuntime = { provider: string; modelName: string; baseUrl: string; apiKey: string; imageQuality?: ImageQualityConfig; webToolProtocol?: WebToolProtocol; modelConfigId?: string; modelConfigRevision?: number }

const cache = new Map<ToolModelKey, { expiresAt: number; value: ToolModelRuntime | null }>()

export class ToolModelConfigurationError extends Error {
  constructor(readonly code: string, readonly configurationMessage?: string) { super(code); this.name = 'ToolModelConfigurationError' }
}

export function clearToolModelRuntimeCache(): void { cache.clear() }

/** Web tools fail explicitly on unavailable/incomplete enabled config; absent config preserves legacy fallback. */
export async function getToolModelRuntime(key: ToolModelKey): Promise<ToolModelRuntime | null> {
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.value?.modelConfigId) return cached.value
    const current = await prisma.aiModelConfig.findUnique({ where: { id: cached.value.modelConfigId }, select: { archivedAt: true, revision: true } })
    if (current && !current.archivedAt && current.revision === cached.value.modelConfigRevision) return cached.value
    cache.delete(key)
  }
  let record = await prisma.aiModelConfig.findFirst({ where: { key, ownerUserId: null, archivedAt: null, enabled: true } }).catch(() => {
    if (key === 'tool:web-search' || key === 'tool:web-fetch') throw new ToolModelConfigurationError('TOOL_CONFIG_UNAVAILABLE')
    return null
  })
  if (record?.archivedById) record = await resolveSystemModelConfig(key)
  if (!record) {
    const original = await prisma.aiModelConfig.findFirst({ where: { key, ownerUserId: null } })
    if (original?.archivedAt || original?.archivedById) record = await resolveSystemModelConfig(key)
  }
  if ((key === 'tool:web-search' || key === 'tool:web-fetch') && record &&
    (record.modelName === 'unconfigured' || !record.baseUrl || !record.apiKeyCiphertext)) {
    throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE')
  }
  const metadata = record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {}
  const value = record && record.modelName !== 'unconfigured' && record.baseUrl && record.apiKeyCiphertext
    ? { ...(record.id ? { modelConfigId: record.id, modelConfigRevision: record.revision } : {}), provider: record.provider, modelName: record.modelName, baseUrl: record.baseUrl, apiKey: decryptSecret(record.apiKeyCiphertext),
        ...((key === 'tool:web-search' || key === 'tool:web-fetch') && metadata.webToolProtocol !== undefined ? { webToolProtocol: metadata.webToolProtocol as WebToolProtocol } : {}),
        ...(key === 'tool:image-generation' && metadata.imageQuality ? { imageQuality: metadata.imageQuality as ImageQualityConfig } : {}) }
    : null
  cache.set(key, { expiresAt: Date.now() + 30_000, value })
  return value
}
