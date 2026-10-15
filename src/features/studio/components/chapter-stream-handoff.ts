import type { AgentStreamEvent } from '../../../../shared/contracts/index.js'
import type { ChapterDraftState } from '../types'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { SaveState } from '../types'

export type ChapterStreamOwner = { novelId: string; scope?: string; sessionId: string | null; epoch?: number }
export type ReviewStreamCursor = { runId: string; seq: number }

/** Host effects survive an A -> B -> A stream replay, independently of message hydration. */
export function claimWorkspaceStreamEvent(cursors: Map<string, ReviewStreamCursor>, owner: ChapterStreamOwner, event: AgentStreamEvent) {
  const key = JSON.stringify([owner.novelId, owner.scope, owner.sessionId])
  const previous = cursors.get(key)
  if (previous?.runId === event.runId && previous.seq >= event.seq) return false
  cursors.set(key, { runId: event.runId, seq: event.seq })
  return true
}

/** Pending reviews also retain their entity cursor when restored from local storage. */
export function isReviewStreamReplay(cursor: ReviewStreamCursor | undefined, event: AgentStreamEvent) {
  return cursor?.runId === event.runId && cursor.seq >= event.seq
}

export function isStaleChapterReview(revision: number | undefined, currentReviewRevision?: number, draftRevision?: number, listRevision?: number) {
  if (revision === undefined) return currentReviewRevision !== undefined
  const latest = Math.max(currentReviewRevision ?? 0, draftRevision ?? 0, listRevision ?? 0)
  return revision < latest || (currentReviewRevision !== undefined && revision === currentReviewRevision)
}

/** The store can reject an old run while its host callback still receives the event. */
export function isWorkspaceStreamOwnerCurrent({ origin, current, activeSessionId, activeRunId, eventRunId }: {
  origin: ChapterStreamOwner; current: ChapterStreamOwner
  activeSessionId: string | null; activeRunId: string | null; eventRunId: string
}) {
  return Boolean(origin.scope && origin.scope === current.scope && origin.novelId === current.novelId
    && origin.epoch === current.epoch && origin.sessionId && origin.sessionId === current.sessionId
    && origin.sessionId === activeSessionId && eventRunId === activeRunId)
}

export function canAdoptChapterResult({ event, origin, current, activeSessionId, activeRunId, selectedChapterId, dirty, draft }: {
  event: Extract<AgentStreamEvent, { type: 'tool.result' }>
  origin: ChapterStreamOwner; current: ChapterStreamOwner
  activeSessionId: string | null; activeRunId: string | null
  selectedChapterId: string | null; dirty: boolean; draft: ChapterDraftState | null
}) {
  const display = event.display
  return Boolean(isWorkspaceStreamOwnerCurrent({ origin, current, activeSessionId, activeRunId, eventRunId: event.runId })
    && event.ok && display?.kind === 'chapterDiff' && display.appliedDirectly
    && display.chapterId === selectedChapterId && (!dirty || draft?.id !== display.chapterId) && typeof display.revision === 'number'
    && Number.isInteger(display.revision) && display.revision > 0
    && (!draft || draft.id !== display.chapterId || display.revision >= draft.revision))
}

export function canApplyChapterSnapshot(current: ChapterDraftState | null, incoming: ChapterDraftState, dirty: boolean) {
  if (!current || current.id !== incoming.id) return true
  return !dirty && incoming.revision >= current.revision
}

export function adoptChapterResult(options: Parameters<typeof canAdoptChapterResult>[0], after: ChapterDraftState, state: {
  draftRef: MutableRefObject<ChapterDraftState | null>; dirtyRef: MutableRefObject<boolean>
  setDraft: Dispatch<SetStateAction<ChapterDraftState | null>>; setDirty: Dispatch<SetStateAction<boolean>>
  setSaveState: Dispatch<SetStateAction<SaveState>>
}) {
  if (!canAdoptChapterResult(options)) return false
  state.draftRef.current = after
  state.dirtyRef.current = false
  state.setDraft(after)
  state.setDirty(false)
  state.setSaveState('saved')
  return true
}
