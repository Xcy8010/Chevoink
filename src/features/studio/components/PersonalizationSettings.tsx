import { useState, type FormEvent } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import { AGENT_PERSONALIZATION_LIMITS, type AgentPersonalizationSettings } from '../../../../shared/contracts/agent-personalization.js'
import { fetchPersonalizationSettings, patchPersonalizationSettings, personalizationSettingsQueryKey } from '../personalization-api'
import PersonalizationMemorySettings from './PersonalizationMemorySettings'

const STYLE_LABELS: Record<AgentPersonalizationSettings['style'], string> = {
  natural: '自然', professional: '专业', direct: '直率', partner: '创作搭档',
}

const DEGREES = [
  { field: 'warmth', label: '亲切程度', options: { less: '克制', default: '默认', more: '更亲切' } },
  { field: 'enthusiasm', label: '热情程度', options: { less: '平稳', default: '默认', more: '更积极' } },
  { field: 'detail', label: '回答详略', options: { less: '简短', default: '默认', more: '详细' } },
  { field: 'emoji', label: '表情符号', options: { less: '少量', default: '默认', more: '多用' } },
  { field: 'format', label: '标题与列表', options: { less: '少用', default: '默认', more: '多用' } },
] as const

const STYLE_SAMPLE: Record<AgentPersonalizationSettings['style'], string> = {
  natural: '可以开头就让主角听见门后的动静，读者会更想接着读。',
  professional: '建议把门后的声响提前到开场，以便更早建立悬念。',
  direct: '把门后的声响放到开头，先让读者产生疑问。',
  partner: '我们试试让主角开头就听见门后的动静，把读者一起拉到门外。',
}

type SettingsChanges = Partial<Omit<AgentPersonalizationSettings, 'memoryEnabled'>>
type SettingsDraft = { revision: number; changes: SettingsChanges }
type SettingsUpdate = { revision: number; changes: Partial<AgentPersonalizationSettings> }

const fieldClass = 'w-full min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50'

function StylePreview({ value }: { value: AgentPersonalizationSettings }) {
  const name = value.preferredName.trim()
  const greeting = {
    less: '',
    default: '说说这一幕的开头。',
    more: `${name ? `${name}，` : ''}我们一起看看怎么让这一幕更抓人。`,
  }[value.warmth]
  const opening = value.enthusiasm === 'more' ? '这一幕很有张力！' : value.enthusiasm === 'default' ? '这个开场有潜力。' : ''
  const suggestion = STYLE_SAMPLE[value.style]
  const explanation = value.detail === 'less' ? '' : '先写主角听见了什么，再写主角的反应。'
  const example = value.detail === 'more' ? '例如：门后传来一声轻响，她停住了，钥匙还抵在锁眼上。' : ''
  const emoji = value.emoji === 'more' ? ' ✨📝' : value.emoji === 'default' ? ' ✨' : ''

  return (
    <div className="min-w-0 space-y-2 rounded-xl bg-[var(--surface-muted)] p-4 text-sm leading-6 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
      <h4 className="font-medium text-[var(--text-primary)]">风格预览</h4>
      {value.format === 'more' ? (
        <>
          {greeting || opening ? <p>{greeting}{opening}{emoji}</p> : null}
          <p className="font-medium text-[var(--text-primary)]">开场建议</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{suggestion}{!greeting && !opening ? emoji : ''}</li>
            {explanation ? <li>{explanation}</li> : null}
          </ul>
          {example ? <p>{example}</p> : null}
        </>
      ) : value.format === 'less' ? (
        <p>{greeting}{opening}{suggestion}{explanation}{example}{emoji}</p>
      ) : (
        <>
          <p>{greeting}{opening}{suggestion}{emoji}</p>
          {explanation ? <p>{explanation}{example}</p> : null}
        </>
      )}
    </div>
  )
}

