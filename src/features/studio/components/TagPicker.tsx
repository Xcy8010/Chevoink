import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Minus, Plus, Search, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import { MAX_NOVEL_TAGS, NOVEL_TAG_GROUPS } from '@/lib/novel-tags'
import { cn } from '@/lib/utils'

type TagPickerProps = {
  value: string[]
  onChange: (tags: string[]) => void
}

export default function TagPicker({ value, onChange }: TagPickerProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const chooserId = useId()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true })
  }, [open])

  const normalizedFilter = filter.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!normalizedFilter) return NOVEL_TAG_GROUPS

    return NOVEL_TAG_GROUPS.map((group) => ({
      ...group,
      tags: group.tags.filter((tag) => tag.toLowerCase().includes(normalizedFilter)),
    })).filter((group) => group.tags.length > 0)
  }, [normalizedFilter])

  function toggleTag(tag: string) {
    if (value.includes(tag)) {
      onChange(value.filter((item) => item !== tag))
      return
    }
    if (value.length >= MAX_NOVEL_TAGS) return
    onChange([...value, tag])
  }

  return (
    <div role="group" aria-label="标签">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)]">标签</span>
          <span className="text-xs tabular-nums text-[var(--text-tertiary)]">{value.length}/{MAX_NOVEL_TAGS}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={chooserId}
          className="gap-1 rounded-lg px-2"
          onClick={() => {
            if (open) setFilter('')
            setOpen(!open)
          }}
        >
          {open ? <Minus aria-hidden="true" className="h-3.5 w-3.5" /> : <Plus aria-hidden="true" className="h-3.5 w-3.5" />}
          {open ? '收起标签' : '添加标签'}
        </Button>
      </div>

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {value.map((tag, index) => (
            <span
              key={tag}
              title={index === 0 ? '主分类' : undefined}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-[var(--surface-muted)] pl-2.5 pr-1 text-xs font-medium text-[var(--text-primary)]"
            >
              {tag}
              <button
                type="button"
                aria-label={'移除标签 ' + tag}
                onClick={() => toggleTag(tag)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div id={chooserId} hidden={!open} className="space-y-2.5 pt-2.5">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 focus-within:border-[var(--accent-border)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]">
          <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
          <input
            ref={searchRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="搜索标签"
            placeholder="搜索标签"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
        </label>

        <div className="max-h-44 space-y-2.5 overflow-y-auto overscroll-contain pr-1">
          {filteredGroups.length === 0 ? (
            <p className="py-1 text-xs text-[var(--text-tertiary)]">没有匹配的标签</p>
          ) : (
            filteredGroups.map((group) => (
              <section key={group.label}>
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{group.label}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {group.tags.map((tag) => {
                    const selected = value.includes(tag)
                    const disabled = !selected && value.length >= MAX_NOVEL_TAGS
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleTag(tag)}
                        disabled={disabled}
                        className={cn(
                          'min-h-7 rounded-full px-2.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                          selected
                            ? 'bg-[var(--surface-contrast)] font-medium text-[var(--text-contrast)]'
                            : 'bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                          disabled && 'cursor-not-allowed opacity-45',
                        )}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </section>
            ))
          )}
        </div>

        <p className="text-xs text-[var(--text-tertiary)]">第一个标签是作品的主分类。</p>
      </div>
    </div>
  )
}
