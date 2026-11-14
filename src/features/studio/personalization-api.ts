import { requestJson } from '@/app/api-client'
import { useShellStore } from '@/store/useShellStore'
import type {
  AgentPersonalizationMemoriesPayload,
  AgentPersonalizationMemory,
  AgentPersonalizationPayload,
  AgentPersonalizationRule,
  AgentPersonalizationRuleOperation,
  AgentPersonalizationSettings,
} from '../../../shared/contracts/agent-personalization.js'

const settingsEndpoint = '/api/agent/personalization'
const memoriesEndpoint = settingsEndpoint + '/memories'
const rulesEndpoint = settingsEndpoint + '/rules'

export const agentPersonalizationQueryKey = ['agent-personalization'] as const
export const personalizationSettingsQueryKey = (owner: string) => [...agentPersonalizationQueryKey, 'settings', owner] as const
export const personalizationMemoriesQueryKey = (owner: string) => [...agentPersonalizationQueryKey, 'memories', owner] as const
export const personalizationRuleOperationsQueryKey = (owner: string) => [...agentPersonalizationQueryKey, 'rule-operations', owner] as const

export function isPersonalizationAccount(owner: string) {
  const { authStatus, sessionUser } = useShellStore.getState()
  return authStatus === 'authenticated' && sessionUser?.id === owner
}

function assertAccount(owner: string) {
  if (!isPersonalizationAccount(owner)) {
    throw new Error('登录状态已变更，请重新打开个性化设置。')
  }
}

async function requestForAccount<T>(owner: string, endpoint: string, init: RequestInit) {
  assertAccount(owner)
  const payload = await requestJson<T>(endpoint, init)
  assertAccount(owner)
  return payload
}

export function fetchPersonalizationSettings(owner: string, signal: AbortSignal) {
  return requestForAccount<AgentPersonalizationPayload>(owner, settingsEndpoint, { signal, cache: 'no-store' })
}

export function patchPersonalizationSettings(owner: string, expectedRevision: number, changes: Partial<AgentPersonalizationSettings>) {
  return requestForAccount<AgentPersonalizationPayload>(owner, settingsEndpoint, {
    method: 'PATCH',
    body: JSON.stringify({ expectedRevision, ...changes }),
  })
}

export function fetchPersonalizationRuleOperations(owner: string, signal: AbortSignal) {
  return requestForAccount<AgentPersonalizationRuleOperation[]>(owner, settingsEndpoint + '/rule-operations', { signal, cache: 'no-store' })
}

export function putPersonalizationRule(owner: string, expectedRevision: number, rule: AgentPersonalizationRule) {
  return requestForAccount<AgentPersonalizationPayload>(owner, rulesEndpoint, {
    method: 'PUT',
    body: JSON.stringify({ ...rule, expectedRevision }),
  })
}

export function deletePersonalizationRule(owner: string, expectedRevision: number, toolName: string) {
  const endpoint = `${rulesEndpoint}/${encodeURIComponent(toolName)}?expectedRevision=${expectedRevision}`
  return requestForAccount<AgentPersonalizationPayload>(owner, endpoint, { method: 'DELETE' })
}

export function fetchPersonalizationMemories(owner: string, signal: AbortSignal) {
  return requestForAccount<AgentPersonalizationMemoriesPayload>(owner, memoriesEndpoint, { signal, cache: 'no-store' })
}

export function createPersonalizationMemory(owner: string, text: string, pinned: boolean) {
  return requestForAccount<AgentPersonalizationMemory>(owner, memoriesEndpoint, {
    method: 'POST',
    body: JSON.stringify({ text, pinned }),
  })
}

export function patchPersonalizationMemory(
  owner: string,
  memory: Pick<AgentPersonalizationMemory, 'id' | 'revision'>,
  changes: Partial<Pick<AgentPersonalizationMemory, 'text' | 'pinned'>>,
) {
  const endpoint = `${memoriesEndpoint}/${encodeURIComponent(memory.id)}`
  return requestForAccount<AgentPersonalizationMemory>(owner, endpoint, {
    method: 'PATCH',
    body: JSON.stringify({ ...changes, expectedRevision: memory.revision }),
  })
}

export function restorePersonalizationMemory(owner: string, memory: Pick<AgentPersonalizationMemory, 'id' | 'revision'>) {
  const endpoint = `${memoriesEndpoint}/${encodeURIComponent(memory.id)}/restore`
  return requestForAccount<AgentPersonalizationMemory>(owner, endpoint, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: memory.revision }),
  })
}

export function deletePersonalizationMemory(owner: string, revision: number, id?: string) {
  const endpoint = id ? `${memoriesEndpoint}/${encodeURIComponent(id)}` : memoriesEndpoint
  return requestForAccount<{ revision: number }>(owner, `${endpoint}?expectedRevision=${revision}`, { method: 'DELETE' })
}
