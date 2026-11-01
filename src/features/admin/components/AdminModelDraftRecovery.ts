import type { QueryClient } from '@tanstack/react-query'
import type { AdminModelForm } from '../pages/AdminModelsPage'

type HistoryDraft = { actorId: string | null; modelId: string; sourceVersion: string; baseline: string; form: AdminModelForm }

// A rejected native history transition can still remount BrowserRouter's route.
// Keep only its one pending recovery in memory; never persist credential drafts.
let rejectedHistoryDrafts = new WeakMap<QueryClient, HistoryDraft>()
export function rememberAdminModelHistoryDraft(client: QueryClient, draft: HistoryDraft): void {
  rejectedHistoryDrafts.set(client, draft)
}
export function takeAdminModelHistoryDraft(client: QueryClient, actorId: string | null, modelId: string): HistoryDraft | undefined {
  const draft = rejectedHistoryDrafts.get(client)
  rejectedHistoryDrafts.delete(client)
  return draft?.actorId === actorId && draft.modelId === modelId ? draft : undefined
}
export function dropAdminModelHistoryDraft(client: QueryClient): void { rejectedHistoryDrafts.delete(client) }
/** Clear on logout or an authenticated administrator change, including while the model route is unmounted. */
export function clearAdminModelHistoryDrafts(): void { rejectedHistoryDrafts = new WeakMap() }
