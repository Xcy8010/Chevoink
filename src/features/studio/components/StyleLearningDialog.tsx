import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, Plus, X } from 'lucide-react'
import type { StudioPayload, StyleSampleRequest } from '../../../../shared/contracts'
import { STYLE_DIMENSIONS, type ChangeStyleLearning, type StyleLearningView, type StyleModelSelection } from '../../../../shared/contracts/style-learning'
import { fetchCreditSummary, fetchCustomModels } from '@/features/account/credits-api'
import { extractAuthorStyleProfileApi, revokeAuthorStyleSourceApi } from '../api'
import { changeStyleLearningApi, getStyleSamples, getStyleWorkspace, startStyleLearningApi } from '../style-learning-api'
import StyleDnaDialog from './StyleDnaDialog'

const button = 'min-h-11 rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-xs transition-opacity hover:opacity-80 disabled:opacity-40'
const statuses: Record<string, string> = { queued: '等待学习', processing: '正在分析当前分段', analyzing: '校验分析依据', paused: '已暂停', interrupted: '需要处理', ready: '学习完成 · 待确认' }

function RuleEditor({ job, busy, onChange }: { job: StyleLearningView; busy: boolean; onChange: (input: ChangeStyleLearning) => void }) {
  const [rules, setRules] = useState(job.rules)
  useEffect(() => setRules(job.rules), [job.rules])
  const [retryConsent, setRetryConsent] = useState(false)
  return <section className="mt-4 space-y-3 border-t border-[var(--border-subtle)] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{job.enabled ? '已启用 · 后续写作自动使用' : statuses[job.status] ?? job.status}</h3><span className="text-xs text-[var(--text-secondary)]">{job.modelLabel}</span></div>
    <progress className="h-1.5 w-full" value={job.processed} max={job.total} aria-label="样章学习进度" />
    <p className="text-xs text-[var(--text-secondary)]">已保存 {job.processed}/{job.total} 段 · v{job.revision} {job.pauseRequested && job.status !== 'paused' ? '· 将在当前段保存后暂停' : ''}</p>
    {job.error ? <p role="alert" className="rounded-xl bg-[var(--surface-muted)] p-3 text-sm">{job.error}</p> : null}
    {['queued', 'processing', 'analyzing'].includes(job.status) ? <button className={button} disabled={busy || job.pauseRequested} onClick={() => onChange({ action: 'pause', revision: job.revision })}>暂停学习</button> : null}
    {job.status === 'paused' ? <button className={button} disabled={busy} onClick={() => onChange({ action: 'resume', revision: job.revision })}>从已保存进度继续</button> : null}
    {job.status === 'interrupted' ? <div><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={retryConsent} onChange={event => setRetryConsent(event.target.checked)} />我确认重新发送未完成段，供应商可能再次计费（不会重跑已完成段）。</label><button className={`${button} mt-2`} disabled={busy || !retryConsent} onClick={() => onChange({ action: 'retry', revision: job.revision, consent: true })}>重试当前段</button></div> : null}
    <details><summary className="min-h-11 cursor-pointer py-3 text-xs">逐段学习依据（{job.reports.length} 段）</summary><div className="scrollbar-none max-h-80 space-y-3 overflow-y-auto overscroll-contain">{job.reports.map(report => <div key={report.chunk} className="rounded-xl bg-[var(--surface-muted)] p-3"><h4 className="text-xs">第 {report.chunk} 段</h4>{report.rules.map((rule, i) => <div key={i} className="mt-3 text-xs"><p>{rule.dimension}：{rule.rule}</p><blockquote className="mt-1 border-l-2 pl-2 text-[var(--text-secondary)]">{rule.evidence}</blockquote></div>)}</div>)}</div></details>
    {job.status === 'ready' ? <>
      {!rules.length ? <p role="status" className="text-sm">没有可启用的规则。可添加更完整的样章重新学习；无需为凑齐维度编造结论。</p> : null}
      <p className="text-xs text-[var(--text-secondary)]">检查并修改规则，再确认启用。每次只启用一套风格；不覆盖人物设定或你当前的要求。局部分析不能保证全剧结构或成稿质量。</p>
      <div className="space-y-3">{rules.map((rule, i) => <div key={i} className="rounded-xl border border-[var(--border-subtle)] p-3"><div className="flex items-center justify-between"><label htmlFor={`style-rule-${i}`} className="text-xs">{rule.dimension}</label><button className="min-h-11 px-3 text-xs" disabled={busy} onClick={() => setRules(current => current.filter((_, index) => index !== i))}>移除</button></div><textarea id={`style-rule-${i}`} rows={2} maxLength={300} value={rule.rule} disabled={busy} onChange={event => setRules(current => current.map((item, index) => index === i ? { ...item, rule: event.target.value } : item))} className="w-full resize-y rounded-lg bg-[var(--surface-muted)] p-2 text-sm" /><p className="mt-2 text-xs text-[var(--text-secondary)]">依据：{rule.evidence}</p></div>)}</div>
      <button className={`${button} bg-[var(--surface-contrast)] text-[var(--text-contrast)]`} disabled={busy || !rules.length || rules.some(rule => !rule.rule.trim())} onClick={() => onChange({ action: 'enable', revision: job.revision, rules })}>{job.enabled ? '保存并应用修改' : '确认规则并启用'}</button>
      {job.enabled ? <button className={`${button} ml-2`} disabled={busy} onClick={() => onChange({ action: 'disable', revision: job.revision })}>停用</button> : null}
    </> : null}
  </section>
}

