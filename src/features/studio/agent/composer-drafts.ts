import { useAgentStore } from './agentStore'
import { registerDesktopSave } from '@/lib/desktop-lifecycle'

type State = ReturnType<typeof useAgentStore.getState>
type Draft = Pick<State, 'composerDraft' | 'composerAttachments' | 'composerReferences' | 'composerSkillIds' | 'composerSubagent' | 'composerUploading' | 'goalMode'>
const prefix = 'chevoink:task-draft:v1:'
const cache = new Map<string, Draft>()
const aliases = new Map<string, string>()
let active: string | undefined
const empty = (): Draft => ({ composerDraft: '', composerAttachments: [], composerReferences: [], composerSkillIds: [], composerSubagent: null, composerUploading: 0, goalMode: false })
const pick = (state: State): Draft => ({ composerDraft: state.composerDraft, composerAttachments: state.composerAttachments, composerReferences: state.composerReferences, composerSkillIds: state.composerSkillIds, composerSubagent: state.composerSubagent, composerUploading: state.composerUploading, goalMode: state.goalMode })
const resolve = (scope: string): string => aliases.get(scope) ?? scope

registerDesktopSave(() => {
  if (!active) return true
  const draft = pick(useAgentStore.getState())
  if (draft.composerUploading > 0) return false
  try {
    localStorage.setItem(prefix + active, JSON.stringify({ ...draft, composerUploading: 0 }))
    return true
  } catch { return false }
})

/** Read the owning window, never the visible window's draft when scopes differ. */
export function hasComposerDraft(scope: string): boolean {
  const key = resolve(scope)
  const draft = active === key ? pick(useAgentStore.getState()) : read(key)
  return Boolean(draft.composerDraft.trim()) || draft.goalMode || draft.composerAttachments.length > 0
    || draft.composerReferences.length > 0 || draft.composerSkillIds.length > 0 || Boolean(draft.composerSubagent) || draft.composerUploading > 0
}

function read(scope: string): Draft {
  if (cache.has(scope)) return cache.get(scope)!
  try {
    const value = JSON.parse(localStorage.getItem(prefix + scope) || 'null')
    if (value && typeof value.composerDraft === 'string' && Array.isArray(value.composerReferences) && Array.isArray(value.composerAttachments) && Array.isArray(value.composerSkillIds)) {
      const pin = value.composerSubagent
      const composerSubagent = pin && typeof pin.id === 'string' && typeof pin.name === 'string' && typeof pin.novelId === 'string'
        ? { id: pin.id, name: pin.name, novelId: pin.novelId } : null
      return { ...empty(), ...value, composerSubagent, composerUploading: 0 }
    }
  } catch { /* Unavailable/corrupt storage must not prevent typing. */ }
  return empty()
}
function save(scope: string, draft: Draft) {
  cache.set(scope, draft)
  try { localStorage.setItem(prefix + scope, JSON.stringify({ ...draft, composerUploading: 0 })) }
  catch { /* Keep the in-memory draft even when storage is full. */ }
}
// Synchronous, small snapshots also cover refresh/closing immediately after typing.
useAgentStore.subscribe((state, previous) => {
  if (!active) return
  const draft = pick(state)
  if ((Object.keys(draft) as Array<keyof Draft>).some(key => state[key] !== previous[key])) save(active, draft)
})
export function activateComposerDraft(scope?: string) {
  if (!scope || active === resolve(scope)) return
  if (active) save(active, pick(useAgentStore.getState()))
  active = resolve(scope)
  useAgentStore.setState(read(active))
}
/** Async uploads/sends must update their originating window, never the currently visible one. */
export function updateComposerDraft(scope: string, update: (draft: Draft) => Draft) {
  const key = resolve(scope)
  const draft = update(active === key ? pick(useAgentStore.getState()) : read(key))
  save(key, draft)
  if (active === key) useAgentStore.setState(draft)
}
/** Lazy local window -> persisted session is an identity promotion, not a task switch. */
export function promoteComposerDraft(from: string, to: string) {
  const draft = active === from ? pick(useAgentStore.getState()) : read(from)
  aliases.set(from, to)
  save(to, draft)
  if (active === from) active = to
  cache.delete(from)
  try { localStorage.removeItem(prefix + from) } catch { /* Optional cleanup. */ }
}
