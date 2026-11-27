import { useAgentStore } from '../agent/agentStore'

/** Both live SSE and restored history publish accepted tool receipts to the
 * store. The folder needs its own read; studio/payload only refreshes chapters. */
export function observePlanFolderWrites(sessionId: string, refresh: () => void): () => void {
  const seen = new Set<string>()
  const observe = (state: ReturnType<typeof useAgentStore.getState>) => {
    if ((state.activeSessionId ?? state.loadedSessionId) !== sessionId) return
    let changed = false
    for (const receipt of state.planFolderWriteReceipts) {
      if (seen.has(receipt)) continue
      seen.add(receipt)
      changed = true
    }
    if (changed) refresh()
  }
  const unsubscribe = useAgentStore.subscribe((state, previous) => {
    if (state.planFolderWriteReceipts !== previous.planFolderWriteReceipts
      || (state.activeSessionId ?? state.loadedSessionId) !== (previous.activeSessionId ?? previous.loadedSessionId)) observe(state)
  })
  observe(useAgentStore.getState())
  return unsubscribe
}
