import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileText, NotebookText, Search } from 'lucide-react'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import type { WorkspacePlanFile } from '../types'
import { formatNumberedChapterTitle } from '../lib/document-title'

export type DocumentKind = 'chapter' | 'plan'
export type DocumentPickerData = {
  chapters: ReadonlyArray<Pick<StudioPayload['chapters'][number], 'id' | 'title' | 'orderIndex' | 'volumeId'>>
  volumes: ReadonlyArray<Pick<StudioPayload['volumes'][number], 'id' | 'title' | 'orderIndex'>>
  plans: ReadonlyArray<Pick<WorkspacePlanFile, 'id' | 'title' | 'planKind'>>
  plansLoaded: boolean
}
const planGroups = { outline: '大纲', detail: '细纲', legacy: '历史未分类' } as const

export default function StudioDocumentPicker({ kind, data, id, trigger, onSelect }: {
  kind: DocumentKind
  data: DocumentPickerData
  id: string
  trigger: HTMLButtonElement | null
  onSelect: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLElement>(null)
  const headingId = useId()
  const isChapter = kind === 'chapter'
  const noun = isChapter ? '章节' : '计划'
  const Icon = isChapter ? FileText : NotebookText
  const entries = useMemo(() => {
    if (kind === 'plan') {
      return data.plans.map(plan => ({
        id: plan.id, label: plan.title.trim() || '未命名计划', group: planGroups[plan.planKind ?? 'legacy'],
      }))
    }
    const volumes = new Map(data.volumes.map(volume => [volume.id, `第 ${volume.orderIndex} 卷 · ${volume.title}`]))
    return [...data.chapters].sort((a, b) => a.orderIndex - b.orderIndex).map(chapter => ({
      id: chapter.id, label: formatNumberedChapterTitle(chapter.title, chapter.orderIndex), group: volumes.get(chapter.volumeId) ?? '',
    }))
  }, [kind, data.plans, data.volumes, data.chapters])
  const needle = search.trim().toLocaleLowerCase()
  const matches = entries.filter(entry => (entry.label + ' ' + entry.group).toLocaleLowerCase().includes(needle))
  useLayoutEffect(() => { (input.current ?? panel.current)?.focus({ preventScroll: true }) }, [])
  useLayoutEffect(() => {
    const card = panel.current
    const parent = card?.parentElement
    if (!card || !parent || !trigger) return
    const place = () => {
      const top = parent.getBoundingClientRect().top
      const anchor = trigger.getBoundingClientRect().top - top - 4
      const available = window.innerHeight - top - card.offsetHeight - 8
      card.style.top = Math.max(0, Math.min(anchor, available)) + 'px'
    }
    place()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    observer?.observe(card)
    const list = trigger.parentElement
    list?.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      list?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [trigger])

  return (
    <section id={id} role="region" aria-labelledby={headingId} ref={panel} tabIndex={-1}
      className="studio-document-picker studio-floating-menu absolute left-[calc(100%+6px)] top-0 flex w-72 flex-col rounded-xl border p-1.5 shadow-[var(--shadow-modal)] outline-none"
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
        if (!buttons.length) return
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1)
        buttons[next]?.focus()
      }}>
      <h3 id={headingId} className="px-2.5 py-1.5 text-sm font-semibold">选择{noun}</h3>
      {entries.length > 0 && (
        <label className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 text-[var(--text-secondary)] focus-within:ring-1 focus-within:ring-[var(--border-strong)]">
          <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <input ref={input} value={search} onChange={event => setSearch(event.target.value)} aria-label={`搜索${noun}`}
            placeholder={`搜索${noun}`} onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && matches.length === 1) onSelect(matches[0].id)
            }}
            className="h-8 min-w-0 flex-1 border-0 bg-transparent text-sm text-[var(--text-primary)] outline-none" />
        </label>
      )}
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {matches.map((entry, index) => <div key={entry.id}>
          {entry.group && entry.group !== matches[index - 1]?.group && <p className="truncate px-2.5 pb-0.5 pt-2 text-xs text-[var(--text-tertiary)]">{entry.group}</p>}
          <button type="button" onClick={() => onSelect(entry.id)} title={entry.label}
            className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm text-[var(--text-primary)]">
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate">{entry.label}</span>
          </button>
        </div>)}
        {matches.length === 0 && <p role="status" className="px-2.5 py-4 text-sm text-[var(--text-secondary)]">{
          needle ? `没有匹配的${noun}` : kind === 'plan' && !data.plansLoaded ? '计划列表尚未载入' : `当前作品暂无${noun}`
        }</p>}
      </div>
    </section>
  )
}
