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
  if (document) return activity.status === 'done' ? bodyDelta(document.before, document.after) : { added: 0, removed: 0 }
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

/** One entry per document, initial body -> latest successful body. Non-body tools never enter this view. */
export function workspaceBodyChanges(activities: WorkspaceActivity[]): BodyChange[] {
  const documents = new Map<string, { before: string; after: string; title: string; activity: WorkspaceActivity }>()
  for (const activity of activities) {
    if (activity.status !== 'done') continue
    const document = activityDocument(activity)
    if (!document) continue
    const { key, title, before, after } = document
    if (before === after) continue
    const existing = documents.get(key)
    documents.delete(key) // insertion order is last changed order, including re-edits
    documents.set(key, { before: existing?.before ?? before, after, title, activity })
  }
  return [...documents.entries()].flatMap(([key, item]) => {
    if (item.before === item.after) return []
    return [{ key, title: item.title, ...bodyDelta(item.before, item.after), activity: item.activity }]
  })
}