export default function StyleLearningDialog({ novelId, chapters = [], initialModel, onClose }: {
  novelId: string; chapters?: StudioPayload['chapters']; initialModel?: StyleModelSelection; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const [upload, setUpload] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [model, setModel] = useState<StyleModelSelection | undefined>(initialModel)
  const [consent, setConsent] = useState(false)
  const [preview, setPreview] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<{ key: string; id: string } | null>(null)
  const workspace = useQuery({ queryKey: ['studio', novelId, 'style-learning'], queryFn: () => getStyleWorkspace(novelId), retry: false, refetchInterval: query => query.state.data?.jobs.some(job => ['queued', 'processing', 'analyzing'].includes(job.status)) ? 2000 : false })
  const credits = useQuery({ queryKey: ['credits', 'summary'], queryFn: fetchCreditSummary })
  const custom = useQuery({ queryKey: ['credits', 'custom-models'], queryFn: fetchCustomModels })
  const sample = workspace.data?.samples.find(item => item.id === selectedId) ?? workspace.data?.samples[0]
  const activeStyle = workspace.data?.jobs.find(job => job.enabled)
  const samples = useQuery({ queryKey: ['studio', novelId, 'style-samples', sample?.id], queryFn: () => getStyleSamples(novelId, sample!.id), enabled: preview && Boolean(sample), retry: false })
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['studio', novelId, 'style-learning'] }); await queryClient.invalidateQueries({ queryKey: ['studio', novelId, 'style-profile'] }) }
  const mutation = useMutation({ mutationFn: (action: () => Promise<unknown>) => action(), onSuccess: async () => { setError(''); await refresh() }, onError: (cause: Error) => { setError(cause.message); void refresh() } })
  useEffect(() => {
    const node = dialog.current
    if (upload || !node) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    node.showModal()
    return () => { node.close(); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }) }
  }, [upload])
  const selectedModel = model?.modelTier === 'custom' ? custom.data?.models.find(item => item.id === model.customModelId) : credits.data?.models.find(item => item.tier === model?.modelTier)
  const efforts = selectedModel?.reasoningEfforts ?? []
  const modelLabel = model?.modelTier === 'custom' ? custom.data?.models.find(item => item.id === model.customModelId)?.displayName : credits.data?.models.find(item => item.tier === model?.modelTier)?.label
  const busy = mutation.isPending
  const start = () => {
    if (!sample || !model) return
    const key = JSON.stringify({ sample: sample.id, model })
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    const requestId = request.current.id
    mutation.mutate(async () => {
      const job = await startStyleLearningApi(novelId, { profileId: sample.id, model, consent: true, requestId })
      // Keep the same key on an uncertain network outcome; a confirmed response
      // ends this intent. Relearning requires a fresh explicit consent action.
      request.current = null
      setConsent(false)
      return job
    })
  }
  if (upload) return <StyleDnaDialog chapters={chapters} profile={null} busy={busy} onClose={() => setUpload(false)} onSubmit={(input: StyleSampleRequest) => mutation.mutate(async () => { const saved = await extractAuthorStyleProfileApi(novelId, input); setSelectedId(saved.profileId); setConsent(false); setUpload(false) })} error={error} />
  return createPortal(<dialog ref={dialog} data-native-back-dismiss onCancel={event => { event.preventDefault(); onClose() }} onClick={event => event.stopPropagation()} className="studio-workspace m-auto h-[min(860px,92dvh)] w-[min(900px,96vw)] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-default)] p-0 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/50" aria-label="样章学习与写作风格">
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] p-4"><Fingerprint className="h-5 w-5" /><div><h2 id="style-learning-title" className="text-base font-semibold">样章学习与写作风格</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">Style DNA · 仅当前作品 · 提炼规则，不训练模型</p></div><button className="ml-auto flex h-11 w-11 items-center justify-center" aria-label="关闭样章学习" onClick={onClose}><X className="h-5 w-5" /></button></header>
      <div className="scrollbar-none min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-6">
        <p className="text-sm text-[var(--text-secondary)]">保存样章 → Agent 分段学习 → 查看依据、确认规则 → 后续写作自动使用。关闭窗口不影响学习，重开可继续查看进度。</p>
        {error ? <p role="alert" className="rounded-xl bg-[var(--surface-muted)] p-3 text-sm">{error}</p> : null}
        {workspace.isPending ? <p role="status">正在读取样章和学习记录…</p> : workspace.error ? <div role="alert"><p>{workspace.error.message}</p><button className={button} onClick={() => void workspace.refetch()}>重新加载</button></div> : <>
          {!workspace.data.privateStyleEnabled ? <p role="alert">本作品已关闭风格使用。请在技能区的数据设置中开启后再学习或启用；已运行任务的上下文不会被追溯修改。</p> : null}
          {activeStyle ? <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-3 text-sm"><p>{workspace.data.privateStyleEnabled ? 'Agent 后续写作自动使用' : '已保存但暂停使用'}：{workspace.data.samples.find(item => item.id === activeStyle.profileId)?.name} · v{activeStyle.revision}</p><button className="mt-1 min-h-11 text-xs underline" onClick={() => { setSelectedId(activeStyle.profileId); setPreview(false); setConsent(false); setDeleteConfirm(false) }}>查看正在使用的规则</button></div> : null}
          <div className="flex flex-wrap items-center gap-3"><h3 className="font-medium">样章文件</h3><button className={`${button} ml-auto inline-flex items-center gap-2`} disabled={busy || !workspace.data.privateStyleEnabled} onClick={() => { setError(''); setUpload(true) }}><Plus className="h-4 w-4" />添加样章</button></div>
          {workspace.data.samples.length ? <label className="block text-xs">样章版本<select aria-label="样章版本" className="mt-2 h-11 w-full rounded-xl bg-[var(--surface-muted)] px-3" value={sample?.id ?? ''} onChange={event => { setSelectedId(event.target.value); setConsent(false); setPreview(false); setDeleteConfirm(false) }}>{workspace.data.samples.map(item => <option key={item.id} value={item.id}>{item.name} · {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</option>)}</select></label> : <p className="rounded-xl bg-[var(--surface-muted)] p-6 text-center text-sm text-[var(--text-secondary)]">还没有样章。添加你拥有使用权的 TXT 或 Markdown，也可从技能区选择作品章节。</p>}
          {sample ? <>
            <ul className="space-y-2 text-sm">{sample.files.map((file, i) => <li key={i} className="flex justify-between gap-3 rounded-xl bg-[var(--surface-muted)] p-3"><span className="min-w-0 break-all">{file.name}</span><span className="shrink-0 text-xs text-[var(--text-secondary)]">{file.chars ? `${file.chars.toLocaleString()} 字符` : '历史样章'}</span></li>)}</ul>
            <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setPreview(value => !value)}>{preview ? '收起原文' : '查看保存的样章'}</button><button className={button} disabled={busy} onClick={() => setDeleteConfirm(value => !value)}>删除样章与学习记录</button></div>
            {deleteConfirm ? <div role="alert" className="rounded-xl border border-[var(--border-subtle)] p-3 text-xs"><p>删除此样章版本的原文、学习结果和启用规则，无法恢复。已发生的模型调用无法撤销；供应商侧数据遵循其政策。</p><button className={`${button} mt-2`} disabled={busy} onClick={() => mutation.mutate(async () => { await revokeAuthorStyleSourceApi(novelId, sample.sourceId, '作者在样章学习中删除样章与派生规则'); setDeleteConfirm(false); setSelectedId(''); setPreview(false); await queryClient.removeQueries({ queryKey: ['studio', novelId, 'style-samples', sample.id] }) })}>确认删除</button></div> : null}
            {preview ? <div className="scrollbar-none max-h-72 overflow-auto overscroll-contain rounded-xl border border-[var(--border-subtle)] p-3">{samples.isPending ? '正在读取原文…' : samples.error ? <p role="alert">{samples.error.message}</p> : samples.data?.files.map((file, i) => <section key={i}><h4 className="mb-2 text-xs font-medium">{file.name}</h4><pre className="whitespace-pre-wrap break-words text-xs leading-6">{file.content}</pre></section>)}</div> : null}
            {workspace.data.jobs.filter(job => job.profileId === sample.id).map(job => <RuleEditor key={job.id} job={job} busy={busy} onChange={input => mutation.mutate(() => changeStyleLearningApi(novelId, job.id, input))} />)}
            {!sample.canLearn ? <p className="text-sm text-[var(--text-secondary)]">这是旧版统计画像，历史片段不等于完整文件。请重新添加样章后学习；不会自动发送旧样章。</p> : <section className="space-y-3 rounded-xl border border-[var(--border-subtle)] p-4">
              <h3 className="text-sm font-medium">让 Agent 学习此样章</h3><p className="text-xs text-[var(--text-secondary)]">学习方面：{STYLE_DIMENSIONS.join('、')}。没有原文依据的方面不会生成规则。</p>
              {credits.error || custom.error ? <div role="alert" className="text-xs">部分模型列表读取失败。<button className="min-h-11 px-2 underline" onClick={() => { void credits.refetch(); void custom.refetch() }}>重新加载模型</button></div> : null}
              <label className="block text-xs">分析模型<select aria-label="分析模型" value={model ? model.modelTier === 'custom' ? `custom:${model.customModelId}` : model.modelTier : ''} className="mt-2 h-11 w-full rounded-lg bg-[var(--surface-muted)] px-2" onChange={event => { const value = event.target.value; const customId = value.startsWith('custom:') ? value.slice(7) : null; const option = customId ? custom.data?.models.find(item => item.id === customId) : credits.data?.models.find(item => item.tier === value); setModel({ modelTier: customId ? 'custom' : value as StyleModelSelection['modelTier'], customModelId: customId, reasoningEffort: option?.defaultReasoningEffort ?? 'high' }); setConsent(false) }}><option value="" disabled>请选择模型</option>{credits.data?.models.filter(item => item.available && item.tier !== 'basic').map(item => <option key={item.tier} value={item.tier}>{item.label}</option>)}{custom.data?.models.filter(item => item.enabled).map(item => <option key={item.id} value={`custom:${item.id}`}>{item.displayName}（自定义）</option>)}</select></label>
              {model ? <label className="block text-xs">推理强度<select className="ml-2 min-h-11 rounded-lg bg-[var(--surface-muted)] px-2" value={model.reasoningEffort} onChange={event => { setModel({ ...model, reasoningEffort: event.target.value as StyleModelSelection['reasoningEffort'] }); setConsent(false) }}>{efforts.map(effort => <option key={effort}>{effort}</option>)}</select></label> : null}
              <p className="text-xs text-[var(--text-secondary)]">使用 {modelLabel ?? '所选模型'}，分段发送样章（每段最多 6000 字符）。{model?.modelTier === 'custom' ? '内容发送至你配置的第三方服务；模型费用由供应商收取。' : '按平台当前模型用量规则计费，实际费用取决于输入、输出及缓存用量，可在用量记录核对。'} 不向其他作品或公共语料库共享。</p>
              <label className="flex items-start gap-2 text-xs leading-5"><input className="mt-1" type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我有权使用这些样章，同意发送给所选模型供应商进行分析，并承担相应调用费用。</label>
              <button className={`${button} bg-[var(--surface-contrast)] text-[var(--text-contrast)]`} disabled={busy || !consent || !model || !selectedModel || !efforts.includes(model.reasoningEffort) || !workspace.data.privateStyleEnabled || workspace.data.jobs.some(job => ['queued', 'processing', 'analyzing'].includes(job.status))} onClick={start}>开始分段学习</button>
            </section>}
          </> : null}
        </>}
      </div>
      <footer className="shrink-0 border-t border-[var(--border-subtle)] p-4 text-xs text-[var(--text-secondary)]">启用后从本作品下一次 Agent 任务开始生效；已开始的任务保留原上下文。当前作品以外不会自动使用。</footer>
    </div>
  </dialog>, document.body)
}
