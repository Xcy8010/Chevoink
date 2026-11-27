import { requestJson } from '@/app/api-client'
export const control =
  'block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm'
export const action =
  'rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm font-medium disabled:opacity-50 hover:bg-[var(--surface-muted)]'
export const post = <T>(path: string, body: unknown, headers?: Record<string, string>) =>
  requestJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
    ...(path.startsWith('/api/governance/appeal/') || path === '/api/governance/appeal'
      ? { credentials: 'omit' as const }
      : {}),
  })
export const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作未完成，请稍后重试。')
