import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Search, X, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type SettingsSectionLink = { id: string; label: string; icon: LucideIcon }

type SearchResult = { key: string; label: string; group?: string; target: HTMLElement }

function normalizeSearch(value: string) {
  return value.normalize('NFKC').trim().toLowerCase()
}

function jumpTo(target: HTMLElement | null | undefined) {
  if (!target?.isConnected) return
  target.focus({ preventScroll: true })
  target.scrollIntoView({
    block: 'start',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  })
}

export default function SettingsLayout({ backButton, links, children }: {
  backButton: ReactNode
  links: SettingsSectionLink[]
  children: ReactNode
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTarget = useRef<HTMLElement | null>(null)
  const resultsId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [activeId, setActiveId] = useState(links[0]?.id)
  const search = normalizeSearch(query)

  useLayoutEffect(() => {
    if (!search) {
      jumpTo(searchTarget.current)
      searchTarget.current = null
      return
    }
    const terms = search.split(/\s+/)
    const matches = (text: string) => {
      const value = normalizeSearch(text)
      return terms.every(term => value.includes(term))
    }
    const found: SearchResult[] = []
    for (const { id, label } of links) {
      const section = document.getElementById(id)
      if (!section || !contentRef.current?.contains(section)) continue
      const heading = section.querySelector('h2')
      if (heading && matches(label)) found.push({ key: id, label, target: heading })
      for (const [index, row] of [...section.querySelectorAll<HTMLElement>('[data-setting-title]')].entries()) {
        const title = row.dataset.settingTitle
        if (title && matches(`${label} ${row.textContent ?? ''} ${row.dataset.settingKeywords ?? ''}`)) {
          found.push({ key: `${id}-${index}`, label: title, group: label, target: row })
        }
      }
    }
    setResults(found)
  }, [links, search])

  useEffect(() => {
    const rail = railRef.current
    const content = contentRef.current
    if (!rail || !content) return
    const sections = links.map(({ id }) => document.getElementById(id)).filter(section => section && content.contains(section))
    let frame = 0
    let railVisible = Boolean(rail.offsetWidth)
    function syncActiveSection() {
      frame = 0
      if (!rail) return
      const line = Number.parseFloat(getComputedStyle(rail).top) + 16
      let current = links[0]?.id
      for (const section of sections) {
        if (section && section.getBoundingClientRect().top <= line) current = section.id
      }
      setActiveId(current)
    }
    const schedule = () => {
      if (railVisible && !frame) frame = window.requestAnimationFrame(syncActiveSection)
    }
    const resize = () => {
      railVisible = Boolean(rail.offsetWidth)
      schedule()
    }
    schedule()
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', resize)
      window.cancelAnimationFrame(frame)
    }
  }, [links])

  function clearSearch() {
    setQuery('')
    inputRef.current?.focus()
  }

  function chooseResult(target: HTMLElement) {
    searchTarget.current = target
    setQuery('')
  }

  return (
    <div className="mx-auto w-full max-w-[64rem] pb-5">
      <header className="mb-5 flex items-center gap-3 border-b border-[var(--border-subtle)] pb-4 pt-1 md:mb-6 md:gap-4 md:pb-5">
        {backButton}
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)] md:text-3xl">设置</h1>
      </header>
      <form role="search" aria-label="搜索设置" className="mb-6 lg:hidden"
        onSubmit={event => {
          event.preventDefault()
          if (search && results[0]) chooseResult(results[0].target)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && query) {
            event.preventDefault()
            clearSearch()
          }
        }}>
        <div className="flex h-12 items-center gap-2.5 rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-solid)] px-3.5 focus-within:border-[var(--accent-border)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]">
          <Search aria-hidden="true" className="size-[18px] shrink-0 text-[var(--text-secondary)]" />
          <input ref={inputRef} type="search" aria-label="搜索设置" aria-controls={search ? resultsId : undefined}
            placeholder="搜索设置" value={query} onChange={event => setQuery(event.target.value)}
            className="min-w-0 flex-1 appearance-none bg-transparent text-base text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] [&::-webkit-search-cancel-button]:hidden" />
          {query && <button type="button" aria-label="清除搜索" onClick={clearSearch}
            className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]">
            <X aria-hidden="true" className="size-4" />
          </button>}
        </div>
        {search && <div id={resultsId} className="mt-2 max-h-72 overflow-auto rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-solid)]">
          {results.length ? (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {results.map(({ key, label, group, target }) => (
                <li key={key}>
                  <button type="button" onClick={() => chooseResult(target)}
                    className="flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-[var(--surface-muted)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)] motion-safe:transition-colors">
                    <span className="min-w-0 flex-1 text-sm font-medium text-[var(--text-primary)]">{label}</span>
                    {group && <span className="shrink-0 text-xs text-[var(--text-secondary)]">{group}</span>}
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--text-secondary)]" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p role="status" className="px-3.5 py-3 text-sm text-[var(--text-secondary)]">未找到匹配的设置</p>}
        </div>}
      </form>
      <div className="grid items-start gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav ref={railRef} aria-label="设置分区"
          className="hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-solid)] lg:sticky lg:top-[calc(var(--app-header-height,0px)+1rem)] lg:block lg:max-h-[calc(100dvh-var(--app-header-height,0px)-2rem)] lg:overflow-y-auto">
          <ul className="space-y-0.5 p-1.5">
            {links.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button type="button" aria-controls={id} aria-current={activeId === id ? 'location' : undefined}
                  onClick={() => jumpTo(document.getElementById(id)?.querySelector('h2'))}
                  className={cn('flex min-h-10 w-full items-center gap-2.5 rounded-[var(--radius-md)] px-3 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand)] motion-safe:transition-colors',
                    activeId === id ? 'bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand)]'
                      : 'font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]')}>
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div ref={contentRef} className="flex min-w-0 flex-col gap-7">{children}</div>
      </div>
    </div>
  )
}
