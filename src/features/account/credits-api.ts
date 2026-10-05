import { requestJson } from '@/app/api-client'
import type {
  CreditAccountSummary,
  CreditActivityPayload,
  CreditUsagePayload,
  TaskCreditUsagePayload,
  CustomModelsPayload,
  ReferralPayload,
  SaveCustomModelRequest,
} from '../../../shared/contracts'

export function fetchCreditSummary(): Promise<CreditAccountSummary> {
  return requestJson<CreditAccountSummary>('/api/credits/summary')
}

export function fetchCreditUsage(): Promise<CreditUsagePayload> {
  return requestJson<CreditUsagePayload>('/api/credits/usage?take=150')
}

export function fetchCreditActivity(): Promise<CreditActivityPayload> {
  return requestJson<CreditActivityPayload>('/api/credits/activity')
}

export function fetchTaskCreditUsage(runId: string, cursor?: string): Promise<TaskCreditUsagePayload> {
  const query = new URLSearchParams({ take: '30' })
  if (cursor) query.set('cursor', cursor)
  return requestJson<TaskCreditUsagePayload>(`/api/credits/tasks/${encodeURIComponent(runId)}?${query}`)
}

export function fetchReferral(): Promise<ReferralPayload> {
  return requestJson<ReferralPayload>('/api/credits/referral')
}

export function fetchCustomModels(): Promise<CustomModelsPayload> {
  return requestJson<CustomModelsPayload>('/api/credits/models')
}

export function createCustomModel(input: SaveCustomModelRequest): Promise<{ id: string }> {
  return requestJson('/api/credits/models', { method: 'POST', body: JSON.stringify(input) })
}

export function updateCustomModel(modelId: string, input: Partial<SaveCustomModelRequest>): Promise<{ ok: true }> {
  return requestJson(`/api/credits/models/${modelId}`, { method: 'PATCH', body: JSON.stringify(input) })
}

export function deleteCustomModel(modelId: string): Promise<{ ok: true }> {
  return requestJson(`/api/credits/models/${modelId}`, { method: 'DELETE' })
}

export function fetchPublicCreditPolicy(): Promise<import('../../../shared/contracts').PublicCreditPolicy> {
  return requestJson('/api/credits/public-policy')
}
