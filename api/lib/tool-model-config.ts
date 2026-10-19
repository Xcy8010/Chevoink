import { prisma } from './prisma.js'
import { decryptSecret } from './secret-box.js'

export type ToolModelKey = 'tool:image-generation' | 'tool:image-vision' | 'tool:web-search' | 'tool:web-fetch'
export type ToolModelRuntime = { provider: string; modelName: string; baseUrl: string; apiKey: string }

const cache = new Map<ToolModelKey, { expiresAt: number; value: ToolModelRuntime | null }>()

export class ToolModelConfigurationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ToolModelConfigurationError' }
}

export function clearToolModelRuntimeCache(): void { cache.clear() }

/** Web tools fail explicitly on unavailable/incomplete enabled config; absent config preserves legacy fallback. */
export async function getToolModelRuntime(key: ToolModelKey): Promise<ToolModelRuntime | null> {
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const record = await prisma.aiModelConfig.findFirst({ where: { key, ownerUserId: null, enabled: true } }).catch(() => {
    if (key === 'tool:web-search' || key === 'tool:web-fetch') throw new ToolModelConfigurationError('TOOL_CONFIG_UNAVAILABLE')
    return null
  })
  if ((key === 'tool:web-search' || key === 'tool:web-fetch') && record &&
    (record.modelName === 'unconfigured' || !record.baseUrl || !record.apiKeyCiphertext)) {
    throw new ToolModelConfigurationError('TOOL_CONFIG_INCOMPLETE')
  }
  const value = record && record.modelName !== 'unconfigured' && record.baseUrl && record.apiKeyCiphertext
    ? { provider: record.provider, modelName: record.modelName, baseUrl: record.baseUrl, apiKey: decryptSecret(record.apiKeyCiphertext) }
    : null
  cache.set(key, { expiresAt: Date.now() + 30_000, value })
  return value
}
