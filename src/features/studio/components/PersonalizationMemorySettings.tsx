import { useId, useRef, useState, type ReactNode } from 'react'
import { Pencil, Pin, PinOff, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
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
import { PersonalizationDialog, PersonalizationFeedback, PersonalizationGroup } from './personalization-ui'

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
    <div className="studio-settings-row spacious">
      <div className="studio-settings-row-copy">
        <span className="studio-settings-row-title">全局记忆</span>
        <p>让 Agent 记住你的偏好，用于所有创作对话。</p>
      </div>
      <button type="button" role="switch" aria-label="全局记忆" aria-checked={memoryEnabled ?? false}
        disabled={memoryEnabled === undefined || settingBusy} onClick={() => onToggle(!memoryEnabled)}
        className="studio-settings-toggle">
        <span aria-hidden="true" />
      </button>
    </div>
    <div className="studio-settings-row spacious">
      <div className="studio-settings-row-copy">
        <span className="studio-settings-row-title">已保存的记忆</span>
        <p>{memoryEnabled === false ? '记忆已暂停使用，你仍可在这里管理。' : '查看、修改或删除 Agent 记住的内容。'}</p>
      </div>
      <button type="button" className="studio-settings-button subtle" ref={manageButton} aria-haspopup="dialog" aria-label="管理已保存的记忆" onClick={() => {
        setFeedback(null)
        setOpen(true)
      }}>管理</button>
    </div>
    {open ? (
      <PersonalizationDialog title="已保存的记忆" kind="manager" busy={busy} onClose={() => setOpen(false)} returnFocus={() => manageButton.current}
        toolbar={<>
          <span>{items.length} / {AGENT_PERSONALIZATION_LIMITS.activeMemories} 条生效记忆</span>
          <button type="button" className="studio-settings-button" ref={addButton} disabled={!ready || busy} onClick={event => openEditor(event.currentTarget)}>
            <Plus strokeWidth={1.6} aria-hidden="true" />添加记忆
          </button>
        </>}
        footer={<>
          <button type="button" className="studio-settings-text-danger" disabled={!ready || busy || items.length + archived.length === 0} onClick={event => {
            if (memories.data) openRemoval(event.currentTarget, { revision: memories.data.revision })
          }}>清空全部记忆</button>
          <button type="button" className="studio-settings-button" ref={doneButton} disabled={busy} onClick={() => setOpen(false)}>完成</button>
        </>}>
          {memories.isPending ? <PersonalizationFeedback>正在加载记忆…</PersonalizationFeedback> : null}
          {memories.isError ? <div className="flex flex-wrap items-center gap-2">
            <PersonalizationFeedback error>记忆列表加载失败。</PersonalizationFeedback>
            <button type="button" className="studio-settings-button" disabled={busy || memories.isFetching} onClick={() => void memories.refetch()}>重试加载记忆</button>
          </div> : null}
          {memories.data ? <>
            {items.length > 0 ? (
              <ul aria-label="生效记忆">
                {items.map(item => {
                  const pinLabel = item.pinned ? '取消固定' : '固定'
                  const PinIcon = item.pinned ? PinOff : Pin
                  return <MemoryRow key={item.id} memory={item}>
                    <button type="button" className="studio-settings-icon-button" title={pinLabel} aria-label={pinLabel} disabled={!ready || busy}
                      aria-pressed={item.pinned} onClick={() => void apply({ kind: 'pin', memory: item })}>
                      <PinIcon strokeWidth={1.6} aria-hidden="true" />
                    </button>
                    <button type="button" className="studio-settings-icon-button" title="编辑" aria-label="编辑" disabled={!ready || busy} onClick={event => openEditor(event.currentTarget, item)}>
                      <Pencil strokeWidth={1.6} aria-hidden="true" />
                    </button>
                    <button type="button" className="studio-settings-icon-button" title="删除" aria-label="删除" disabled={!ready || busy} onClick={event => openRemoval(event.currentTarget, { memory: item, revision: item.revision })}>
                      <Trash2 strokeWidth={1.6} aria-hidden="true" />
                    </button>
                  </MemoryRow>
                })}
              </ul>
            ) : <p className="studio-settings-empty">还没有保存的记忆。</p>}
            {archived.length > 0 ? <details className="studio-settings-recovery">
              <summary className="cursor-pointer py-3 text-sm font-medium">最近整理 · {archived.length} 条可恢复</summary>
              <p className="studio-settings-feedback">自动移出的记忆可在 30 天内恢复。恢复后会占用生效名额。</p>
              <ul aria-label="可恢复记忆">
                {archived.map(item => <MemoryRow key={item.id} memory={item}>
                  <button type="button" className="studio-settings-icon-button" title="恢复" aria-label="恢复" disabled={!ready || busy} onClick={() => void apply({ kind: 'restore', memory: item })}>
                    <RotateCcw strokeWidth={1.6} aria-hidden="true" />
                  </button>
                  <button type="button" className="studio-settings-icon-button" title="彻底删除" aria-label="彻底删除" disabled={!ready || busy} onClick={event => openRemoval(event.currentTarget, { memory: item, revision: item.revision })}>
                    <Trash2 strokeWidth={1.6} aria-hidden="true" />
                  </button>
                </MemoryRow>)}
              </ul>
            </details> : null}
          </> : null}
          {busy && !edit && !removal ? <PersonalizationFeedback>正在更新记忆…</PersonalizationFeedback> : null}
          {feedback ? <PersonalizationFeedback error={feedback.error}>{feedback.text}</PersonalizationFeedback> : null}
      </PersonalizationDialog>
    ) : null}
    {edit ? (
      <PersonalizationDialog title={edit.memory ? '编辑记忆' : '添加记忆'} busy={busy} onClose={() => setEdit(null)} returnFocus={managerFocus}
        footer={<>
          <button type="button" className="studio-settings-button" disabled={busy} onClick={() => setEdit(null)}>取消</button>
          <button form={editorId} type="submit" className="studio-settings-button primary" disabled={!ready || busy || !canSave}>{busy ? '保存中…' : '保存记忆'}</button>
        </>}>
        <form id={editorId} onSubmit={event => { event.preventDefault(); if (canSave) void apply({ kind: 'save', edit }) }}>
          <label className="studio-settings-form-label" htmlFor={editorId + '-text'}>{edit.memory ? '记忆内容' : '新记忆'}</label>
          <textarea id={editorId + '-text'} className="studio-settings-field" rows={4} maxLength={2 * AGENT_PERSONALIZATION_LIMITS.memoryText}
            data-personalization-focus disabled={busy} value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} />
          {!edit.memory ? <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={edit.pinned} disabled={busy} onChange={event => setEdit({ ...edit, pinned: event.target.checked })} />
            固定这条记忆
          </label> : null}
          {tooLong ? <PersonalizationFeedback error>记忆最多 {AGENT_PERSONALIZATION_LIMITS.memoryText} 字。</PersonalizationFeedback> : null}
          {missing ? <PersonalizationFeedback error>这条记忆已移出或删除。你仍可复制草稿。</PersonalizationFeedback> : null}
          {stale && latest ? <div className="mt-3 space-y-2">
            <p>记忆已更新。当前内容：</p>
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{latest.text}</p>
            <button type="button" className="studio-settings-button" disabled={!ready || busy} onClick={() => setEdit({ ...edit, memory: latest, error: undefined })}>已核对，继续编辑</button>
          </div> : null}
          {edit.error ? <PersonalizationFeedback error>{edit.error}</PersonalizationFeedback> : null}
        </form>
      </PersonalizationDialog>
    ) : null}
    {removal ? (
      <PersonalizationDialog title={removal.memory ? '删除这条记忆？' : '清空全局记忆？'} kind="confirm" busy={busy} onClose={() => setRemoval(null)} returnFocus={managerFocus}
        footer={<>
          <button type="button" className="studio-settings-button" data-personalization-focus disabled={busy} onClick={() => setRemoval(null)}>取消</button>
          <button type="button" className="studio-settings-button danger" disabled={!ready || busy} onClick={() => void apply({ kind: 'delete', removal })}>
            {busy ? '删除中…' : removal.memory ? '删除记忆' : '确认清空'}
          </button>
        </>}>
        <div className="space-y-3">
          {removal.memory ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{removal.memory.text}</p> : null}
          <p>
            {removal.memory ? '这条记忆将被彻底删除，无法恢复。' : '所有生效和可恢复的记忆都将被彻底删除，无法恢复。'}
          </p>
          {removal.error ? <PersonalizationFeedback error>{removal.error}</PersonalizationFeedback> : null}
        </div>
      </PersonalizationDialog>
    ) : null}
  </PersonalizationGroup>
}

function MemoryRow({ memory, children }: { memory: AgentPersonalizationMemory; children: ReactNode }) {
  return <li className="studio-settings-item">
    <div className="studio-settings-memory-text">
      <p className="whitespace-pre-wrap">{memory.text}</p>
      <small>
        {memory.pinned ? '已固定 · ' : ''}{memory.source === 'manual' ? '手动添加' : '来自对话'}
        {' · '}{changeLabels[memory.lastChange]}{' · '}<time dateTime={memory.updatedAt}>{updatedDate.format(new Date(memory.updatedAt))}</time>
      </small>
      {memory.recoveryUntil ? <small>可恢复至 <time dateTime={memory.recoveryUntil}>{updatedDate.format(new Date(memory.recoveryUntil))}</time></small> : null}
    </div>
    <div className="studio-settings-actions">{children}</div>
  </li>
}
