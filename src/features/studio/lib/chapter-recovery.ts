import { z } from 'zod'

const editsSchema = z.object({
  title: z.string(), summary: z.string(), content: z.string(),
  status: z.enum(['draft', 'published', 'scheduled', 'archived']),
  visibility: z.enum(['private', 'public', 'followers']),
  revision: z.number().int().positive(),
})
type Edits = z.infer<typeof editsSchema>
export type ChapterCopy = { slot: string; time: number; edits: Edits }

// Unique per document, including a duplicated browser tab. A fresh document can
// recover persisted copies without sharing a mutable slot with the original tab.
const writer = Math.random().toString(36).slice(2) + Date.now().toString(36)
let nextCopy = 0
const adopted = new Map<string, ChapterCopy>()
const volatile = new Map<string, ChapterCopy>()
function preventLoss(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}

export function chapterRecoveryKey(userId: string | undefined, novelId: string, chapterId: string) {
  return userId ? 'chevoink:chapter-draft:' + JSON.stringify([userId, novelId, chapterId]) : undefined
}

function readCopy(slot: string): ChapterCopy | undefined {
  try {
    const raw = localStorage.getItem(slot)
    if (!raw) return
    const data = JSON.parse(raw)
    const edits = editsSchema.safeParse(data.edits).data
    if (edits && Number.isFinite(data.time)) return { slot, time: data.time, edits }
  } catch { /* Storage may be unavailable in a webview. */ }
}

export function listChapterCopies(key: string | undefined): ChapterCopy[] {
  if (!key) return []
  const prefix = key + ':copy:'
  const copies = new Map<string, ChapterCopy>()
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const slot = localStorage.key(index)
      if (!slot?.startsWith(prefix) || slot.endsWith(':position')) continue
      const copy = readCopy(slot)
      if (copy) copies.set(slot, copy)
    }
  } catch { /* A quota failure may have left a recoverable in-memory copy. */ }
  const pending = volatile.get(key)
  if (pending) copies.set(pending.slot, pending)
  return [...copies.values()].sort((a, b) => b.time - a.time)
}

export function adoptChapterCopy(key: string, copy: ChapterCopy) {
  adopted.set(key, copy)
}

export function currentChapterCopy(key: string | undefined) {
  if (!key) return
  return volatile.get(key) ?? adopted.get(key)
}

export function readChapterEdits(key: string | undefined) {
  return currentChapterCopy(key)?.edits
}

export function retireChapterCopy(key: string, copy: ChapterCopy) {
  const pending = volatile.get(key)
  if (pending?.slot === copy.slot && pending.time === copy.time) {
    volatile.delete(key)
    if (!volatile.size) window.removeEventListener('beforeunload', preventLoss)
  }
  if (adopted.get(key)?.slot === copy.slot) adopted.delete(key)
  // A slot is immutable. Retiring it can never remove another tab's newer write.
  try {
    localStorage.removeItem(copy.slot)
    localStorage.removeItem(copy.slot + ':position')
  } catch { /* A future read reconciles the saved content. */ }
}

export function storeChapterEdits(key: string | undefined, draft: Edits | null): boolean {
  if (!key) return false
  const previous = adopted.get(key)
  const ownSlots = key + ':copy:' + writer + ':'
  if (!draft) {
    const current = currentChapterCopy(key)
    if (current) retireChapterCopy(key, current)
    if (previous && previous !== current && previous.slot.startsWith(ownSlots)) retireChapterCopy(key, previous)
    adopted.delete(key)
    return true
  }
  const { title, summary, content, status, visibility, revision } = draft
  const slot = ownSlots + (++nextCopy)
  const copy = { slot, time: Date.now(), edits: { title, summary, content, status, visibility, revision } }
  try {
    localStorage.setItem(slot, JSON.stringify({ time: copy.time, edits: copy.edits }))
  } catch {
    volatile.set(key, copy)
    window.addEventListener('beforeunload', preventLoss)
    return false
  }
  volatile.delete(key)
  if (!volatile.size) window.removeEventListener('beforeunload', preventLoss)
  // A recovered copy may still be the unsaved text visible in another tab.
  // Only a server acknowledgement can retire that other writer's version.
  if (previous?.slot.startsWith(ownSlots)) retireChapterCopy(key, previous)
  adopted.set(key, copy)
  return true
}

export function sameChapterEdits(a: Edits, b: Edits) {
  return a.content === b.content && a.title === b.title && a.summary === b.summary
    && a.status === b.status && a.visibility === b.visibility
}
