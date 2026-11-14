import { useId, useRef, useState } from 'react'
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
import {
  AGENT_PERSONALIZATION_LIMITS,
  type AgentPersonalizationPayload,
  type AgentPersonalizationRule,
  type InterpretedAgentPersonalizationRule,
} from '../../../../shared/contracts/agent-personalization.js'
import {
  fetchPersonalizationRuleOperations,
  interpretPersonalizationRule,
  personalizationRuleOperationsQueryKey,
} from '../personalization-api'
import { PersonalizationDialog, PersonalizationFeedback, PersonalizationGroup } from './personalization-ui'

const permissionLabels: Record<AgentPersonalizationRule['permission'], string> = {
  allow: '无需询问', ask: '先询问我', deny: '不允许',
}

type RuleDraft = {
  originalToolName?: string
  revision: number
  text: string
  preview?: InterpretedAgentPersonalizationRule
  error?: string
}

type RuleRemoval = { toolName: string; revision: number; error?: string }

function ruleSentence(title: string, permission: AgentPersonalizationRule['permission']) {
  if (permission === 'ask') return title + '前，先问我。'
  return (permission === 'allow' ? '可以直接' : '不要') + title + '。'
}

export default function PersonalizationRuleSettings({ owner, saved, disabled, busy, onSave, onDelete }: {
  owner: string
  saved: AgentPersonalizationPayload
  disabled: boolean
  busy: boolean
  onSave: (rule: InterpretedAgentPersonalizationRule & { text: string }, revision: number, originalToolName?: string) => Promise<void>
  onDelete: (toolName: string, revision: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [removal, setRemoval] = useState<RuleRemoval | null>(null)
  const [interpreting, setInterpreting] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const operations = useQuery({
    queryKey: personalizationRuleOperationsQueryKey(owner),
    queryFn: ({ signal }) => fetchPersonalizationRuleOperations(owner, signal),
    enabled: open && saved.rules.length > 0,
  })
  const manageButton = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const doneButton = useRef<HTMLButtonElement>(null)
  const actionTrigger = useRef<HTMLButtonElement | null>(null)
  const editorId = useId()
  const titles = new Map(operations.data?.map(operation => [operation.toolName, operation.title]))
  const titleFor = (name: string) => titles.get(name) ?? name
  const original = saved.rules.find(rule => rule.toolName === draft?.originalToolName)
  const missing = Boolean(draft?.originalToolName && !original)
  const stale = Boolean(draft && draft.revision !== saved.revision)
  const duplicate = Boolean(draft?.preview && draft.preview.toolName !== draft.originalToolName
    && saved.rules.some(rule => rule.toolName === draft.preview?.toolName))
  const text = draft?.text.trim() ?? ''

  function managerFocus() {
    const trigger = actionTrigger.current
    return trigger?.isConnected && !trigger.disabled ? trigger : (addButton.current?.disabled ? doneButton.current : addButton.current)
  }

  function showEditor(trigger: HTMLButtonElement, rule?: AgentPersonalizationRule) {
    actionTrigger.current = trigger
    setFeedback(null)
    setDraft({
      text: rule ? (rule.text || ruleSentence(titleFor(rule.toolName), rule.permission)) : '',
      originalToolName: rule?.toolName,
      revision: saved.revision,
    })
  }

  async function submitRule() {
    if (!draft || disabled || interpreting || !text || stale || missing || duplicate) return
    if (!draft.preview) {
      setInterpreting(true)
      try {
        const preview = await interpretPersonalizationRule(owner, text)
        setDraft(current => current === draft ? { ...current, preview, error: undefined } : current)
      } catch (error) {
        const message = error instanceof Error ? error.message : '规则识别失败，请重试。'
        setDraft(current => current === draft ? { ...current, error: message } : current)
      } finally {
        setInterpreting(false)
      }
      return
    }
    try {
      await onSave({ ...draft.preview, text }, draft.revision, draft.originalToolName)
      setDraft(null)
      setFeedback({ text: '已保存自定义规则。' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存规则失败，请重试。'
      setDraft({ ...draft, preview: undefined, error: message })
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
    <button type="button" ref={manageButton} aria-haspopup="dialog" onClick={() => { setFeedback(null); setOpen(true) }} className="studio-settings-row studio-settings-row-link spacious">
      <span className="studio-settings-row-copy">
        <span className="studio-settings-row-title">自定义规则</span>
        <span className="studio-settings-description">写下 Agent 可以直接执行、需要询问或不允许的操作。</span>
      </span>
      <span className="studio-settings-rule-count">{saved.rules.length}</span>
      <ChevronRight aria-hidden="true" strokeWidth={1.6} className="studio-settings-arrow" />
    </button>
    {open ? (
      <PersonalizationDialog title="自定义规则" kind="manager" busy={busy} onClose={() => setOpen(false)} returnFocus={() => manageButton.current}
        toolbar={<>
          <span title="规则在整个创作区生效。平台要求的确认仍然适用。">在整个创作区生效</span>
          <button type="button" className="studio-settings-button" ref={addButton} disabled={disabled} onClick={event => showEditor(event.currentTarget)}>
            <Plus strokeWidth={1.6} aria-hidden="true" />添加规则
          </button>
        </>}
        footer={<button type="button" className="studio-settings-button" ref={doneButton} disabled={busy} onClick={() => setOpen(false)}>完成</button>}>
        {saved.rules.length > 0 ? (
          <ul aria-label="规则列表">
            {saved.rules.map(rule => {
              const title = titleFor(rule.toolName)
              return <li key={rule.toolName} className="studio-settings-item">
                <div className="studio-settings-rule-text">
                  <strong className="whitespace-pre-wrap">{rule.text || title}</strong>
                  <small>{rule.text ? title + ' · ' : ''}{permissionLabels[rule.permission]}</small>
                </div>
                <div className="studio-settings-actions">
                  <button type="button" className="studio-settings-icon-button" title="编辑规则" aria-label={'编辑规则：' + title} disabled={disabled} onClick={event => showEditor(event.currentTarget, rule)}>
                    <Pencil strokeWidth={1.6} aria-hidden="true" />
                  </button>
                  <button type="button" className="studio-settings-icon-button" title="删除规则" aria-label={'删除规则：' + title} disabled={disabled} onClick={event => {
                    actionTrigger.current = event.currentTarget
                    setFeedback(null)
                    setRemoval({ toolName: rule.toolName, revision: saved.revision })
                  }}><Trash2 strokeWidth={1.6} aria-hidden="true" /></button>
                </div>
              </li>
            })}
          </ul>
        ) : <p className="studio-settings-empty">还没有自定义规则</p>}
        {feedback ? <PersonalizationFeedback error={feedback.error}>{feedback.text}</PersonalizationFeedback> : null}
        {disabled && !busy ? <PersonalizationFeedback error>个性化设置加载失败，请关闭规则管理后重试加载设置。</PersonalizationFeedback> : null}
      </PersonalizationDialog>
    ) : null}
    {draft ? (
      <PersonalizationDialog title={draft.originalToolName ? '编辑规则' : '添加规则'} busy={busy || interpreting}
        onClose={() => setDraft(null)} returnFocus={managerFocus}
        footer={<>
          <button type="button" className="studio-settings-button" disabled={busy || interpreting} onClick={() => setDraft(null)}>取消</button>
          <button type="submit" form={editorId} className="studio-settings-button primary"
            disabled={disabled || interpreting || !text || stale || missing || duplicate}>
            {busy ? '保存中…' : interpreting ? '正在识别…' : draft.preview ? '保存' : '预览规则'}
          </button>
        </>}>
        <form id={editorId} onSubmit={event => { event.preventDefault(); void submitRule() }}>
          <label className="studio-settings-form-label" htmlFor={editorId + '-text'}>规则内容</label>
          <textarea id={editorId + '-text'} className="studio-settings-field" rows={3}
            placeholder="例如：修改正文片段前，先问我。"
            data-personalization-focus disabled={busy || interpreting} maxLength={AGENT_PERSONALIZATION_LIMITS.ruleText}
            value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value, preview: undefined, error: undefined })} />
          {draft.preview && !stale ? <div role="status" className="studio-settings-rule-preview">
            <p>{draft.preview.title} · {permissionLabels[draft.preview.permission]}</p>
            {original && original.toolName !== draft.preview.toolName ? <p className="mt-1 text-[var(--studio-settings-muted)]">
              将替换「{titleFor(original.toolName)}」的旧规则。
            </p> : null}
          </div> : null}
          {duplicate ? <PersonalizationFeedback error>这项操作已有规则，请编辑已有规则。</PersonalizationFeedback> : null}
          {missing ? <PersonalizationFeedback error>原规则已删除。你可以复制这段草稿，另建一条规则。</PersonalizationFeedback> : null}
          {draft.error ? <PersonalizationFeedback error>{draft.error}</PersonalizationFeedback> : null}
          {!missing && stale ? <div className="mt-3 space-y-2">
            <p>个性化设置已更新。{original ? '原规则：' + (original.text || ruleSentence(titleFor(original.toolName), original.permission)) : ''}</p>
            <button type="button" className="studio-settings-button" disabled={disabled} onClick={() => setDraft({ ...draft, revision: saved.revision, preview: undefined, error: undefined })}>已核对，继续编辑</button>
          </div> : null}
        </form>
      </PersonalizationDialog>
    ) : null}
    {removal ? (
      <PersonalizationDialog title="删除这条规则？" kind="confirm" busy={busy} onClose={() => setRemoval(null)} returnFocus={managerFocus}
        footer={<>
          <button type="button" className="studio-settings-button" data-personalization-focus disabled={busy} onClick={() => setRemoval(null)}>取消</button>
          <button type="button" className="studio-settings-button danger" disabled={disabled} onClick={() => void removeRule()}>{busy ? '删除中…' : '删除规则'}</button>
        </>}>
        <div className="space-y-3">
          <p className="[overflow-wrap:anywhere]">「{titleFor(removal.toolName)}」将恢复默认处理方式。</p>
          {removal.error ? <PersonalizationFeedback error>{removal.error}</PersonalizationFeedback> : null}
        </div>
      </PersonalizationDialog>
    ) : null}
  </PersonalizationGroup>
}
