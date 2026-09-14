import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { StoryMemoryCard } from '../../../../../shared/contracts/index.js'
import { deleteStoryMemory, updateStoryMemory } from '../agentApi'
import { useShellStore } from '@/store/useShellStore'

const button = 'min-h-11 rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-40'

/** Native top-layer focus trap: no backdrop-dismiss and no keyboard events leaking to the card fan. */
export function MemoryModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const focus = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    return () => { dialog.close(); document.body.style.overflow = overflow; if (focus?.isConnected) focus.focus() }
  }, [])
  return createPortal(<dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }}
    onKeyDown={event => event.stopPropagation()}
    className="studio-workspace m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-4 text-[var(--text-primary)] shadow-xl backdrop:bg-black/40 sm:p-6">
    <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-base font-semibold">{title}</h3>
      <button className={button} type="button" aria-label={`关闭${title}`} onClick={onClose}>关闭</button></div>
    {children}
  </dialog>, document.body)
}

type Draft = { title: string; content: string; importance: number; expectedVersion: number }
function readDraft(key: string, card: StoryMemoryCard): Draft {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (value && typeof value === 'object' && 'title' in value && 'content' in value && 'importance' in value && 'expectedVersion' in value
      && typeof value.title === 'string' && typeof value.content === 'string' && typeof value.importance === 'number' && typeof value.expectedVersion === 'number') return value as Draft
  } catch { /* Storage unavailable: editing still works in memory. */ }
  return { title: card.title, content: card.content, importance: card.importance, expectedVersion: card.version }
}
function removeDraft(key: string) { try { sessionStorage.removeItem(key) } catch { /* no storage */ } }

export function MemoryCardDeleteDialog({ card, onClose, onDeleted }: { card: StoryMemoryCard; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  async function remove() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { await deleteStoryMemory(card.id, card.version); onDeleted() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败，请重试。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <MemoryModal title="删除记忆卡片" onClose={() => { if (!pending.current) onClose() }}>
    <p className="break-words text-sm leading-6">确定删除「{card.title}」？删除后不再参与后续记忆召回，不修改章节正文或历史对话。系统保留修订记录，不自动重建同名卡片。</p>
    {error && <p role="alert" className="mt-3 text-sm text-rose-500">{error}</p>}
    <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className={`${button} bg-rose-700 text-white`} disabled={busy} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除'}</button></div>
  </MemoryModal>
}

export default function MemoryCardEditor({ card, novelId, onClose, onSaved }: { card: StoryMemoryCard; novelId: string; onClose: () => void; onSaved: (card: StoryMemoryCard) => void }) {
  const userId = useShellStore(state => state.sessionUser?.id ?? 'anonymous')
  const key = `chevoink:memory-draft:${userId}:${novelId}:${card.id}`
  const [draft, setDraft] = useState(() => readDraft(key, card))
  const [confirmClose, setConfirmClose] = useState(false)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const [storageError, setStorageError] = useState(false)
  const dirty = draft.title !== card.title || draft.content !== card.content || draft.importance !== card.importance
  const stale = draft.expectedVersion !== card.version
  // Save on each edit, not on delayed unmount: switching works or refreshing cannot overwrite another card.
  const change = (next: Draft) => {
    setDraft(next)
    try { sessionStorage.setItem(key, JSON.stringify(next)); setStorageError(false) } catch { setStorageError(true) }
  }
  const requestClose = useCallback(() => {
    if (pending.current) return
    if (confirmClose) { setConfirmClose(false); return }
    if (dirty) setConfirmClose(true); else { removeDraft(key); onClose() }
  }, [confirmClose, dirty, key, onClose])
  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])
  async function save() {
    if (pending.current || stale) return
    if (!draft.title.trim() || !draft.content.trim()) { setError('标题与内容不能为空。'); return }
    pending.current = true
    setSaving(true)
    setError('')
    try {
      const result = await updateStoryMemory(card.id, { ...draft, title: draft.title.trim(), content: draft.content.trim() })
      removeDraft(key)
      onSaved(result.memory)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，你的草稿仍保留。') }
    finally { pending.current = false; setSaving(false) }
  }
  return <MemoryModal title="编辑记忆卡片" onClose={requestClose}>
    <p className="mb-3 text-xs leading-5 text-[var(--text-secondary)]">草稿保留在当前浏览器标签页，保存后才生效。{card.reviewStatus === 'pending' ? '这是待审核候选；保存修订即确认此设定。' : '模型候选不会直接覆盖作者修订。'}</p>
    {['relationshipState', 'timelineEvent'].includes(card.memoryType) && <p className="mb-3 text-xs leading-5 text-[var(--text-secondary)]">原样确认会同步工具提供的结构化关系/事件；修改标题或正文后，仅以修订后的卡片参与记忆召回，不沿用旧结构化字段。</p>}
    {storageError && <p role="alert" className="mb-3 text-sm text-amber-600">浏览器无法暂存草稿，请勿刷新或离开，先保存修订。</p>}
    {stale && <div className="mb-3 rounded-xl border p-3 text-sm">草稿基于旧版卡片。请与最新内容核对后再保存。
      <details><summary className="cursor-pointer py-2">查看服务器最新内容</summary><p className="whitespace-pre-wrap break-words">{card.title}{'\n'}{card.content}</p></details>
      <button type="button" className={button} onClick={() => change({ ...draft, expectedVersion: card.version })}>已核对，以当前版本继续编辑</button></div>}
    <fieldset disabled={saving} className="space-y-3">
      <label className="block text-sm">标题<input value={draft.title} maxLength={160} onChange={e => change({ ...draft, title: e.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3" /></label>
      <label className="block text-sm">内容<textarea value={draft.content} maxLength={8000} rows={9} onChange={e => change({ ...draft, content: e.target.value })} className="mt-1 w-full resize-y rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 text-base leading-6" /></label>
      <label className="block text-sm">重要性 {draft.importance}<input type="range" min={1} max={100} value={draft.importance} onChange={e => change({ ...draft, importance: Number(e.target.value) })} className="mt-2 min-h-8 w-full" /></label>
    </fieldset>
    {error && <p role="alert" className="mt-3 text-sm text-rose-500">{error}</p>}
    {confirmClose ? <section aria-label="未保存修改" className="mt-4 rounded-xl border border-amber-600/40 p-3">
      <p className="text-sm">修改尚未保存。可继续编辑，或保留草稿稍后再改。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => setConfirmClose(false)}>继续编辑</button>
        <button type="button" className={button} disabled={storageError} onClick={onClose}>保留草稿并关闭</button>
        <button type="button" className={`${button} text-rose-500`} onClick={() => { removeDraft(key); onClose() }}>放弃修改</button>
      </div>
    </section> : null}
    <div className="mt-4 flex justify-end gap-2"><button type="button" className={button} disabled={saving} onClick={requestClose}>取消</button>
      <button type="button" className={`${button} bg-[var(--surface-contrast)] text-[var(--text-contrast)]`} disabled={saving || stale} onClick={() => void save()}>{saving ? '保存中…' : '保存修订'}</button></div>
  </MemoryModal>
}