export default function PersonalizationSettings() {
  const authStatus = useShellStore(state => state.authStatus)
  const owner = useShellStore(state => state.sessionUser?.id)
  if (authStatus === 'checking') return <p role="status" className="text-sm text-[var(--text-secondary)]">正在加载个性化设置…</p>
  if (authStatus !== 'authenticated' || !owner) {
    return <p role="status" className="text-sm text-[var(--text-secondary)]">登录后可管理个性化设置。</p>
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
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [updateMessage, setUpdateMessage] = useState<{ text: string; error: boolean } | null>(null)
  const { mutateAsync } = useMutation({
    mutationKey: queryKey,
    mutationFn: async ({ revision, changes }: SettingsUpdate) => {
      await client.cancelQueries({ queryKey })
      const saved = await patchPersonalizationSettings(owner, revision, changes)
      if (useShellStore.getState().sessionUser?.id === owner) {
        client.setQueryData<typeof saved>(queryKey, current => current && current.revision > saved.revision ? current : saved)
      }
      return saved
    },
    onSettled: async () => {
      if (useShellStore.getState().sessionUser?.id === owner) await client.invalidateQueries({ queryKey })
    },
  })
  const busy = useIsMutating({ mutationKey: queryKey }) > 0
  const saved = settings.data
  const value = saved ? { ...saved.settings, ...draft?.changes } : null

  function change<K extends keyof SettingsChanges>(field: K, next: AgentPersonalizationSettings[K]) {
    if (!saved || busy) return
    setUpdateMessage(null)
    setDraft(current => {
      const changes = { ...current?.changes, [field]: next }
      if (next === saved.settings[field]) delete changes[field]
      return Object.keys(changes).length > 0 ? { changes, revision: current?.revision ?? saved.revision } : null
    })
  }

  async function update({ revision, changes }: SettingsUpdate) {
    setUpdateMessage(null)
    try {
      const result = await mutateAsync({ revision, changes })
      if (changes.memoryEnabled === undefined) {
        setDraft(null)
      } else {
        setDraft(current => current?.revision === revision ? { ...current, revision: result.revision } : current)
      }
      setUpdateMessage({ text: changes.memoryEnabled === undefined ? '已保存个性化设置。' : (result.settings.memoryEnabled ? '已开启全局记忆。' : '已关闭全局记忆。'), error: false })
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        const refreshed = client.getQueryState<typeof saved>(queryKey)
        if (refreshed?.status === 'success' && refreshed.data) {
          const nextRevision = refreshed.data.revision
          setDraft(current => current ? { ...current, revision: nextRevision } : current)
          setUpdateMessage({ text: '已刷新最新设置，请核对后重试。', error: true })
          return
        }
      }
      setUpdateMessage({ text: error instanceof Error ? error.message : '保存失败，请重试。', error: true })
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (draft && !busy) void update(draft)
  }

  return (
    <div className="max-w-[680px] space-y-8">
      {settings.isPending ? <p role="status" className="text-sm text-[var(--text-secondary)]">正在加载个性化设置…</p> : null}
      {settings.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-rose-500">个性化设置加载失败。</p>
          <Button size="sm" variant="ghost" disabled={settings.isFetching} onClick={() => void settings.refetch()}>重试加载设置</Button>
        </div>
      ) : null}
      {value ? (
        <form onSubmit={save} className="space-y-7">
          <fieldset disabled={busy} className="min-w-0 space-y-4 border-b border-[var(--border-subtle)] pb-6">
            <legend className="mb-2 text-sm font-semibold text-[var(--text-primary)]">关于你</legend>
            <p className="text-xs text-[var(--text-secondary)]">这些信息仅用于你的 Agent 对话。</p>
            <label className="block space-y-2 text-sm">
              <span className="font-medium">希望 Agent 如何称呼你</span>
              <input className={fieldClass} value={value.preferredName} maxLength={AGENT_PERSONALIZATION_LIMITS.preferredName} onChange={event => change('preferredName', event.target.value)} />
            </label>
            <label className="block space-y-2 text-sm">
              <span className="font-medium">希望 Agent 了解的创作背景</span>
              <textarea className={cn(fieldClass, 'resize-y')} rows={3} value={value.aboutMe} maxLength={AGENT_PERSONALIZATION_LIMITS.aboutMe} onChange={event => change('aboutMe', event.target.value)} />
            </label>
          </fieldset>

          <fieldset disabled={busy} className="min-w-0 space-y-4 border-b border-[var(--border-subtle)] pb-6">
            <legend className="mb-2 text-sm font-semibold text-[var(--text-primary)]">交流风格</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <label className="min-w-0 space-y-2 text-sm">
                <span className="font-medium">基础风格</span>
                <select className={fieldClass} value={value.style} onChange={event => change('style', event.target.value as AgentPersonalizationSettings['style'])}>
                  {Object.entries(STYLE_LABELS).map(([option, label]) => <option key={option} value={option}>{label}</option>)}
                </select>
              </label>
              {DEGREES.map(({ field, label, options }) => (
                <label key={field} className="min-w-0 space-y-2 text-sm">
                  <span className="font-medium">{label}</span>
                  <select className={fieldClass} value={value[field]} onChange={event => change(field, event.target.value as AgentPersonalizationSettings[typeof field])}>
                    {Object.entries(options).map(([option, text]) => <option key={option} value={option}>{text}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <StylePreview value={value} />
          </fieldset>

          <label className="block space-y-2 text-sm">
            <span className="font-semibold">自定义指令</span>
            <textarea disabled={busy} className={cn(fieldClass, 'resize-y')} rows={4} value={value.customInstructions} maxLength={AGENT_PERSONALIZATION_LIMITS.customInstructions} onChange={event => change('customInstructions', event.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!draft || busy}>{busy && draft ? '保存中…' : '保存设置'}</Button>
            {updateMessage ? <p role={updateMessage.error ? 'alert' : 'status'} className={cn('text-sm', updateMessage.error ? 'text-rose-500' : 'text-[var(--text-secondary)]')}>{updateMessage.text}</p> : null}
          </div>
        </form>
      ) : null}

      <PersonalizationMemorySettings
        owner={owner}
        memoryEnabled={saved?.settings.memoryEnabled}
        settingBusy={busy}
        onToggle={enabled => { if (saved && !busy) void update({ revision: saved.revision, changes: { memoryEnabled: enabled } }) }}
      />
    </div>
  )
}
