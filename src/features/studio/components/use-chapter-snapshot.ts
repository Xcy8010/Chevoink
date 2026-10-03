import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Chapter } from '../../../../shared/contracts/index.js'
import { buildChapterDraft } from '../lib/form-state'
import { formatDateTime } from '../lib/agent-session'
import type { ChapterDraftState, SaveState } from '../types'
import { canApplyChapterSnapshot } from './chapter-stream-handoff'

/** Adopt only the selected task's saved snapshot; outgoing chapter dirtiness cannot block incoming hydration. */
export function useChapterSnapshot({ data, selectedChapterId, novelId, scope, hydratedScope, draftRef, dirtyRef,
  setDraft, setDirty, setSaveState, setLastSavedAt, setSaveMessage }: {
  data: Chapter | undefined; selectedChapterId: string | null; novelId: string; scope?: string; hydratedScope?: string
  draftRef: MutableRefObject<ChapterDraftState | null>; dirtyRef: MutableRefObject<boolean>
  setDraft: Dispatch<SetStateAction<ChapterDraftState | null>>; setDirty: Dispatch<SetStateAction<boolean>>
  setSaveState: Dispatch<SetStateAction<SaveState>>; setLastSavedAt: Dispatch<SetStateAction<string | null>>
  setSaveMessage: Dispatch<SetStateAction<string>>
}) {
  useEffect(() => {
    if (!data || data.id !== selectedChapterId || !scope || scope !== hydratedScope || data.novelId !== novelId) return
    const incoming = buildChapterDraft(data)
    if (!canApplyChapterSnapshot(draftRef.current, incoming, dirtyRef.current)) return
    draftRef.current = incoming
    dirtyRef.current = false
    setDraft(incoming)
    setDirty(false)
    setSaveState('saved')
    setLastSavedAt(data.updatedAt)
    setSaveMessage(`已同步到 ${formatDateTime(data.updatedAt)}`)
  }, [data, selectedChapterId, novelId, scope, hydratedScope, draftRef, dirtyRef, setDraft, setDirty, setSaveState, setLastSavedAt, setSaveMessage])
}
