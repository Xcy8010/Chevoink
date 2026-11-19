import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { StoryMemoryCard } from '../../../../../shared/contracts/index.js'
import { deleteStoryMemory, updateStoryMemory } from '../agentApi'
import { useShellStore } from '@/store/useShellStore'
import { MemoryMarkdown } from './MemoryMarkdown'
import './memory-catalog.css'

const button = 'min-h-11 rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-40'

/** Native top-layer focus trap keeps card editor shortcuts within the editor. */
export function MemoryModal({ title, onClose, children, footer, busy = false }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  busy?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const focus = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    const viewport = window.visualViewport
    const resize = () => {
      if (!viewport) return
      dialog.style.setProperty('--memory-viewport-height', `${viewport.height}px`)
      dialog.style.setProperty('--memory-viewport-top', `${viewport.offsetTop}px`)
    }
    document.body.style.overflow = 'hidden'
    resize()
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', resize)
    dialog.showModal()
    heading.current?.focus({ preventScroll: true })
    return () => {
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', resize)
      dialog.close()
      document.body.style.overflow = overflow
      if (focus?.isConnected) focus.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(<dialog ref={ref} aria-label={title} aria-busy={busy || undefined} data-native-back-dismiss
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }}
    onKeyDown={event => event.stopPropagation()}
    className="studio-workspace fixed inset-x-0 bottom-auto top-[calc(var(--memory-viewport-top,0px)+var(--memory-viewport-height,100dvh)/2)] m-auto max-h-[min(90dvh,calc(var(--memory-viewport-height,100dvh)-16px))] w-[calc(100%-1.5rem)] max-w-lg -translate-y-1/2 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-0 text-[var(--text-primary)] shadow-xl backdrop:bg-black/40 open:flex open:flex-col">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-1 sm:px-6">
      <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">{title}</h3>
      <button type="button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-[var(--surface-muted)] disabled:opacity-40">
        <X aria-hidden="true" className="h-5 w-5" />
      </button>
    </header>
    <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6 sm:py-4">{children}</div>
    <footer className="shrink-0 border-t border-[var(--border-subtle)] px-4 py-2 sm:px-6 sm:py-3">{footer}</footer>
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
  return <MemoryModal title="删除记忆卡片" busy={busy} onClose={() => { if (!pending.current) onClose() }} footer={
    <div className="flex flex-wrap justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className={`${button} text-[var(--color-error)]`} disabled={busy} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除'}</button></div>
  }>
    <p className="break-words text-sm leading-6">删除「{card.title}」？这张卡片将从创作记忆中移除。</p>
    {error && <p role="alert" className="mt-3 text-sm text-[var(--color-error)]">{error}</p>}
  </MemoryModal>
}

export default function MemoryCardEditor({ card, novelId, onClose, onSaved }: { card: StoryMemoryCard; novelId: string; onClose: () => void; onSaved: (card: StoryMemoryCard) => void }) {
  const userId = useShellStore(state => state.sessionUser?.id ?? 'anonymous')
  const key = `chevoink:memory-draft:${userId}:${novelId}:${card.id}`
  const [draft, setDraft] = useState(() => readDraft(key, card))
  const [preview, setPreview] = useState(false)
  const contentId = useId()
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
  return <MemoryModal title="编辑记忆卡片" busy={saving} onClose={requestClose} footer={
    <>
      {error && <p role="alert" className="mb-2 text-sm text-[var(--color-error)]">{error}</p>}
      {confirmClose ? <section aria-label="未保存修改">
        <p className="text-sm">修改尚未保存。可继续编辑，或保留草稿稍后再改。</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => setConfirmClose(false)}>继续编辑</button>
          <button type="button" className={button} disabled={storageError} onClick={onClose}>保留草稿并关闭</button>
          <button type="button" className={`${button} text-[var(--color-error)]`} onClick={() => { removeDraft(key); onClose() }}>放弃修改</button>
        </div>
      </section> : <div className="flex justify-end gap-2"><button type="button" className={button} disabled={saving} onClick={requestClose}>取消</button>
        <button type="button" className={`${button} memory-editor-save`} disabled={saving || stale} onClick={() => void save()}>{saving ? '保存中…' : '保存修订'}</button></div>}
    </>
  }>
    {storageError && <p role="alert" className="mb-3 text-sm text-[var(--color-warning)]">浏览器无法暂存草稿，请勿刷新或离开，先保存修订。</p>}
    {stale && <div className="mb-3 rounded-xl border p-3 text-sm">草稿基于旧版卡片。请与最新内容核对后再保存。
      <details><summary className="cursor-pointer py-2">查看服务器最新内容</summary><p className="whitespace-pre-wrap break-words">{card.title}{'\n'}{card.content}</p></details>
      <button type="button" className={button} onClick={() => change({ ...draft, expectedVersion: card.version })}>已核对，以当前版本继续编辑</button></div>}
    <fieldset disabled={saving || confirmClose} className="space-y-3">
      <label className="block text-sm">标题<input value={draft.title} maxLength={160} onChange={e => change({ ...draft, title: e.target.value })} className="memory-editor-field mt-1.5 min-h-11 w-full rounded-xl border border-[var(--border-subtle)] px-3 text-base" /></label>
      <div>
        <div className="memory-editor-mode">
          <label htmlFor={contentId}>内容</label>
          <div role="group" aria-label="正文显示方式">
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Markdown</button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
          </div>
        </div>
        <textarea id={contentId} hidden={preview} value={draft.content} rows={8} onChange={e => change({ ...draft, content: e.target.value })}
          className="memory-editor-field memory-editor-source w-full resize-y rounded-xl border border-[var(--border-subtle)] p-3 text-base leading-7" />
        {preview && <section className="memory-editor-preview" aria-label="正文预览">
          {draft.content.trim() ? <MemoryMarkdown title={draft.title} content={draft.content} /> : <p>暂无内容</p>}
        </section>}
      </div>
      <label className="block text-sm">重要性 {draft.importance}<input type="range" min={1} max={100} value={draft.importance} onChange={e => change({ ...draft, importance: Number(e.target.value) })} className="memory-editor-range mt-1 min-h-11 w-full" /></label>
    </fieldset>
  </MemoryModal>
}
