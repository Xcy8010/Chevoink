import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'

export type SettingsSection = { id: string; label: string }

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

export default function SettingsLayout({ backButton, sections, children }: {
  backButton: ReactNode
  sections: SettingsSection[]
  children: ReactNode
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTarget = useRef<HTMLElement | null>(null)
  const resultsId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
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
    for (const { id, label } of sections) {
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
  }, [sections, search])

  function clearSearch() {
    setQuery('')
    inputRef.current?.focus()
  }

  function chooseResult(target: HTMLElement) {
    searchTarget.current = target
    setQuery('')
  }

  return (
    <div className="mx-auto w-full max-w-[50rem] pb-5">
      <header className="mb-5 flex items-center gap-3 border-b border-[var(--border-subtle)] pb-4 pt-1 md:mb-6 md:gap-4 md:pb-5">
        {backButton}
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)] md:text-3xl">设置</h1>
      </header>
      <form role="search" aria-label="搜索设置" className="mb-6"
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
      <div ref={contentRef} className="flex min-w-0 flex-col gap-7">{children}</div>
    </div>
  )
}
