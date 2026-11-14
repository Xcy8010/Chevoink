import { useId, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import {
  AGENT_PERSONALIZATION_LIMITS,
  type AgentPersonalizationPayload,
  type AgentPersonalizationRule,
  type AgentPersonalizationSettings,
} from '../../../../shared/contracts/agent-personalization.js'
import {
  deletePersonalizationRule,
  fetchPersonalizationSettings,
  isPersonalizationAccount,
  patchPersonalizationSettings,
  personalizationSettingsQueryKey,
  putPersonalizationRule,
} from '../personalization-api'
import PersonalizationMemorySettings from './PersonalizationMemorySettings'
import PersonalizationRuleSettings from './PersonalizationRuleSettings'
import { PersonalizationDialog, PersonalizationFeedback, PersonalizationGroup, personalizationField, personalizationRow } from './personalization-ui'

const STYLE_LABELS: Record<AgentPersonalizationSettings['style'], string> = {
  natural: '默认', professional: '专业', direct: '直率', partner: '创作搭档',
}

const STYLE_FIELDS = [
  { field: 'style', label: '基础风格和语气', options: STYLE_LABELS },
  { field: 'warmth', label: '亲切程度', options: { less: '克制', default: '默认', more: '更亲切' } },
  { field: 'enthusiasm', label: '热情程度', options: { less: '平稳', default: '默认', more: '更积极' } },
  { field: 'detail', label: '回答详略', options: { less: '简短', default: '默认', more: '详细' } },
  { field: 'emoji', label: '表情符号', options: { less: '少量', default: '默认', more: '多用' } },
  { field: 'format', label: '标题与列表', options: { less: '少用', default: '默认', more: '多用' } },
] as const

type SettingsChanges = Partial<AgentPersonalizationSettings>
type SettingsAction = { revision: number } & (
  | { kind: 'settings'; changes: SettingsChanges }
  | { kind: 'put-rule'; rule: AgentPersonalizationRule }
  | { kind: 'delete-rule'; toolName: string }
)

export default function PersonalizationSettings() {
  const authStatus = useShellStore(state => state.authStatus)
  const owner = useShellStore(state => state.sessionUser?.id)
  if (authStatus === 'checking') return <PersonalizationFeedback>正在加载个性化设置…</PersonalizationFeedback>
  if (authStatus !== 'authenticated' || !owner) {
    return <PersonalizationFeedback>登录后可管理个性化设置。</PersonalizationFeedback>
  }
  return <AccountPersonalizationSettings key={owner} owner={owner} />
}

function AccountPersonalizationSettings({ owner }: { owner: string }) {
  const client = useQueryClient()
  const queryKey = personalizationSettingsQueryKey(owner)
  const settings = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchPersonalizationSettings(owner, signal),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const { mutateAsync } = useMutation({
    mutationKey: queryKey,
    mutationFn: async (action: SettingsAction) => {
      await client.cancelQueries({ queryKey })
      let saved: AgentPersonalizationPayload
      switch (action.kind) {
        case 'settings':
          saved = await patchPersonalizationSettings(owner, action.revision, action.changes)
          break
        case 'put-rule':
          saved = await putPersonalizationRule(owner, action.revision, action.rule)
          break
        case 'delete-rule':
          saved = await deletePersonalizationRule(owner, action.revision, action.toolName)
          break
      }
      if (isPersonalizationAccount(owner)) {
        client.setQueryData<AgentPersonalizationPayload>(queryKey, current => current && current.revision > saved.revision ? current : saved)
      }
    },
    onSettled: async () => {
      if (isPersonalizationAccount(owner)) await client.invalidateQueries({ queryKey })
    },
  })
  const busy = useIsMutating({ mutationKey: queryKey }) > 0
  const saved = settings.data
  const disabled = busy || settings.isError || !saved
  const [feedback, setFeedback] = useState<{ message: string; retry?: SettingsChanges } | null>(null)
  const [draft, setDraft] = useState<{ text: string; revision: number; error?: string } | null>(null)
  const replyButton = useRef<HTMLButtonElement>(null)
  const replyId = useId()
  const replyStale = Boolean(draft && saved && draft.revision !== saved.revision)

  async function updateImmediate(changes: SettingsChanges) {
    if (!saved || disabled) return
    setFeedback(null)
    try {
      await mutateAsync({ kind: 'settings', revision: saved.revision, changes })
      setFeedback({ message: '已保存个性化设置。' })
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : '保存失败，请重试。', retry: changes })
    }
  }

  async function saveReply() {
    if (!draft || !saved || disabled || replyStale || draft.text.trim() === saved.settings.customInstructions) return
    try {
      await mutateAsync({ kind: 'settings', revision: draft.revision, changes: { customInstructions: draft.text.trim() } })
      setDraft(null)
      setFeedback({ message: '已保存回答偏好。' })
    } catch (error) {
      const message = error instanceof ApiClientError && error.status === 409
        ? '回答偏好已更新。已保留草稿，请核对最新内容后重试。'
        : error instanceof Error ? error.message : '保存失败，请重试。'
      setDraft({ ...draft, error: message })
    }
  }

  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      {settings.isPending ? <PersonalizationFeedback>正在加载个性化设置…</PersonalizationFeedback> : null}
      {settings.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <PersonalizationFeedback error>个性化设置加载失败。</PersonalizationFeedback>
          <Button size="sm" variant="ghost" disabled={settings.isFetching || busy} onClick={() => void settings.refetch()}>重试加载设置</Button>
        </div>
      ) : null}
      <PersonalizationMemorySettings
        owner={owner}
        memoryEnabled={saved?.settings.memoryEnabled}
        settingBusy={disabled}
        onToggle={enabled => void updateImmediate({ memoryEnabled: enabled })}
      />
      {saved ? <>
        <PersonalizationGroup title="风格与语气">
          {STYLE_FIELDS.map(({ field, label, options }) => (
            <label key={field} className={cn(personalizationRow, 'text-sm font-medium')}>
              {label}
              <select
                className={cn(personalizationField, 'w-[7.5rem] shrink-0 font-normal')}
                value={saved.settings[field]}
                disabled={disabled}
                onChange={event => void updateImmediate({ [field]: event.target.value })}
              >
                {Object.entries(options).map(([option, text]) => <option key={option} value={option}>{text}</option>)}
              </select>
            </label>
          ))}
        </PersonalizationGroup>

        <PersonalizationRuleSettings
          owner={owner}
          saved={saved}
          disabled={disabled}
          busy={busy}
          onSave={(rule, revision) => mutateAsync({ kind: 'put-rule', rule, revision })}
          onDelete={(toolName, revision) => mutateAsync({ kind: 'delete-rule', toolName, revision })}
        />

        <PersonalizationGroup title="自定义指令">
          <button type="button" ref={replyButton} aria-haspopup="dialog" onClick={() => {
            setFeedback(null)
            setDraft({ text: saved.settings.customInstructions, revision: saved.revision })
          }} className={cn(personalizationRow, 'min-h-[4.5rem] rounded-2xl text-left hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]')}>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">回答偏好</span>
              <span className="mt-1 block truncate text-xs text-[var(--text-secondary)]">{saved.settings.customInstructions || '告诉 Agent，你希望它如何与你交流、协作。'}</span>
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--text-secondary)]" />
          </button>
        </PersonalizationGroup>
        {draft ? (
          <PersonalizationDialog title="回答偏好" busy={busy} onClose={() => setDraft(null)} returnFocus={() => replyButton.current}
            footer={<>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>取消</Button>
              <Button form={replyId} type="submit" variant="primary" disabled={disabled || replyStale || draft.text.trim() === saved.settings.customInstructions}>{busy ? '保存中…' : '保存'}</Button>
            </>}>
            <form id={replyId} className="space-y-3" onSubmit={event => { event.preventDefault(); void saveReply() }}>
              <label className="block space-y-2 text-sm">
                <span className="font-medium">自定义指令</span>
                <textarea className={cn(personalizationField, 'w-full resize-y text-base sm:text-sm')} rows={5} maxLength={AGENT_PERSONALIZATION_LIMITS.customInstructions}
                  data-personalization-focus disabled={busy} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} />
              </label>
              {replyStale ? (
                <div className="space-y-2 text-sm">
                  <p>个性化设置已更新。当前回答偏好：</p>
                  <p className="whitespace-pre-wrap text-[var(--text-secondary)] [overflow-wrap:anywhere]">{saved.settings.customInstructions || '尚未设置回答偏好。'}</p>
                  <Button size="sm" disabled={disabled} onClick={() => setDraft({ ...draft, revision: saved.revision, error: undefined })}>已核对，继续编辑</Button>
                </div>
              ) : null}
              {draft.error ? <PersonalizationFeedback error>{draft.error}</PersonalizationFeedback> : null}
            </form>
          </PersonalizationDialog>
        ) : null}
      </> : null}
      {busy && !draft ? <PersonalizationFeedback>正在保存个性化设置…</PersonalizationFeedback> : null}
      {feedback ? <div className="flex flex-wrap items-center gap-2">
        <PersonalizationFeedback error={Boolean(feedback.retry)}>{feedback.message}</PersonalizationFeedback>
        {feedback.retry ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {
          if (feedback.retry) void updateImmediate(feedback.retry)
        }}>重试保存</Button> : null}
      </div> : null}
    </div>
  )
}
