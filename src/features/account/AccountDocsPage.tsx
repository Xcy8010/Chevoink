import { useQuery } from '@tanstack/react-query'
import { fetchPublicCreditPolicy } from './credits-api'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'

import { cn } from '@/lib/utils'
import AccountLayout from './AccountLayout'
import { getAccountDocs, DOC_GROUPS } from './docs-content'

export default function AccountDocsPage() {
  const policy = useQuery({ queryKey: ['credits', 'public-policy'], queryFn: fetchPublicCreditPolicy, staleTime: 20_000, refetchInterval: 60_000 })
  const docs = useMemo(() => getAccountDocs(policy.data?.publicBetaEnabled), [policy.data?.publicBetaEnabled])
  const [searchParams, setSearchParams] = useSearchParams()
  const [keyword, setKeyword] = useState('')
  const activeDoc = docs.find((doc) => doc.key === searchParams.get('doc')) ?? docs[0]

  const filteredDocs = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return docs
    return docs.filter(
      (doc) =>
        doc.title.toLowerCase().includes(kw) ||
        doc.summary.toLowerCase().includes(kw) ||
        doc.sections.some((section) => section.heading.toLowerCase().includes(kw)),
    )
  }, [keyword, docs])

  function selectDoc(key: string) {
    setSearchParams({ doc: key })
  }

  function jumpTo(sectionId: string) {
    document.getElementById(`doc-${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (policy.isLoading || policy.isError) return <AccountLayout withSidebar={false}><p className="px-5 py-9 text-sm text-[var(--text-secondary)]">{policy.isError ? '暂时无法读取文档。' : '加载中…'}</p></AccountLayout>

  return (
    <AccountLayout withSidebar={false}>
      <div className="flex items-stretch">
        <aside className="hidden w-[248px] shrink-0 border-r border-[#e8e8e5] md:block dark:border-[var(--border-subtle)]">
          <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-4 py-7 [scrollbar-gutter:stable]">
            <label className="flex h-9 items-center gap-2 rounded-[10px] border border-[#e4e4e1] bg-white px-3 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <Search className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索文档"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
            </label>
            <nav className="mt-6 space-y-6">
              {DOC_GROUPS.map((group) => {
                const docs = filteredDocs.filter((doc) => doc.group === group)
                if (docs.length === 0) return null
                return (
                  <div key={group}>
                    <p className="px-3 text-xs text-[var(--text-tertiary)]">{group}</p>
                    <div className="mt-2 space-y-0.5">
                      {docs.map((doc) => (
                        <button
                          key={doc.key}
                          type="button"
                          onClick={() => selectDoc(doc.key)}
                          className={cn(
                            'block w-full rounded-[9px] px-3 py-2 text-left text-sm transition-colors',
                            doc.key === activeDoc.key
                              ? 'bg-emerald-600/10 font-medium text-emerald-700 dark:text-emerald-400'
                              : 'text-[var(--text-secondary)] hover:bg-[#f1f1ef] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]',
                          )}
                        >
                          {doc.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
              {filteredDocs.length === 0 ? <p className="px-3 text-xs text-[var(--text-tertiary)]">没有匹配的文档。</p> : null}
            </nav>
          </div>
        </aside>
        <article className="min-w-0 flex-1 px-5 py-9 sm:px-8 lg:px-12 lg:py-11">
          <div className="mx-auto flex max-w-[1020px] gap-10">
            <div className="min-w-0 flex-1">
              <select
                value={activeDoc.key}
                onChange={(event) => selectDoc(event.target.value)}
                className="h-9 w-full rounded-[10px] border border-[#e4e4e1] bg-white px-3 text-sm outline-none md:hidden dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]"
                aria-label="选择文档"
              >
                {docs.map((doc) => (
                  <option key={doc.key} value={doc.key}>{doc.group} · {doc.title}</option>
                ))}
              </select>
              <p className="mt-4 text-xs font-medium text-emerald-700 md:mt-0 dark:text-emerald-400">{activeDoc.group}</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-.03em]">{activeDoc.title}</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{activeDoc.summary}</p>
              {activeDoc.sections.map((section) => (
                <section key={section.id} className="mt-10">
                  <h2 id={`doc-${section.id}`} className="scroll-mt-20 text-xl font-semibold tracking-[-.02em]">{section.heading}</h2>
                  {section.paragraphs?.map((paragraph) => (
                    <p key={paragraph.slice(0, 24)} className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{paragraph}</p>
                  ))}
                  {section.bullets ? (
                    <ul className="mt-3 space-y-2.5">
                      {section.bullets.map((bullet) => (
                        <li key={bullet.slice(0, 24)} className="flex items-start gap-2.5 text-sm leading-6 text-[var(--text-secondary)]">
                          <span className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ))}
            </div>
            <nav className="hidden w-[176px] shrink-0 xl:block">
              <div className="sticky top-20 py-1">
                <p className="text-xs font-medium">本页目录</p>
                <ul className="mt-3 space-y-2.5 border-l border-[#e4e4e1] dark:border-[var(--border-subtle)]">
                  {activeDoc.sections.map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        onClick={() => jumpTo(section.id)}
                        className="-ml-px block border-l border-transparent pl-3 text-left text-xs leading-5 text-[var(--text-tertiary)] transition-colors hover:border-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                      >
                        {section.heading}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          </div>
        </article>
      </div>
    </AccountLayout>
  )
}
