import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import { AGENT_PERSONALIZATION_LIMITS, type AgentPersonalizationMemory } from '../../../../shared/contracts/agent-personalization.js'
import { deletePersonalizationMemory, fetchPersonalizationMemories, personalizationMemoriesQueryKey, savePersonalizationMemory } from '../personalization-api'
import ConfirmDialog from './ConfirmDialog'

const updatedDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

type Edit = { memory?: AgentPersonalizationMemory; text: string }
type Removal = { id?: string; revision: number }
type MemoryAction = { kind: 'save'; edit: Edit } | { kind: 'delete'; removal: Removal }

export default function PersonalizationMemorySettings({
  owner,
  memoryEnabled,
  settingBusy,
  onToggle,
}: {
  owner: string
  memoryEnabled?: boolean
  settingBusy: boolean
  onToggle: (enabled: boolean) => void
}) {
  const client = useQueryClient()
  const queryKey = personalizationMemoriesQueryKey(owner)
  const memories = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchPersonalizationMemories(owner, signal),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const [edit, setEdit] = useState<Edit | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [actionError, setActionError] = useState('')
  const { mutateAsync } = useMutation({
    mutationKey: queryKey,
    mutationFn: async (action: MemoryAction) => {
      await client.cancelQueries({ queryKey })
      if (action.kind === 'save') {
        await savePersonalizationMemory(owner, action.edit.text.trim(), action.edit.memory)
      } else {
        await deletePersonalizationMemory(owner, action.removal.revision, action.removal.id)
      }
    },
    onSettled: async () => {
      if (useShellStore.getState().sessionUser?.id === owner) {
        await client.invalidateQueries({ queryKey })
      }
    },
  })
  const busy = useIsMutating({ mutationKey: queryKey }) > 0
  const items = memories.data?.memories ?? []
  const listReady = Boolean(memories.data && !memories.isError)
  const editedMemoryMissing = Boolean(edit?.memory && listReady && !items.some(item => item.id === edit.memory?.id))
  const confirmationTitle = removal?.id ? '删除这条记忆？' : '清空全局记忆？'
  const confirmTrigger = useRef<HTMLButtonElement | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!removal) return
    const trigger = confirmTrigger.current
    const fallback = addButton.current
    const dialog = document.querySelector<HTMLElement>(`[data-workspace-confirm-dialog][aria-label="${confirmationTitle}"]`)
    dialog?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    return () => {
      const target = trigger?.isConnected && !trigger.disabled ? trigger : fallback
      target?.focus({ preventScroll: true })
    }
  }, [confirmationTitle, removal])

  function handleConfirmationKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) setRemoval(null)
    }
    if (event.key !== 'Tab') return
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey ? event.target === first : event.target === last) {
      event.preventDefault()
      const next = event.shiftKey ? last : first
      next?.focus()
    }
  }

  function openRemoval(trigger: HTMLButtonElement, next: Removal) {
    setActionError('')
    confirmTrigger.current = trigger
    setRemoval(next)
  }

  async function apply(action: MemoryAction) {
    if (busy) return
    setActionError('')
    try {
      await mutateAsync(action)
      if (action.kind === 'save') setEdit(null)
      else setRemoval(null)
    } catch (error) {
      if (error instanceof ApiClientError && (error.status === 409 || error.status === 404)) {
        if (action.kind === 'delete') {
          setRemoval(null)
        } else if (action.edit.memory) {
          const latest = client.getQueryData<typeof memories.data>(queryKey)?.memories.find(item => item.id === action.edit.memory?.id)
          if (latest) setEdit({ ...action.edit, memory: latest })
        }
        setActionError(error.message)
      } else {
        setActionError(error instanceof Error ? error.message : '无法保存记忆更改，请重试。')
      }
    }
  }

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (listReady && edit?.text.trim() && edit.text.trim() !== edit.memory?.text && !editedMemoryMissing) void apply({ kind: 'save', edit })
  }

  return (
    <section className="space-y-4 border-t border-[var(--border-subtle)] pt-6" aria-label="全局记忆">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">全局记忆</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--text-tertiary)]">
            {memoryEnabled === false ? '已暂停使用和保存对话记忆。已有记忆仍可管理。' : '在不同作品和对话中使用已保存的记忆。'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="全局记忆"
          aria-checked={memoryEnabled ?? false}
          disabled={memoryEnabled === undefined || settingBusy}
          onClick={() => onToggle(!memoryEnabled)}
          className={cn(
            'relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50',
            memoryEnabled ? 'border-[#71857c] bg-[#71857c] dark:border-[#8fa198] dark:bg-[#8fa198]' : 'border-[var(--border-strong)] bg-[var(--surface-muted)]',
          )}
        >
          <span aria-hidden="true" className={cn('absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform', memoryEnabled && 'translate-x-5')} />
        </button>
      </div>

      {memories.isPending ? <p role="status" className="text-sm text-[var(--text-secondary)]">正在加载记忆…</p> : null}
      {memories.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-rose-500">记忆列表加载失败。</p>
          <Button size="sm" variant="ghost" disabled={busy || memories.isFetching} onClick={() => void memories.refetch()}>重试加载记忆</Button>
        </div>
      ) : null}
      {memories.data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button ref={addButton} size="sm" disabled={!listReady || busy || Boolean(edit)} onClick={() => { setActionError(''); setEdit({ text: '' }) }}>添加记忆</Button>
            <Button size="sm" variant="ghost" className="text-rose-600 dark:text-rose-400" disabled={!listReady || busy || Boolean(edit) || items.length === 0} onClick={event => {
              if (memories.data) openRemoval(event.currentTarget, { revision: memories.data.revision })
            }}>清空记忆</Button>
          </div>
          {edit ? (
            <form onSubmit={submitEdit} className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4">
              <label className="block space-y-2 text-sm">
                <span className="font-medium">{edit.memory ? '编辑记忆' : '新记忆'}</span>
                <textarea
                  autoFocus
                  className="w-full min-w-0 resize-y rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                  rows={3}
                  value={edit.text}
                  maxLength={AGENT_PERSONALIZATION_LIMITS.memoryText}
                  disabled={busy}
                  onChange={event => { setActionError(''); setEdit({ ...edit, text: event.target.value }) }}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" type="submit" disabled={!listReady || busy || editedMemoryMissing || !edit.text.trim() || edit.text.trim() === edit.memory?.text}>{busy ? '保存中…' : '保存记忆'}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setActionError(''); setEdit(null) }}>取消</Button>
              </div>
            </form>
          ) : null}
          {items.length > 0 ? (
            <ul aria-label="已保存的记忆" className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
              {items.map(item => (
                <li key={item.id} className="space-y-2 py-3.5">
                  <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">{item.text}</p>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="text-xs text-[var(--text-secondary)]">
                      {item.source === 'manual' ? '手动添加' : '来自对话'}
                      <span aria-hidden="true"> · </span>
                      <time dateTime={item.updatedAt}>更新于 {updatedDate.format(new Date(item.updatedAt))}</time>
                    </span>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" disabled={!listReady || busy || Boolean(edit)} onClick={() => { setActionError(''); setEdit({ memory: item, text: item.text }) }}>编辑</Button>
                      <Button size="sm" variant="ghost" disabled={!listReady || busy || Boolean(edit)} onClick={event => openRemoval(event.currentTarget, { id: item.id, revision: item.revision })}>删除</Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-[var(--text-secondary)]">还没有保存的记忆。</p>}
        </>
      ) : null}
      {actionError && !removal ? <p role="alert" className="text-sm text-rose-500">{actionError}</p> : null}

      <div onKeyDown={handleConfirmationKeys}>
        <ConfirmDialog
          open={Boolean(removal)}
          title={confirmationTitle}
          description={removal?.id ? '删除后，Agent 将不再使用这条记忆。' : '这会删除所有已保存的全局记忆。'}
          confirmLabel={removal?.id ? '删除记忆' : '确认清空'}
          tone="danger"
          busy={busy}
          overlayClassName="z-[210]"
          onCancel={() => { if (!busy) setRemoval(null) }}
          onConfirm={() => { if (removal) void apply({ kind: 'delete', removal }) }}
        >
          {actionError ? <p role="alert" className="mt-3 text-sm text-rose-500">{actionError}</p> : null}
        </ConfirmDialog>
      </div>
    </section>
  )
}
