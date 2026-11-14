import { useId, useRef, useState, type ReactNode } from 'react'
import { Pencil, Pin, PinOff, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { AGENT_PERSONALIZATION_LIMITS, type AgentPersonalizationMemory } from '../../../../shared/contracts/agent-personalization.js'
import {
  createPersonalizationMemory,
  deletePersonalizationMemory,
  fetchPersonalizationMemories,
  isPersonalizationAccount,
  patchPersonalizationMemory,
  personalizationMemoriesQueryKey,
  restorePersonalizationMemory,
} from '../personalization-api'
import { PersonalizationDialog, PersonalizationFeedback, PersonalizationGroup, personalizationField, personalizationRow } from './personalization-ui'

const updatedDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const changeLabels: Record<AgentPersonalizationMemory['lastChange'], string> = {
  saved: '保存', edited: '编辑', merged: '合并', corrected: '更正', capacity: '自动移出', restored: '恢复', migrated: '从个性化设置迁入',
}

type MemoryEdit = { memory?: AgentPersonalizationMemory; text: string; pinned: boolean; error?: string }
type Removal = { memory?: AgentPersonalizationMemory; revision: number; error?: string }
type MemoryAction =
  | { kind: 'save'; edit: MemoryEdit }
  | { kind: 'pin' | 'restore'; memory: AgentPersonalizationMemory }
  | { kind: 'delete'; removal: Removal }

export default function PersonalizationMemorySettings({ owner, memoryEnabled, settingBusy, onToggle }: {
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
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<MemoryEdit | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const { mutateAsync } = useMutation({
    mutationKey: queryKey,
    mutationFn: async (action: MemoryAction) => {
      await client.cancelQueries({ queryKey })
      switch (action.kind) {
        case 'save': {
          const { memory, text, pinned } = action.edit
          if (memory) await patchPersonalizationMemory(owner, memory, { text: text.trim() })
          else await createPersonalizationMemory(owner, text.trim(), pinned)
          break
        }
        case 'pin':
          await patchPersonalizationMemory(owner, action.memory, { pinned: !action.memory.pinned })
          break
        case 'restore':
          await restorePersonalizationMemory(owner, action.memory)
          break
        case 'delete':
          await deletePersonalizationMemory(owner, action.removal.revision, action.removal.memory?.id)
          break
      }
    },
    onSettled: async () => {
      if (isPersonalizationAccount(owner)) await client.invalidateQueries({ queryKey })
    },
  })
  const busy = useIsMutating({ mutationKey: queryKey }) > 0
  const items = memories.data?.memories ?? []
  const archived = memories.data?.archived ?? []
  const ready = Boolean(memories.data && !memories.isError)
  const latest = edit?.memory ? items.find(item => item.id === edit.memory?.id) : undefined
  const missing = Boolean(edit?.memory && ready && !latest)
  const stale = Boolean(edit?.memory && latest && latest.revision !== edit.memory.revision)
  const text = edit?.text.trim() ?? ''
  const tooLong = Array.from(text).length > AGENT_PERSONALIZATION_LIMITS.memoryText
  const canSave = Boolean(text && !tooLong && !missing && !stale && text !== edit?.memory?.text)
  const editorId = useId()
  const manageButton = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const doneButton = useRef<HTMLButtonElement>(null)
  const actionTrigger = useRef<HTMLButtonElement | null>(null)

  function managerFocus() {
    const trigger = actionTrigger.current
    return trigger?.isConnected && !trigger.disabled ? trigger : (addButton.current?.disabled ? doneButton.current : addButton.current)
  }

  function openEditor(trigger: HTMLButtonElement, memory?: AgentPersonalizationMemory) {
    actionTrigger.current = trigger
    setFeedback(null)
    setEdit({ memory, text: memory?.text ?? '', pinned: memory?.pinned ?? false })
  }

  function openRemoval(trigger: HTMLButtonElement, next: Removal) {
    actionTrigger.current = trigger
    setFeedback(null)
    setRemoval(next)
  }

  async function apply(action: MemoryAction) {
    if (busy || !ready) return
    setFeedback(null)
    try {
      await mutateAsync(action)
      if (action.kind === 'save') {
        setEdit(null)
        setFeedback({ text: '已保存记忆。' })
      } else if (action.kind === 'delete') {
        setRemoval(null)
        setFeedback({ text: action.removal.memory ? '已彻底删除记忆。' : '已清空全部记忆。' })
      } else if (action.kind === 'pin') {
        setFeedback({ text: action.memory.pinned ? '已取消固定。' : '已固定记忆。' })
      } else {
        setFeedback({ text: '已恢复记忆。' })
        addButton.current?.focus({ preventScroll: true })
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : '无法保存记忆更改，请重试。'
      if (action.kind === 'save') setEdit({ ...action.edit, error: text })
      else if (action.kind === 'delete') {
        if (error instanceof ApiClientError && (error.status === 409 || error.status === 404)) {
          setRemoval(null)
          setFeedback({ text, error: true })
        } else {
          setRemoval({ ...action.removal, error: text })
        }
      } else setFeedback({ text, error: true })
    }
  }

  return <PersonalizationGroup title="记忆">
    <div className={cn(personalizationRow, 'min-h-[4.5rem]')}>
      <div className="min-w-0">
        <p className="text-sm font-medium">全局记忆</p>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
          {memoryEnabled === false ? '已暂停使用和保存对话记忆。已有记忆仍可管理。' : '让 Agent 记住你的偏好，用于所有创作对话。'}
        </p>
      </div>
      <button type="button" role="switch" aria-label="全局记忆" aria-checked={memoryEnabled ?? false}
        disabled={memoryEnabled === undefined || settingBusy} onClick={() => onToggle(!memoryEnabled)}
        className="group flex h-11 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50">
        <span aria-hidden="true" className={cn('relative h-6 w-11 rounded-full border motion-safe:transition-colors',
          memoryEnabled ? 'border-[var(--surface-contrast)] bg-[var(--surface-contrast)]' : 'border-[var(--border-strong)] bg-[var(--surface-muted)]')}>
          <span className={cn('absolute left-0.5 top-0.5 size-[18px] rounded-full motion-safe:transition-transform',
            memoryEnabled ? 'translate-x-5 bg-[var(--text-contrast)]' : 'bg-[var(--text-secondary)]')} />
        </span>
      </button>
    </div>
    <div className={cn(personalizationRow, 'min-h-[4.5rem]')}>
      <div className="min-w-0">
        <p className="text-sm font-medium">已保存的记忆</p>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
          {memories.data ? `${items.length} / ${AGENT_PERSONALIZATION_LIMITS.activeMemories} 条生效记忆` : '查看、修改或删除 Agent 记住的内容。'}
        </p>
      </div>
      <Button ref={manageButton} size="sm" className="min-h-11 shrink-0 rounded-lg border-transparent bg-[var(--surface-muted)]" aria-haspopup="dialog" aria-label="管理已保存的记忆" onClick={() => {
        setFeedback(null)
        setOpen(true)
      }}>管理</Button>
    </div>
    {open ? (
      <PersonalizationDialog title="已保存的记忆" wide busy={busy} onClose={() => setOpen(false)} returnFocus={() => manageButton.current}
        footer={<>
          <Button variant="ghost" size="sm" className="mr-auto min-h-11 text-rose-700 dark:text-rose-400" disabled={!ready || busy || items.length + archived.length === 0} onClick={event => {
            if (memories.data) openRemoval(event.currentTarget, { revision: memories.data.revision })
          }}>清空全部记忆</Button>
          <Button ref={doneButton} size="sm" className="min-h-11" disabled={busy} onClick={() => setOpen(false)}>完成</Button>
        </>}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{items.length} / {AGENT_PERSONALIZATION_LIMITS.activeMemories} 条生效记忆</span>
            <Button ref={addButton} size="sm" className="min-h-11" disabled={!ready || busy} onClick={event => openEditor(event.currentTarget)}>
              <Plus className="size-4" aria-hidden="true" />添加记忆
            </Button>
          </div>
          {memories.isPending ? <PersonalizationFeedback>正在加载记忆…</PersonalizationFeedback> : null}
          {memories.isError ? <div className="flex flex-wrap items-center gap-2">
            <PersonalizationFeedback error>记忆列表加载失败。</PersonalizationFeedback>
            <Button size="sm" variant="ghost" disabled={busy || memories.isFetching} onClick={() => void memories.refetch()}>重试加载记忆</Button>
          </div> : null}
          {memories.data ? <>
            {items.length > 0 ? (
              <ul aria-label="生效记忆" className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
                {items.map(item => {
                  const pinLabel = item.pinned ? '取消固定' : '固定'
                  const PinIcon = item.pinned ? PinOff : Pin
                  return <MemoryRow key={item.id} memory={item}>
                    <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title={pinLabel} aria-label={pinLabel} disabled={!ready || busy}
                      aria-pressed={item.pinned} onClick={() => void apply({ kind: 'pin', memory: item })}>
                      <PinIcon className="size-4" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title="编辑" aria-label="编辑" disabled={!ready || busy} onClick={event => openEditor(event.currentTarget, item)}>
                      <Pencil className="size-4" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title="删除" aria-label="删除" disabled={!ready || busy} onClick={event => openRemoval(event.currentTarget, { memory: item, revision: item.revision })}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </MemoryRow>
                })}
              </ul>
            ) : <p className="py-6 text-center text-sm text-[var(--text-secondary)]">还没有保存的记忆。</p>}
            {archived.length > 0 ? <details className="rounded-xl border border-[var(--border-subtle)] px-3">
              <summary className="cursor-pointer py-3 text-sm font-medium">最近整理 · {archived.length} 条可恢复</summary>
              <p className="pb-2 text-xs leading-5 text-[var(--text-secondary)]">自动移出的记忆可在 30 天内恢复。恢复后会占用生效名额。</p>
              <ul aria-label="可恢复记忆" className="divide-y divide-[var(--border-subtle)]">
                {archived.map(item => <MemoryRow key={item.id} memory={item}>
                  <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title="恢复" aria-label="恢复" disabled={!ready || busy} onClick={() => void apply({ kind: 'restore', memory: item })}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title="彻底删除" aria-label="彻底删除" disabled={!ready || busy} onClick={event => openRemoval(event.currentTarget, { memory: item, revision: item.revision })}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </MemoryRow>)}
              </ul>
            </details> : null}
          </> : null}
          {busy && !edit && !removal ? <PersonalizationFeedback>正在更新记忆…</PersonalizationFeedback> : null}
          {feedback ? <PersonalizationFeedback error={feedback.error}>{feedback.text}</PersonalizationFeedback> : null}
        </div>
      </PersonalizationDialog>
    ) : null}
    {edit ? (
      <PersonalizationDialog title={edit.memory ? '编辑记忆' : '添加记忆'} busy={busy} onClose={() => setEdit(null)} returnFocus={managerFocus}
        footer={<>
          <Button variant="ghost" disabled={busy} onClick={() => setEdit(null)}>取消</Button>
          <Button form={editorId} type="submit" variant="primary" disabled={!ready || busy || !canSave}>{busy ? '保存中…' : '保存记忆'}</Button>
        </>}>
        <form id={editorId} className="space-y-3" onSubmit={event => { event.preventDefault(); if (canSave) void apply({ kind: 'save', edit }) }}>
          <label className="block space-y-2 text-sm">
            <span className="font-medium">{edit.memory ? '记忆内容' : '新记忆'}</span>
            <textarea className={cn(personalizationField, 'w-full resize-y text-base sm:text-sm')} rows={4} maxLength={2 * AGENT_PERSONALIZATION_LIMITS.memoryText}
              data-personalization-focus disabled={busy} value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} />
          </label>
          {!edit.memory ? <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.pinned} disabled={busy} onChange={event => setEdit({ ...edit, pinned: event.target.checked })} />
            固定这条记忆
          </label> : null}
          {tooLong ? <PersonalizationFeedback error>记忆最多 {AGENT_PERSONALIZATION_LIMITS.memoryText} 字。</PersonalizationFeedback> : null}
          {missing ? <PersonalizationFeedback error>这条记忆已移出或删除。你仍可复制草稿。</PersonalizationFeedback> : null}
          {stale && latest ? <div className="space-y-2 text-sm">
            <p>记忆已更新。当前内容：</p>
            <p className="whitespace-pre-wrap text-[var(--text-secondary)] [overflow-wrap:anywhere]">{latest.text}</p>
            <Button size="sm" disabled={!ready || busy} onClick={() => setEdit({ ...edit, memory: latest, error: undefined })}>已核对，继续编辑</Button>
          </div> : null}
          {edit.error ? <PersonalizationFeedback error>{edit.error}</PersonalizationFeedback> : null}
        </form>
      </PersonalizationDialog>
    ) : null}
    {removal ? (
      <PersonalizationDialog title={removal.memory ? '删除这条记忆？' : '清空全局记忆？'} busy={busy} onClose={() => setRemoval(null)} returnFocus={managerFocus}
        footer={<>
          <Button variant="ghost" data-personalization-focus disabled={busy} onClick={() => setRemoval(null)}>取消</Button>
          <Button variant="primary" className="bg-rose-700 text-white hover:bg-rose-800" disabled={!ready || busy} onClick={() => void apply({ kind: 'delete', removal })}>
            {busy ? '删除中…' : removal.memory ? '删除记忆' : '确认清空'}
          </Button>
        </>}>
        <div className="space-y-3">
          {removal.memory ? <p className="whitespace-pre-wrap rounded-lg bg-[var(--surface-muted)] p-3 text-sm [overflow-wrap:anywhere]">{removal.memory.text}</p> : null}
          <p className="text-sm text-[var(--text-secondary)]">
            {removal.memory ? '这条记忆将被彻底删除，无法恢复。' : '所有生效和可恢复的记忆都将被彻底删除，无法恢复。'}
          </p>
          {removal.error ? <PersonalizationFeedback error>{removal.error}</PersonalizationFeedback> : null}
        </div>
      </PersonalizationDialog>
    ) : null}
  </PersonalizationGroup>
}

function MemoryRow({ memory, children }: { memory: AgentPersonalizationMemory; children: ReactNode }) {
  return <li className="flex min-w-0 flex-wrap items-start justify-between gap-x-1 py-2.5 sm:flex-nowrap">
    <div className="min-w-0 flex-[1_1_11rem] py-1.5">
      <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">{memory.text}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
        {memory.pinned ? '已固定 · ' : ''}{memory.source === 'manual' ? '手动添加' : '来自对话'}
        {' · '}{changeLabels[memory.lastChange]}{' · '}<time dateTime={memory.updatedAt}>{updatedDate.format(new Date(memory.updatedAt))}</time>
      </p>
      {memory.recoveryUntil ? <p className="text-xs leading-5 text-[var(--text-secondary)]">可恢复至 <time dateTime={memory.recoveryUntil}>{updatedDate.format(new Date(memory.recoveryUntil))}</time></p> : null}
    </div>
    <div className="ml-auto flex shrink-0 gap-0.5">{children}</div>
  </li>
}
