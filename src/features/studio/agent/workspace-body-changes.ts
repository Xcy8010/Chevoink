import type { WorkspaceActivity } from './agentStore'
import { buildReviewDiff } from '../components/diff'

export type BodyChange = { key: string; title: string; added: number; removed: number; activity: WorkspaceActivity }
function activityDocument(activity: WorkspaceActivity) {
  const display = activity.display
  if (display?.kind === 'chapterDiff') return { key: `chapter:${display.chapterId}`, title: display.chapterTitle, before: display.before, after: display.after }
  if (display?.kind === 'planDiff') return { key: `plan:${display.artifactId}`, title: display.title, before: display.before, after: display.after }
  if (display?.kind === 'planFile' && activity.toolName === 'plan_save') return { key: `plan:${display.artifactId}`, title: display.title, before: '', after: display.content }
  if (activity.chapterId && typeof activity.before === 'string' && typeof activity.after === 'string') return {
    key: `chapter:${activity.chapterId}`, title: activity.label, before: activity.before, after: activity.after,
  }
  return null
}

const bodyDeltas = new WeakMap<WorkspaceActivity, { before: string; after: string; delta: { added: number; removed: number } }>()
function bodyDelta(before: string, after: string) {
  let added = 0, removed = 0
  for (const segment of buildReviewDiff(before, after).segments) {
    if (segment.kind === 'added') added += Array.from(segment.text).length
    if (segment.kind === 'removed') removed += Array.from(segment.text).length
  }
  return { added, removed }
}

/** The tree row and document summary share the same prose identification/counting. */
export function workspaceActivityDelta(activity: WorkspaceActivity) {
  const document = activityDocument(activity)
  if (document) {
    if (activity.status !== 'done') return { added: 0, removed: 0 }
    const saved = bodyDeltas.get(activity)
    if (saved?.before === document.before && saved.after === document.after) return saved.delta
    const delta = bodyDelta(document.before, document.after)
    bodyDeltas.set(activity, { before: document.before, after: document.after, delta })
    return delta
  }
  const delta = activity.deltaChars ?? 0
  return { added: Math.max(0, delta), removed: Math.max(0, -delta) }
}

export function workspaceGroupDelta(activities: WorkspaceActivity[]) {
  const body = workspaceBodyChanges(activities).reduce((sum, item) => ({ added: sum.added + item.added, removed: sum.removed + item.removed }), { added: 0, removed: 0 })
  return activities.filter(activity => !activityDocument(activity)).reduce((sum, activity) => {
    const delta = workspaceActivityDelta(activity)
    return { added: sum.added + delta.added, removed: sum.removed + delta.removed }
  }, body)
}

/** One row per document; successful edit additions and removals never cancel.
 * Replayed call snapshots contribute once, using their final successful body. */
export function workspaceBodyChanges(activities: WorkspaceActivity[]): BodyChange[] {
  const completed = new Map(activities.filter(activity => activity.status === 'done').map(activity => [activity.callId, activity]))
  const documents = new Map<string, BodyChange>()
  for (const activity of completed.values()) {
    const document = activityDocument(activity)
    if (!document || document.before === document.after) continue
    const { key, title } = document
    const delta = workspaceActivityDelta(activity), existing = documents.get(key)
    documents.delete(key)
    documents.set(key, { key, title, added: (existing?.added ?? 0) + delta.added,
      removed: (existing?.removed ?? 0) + delta.removed, activity })
  }
  return [...documents.values()]
}
