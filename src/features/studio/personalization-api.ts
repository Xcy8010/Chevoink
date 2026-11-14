import { requestJson } from '@/app/api-client'
import { useShellStore } from '@/store/useShellStore'
import type {
  AgentPersonalizationMemoriesPayload,
  AgentPersonalizationMemory,
  AgentPersonalizationPayload,
  AgentPersonalizationSettings,
} from '../../../shared/contracts/agent-personalization.js'

const settingsEndpoint = '/api/agent/personalization'
const memoriesEndpoint = settingsEndpoint + '/memories'

export const agentPersonalizationQueryKey = ['agent-personalization'] as const
export const personalizationSettingsQueryKey = (owner: string) => [...agentPersonalizationQueryKey, 'settings', owner] as const
export const personalizationMemoriesQueryKey = (owner: string) => [...agentPersonalizationQueryKey, 'memories', owner] as const

function assertAccount(owner: string) {
  const { authStatus, sessionUser } = useShellStore.getState()
  if (authStatus !== 'authenticated' || sessionUser?.id !== owner) {
    throw new Error('登录状态已变更，请重新打开个性化设置。')
  }
}

export async function fetchPersonalizationSettings(owner: string, signal: AbortSignal) {
  assertAccount(owner)
  const payload = await requestJson<AgentPersonalizationPayload>(settingsEndpoint, { signal, cache: 'no-store' })
  assertAccount(owner)
  return payload
}

export function patchPersonalizationSettings(owner: string, expectedRevision: number, changes: Partial<AgentPersonalizationSettings>) {
  assertAccount(owner)
  return requestJson<AgentPersonalizationPayload>(settingsEndpoint, {
    method: 'PATCH',
    body: JSON.stringify({ expectedRevision, ...changes }),
  })
}

export async function fetchPersonalizationMemories(owner: string, signal: AbortSignal) {
  assertAccount(owner)
  const payload = await requestJson<AgentPersonalizationMemoriesPayload>(memoriesEndpoint, { signal, cache: 'no-store' })
  assertAccount(owner)
  return payload
}

export function savePersonalizationMemory(owner: string, text: string, memory?: AgentPersonalizationMemory) {
  assertAccount(owner)
  const endpoint = memory ? `${memoriesEndpoint}/${encodeURIComponent(memory.id)}` : memoriesEndpoint
  return requestJson<AgentPersonalizationMemory>(endpoint, {
    method: memory ? 'PATCH' : 'POST',
    body: JSON.stringify(memory ? { text, expectedRevision: memory.revision } : { text }),
  })
}

export function deletePersonalizationMemory(owner: string, revision: number, id?: string) {
  assertAccount(owner)
  const endpoint = id ? `${memoriesEndpoint}/${encodeURIComponent(id)}` : memoriesEndpoint
  return requestJson<{ revision: number }>(`${endpoint}?expectedRevision=${revision}`, { method: 'DELETE' })
}
