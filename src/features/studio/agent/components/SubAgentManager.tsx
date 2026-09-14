import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  BadgeCheck,
  BookOpenCheck,
  Bot,
  CirclePause,
  CirclePlay,
  Library,
  LoaderCircle,
  Pencil,
  Plus,
  ScrollText,
  SearchCheck,
  Trash2,
  X,
} from 'lucide-react'
import { createPortal } from 'react-dom'

import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { AgentSubtaskLogsView, AgentSubtaskRole, AgentSubtaskView } from '../../../../../shared/contracts'
import {
  createAgentSubtaskRequest,
  deleteAgentSubtaskRequest,
  fetchAgentSubtaskLogs,
  fetchAgentSubtasks,
  updateAgentSubtaskRequest,
} from '../agentApi'

type Draft = {
  name: string
  role: AgentSubtaskRole
  triggerCondition: string
  prompt: string
}

type EditorState = {
  mode: 'create' | 'edit'
  itemId: string | null
  draft: Draft
}

type RoleMeta = {
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}

const roleOrder: AgentSubtaskRole[] = ['research', 'continuity', 'quality', 'lore']
const roleMeta: Record<AgentSubtaskRole, RoleMeta> = {
  research: { label: '调研', description: '检索资料、整理证据与来源', icon: SearchCheck },
  continuity: { label: '一致性', description: '核对前后文、时间线与人物状态', icon: BookOpenCheck },
  quality: { label: '质量', description: '审阅节奏、逻辑与表达完成度', icon: BadgeCheck },
  lore: { label: '设定', description: '维护世界观、规则与专有名词', icon: Library },
}

const statusLabel: Record<string, string> = {
  ready: '已启用',
  queued: '等待执行',
  running: '执行中',
  awaiting_approval: '等待授权',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已停用',
}

const emptyDraft: Draft = { name: '', role: 'research', triggerCondition: '', prompt: '' }
const inputClass = 'h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]'
const textareaClass = 'min-h-32 w-full resize-y rounded-[10px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-3 text-sm leading-6 outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]'

function editorFor(item?: AgentSubtaskView): EditorState {
  if (!item) return { mode: 'create', itemId: null, draft: emptyDraft }
  return {
    mode: 'edit',
    itemId: item.id,
    draft: {
      name: item.name,
      role: item.role,
      triggerCondition: item.triggerCondition,
      prompt: item.prompt,
    },
  }
}

function SubAgentEditorDialog({
  state,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  state: EditorState | null
  busy: boolean
  onChange: (state: EditorState) => void
  onClose: () => void
  onSubmit: () => void
}) {
  if (!state) return null
  const valid = state.draft.name.trim() && state.draft.triggerCondition.trim() && state.draft.prompt.trim()
  const updateDraft = (patch: Partial<Draft>) => onChange({ ...state, draft: { ...state.draft, ...patch } })

  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[270] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section role="dialog" aria-modal="true" aria-label={state.mode === 'create' ? '新建子 Agent' : '编辑子 Agent'} className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_26px_80px_rgba(15,23,42,.22)]">
        <header className="flex items-start gap-4 border-b border-[var(--border-subtle)] px-5 py-4 sm:px-6">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Bot className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h3 className="text-base font-semibold">{state.mode === 'create' ? '新建子 Agent' : '编辑子 Agent'}</h3><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">主 Agent 命中触发条件后会在当前任务内调用它，并负责审查与整合结果。</p></div>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-[1fr_190px]">
            <label className="block"><span className="mb-1.5 block text-xs font-medium">名称</span><input autoFocus className={inputClass} value={state.draft.name} maxLength={60} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="例如：世界观校对员" /></label>
            <label className="block"><span className="mb-1.5 block text-xs font-medium">专业分类</span><select className={inputClass} value={state.draft.role} onChange={(event) => updateDraft({ role: event.target.value as AgentSubtaskRole })}>{roleOrder.map((role) => <option key={role} value={role}>{roleMeta[role].label}</option>)}</select></label>
          </div>
          <label className="block"><span className="mb-1.5 block text-xs font-medium">什么时候调用</span><input className={inputClass} value={state.draft.triggerCondition} maxLength={240} onChange={(event) => updateDraft({ triggerCondition: event.target.value })} placeholder="例如：章节涉及已有设定、时间线或人物状态时" /><span className="mt-1.5 block text-[10px] leading-4 text-[var(--text-tertiary)]">写清可判断的场景，主 Agent 才能稳定选择它。</span></label>
          <label className="block"><span className="mb-1.5 block text-xs font-medium">职责与输出</span><textarea className={textareaClass} value={state.draft.prompt} maxLength={4000} onChange={(event) => updateDraft({ prompt: event.target.value })} placeholder="说明要检查什么、必须参考哪些内容、输出什么，以及不得做什么…" /><span className="mt-1.5 block text-[10px] leading-4 text-[var(--text-tertiary)]">子 Agent 跟随主任务模型和计费；执行上限由服务端统一保护。</span></label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-4 sm:px-6"><Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" onClick={onSubmit} disabled={!valid || busy}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}{state.mode === 'create' ? '创建子 Agent' : '保存更改'}</Button></footer>
      </section>
    </div>,
    document.body,
  )
}

