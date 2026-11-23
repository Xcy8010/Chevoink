import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { AgentApiError } from '../agentApi'

export function refreshMemoryAfterWrite(client: QueryClient, queryKey: QueryKey) {
  const filter = { queryKey, exact: true }
  // Also supersede a cold read, which normal invalidation would otherwise reuse.
  void client.cancelQueries(filter)
  return client.invalidateQueries(filter)
}

// A definitive loss of access replaces the snapshot. Later network failures
// must not make previously visible private data reappear.
export async function readMemorySnapshot<T>(request: Promise<T>): Promise<{ value: T; denied?: never } | { value?: never; denied: string }> {
  try {
    return { value: await request }
  } catch (error) {
    if (isMemoryAccessError(error)) return { denied: error.message || '当前内容已不可访问。' }
    throw error
  }
}

export function isMemoryAccessError(error: unknown): error is AgentApiError {
  return error instanceof AgentApiError && [401, 403, 404].includes(error.status)
}
