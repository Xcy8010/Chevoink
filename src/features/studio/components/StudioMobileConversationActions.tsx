import { useQueryClient } from '@tanstack/react-query'
import { Archive, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AgentSession } from '../../../../shared/contracts/index.js'
import { deleteAgentSession, fetchSessionsRunStatus, renameAgentSession, updateAgentSessionSettings } from '../agent/agentApi'
import StudioMobileSheet from './StudioMobileSheet'

type Action = 'pin' | 'rename' | 'archive' | 'restore' | 'delete'
export type MobileConversationChange = { action: Action; session: AgentSession }

export default function StudioMobileConversationActions({ session, trigger, onClose, onChange }: {
  session: AgentSession
  trigger: HTMLButtonElement
  onClose: () => void
  onChange: (change: MobileConversationChange) => void
}) {
  const queryClient = useQueryClient()
  const [action, setAction] = useState<Exclude<Action, 'pin'> | null>(null)
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function execute(next: Action, dismiss: () => void) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      let updated = session
      if (next === 'rename') {
        updated = (await renameAgentSession(session.id, title.trim())).session
      } else if (next === 'pin') {
        updated = (await updateAgentSessionSettings(session.id, { pinned: !session.pinnedAt })).session
      } else if (next === 'restore') {
        updated = (await updateAgentSessionSettings(session.id, { status: 'active' })).session
      } else if (next === 'archive') {
        const { statuses } = await fetchSessionsRunStatus([session.id])
        if (['queued', 'running', 'awaiting_approval'].includes(statuses[session.id]?.status ?? '')) {
          setError('对话正在运行或等待确认，结束后才能归档。')
          return
        }
        updated = (await updateAgentSessionSettings(session.id, { status: 'archived' })).session
      } else {
        await deleteAgentSession(session.id)
      }
      onChange({ action: next, session: updated })
      void queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] })
      dismiss()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally { setBusy(false) }
  }

  const row = 'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] disabled:opacity-45'
  const heading = action === 'rename' ? '重命名对话' : action === 'archive' ? '归档对话' : action === 'restore' ? '恢复对话' : action === 'delete' ? '删除对话' : '对话操作'
  const PinIcon = session.pinnedAt ? PinOff : Pin
  return <StudioMobileSheet title={heading} closeLabel="关闭对话操作" trigger={trigger} busy={busy} onClose={onClose}>{dismiss => <>
    <p className="mb-3 mt-1 truncate px-3 text-sm text-[var(--text-secondary)]">{session.title}</p>
    {error && <p role="alert" className="mb-2 text-sm text-[var(--color-error)]">{error}</p>}
    {action === null ? <>
      <button type="button" disabled={busy} className={row} onClick={() => { void execute('pin', dismiss) }}><PinIcon aria-hidden="true" size={18} />{session.pinnedAt ? '取消置顶' : '置顶对话'}</button>
      <button type="button" disabled={busy} className={row} onClick={() => setAction('rename')}><Pencil aria-hidden="true" size={18} />重命名</button>
      <button type="button" disabled={busy} className={row} onClick={() => setAction(session.status === 'archived' ? 'restore' : 'archive')}><Archive aria-hidden="true" size={18} />{session.status === 'archived' ? '恢复对话' : '归档'}</button>
      <button type="button" disabled={busy} className={row + ' text-[var(--color-error)]'} onClick={() => setAction('delete')}><Trash2 aria-hidden="true" size={18} />删除</button>
      <button type="button" disabled={busy} className={row + ' justify-center border-t border-[var(--border-subtle)]'} onClick={() => dismiss()}>取消</button>
    </> : <form className="px-2 pb-2" onSubmit={event => { event.preventDefault(); if (action !== 'rename' || title.trim()) void execute(action, dismiss) }}>
      {action === 'rename' ? <input
        aria-label="对话名称"
        autoFocus
        value={title}
        disabled={busy}
        onChange={event => setTitle(event.target.value)}
        maxLength={160}
        className="h-11 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 text-base"
      /> : <p className="text-sm leading-6">
        {action === 'archive' ? '归档后可在「全部对话」的已归档列表中恢复，对话和作品正文会保留。' : action === 'restore' ? '恢复后，这段对话会重新显示在作品的对话列表中。' : '删除后无法恢复这段对话，正在执行的任务也会停止。已经写入作品的正文会保留。'}
      </p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" disabled={busy} className="min-h-11 rounded-lg px-3 hover:bg-[var(--surface-muted)]" onClick={() => { setAction(null); setError('') }}>返回</button>
        <button type="submit" disabled={busy || (action === 'rename' && !title.trim())} className="min-h-11 rounded-lg bg-[var(--surface-contrast)] px-3 font-medium text-[var(--text-contrast)] disabled:opacity-45">
          {busy ? '处理中…' : action === 'rename' ? '保存' : action === 'archive' ? '确认归档' : action === 'restore' ? '确认恢复' : '确认删除'}
        </button>
      </div>
    </form>}
  </>}</StudioMobileSheet>
}
