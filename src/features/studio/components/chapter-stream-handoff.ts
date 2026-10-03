import type { AgentStreamEvent } from '../../../../shared/contracts/index.js'
import type { ChapterDraftState } from '../types'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { SaveState } from '../types'

export type ChapterStreamOwner = { novelId: string; scope?: string; sessionId: string | null }

export function canAdoptChapterResult({ event, origin, current, activeSessionId, activeRunId, selectedChapterId, dirty, draft }: {
  event: Extract<AgentStreamEvent, { type: 'tool.result' }>
  origin: ChapterStreamOwner; current: ChapterStreamOwner
  activeSessionId: string | null; activeRunId: string | null
  selectedChapterId: string | null; dirty: boolean; draft: ChapterDraftState | null
}) {
  const display = event.display
  return Boolean(origin.scope && origin.scope === current.scope && origin.novelId === current.novelId
    && origin.sessionId && origin.sessionId === current.sessionId && origin.sessionId === activeSessionId
    && event.runId === activeRunId && event.ok && display?.kind === 'chapterDiff' && display.appliedDirectly
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
