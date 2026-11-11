import type { ApiFailure, ApiResponse } from '../../shared/contracts'
import { buildAuthHeader } from '@/lib/auth-token'
import { buildApiUrl } from './api-base'

export const ACCOUNT_REQUIREMENT_EVENT = 'chevoink:account-requirement'

export function notifyAccountRequirement(status: number, code?: string) {
  const required = status === 403 && (code === 'AUTH_EMAIL_BIND_REQUIRED' || code === 'AUTH_PHONE_VERIFICATION_REQUIRED')
  if (required && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ACCOUNT_REQUIREMENT_EVENT))
  }
  return required
}

export class ApiClientError extends Error {
  status: number
  code?: string
  fieldErrors?: Record<string, string>

  constructor(message: string, status: number, fieldErrors?: Record<string, string>, code?: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.fieldErrors = fieldErrors
    this.code = code
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeader(),
      ...(init?.headers ?? {}),
    },
  })

  const payload = (await response.json()) as ApiResponse<T>

  if (!response.ok || !payload.success) {
    const errorPayload = payload as ApiFailure
    if (!payload.success) notifyAccountRequirement(response.status, errorPayload.error.code)

    throw new ApiClientError(
      payload.success ? '请求失败' : errorPayload.error.message,
      response.status,
      payload.success ? undefined : errorPayload.error.fieldErrors,
      payload.success ? undefined : errorPayload.error.code,
    )
  }

  return payload.data
}
