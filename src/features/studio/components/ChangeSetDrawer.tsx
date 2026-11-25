import { StudioPresence } from './StudioPresence'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, RotateCcw, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { StudioPayload } from '../../../../shared/contracts/index.js'
import { applyChangeSet, getChangeSet, rollbackChangeSet } from '../api'
import { useDialogFocusTrap } from './use-dialog-focus-trap'

type ChangeSetDrawerProps = {
  changeSetId: string | null
  novelId: string
  chapters: StudioPayload['chapters']
  onClose: () => void
  onChanged: () => void | Promise<void>
}

const statusLabel = {
  draft: '待审',
  approved: '已批准',
  applying: '应用中',
  applied: '已应用',
  conflicted: '存在冲突',
  failed: '应用失败',
  rolled_back: '已回滚',
} as const

function preview(value: string | null) {
  if (!value) return '（空）'
  return value.length > 260 ? `${value.slice(0, 260)}…` : value
}

export default function ChangeSetDrawer({ changeSetId, novelId, chapters, onClose, onChanged }: ChangeSetDrawerProps) {
  const panel = useRef<HTMLElement>(null)
  useDialogFocusTrap({ panel, open: Boolean(changeSetId), onClose })
  const queryClient = useQueryClient()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const query = useQuery({
    queryKey: ['changeset', changeSetId],
    queryFn: () => getChangeSet(changeSetId as string),
    enabled: Boolean(changeSetId),
  })
  const changeSet = query.data ?? null

  useEffect(() => {
    if (!changeSet) return
    setSelectedIds(new Set(changeSet.patches.filter((patch) => patch.selected).map((patch) => patch.id)))
  }, [changeSet])

  const chapterNames = useMemo(() => new Map(chapters.map((chapter) => [chapter.id, chapter.title])), [chapters])
  const applyMutation = useMutation({
    mutationFn: () => applyChangeSet(changeSetId as string, { selectedPatchIds: [...selectedIds] }),
    onSuccess: async (next) => {
      queryClient.setQueryData(['changeset', changeSetId], next)
      await queryClient.invalidateQueries({ queryKey: ['studio', novelId] })
      await onChanged()
    },
  })
  const rollbackMutation = useMutation({
    mutationFn: () => rollbackChangeSet(changeSetId as string, '作者在变更抽屉中确认整体回滚'),
    onSuccess: async (next) => {
      queryClient.setQueryData(['changeset', changeSetId], next)
      await queryClient.invalidateQueries({ queryKey: ['studio', novelId] })
      await onChanged()
    },
  })

  const busy = query.isLoading || applyMutation.isPending || rollbackMutation.isPending
  const canSelect = changeSet && ['draft', 'approved', 'conflicted', 'failed'].includes(changeSet.status)
  const error = applyMutation.error ?? rollbackMutation.error ?? query.error

  return (
    <StudioPresence kind="dialog">{changeSetId && (
    <div className="studio-tool-overlay fixed inset-0 z-[150] bg-black/30 md:left-auto md:w-[36rem] lg:left-0 lg:w-full" onClick={onClose}>
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        data-studio-motion-panel
        tabIndex={-1}
        className="studio-tool-dialog studio-tool-dialog--wide flex h-full min-h-0 w-full flex-col bg-[var(--surface-default)] shadow-2xl md:border-l md:border-[var(--border-subtle)]"
        onClick={(event) => event.stopPropagation()}
        aria-label="全书变更审查"
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">全书变更</h2>
            <p className="truncate text-[11px] text-[var(--text-tertiary)]">ChangeSet {changeSetId}</p>
          </div>
          {changeSet ? (
            <span className={cn(
              'rounded-full px-2 py-1 text-[11px]',
              changeSet.status === 'applied' ? 'bg-emerald-500/10 text-emerald-600' :
                changeSet.status === 'conflicted' || changeSet.status === 'failed' ? 'bg-rose-500/10 text-rose-600' :
                  'bg-[var(--surface-muted)] text-[var(--text-secondary)]',
            )}>
              {statusLabel[changeSet.status]}
            </span>
          ) : null}
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full hover:bg-[var(--surface-muted)]" aria-label="关闭全书变更">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="studio-tool-body min-h-0 flex-auto overflow-y-auto px-4 py-4">
          {query.isLoading ? <p role="status" className="text-sm text-[var(--text-secondary)]">正在读取变更预览…</p> : null}
          {changeSet ? (
            <>
              <div className="mb-4 flex items-start gap-2 border-b border-[var(--border-subtle)] pb-4 text-xs leading-6 text-[var(--text-secondary)]">
                {changeSet.status === 'applied' || changeSet.status === 'rolled_back' ? <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-amber-500" />}
                <p>{changeSet.patches.length} 个字段补丁；应用时会重新校验所有章节版本与内容哈希，任一冲突则整批不写入。</p>
              </div>
              <div className="space-y-3">
                {changeSet.patches.map((patch) => (
                  <label key={patch.id} className="block border-b border-[var(--border-subtle)] pb-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(patch.id)}
                        disabled={!canSelect}
                        onChange={(event) => setSelectedIds((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(patch.id)
                          else next.delete(patch.id)
                          return next
                        })}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">
                        {chapterNames.get(patch.targetId) ?? patch.targetId} · {patch.field}
                      </span>
                      <span className="text-[10px] text-[var(--text-tertiary)]">v{patch.expectedRevision}</span>
                    </div>
                    <div className="mt-2 grid gap-2 text-[11px] leading-5 lg:grid-cols-2">
                      <div className="min-w-0">
                        <span className="hidden pb-1 font-medium text-[var(--text-secondary)] lg:block">变更前</span>
                        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-rose-400 bg-rose-500/5 px-2 py-1.5 font-sans text-[var(--text-secondary)]">{preview(patch.before)}</pre>
                      </div>
                      <div className="min-w-0">
                        <span className="hidden pb-1 font-medium text-[var(--text-secondary)] lg:block">变更后</span>
                        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-emerald-500 bg-emerald-500/5 px-2 py-1.5 font-sans text-[var(--text-secondary)]">{preview(patch.after)}</pre>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <footer className="shrink-0 border-t border-[var(--border-subtle)] p-4 lg:flex lg:items-center lg:justify-end lg:gap-3 lg:empty:hidden">
          {error ? <p role="alert" className="mb-2 text-xs text-rose-600 lg:mb-0 lg:mr-auto">{error instanceof Error ? error.message : '操作失败，请刷新后重试。'}</p> : null}
          {changeSet && canSelect ? (
            <Button className="w-full lg:w-auto" disabled={busy || selectedIds.size === 0} onClick={() => applyMutation.mutate()}>
              确认并原子应用 {selectedIds.size} 项
            </Button>
          ) : null}
          {changeSet?.status === 'applied' ? (
            <Button variant="secondary" className="w-full lg:w-auto" disabled={busy} onClick={() => rollbackMutation.mutate()}>
              <RotateCcw className="h-4 w-4" />
              整体回滚
            </Button>
          ) : null}
        </footer>
      </section>
    </div>
    )}</StudioPresence>
  )
}
