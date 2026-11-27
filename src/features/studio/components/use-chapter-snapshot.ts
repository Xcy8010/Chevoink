import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Chapter } from '../../../../shared/contracts/index.js'
import { buildChapterDraft } from '../lib/form-state'
import { formatDateTime } from '../lib/agent-session'
import type { ChapterDraftState, SaveState } from '../types'
import { canApplyChapterSnapshot } from './chapter-stream-handoff'
import { adoptChapterCopy, chapterRecoveryKey, currentChapterCopy, pendingChapterCopies, retireChapterCopy, sameChapterEdits, storeChapterEdits, viewSyncedChapter, type ChapterCopy } from '../lib/chapter-recovery'

/** Adopt only the selected task's saved snapshot; outgoing chapter dirtiness cannot block incoming hydration. */
export function useChapterSnapshot({ data, selectedChapterId, novelId, userId, scope, hydratedScope, draftRef, dirtyRef,
  setDraft, setDirty, setSaveState, setLastSavedAt, setSaveMessage }: {
  data: Chapter | undefined; selectedChapterId: string | null; novelId: string; userId?: string; scope?: string; hydratedScope?: string
  draftRef: MutableRefObject<ChapterDraftState | null>; dirtyRef: MutableRefObject<boolean>
  setDraft: Dispatch<SetStateAction<ChapterDraftState | null>>; setDirty: Dispatch<SetStateAction<boolean>>
  setSaveState: Dispatch<SetStateAction<SaveState>>; setLastSavedAt: Dispatch<SetStateAction<string | null>>
  setSaveMessage: Dispatch<SetStateAction<string>>
}) {
  const key = selectedChapterId ? chapterRecoveryKey(userId, novelId, selectedChapterId) : undefined
  const checked = useRef<{ key: string; choiceRevision?: number }>()
  const [choices, setChoices] = useState<{ key: string; copies: ChapterCopy[]; activeSlot?: string } | null>(null)
  const draftRevision = draftRef.current?.revision
  useLayoutEffect(() => {
    checked.current = undefined
    setChoices(null)
  }, [key])
  const restore = useCallback((key: string, incoming: ChapterDraftState, copy: ChapterCopy) => {
    const restored = { ...incoming, ...copy.edits, revision: incoming.revision,
      ...(copy.edits.revision !== incoming.revision ? { status: incoming.status, visibility: incoming.visibility } : {}) }
    // A newer revision reaches here only after the author selected this copy.
    adoptChapterCopy(key, { ...copy, edits: restored })
    draftRef.current = restored
    dirtyRef.current = true
    setDraft(restored)
    setDirty(true)
    setSaveState('pending')
    setSaveMessage('已恢复未同步的章节修改。')
  }, [draftRef, dirtyRef, setDraft, setDirty, setSaveState, setSaveMessage])
  const showSaved = useCallback((chapter: Chapter) => {
    const incoming = buildChapterDraft(chapter)
    draftRef.current = incoming
    dirtyRef.current = false
    setDraft(incoming)
    setDirty(false)
    setSaveState('saved')
    setLastSavedAt(chapter.updatedAt)
    setSaveMessage(`已同步到 ${formatDateTime(chapter.updatedAt)}`)
  }, [draftRef, dirtyRef, setDraft, setDirty, setSaveState, setLastSavedAt, setSaveMessage])
  // A cached or just-resolved chapter (including its recovery copy) belongs in the next paint.
  useLayoutEffect(() => {
    if (!data || data.id !== selectedChapterId || !scope || scope !== hydratedScope || data.novelId !== novelId) return
    const incoming = buildChapterDraft(data)
    const active = draftRef.current
    const diverged = !!key && dirtyRef.current && active?.id === incoming.id && incoming.revision > active.revision
    if (!diverged && !canApplyChapterSnapshot(active, incoming, dirtyRef.current)) return
    if (key && (checked.current?.key !== key || diverged
      || (checked.current.choiceRevision !== undefined && checked.current.choiceRevision !== incoming.revision))) {
      checked.current = { key }
      if (diverged && !sameChapterEdits(active, incoming)) {
        const local = currentChapterCopy(key)
        if (!local || !sameChapterEdits(local.edits, active)) storeChapterEdits(key, active)
      }
      const copies = pendingChapterCopies(key).filter(copy => {
        if (!sameChapterEdits(copy.edits, incoming)) return true
        retireChapterCopy(key, copy)
        return false
      })
      const copy = copies.length === 1 ? copies[0] : copies.find(item => item.slot === currentChapterCopy(key)?.slot)
      if (copy && copy.edits.revision === incoming.revision) {
        setChoices(null)
        restore(key, incoming, copy)
        return
      }
      setChoices(copies.length ? { key, copies, activeSlot: diverged ? currentChapterCopy(key)?.slot : undefined } : null)
      if (copies.length) checked.current.choiceRevision = incoming.revision
      if (diverged && copies.length) return
    }
    showSaved(data)
  }, [data, selectedChapterId, novelId, key, scope, hydratedScope, draftRevision, draftRef, dirtyRef, restore, showSaved])
  if (!choices || choices.key !== key || !data || data.id !== selectedChapterId || data.novelId !== novelId || scope !== hydratedScope) return null
  // Input committed by the editor blur can arrive while the choice opens.
  // A newer immutable copy of those edits must replace the old preview.
  const copies = choices.copies.map(copy => copy.slot === choices.activeSlot ? currentChapterCopy(key) ?? copy : copy)
  return {
    copies,
    conflict: copies.some(copy => copy.edits.revision !== data.revision),
    choose(copy: ChapterCopy | null) {
      checked.current = { key: choices.key }
      setChoices(null)
      if (copy) restore(choices.key, buildChapterDraft(data), copy)
      else {
        viewSyncedChapter(choices.key, copies)
        showSaved(data)
      }
    },
  }
}
