import { useId, useRef, useState } from 'react'
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { AgentPersonalizationPayload, AgentPersonalizationRule } from '../../../../shared/contracts/agent-personalization.js'
import { fetchPersonalizationRuleOperations, personalizationRuleOperationsQueryKey } from '../personalization-api'
import { PersonalizationDialog, PersonalizationFeedback, PersonalizationGroup, personalizationField, personalizationRow } from './personalization-ui'

const permissionLabels: Record<AgentPersonalizationRule['permission'], string> = {
  allow: '无需询问', ask: '先询问我', deny: '不允许',
}

type RuleDraft = {
  rule: AgentPersonalizationRule
  revision: number
  editing: boolean
  error?: string
}

type RuleRemoval = { toolName: string; revision: number; error?: string }

export default function PersonalizationRuleSettings({ owner, saved, disabled, busy, onSave, onDelete }: {
  owner: string
  saved: AgentPersonalizationPayload
  disabled: boolean
  busy: boolean
  onSave: (rule: AgentPersonalizationRule, revision: number) => Promise<void>
  onDelete: (toolName: string, revision: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [removal, setRemoval] = useState<RuleRemoval | null>(null)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const operations = useQuery({
    queryKey: personalizationRuleOperationsQueryKey(owner),
    queryFn: ({ signal }) => fetchPersonalizationRuleOperations(owner, signal),
    enabled: open,
  })
  const manageButton = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const doneButton = useRef<HTMLButtonElement>(null)
  const actionTrigger = useRef<HTMLButtonElement | null>(null)
  const editorId = useId()
  const titles = new Map(operations.data?.map(operation => [operation.toolName, operation.title]))
  const rulesByTool = new Map(saved.rules.map(rule => [rule.toolName, rule]))
  const available = operations.data?.filter(operation => !rulesByTool.has(operation.toolName)) ?? []
  const activeRule = draft && rulesByTool.get(draft.rule.toolName)
  const ruleUnavailable = Boolean(draft && (draft.editing ? !activeRule : activeRule))
  const formChanged = draft?.rule.permission !== activeRule?.permission

  function managerFocus() {
    const trigger = actionTrigger.current
    return trigger?.isConnected && !trigger.disabled ? trigger : (addButton.current?.disabled ? doneButton.current : addButton.current)
  }

  function showEditor(trigger: HTMLButtonElement, rule: AgentPersonalizationRule, editing: boolean) {
    actionTrigger.current = trigger
    setFeedback(null)
    setDraft({ rule, revision: saved.revision, editing })
  }

  async function saveRule() {
    if (!draft || disabled || !draft.rule.toolName || ruleUnavailable || !formChanged) return
    try {
      await onSave(draft.rule, draft.revision)
      setDraft(null)
      setFeedback({ text: '已保存自定义规则。' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存规则失败，请重试。'
      setDraft({ ...draft, error: message })
    }
  }

  async function removeRule() {
    if (!removal || disabled) return
    try {
      await onDelete(removal.toolName, removal.revision)
      setRemoval(null)
      setFeedback({ text: '已删除自定义规则。' })
    } catch (error) {
      const text = error instanceof Error ? error.message : '删除规则失败，请重试。'
      if (error instanceof ApiClientError && (error.status === 409 || error.status === 404)) {
        setRemoval(null)
        setFeedback({ text, error: true })
      } else {
        setRemoval({ ...removal, error: text })
      }
    }
  }

  return <PersonalizationGroup title="权限">
    <button type="button" ref={manageButton} aria-haspopup="dialog" onClick={() => { setFeedback(null); setOpen(true) }} className={cn(personalizationRow, 'min-h-[4.5rem] rounded-2xl text-left hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]')}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">自定义规则</span>
        <span className="mt-1 block text-xs text-[var(--text-secondary)]">为 Agent 操作设置执行方式。</span>
      </span>
      <span className="shrink-0 text-xs text-[var(--text-secondary)]">{saved.rules.length} 条</span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--text-secondary)]" />
    </button>
    {open ? (
      <PersonalizationDialog title="自定义规则" wide busy={busy} onClose={() => setOpen(false)} returnFocus={() => manageButton.current}
        footer={<Button ref={doneButton} size="sm" className="min-h-11" disabled={busy} onClick={() => setOpen(false)}>完成</Button>}>
        <div className="space-y-3">
          <p className="text-xs leading-5 text-[var(--text-secondary)]">规则在所有创作对话中生效。平台限制、数据访问权限和平台要求的确认仍然适用。</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{saved.rules.length} 条规则</span>
            <Button ref={addButton} size="sm" className="min-h-11" disabled={disabled || operations.isError || available.length === 0} onClick={event => {
              showEditor(event.currentTarget, { toolName: '', permission: 'ask' }, false)
            }}><Plus className="size-4" aria-hidden="true" />添加规则</Button>
          </div>
          {operations.isPending ? <PersonalizationFeedback>正在加载可选操作…</PersonalizationFeedback> : null}
          {operations.isError ? <div className="flex flex-wrap items-center gap-2">
            <PersonalizationFeedback error>可选操作加载失败。</PersonalizationFeedback>
            <Button size="sm" variant="ghost" disabled={operations.isFetching || busy} onClick={() => void operations.refetch()}>重试加载操作</Button>
          </div> : null}
          {operations.isSuccess && available.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">所有可选操作都已有规则。</p> : null}
          {saved.rules.length > 0 ? (
            <ul aria-label="规则列表" className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
              {saved.rules.map(rule => {
                const title = titles.get(rule.toolName) ?? rule.toolName
                return <li key={rule.toolName} className="flex min-w-0 items-start gap-1 py-2.5">
                  <div className="min-w-0 flex-1 py-1.5">
                    <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">{permissionLabels[rule.permission]}</p>
                  </div>
                  <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title="编辑规则" aria-label={`编辑规则：${title}`} disabled={disabled} onClick={event => showEditor(event.currentTarget, rule, true)}>
                    <Pencil className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" className="h-11 w-11 shrink-0 px-0" title="删除规则" aria-label={`删除规则：${title}`} disabled={disabled} onClick={event => {
                    actionTrigger.current = event.currentTarget
                    setFeedback(null)
                    setRemoval({ toolName: rule.toolName, revision: saved.revision })
                  }}><Trash2 className="size-4" aria-hidden="true" /></Button>
                </li>
              })}
            </ul>
          ) : <p className="py-6 text-center text-sm text-[var(--text-secondary)]">还没有自定义规则。</p>}
          {feedback ? <PersonalizationFeedback error={feedback.error}>{feedback.text}</PersonalizationFeedback> : null}
          {disabled && !busy ? <PersonalizationFeedback error>个性化设置加载失败，请关闭规则管理后重试加载设置。</PersonalizationFeedback> : null}
        </div>
      </PersonalizationDialog>
    ) : null}
    {draft ? (
      <PersonalizationDialog title={draft.editing ? '编辑规则' : '添加规则'} busy={busy} onClose={() => setDraft(null)} returnFocus={managerFocus}
        footer={<>
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>取消</Button>
          <Button type="submit" form={editorId} variant="primary" disabled={disabled || !draft.rule.toolName || ruleUnavailable || !formChanged || draft.revision !== saved.revision}>{busy ? '保存中…' : '保存'}</Button>
        </>}>
        <form id={editorId} className="space-y-3" onSubmit={event => { event.preventDefault(); if (draft.revision === saved.revision) void saveRule() }}>
          {draft.editing ? <div className="space-y-2 text-sm"><p className="font-medium">操作</p><p className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{titles.get(draft.rule.toolName) ?? draft.rule.toolName}</p></div> : (
            <label className="block space-y-2 text-sm">
              <span className="font-medium">操作</span>
              <select className={cn(personalizationField, 'w-full')} disabled={busy} data-personalization-focus value={draft.rule.toolName} onChange={event => setDraft({ ...draft, rule: { ...draft.rule, toolName: event.target.value }, error: undefined })}>
                <option value="" disabled>请选择操作</option>
                {ruleUnavailable ? <option value={draft.rule.toolName}>{titles.get(draft.rule.toolName)}（已有规则）</option> : null}
                {available.map(operation => <option key={operation.toolName} value={operation.toolName}>{operation.title}</option>)}
              </select>
            </label>
          )}
          <label className="block space-y-2 text-sm">
            <span className="font-medium">执行方式</span>
            <select className={cn(personalizationField, 'w-full')} disabled={busy} data-personalization-focus={draft.editing ? '' : undefined} value={draft.rule.permission} onChange={event => {
              setDraft({ ...draft, rule: { ...draft.rule, permission: event.target.value as AgentPersonalizationRule['permission'] }, error: undefined })
            }}>
              {Object.entries(permissionLabels).map(([permission, label]) => <option key={permission} value={permission}>{label}</option>)}
            </select>
          </label>
          {ruleUnavailable ? <PersonalizationFeedback error>{draft.editing ? '这条规则已删除。' : '此操作已有规则，请选择其他操作或编辑已有规则。'}</PersonalizationFeedback> : null}
          {draft.error ? <PersonalizationFeedback error>{draft.error}</PersonalizationFeedback> : null}
          {!ruleUnavailable && draft.revision !== saved.revision ? (
            <div className="space-y-2 text-sm">
              <p>个性化设置已更新。{activeRule ? `此操作当前的执行方式为「${permissionLabels[activeRule.permission]}」。` : ''}</p>
              <Button size="sm" disabled={disabled} onClick={() => setDraft({ ...draft, revision: saved.revision, error: undefined })}>已核对，继续编辑</Button>
            </div>
          ) : null}
        </form>
      </PersonalizationDialog>
    ) : null}
    {removal ? (
      <PersonalizationDialog title="删除这条规则？" busy={busy} onClose={() => setRemoval(null)} returnFocus={managerFocus}
        footer={<>
          <Button variant="ghost" data-personalization-focus disabled={busy} onClick={() => setRemoval(null)}>取消</Button>
          <Button variant="primary" className="bg-rose-700 text-white hover:bg-rose-800" disabled={disabled} onClick={() => void removeRule()}>{busy ? '删除中…' : '删除规则'}</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)] [overflow-wrap:anywhere]">「{titles.get(removal.toolName) ?? removal.toolName}」将恢复默认处理方式。</p>
          {removal.error ? <PersonalizationFeedback error>{removal.error}</PersonalizationFeedback> : null}
        </div>
      </PersonalizationDialog>
    ) : null}
  </PersonalizationGroup>
}
