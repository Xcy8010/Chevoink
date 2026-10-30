import { useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import { agentWindowConfigurationSchema, type AgentWindowConfigurationPayload, type AgentWindowConfiguration } from '../../../../shared/contracts/agent-window-configuration.js'

type Changes = Partial<AgentWindowConfiguration>
type Pending = { tail: Promise<unknown>; changes: Map<symbol, Changes>; confirmed?: AgentWindowConfigurationPayload }
const pending = new Map<string, Pending>()
export const windowConfigurationQueryKey = (sessionId: string) => ['agent', 'window-configuration', sessionId] as const

function publish(client: QueryClient, sessionId: string, value: AgentWindowConfigurationPayload, queue: Pending) {
  const configuration = [...queue.changes.values()].reduce((current, patch) => ({ ...current, ...patch }), value.configuration)
  client.setQueryData(windowConfigurationQueryKey(sessionId), { ...value, configuration })
}

/** Serialize writes from the composer and settings against the same server revision. */
export function saveWindowConfiguration(client: QueryClient, sessionId: string, patch: Changes) {
  const key = windowConfigurationQueryKey(sessionId)
  const queue: Pending = pending.get(sessionId) ?? { tail: Promise.resolve(), changes: new Map(), confirmed: client.getQueryData<AgentWindowConfigurationPayload>(key) }
  pending.set(sessionId, queue)
  const id = Symbol()
  queue.changes.set(id, patch)
  const cached = client.getQueryData<AgentWindowConfigurationPayload>(key)
  if (cached) publish(client, sessionId, cached, queue)
  const work = queue.tail.catch(() => {}).then(async () => {
    await client.cancelQueries({ queryKey: key })
    try {
      const before = await requestJson<AgentWindowConfigurationPayload>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/configuration`)
      queue.confirmed = before
      const value = await requestJson<AgentWindowConfigurationPayload>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/configuration`, {
        method: 'PATCH', body: JSON.stringify({ expectedRevision: before.revision, ...patch }),
      })
      queue.changes.delete(id)
      queue.confirmed = value
      publish(client, sessionId, value, queue)
      return value
    } catch (error) {
      queue.changes.delete(id)
      if (queue.confirmed) publish(client, sessionId, queue.confirmed, queue)
      void client.invalidateQueries({ queryKey: key })
      throw error
    }
  }).finally(() => {
    queue.changes.delete(id)
    if (!queue.changes.size) pending.delete(sessionId)
  })
  queue.tail = work
  return work
}

export function useAgentWindowConfiguration(novelId: string, sessionId: string | null, draftScope = '') {
  const client = useQueryClient()
  const [saveError, setSaveError] = useState<{ scope: string; message: string } | null>(null)
  const scope = sessionId ?? `draft:${novelId}:${draftScope}`
  const key = windowConfigurationQueryKey(scope)
  const query = useQuery({ queryKey: key,
    queryFn: async ({ signal }) => {
      const value = await requestJson<AgentWindowConfigurationPayload>(`/api/agent/sessions/${encodeURIComponent(sessionId!)}/configuration`, { signal })
      const queue = pending.get(sessionId!)
      if (queue) {
        queue.confirmed = value
        return { ...value, configuration: [...queue.changes.values()].reduce((current, patch) => ({ ...current, ...patch }), value.configuration) }
      }
      return value
    },
    enabled: Boolean(sessionId), retry: false, staleTime: 0,
    refetchInterval: () => sessionId && !pending.has(sessionId) ? 5000 : false,
    initialData: !sessionId ? () => {
      let configuration: AgentWindowConfiguration = { model: null, creativeFreedom: 'balanced' }
      if (typeof window !== 'undefined') {
        try { configuration = agentWindowConfigurationSchema.parse(JSON.parse(window.localStorage.getItem(`chevoink:window-configuration:${scope}`) ?? '{}')) } catch { /* An invalid old draft has no saved preference. */ }
      }
      return { sessionId: scope, novelId, title: '', revision: 0, configuration }
    } : undefined,
  })
  const configuration = query.data?.configuration ?? { model: null, creativeFreedom: 'balanced' as const }
  const update = (patch: Changes) => {
    setSaveError(null)
    if (!sessionId) {
      const current = client.getQueryData<AgentWindowConfigurationPayload>(key) ?? { sessionId: scope, novelId, title: '', revision: 0, configuration }
      const next = { ...current, configuration: { ...current.configuration, ...patch } }
      client.setQueryData(key, next)
      try { window.localStorage.setItem(`chevoink:window-configuration:${scope}`, JSON.stringify(next.configuration)) }
      catch { setSaveError({ scope, message: '窗口配置无法保存到本机，请检查浏览器存储权限。' }) }
      return Promise.resolve(next)
    }
    const work = saveWindowConfiguration(client, sessionId, patch)
    void work.catch(error => setSaveError({ scope, message: error instanceof Error ? error.message : '窗口配置保存失败。' }))
    return work
  }
  return { configuration, title: query.data?.title, revision: query.data?.revision ?? 0,
    loading: Boolean(sessionId) && query.isPending,
    error: (saveError?.scope === scope ? saveError.message : null) ?? (query.error instanceof Error ? query.error.message : null), update,
    ready: async () => { await pending.get(sessionId ?? '')?.tail; if (query.error) throw query.error; if (sessionId && query.isPending) throw new Error('窗口配置尚未载入，请稍后重试。') },
    promote: (targetSessionId: string) => saveWindowConfiguration(client, targetSessionId, configuration),
    refresh: () => client.invalidateQueries({ queryKey: key }),
  }
}
