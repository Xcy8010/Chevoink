import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Chapter } from '../../../../shared/contracts/index.js'
import { buildChapterDraft } from '../lib/form-state'
import { formatDateTime } from '../lib/agent-session'
import type { ChapterDraftState, SaveState } from '../types'
import { canApplyChapterSnapshot } from './chapter-stream-handoff'
import { adoptChapterCopy, chapterRecoveryKey, currentChapterCopy, listChapterCopies, retireChapterCopy, sameChapterEdits, type ChapterCopy } from '../lib/chapter-recovery'

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
  const checkedKey = useRef<string>()
  const [choices, setChoices] = useState<{ key: string; copies: ChapterCopy[] } | null>(null)
  useLayoutEffect(() => {
    checkedKey.current = undefined
    setChoices(null)
  }, [key])
  const restore = useCallback((key: string, incoming: ChapterDraftState, copy: ChapterCopy) => {
    adoptChapterCopy(key, copy)
    // Keep the revision originally edited, even when the server changed in the interim.
    const restored = { ...incoming, ...copy.edits }
    draftRef.current = restored
    dirtyRef.current = true
    setDraft(restored)
    setDirty(true)
    setSaveState('pending')
    setSaveMessage('已恢复未同步的章节修改。')
  }, [draftRef, dirtyRef, setDraft, setDirty, setSaveState, setSaveMessage])
  // A cached or just-resolved chapter (including its recovery copy) belongs in the next paint.
  useLayoutEffect(() => {
    if (!data || data.id !== selectedChapterId || !scope || scope !== hydratedScope || data.novelId !== novelId) return
    const incoming = buildChapterDraft(data)
    if (!canApplyChapterSnapshot(draftRef.current, incoming, dirtyRef.current)) return
    if (key && checkedKey.current !== key) {
      checkedKey.current = key
      const copies = listChapterCopies(key).filter(copy => {
        if (!sameChapterEdits(copy.edits, incoming)) return true
        retireChapterCopy(key, copy)
        return false
      })
      const copy = copies.length === 1 ? copies[0] : copies.find(item => item.slot === currentChapterCopy(key)?.slot)
      if (copy) {
        setChoices(null)
        restore(key, incoming, copy)
        return
      }
      setChoices(copies.length > 1 ? { key, copies } : null)
    }
    draftRef.current = incoming
    dirtyRef.current = false
    setDraft(incoming)
    setDirty(false)
    setSaveState('saved')
    setLastSavedAt(data.updatedAt)
    setSaveMessage(`已同步到 ${formatDateTime(data.updatedAt)}`)
  }, [data, selectedChapterId, novelId, key, scope, hydratedScope, draftRef, dirtyRef, setDraft, setDirty, setSaveState, setLastSavedAt, setSaveMessage, restore])
  if (!choices || choices.key !== key || !data || data.id !== selectedChapterId || data.novelId !== novelId || scope !== hydratedScope) return null
  return {
    copies: choices.copies,
    choose(copy: ChapterCopy | null) {
      setChoices(null)
      if (copy) restore(choices.key, buildChapterDraft(data), copy)
    },
  }
}