function DeleteDialog({ item, busy, onClose, onConfirm }: { item: AgentSubtaskView | null; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  if (!item) return null
  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[275] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section role="alertdialog" aria-modal="true" aria-label="删除子 Agent" className="w-full max-w-md rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-[0_24px_70px_rgba(15,23,42,.2)]">
        <h3 className="text-base font-semibold">删除“{item.name}”？</h3>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">此操作会同时删除它的调用记录，主 Agent 之后也无法再调用它。</p>
        <div className="mt-6 flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" className="bg-rose-700 hover:bg-rose-800" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}删除</Button></div>
      </section>
    </div>,
    document.body,
  )
}

function LogsDialog({ logs, onClose }: { logs: AgentSubtaskLogsView | null; onClose: () => void }) {
  if (!logs) return null
  return createPortal(
    <div className="studio-workspace fixed inset-0 z-[270] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section role="dialog" aria-modal="true" aria-label={`${logs.name} 使用日志`} className="flex max-h-[82dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_24px_70px_rgba(15,23,42,.2)]">
        <header className="flex items-start gap-4 border-b border-[var(--border-subtle)] px-5 py-4"><div className="min-w-0 flex-1"><h3 className="truncate text-base font-semibold">{logs.name} · 使用日志</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">{statusLabel[logs.status] ?? logs.status} · 记录每次内嵌调用</p></div><button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" onClick={onClose} aria-label="关闭使用日志"><X className="h-4 w-4" /></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {logs.entries.length > 0 ? <ol className="divide-y divide-[var(--border-subtle)]">{logs.entries.map((entry) => <li key={entry.id} className="flex gap-3 py-4 first:pt-0 last:pb-0"><span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', entry.tone === 'danger' ? 'bg-rose-500' : entry.tone === 'warning' ? 'bg-amber-500' : entry.tone === 'success' ? 'bg-[#71857c]' : 'bg-[var(--border-strong)]')} /><div className="min-w-0 flex-1"><div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between"><p className="text-xs font-medium">{entry.title}</p><time className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{new Date(entry.time).toLocaleString()}</time></div><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-secondary)]">{entry.detail}</p></div></li>)}</ol> : <div className="py-16 text-center text-xs text-[var(--text-tertiary)]">还没有调用记录</div>}
        </div>
      </section>
    </div>,
    document.body,
  )
}

export default function SubAgentManager({ novelId, sessionId, chapterId }: { novelId: string; sessionId: string | null; chapterId?: string | null }) {
  const [items, setItems] = useState<AgentSubtaskView[]>([])
  const [activeRole, setActiveRole] = useState<'all' | AgentSubtaskRole>('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AgentSubtaskView | null>(null)
  const [logs, setLogs] = useState<AgentSubtaskLogsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const data = await fetchAgentSubtasks(novelId)
    setItems(data.items)
  }, [novelId])

  useEffect(() => {
    setLoading(true)
    void refresh()
      .catch((cause) => setError(cause instanceof Error ? cause.message : '子 Agent 加载失败。'))
      .finally(() => setLoading(false))
  }, [refresh])

  useEffect(() => {
    if (!editor && !deleteTarget && !logs) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      setEditor(null)
      setDeleteTarget(null)
      setLogs(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, deleteTarget, editor, logs])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  const roleGroups = useMemo(() => roleOrder.map((role) => ({
    role,
    items: items.filter((item) => item.role === role),
  })).filter((group) => activeRole === 'all' ? group.items.length > 0 : group.role === activeRole), [activeRole, items])

  const saveEditor = () => {
    if (!editor) return
    const draft = {
      name: editor.draft.name.trim(),
      role: editor.draft.role,
      triggerCondition: editor.draft.triggerCondition.trim(),
      prompt: editor.draft.prompt.trim(),
    }
    void run(async () => {
      if (editor.mode === 'create') {
        await createAgentSubtaskRequest({ novelId, parentSessionId: sessionId, chapterId, ...draft })
      } else if (editor.itemId) {
        await updateAgentSubtaskRequest(editor.itemId, draft)
      }
      setEditor(null)
      await refresh()
    })
  }

  return (
    <section>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1"><h3 className="text-base font-semibold tracking-tight">专业子 Agent</h3><p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--text-secondary)]">为当前作品配置可复用的专业助手。主 Agent 会根据触发条件在当前任务内调用，不会另开聊天窗口；停用后立即从可调用目录移除。</p></div>
        <Button variant="primary" size="sm" onClick={() => setEditor(editorFor())}><Plus className="h-4 w-4" />新建子 Agent</Button>
      </div>

      {error ? <p role="alert" className="mt-4 border-l-2 border-rose-500 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/20 dark:text-rose-300">{error}</p> : null}

      <div className="mt-5 flex gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2" aria-label="子 Agent 分类">
        <button type="button" onClick={() => setActiveRole('all')} className={cn('h-8 shrink-0 rounded-[8px] px-3 text-xs transition-colors', activeRole === 'all' ? 'bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]/70')}>全部 {items.length}</button>
        {roleOrder.map((role) => <button key={role} type="button" onClick={() => setActiveRole(role)} className={cn('h-8 shrink-0 rounded-[8px] px-3 text-xs transition-colors', activeRole === role ? 'bg-[var(--surface-muted)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]/70')}>{roleMeta[role].label} {items.filter((item) => item.role === role).length}</button>)}
      </div>

      {loading ? <div className="flex min-h-56 items-center justify-center text-xs text-[var(--text-tertiary)]"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />正在加载子 Agent</div> : null}
      {!loading && roleGroups.map((group) => {
        const meta = roleMeta[group.role]
        const Icon = meta.icon
        return (
          <div key={group.role} className="mt-6 first:mt-5">
            <div className="flex items-center gap-3 pb-2"><span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Icon className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-medium">{meta.label}</p><p className="text-[10px] text-[var(--text-tertiary)]">{meta.description}</p></div><span className="text-xs text-[var(--text-tertiary)]">{group.items.length}</span></div>
            <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
              {group.items.map((item) => (
                <article key={item.id} className={cn('py-4', !item.enabled && 'opacity-65')}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h4 className="truncate text-sm font-semibold">{item.name}</h4><span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">{item.enabled ? '已启用' : '已停用'}</span></div>
                      <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]"><span className="font-medium text-[var(--text-primary)]">触发：</span>{item.triggerCondition}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--text-secondary)]">{item.prompt}</p>
                      <p className="mt-2 text-[10px] text-[var(--text-tertiary)]">累计调用 {item.runCount} 次{item.lastRunAt ? ` · 最近 ${new Date(item.lastRunAt).toLocaleString()}` : ' · 尚未调用'}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await updateAgentSubtaskRequest(item.id, { enabled: !item.enabled }); await refresh() })}>{item.enabled ? <CirclePause className="h-4 w-4" /> : <CirclePlay className="h-4 w-4" />}{item.enabled ? '停用' : '启用'}</Button>
                      <button type="button" onClick={() => void run(async () => setLogs(await fetchAgentSubtaskLogs(item.id)))} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" aria-label={`查看${item.name}使用日志`} title="使用日志"><ScrollText className="h-4 w-4" /></button>
                      <button type="button" onClick={() => setEditor(editorFor(item))} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]" aria-label={`编辑${item.name}`} title="编辑"><Pencil className="h-4 w-4" /></button>
                      <button type="button" onClick={() => setDeleteTarget(item)} className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/20" aria-label={`删除${item.name}`} title="删除"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )
      })}

      {!loading && roleGroups.every((group) => group.items.length === 0) ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]"><Bot className="h-5 w-5" /></span>
          <h4 className="mt-4 text-sm font-medium">{items.length === 0 ? '创建第一个专业子 Agent' : `还没有${activeRole === 'all' ? '' : roleMeta[activeRole].label}子 Agent`}</h4>
          <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-secondary)]">{items.length === 0 ? '可从一致性校对、资料调研或质量审阅开始，主 Agent 会在合适的任务中自动调用。' : '切换到其他分类查看，或新建一个该分类的子 Agent。'}</p>
          <Button size="sm" className="mt-4" onClick={() => setEditor(editorFor())}><Plus className="h-4 w-4" />新建子 Agent</Button>
        </div>
      ) : null}

      <SubAgentEditorDialog state={editor} busy={busy} onChange={setEditor} onClose={() => setEditor(null)} onSubmit={saveEditor} />
      <DeleteDialog item={deleteTarget} busy={busy} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (!deleteTarget) return; void run(async () => { await deleteAgentSubtaskRequest(deleteTarget.id); setDeleteTarget(null); await refresh() }) }} />
      <LogsDialog logs={logs} onClose={() => setLogs(null)} />
    </section>
  )
}
