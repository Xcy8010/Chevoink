import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiClientError } from '@/app/api-client'
import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import type {
  AdminAgentEvalSuiteRow,
  AdminCreateAgentEvalSampleRequest,
  AgentBlindReviewSubmission,
  AgentEvalCandidateOrigin,
  AgentEvalDimension,
  AgentEvalGuessedOrigin,
  AgentEvalMechanicalReason,
  AgentEvalRating,
} from '../../../../shared/contracts/index.js'
import {
  AGENT_EVAL_DIMENSIONS,
  AGENT_EVAL_MECHANICAL_REASONS,
} from '../../../../shared/contracts/index.js'
import {
  addAdminAgentEvalSample,
  createAdminAgentEvalSuite,
  getAdminAgentEvalResults,
  getAdminAgent3OperationsMetrics,
  getNextAdminBlindReview,
  listAdminAgentEvalSuites,
  submitAdminBlindReview,
  updateAdminAgentEvalSuiteStatus,
} from '../api'
import { AdminCard, AdminPageHeader, AdminPanelState, StatusPill } from '../AdminLayout'
import { useAdminSession } from '../admin-shared'

const DIMENSION_LABELS: Record<AgentEvalDimension, string> = {
  continue_reading: '继续阅读意愿',
  plot_progress: '情节有效推进',
  character_agency_voice: '人物能动性与声音',
  emotion_credibility: '情感可信度',
  style_consistency: '文风一致性',
  description_function: '描写功能性',
  mechanical_texture: '去机械感',
  chapter_bridge: '章节衔接',
  overall_preference: '整体质量',
}

const REASON_LABELS: Record<AgentEvalMechanicalReason, string> = {
  style_drift: '文风割裂',
  orphaned_sophistication: '无铺垫炫技',
  plot_progress: '剧情停滞',
  description_load: '描写占比失衡',
  emotion_grounding: '情感虚浮',
  explanation_echo: '解释性复述',
  sentence_homology: '句式同质',
  image_repetition: '意象重复',
  character_voice: '角色同声',
  causal_gap: '因果断裂',
  chapter_bridge: '衔接机械',
  reader_pull: '缺少阅读牵引',
}

const ORIGIN_LABELS: Record<AgentEvalCandidateOrigin, string> = {
  agent2: 'Agent 2',
  agent3: 'Agent 3',
  human: '人类样本',
}

const STATUS_LABELS = { draft: '草稿', active: '进行中', completed: '已结束' }
const EMPTY_SUITES: AdminAgentEvalSuiteRow[] = []
const inputClass = 'h-10 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm outline-none focus:border-[var(--text-primary)]'
const textareaClass = 'w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--text-primary)]'

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback
}

function blankCandidateRatings(labels: string[]): AgentBlindReviewSubmission['candidateRatings'] {
  return Object.fromEntries(
    labels.map((label) => [
      label,
      Object.fromEntries(AGENT_EVAL_DIMENSIONS.map((dimension) => [dimension, 3])) as Record<AgentEvalDimension, AgentEvalRating>,
    ]),
  )
}

export default function AdminAgentEvalsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { admin } = useAdminSession()
  const [selectedSuiteId, setSelectedSuiteId] = useState('')
  const [reviewNonce, setReviewNonce] = useState(0)

  const suitesQuery = useQuery({ queryKey: ['admin', 'evals', 'suites'], queryFn: listAdminAgentEvalSuites })
  const operationsQuery = useQuery({ queryKey: ['admin', 'agent3', 'operations'], queryFn: getAdminAgent3OperationsMetrics, enabled: Boolean(admin?.isSuperAdmin) })
  const suites = suitesQuery.data?.suites ?? EMPTY_SUITES
  const selectedSuite = suites.find((suite) => suite.id === selectedSuiteId) ?? suites[0]

  useEffect(() => {
    if (!selectedSuiteId && suites[0]) setSelectedSuiteId(suites[0].id)
  }, [selectedSuiteId, suites])

  const assignmentQuery = useQuery({
    queryKey: ['admin', 'evals', 'assignment', selectedSuite?.id, reviewNonce],
    queryFn: () => getNextAdminBlindReview(selectedSuite?.id),
    enabled: selectedSuite?.status === 'active',
    retry: false,
  })
  const assignment = assignmentQuery.data?.assignment ?? null
  const labels = useMemo(() => assignment?.candidates.map((candidate) => candidate.label) ?? [], [assignment])
  const [candidateRatings, setCandidateRatings] = useState<AgentBlindReviewSubmission['candidateRatings']>({})
  const [guessedOrigins, setGuessedOrigins] = useState<Record<string, AgentEvalGuessedOrigin>>({})
  const [mechanicalReasons, setMechanicalReasons] = useState<Record<string, AgentEvalMechanicalReason[]>>({})
  const [preferredLabel, setPreferredLabel] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    setCandidateRatings(blankCandidateRatings(labels))
    setGuessedOrigins(Object.fromEntries(labels.map((label) => [label, 'unsure'])))
    setMechanicalReasons(Object.fromEntries(labels.map((label) => [label, []])))
    setPreferredLabel('')
    setNotes('')
  }, [assignment?.sampleId, labels])

  const resultsQuery = useQuery({
    queryKey: ['admin', 'evals', 'results', selectedSuite?.id],
    queryFn: () => getAdminAgentEvalResults(selectedSuite!.id),
    enabled: Boolean(admin?.isSuperAdmin && selectedSuite?.id),
  })

  const submitMutation = useMutation({
    mutationFn: () => submitAdminBlindReview(assignment!.sampleId, { candidateRatings, guessedOrigins, mechanicalReasons, preferredLabel, notes }),
    onSuccess: async () => {
      toast.success('盲评已提交，已载入下一份样本。')
      await queryClient.invalidateQueries({ queryKey: ['admin', 'evals'] })
      setReviewNonce((value) => value + 1)
    },
    onError: (error) => toast.error(errorMessage(error, '盲评提交失败。')),
  })

  const statusMutation = useMutation({
    mutationFn: (status: 'active' | 'completed') => updateAdminAgentEvalSuiteStatus(selectedSuite!.id, status),
    onSuccess: async (_, status) => {
      toast.success(status === 'active' ? '盲评已开始，样本已冻结。' : '盲评已结束。')
      await queryClient.invalidateQueries({ queryKey: ['admin', 'evals'] })
    },
    onError: (error) => toast.error(errorMessage(error, '状态更新失败。')),
  })

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Agent 3.5 创作盲评"
        description="固定量表、匿名候选、可追溯授权；评审过程中不展示候选真实来源。"
      />

      {admin?.isSuperAdmin ? <SuiteCreator /> : null}

      {admin?.isSuperAdmin && operationsQuery.data ? <AdminCard>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Agent 3.5 近 30 天运行门禁</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">只汇总匿名计数、耗时和预算，不读取小说正文。</p></div><StatusPill tone={operationsQuery.data.research.queryBudgetViolations === 0 ? 'success' : 'danger'}>{operationsQuery.data.research.queryBudgetViolations === 0 ? '研究预算正常' : '存在预算越界'}</StatusPill></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="研究构建 / 复用" value={`${operationsQuery.data.research.builds} / ${operationsQuery.data.research.reuses}`} detail={`复用率 ${Math.round(operationsQuery.data.research.reuseRate * 100)}%`} />
          <Metric label="单档案搜索" value={operationsQuery.data.research.averageSearchesPerBuild.toFixed(1)} detail={`平均 ${Math.round(operationsQuery.data.research.averageInputTokensPerBuild)} input tokens`} />
          <Metric label="前三章试制" value={`${operationsQuery.data.prototypes.completed}/${operationsQuery.data.prototypes.total}`} detail={`完成率 ${Math.round(operationsQuery.data.prototypes.completionRate * 100)}%`} />
          <Metric label="隐私与邀请" value={`${operationsQuery.data.privacy.analyticsOptOut} 项目退出`} detail={`${operationsQuery.data.sharing.accepted} 次邀请已接受`} />
        </div>
      </AdminCard> : null}

      <AdminCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">评测套件</h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">激活后样本冻结；仅超级管理员可揭盲查看汇总。</p>
          </div>
          <select
            value={selectedSuite?.id ?? ''}
            onChange={(event) => setSelectedSuiteId(event.target.value)}
            className={`${inputClass} w-full md:w-72`}
          >
            {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
          </select>
        </div>

        <AdminPanelState state={suitesQuery.isLoading ? 'loading' : suitesQuery.isError ? 'error' : suites.length === 0 ? 'empty' : 'ready'}>
          {selectedSuite ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--border-default)] pt-4 text-sm">
              <StatusPill tone={selectedSuite.status === 'active' ? 'warning' : selectedSuite.status === 'completed' ? 'success' : 'neutral'}>
                {STATUS_LABELS[selectedSuite.status]}
              </StatusPill>
              <span>{selectedSuite.sampleCount} 个样本</span>
              <span>{selectedSuite.reviewCount} 份评审</span>
              <span className="text-[var(--text-secondary)]">数据集 {selectedSuite.datasetVersion} · 量表 {selectedSuite.rubricVersion}</span>
              {admin?.isSuperAdmin && selectedSuite.status === 'draft' ? (
                <Button size="sm" variant="primary" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate('active')}>开始盲评</Button>
              ) : null}
              {admin?.isSuperAdmin && selectedSuite.status === 'active' ? (
                <Button size="sm" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate('completed')}>结束并冻结结果</Button>
              ) : null}
            </div>
          ) : null}
        </AdminPanelState>
      </AdminCard>

      {admin?.isSuperAdmin && selectedSuite?.status === 'draft' ? <SampleCreator suiteId={selectedSuite.id} /> : null}

      {selectedSuite?.status === 'active' ? (
        <AdminCard>
          <AdminPanelState state={assignmentQuery.isLoading ? 'loading' : assignmentQuery.isError ? 'error' : !assignment ? 'empty' : 'ready'}>
            {assignment ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!preferredLabel) return toast.error('请选择整体更优的候选。')
                  submitMutation.mutate()
                }}
              >
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{assignment.sampleCode} · {assignment.title}</h2>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">{assignment.genre} · {assignment.task} · {assignment.style}</p>
                    <p className="mt-2 text-sm text-[var(--text-secondary)]">{assignment.evaluationBrief}</p>
                  </div>
                  <StatusPill>{assignment.progress.reviewed + 1} / {assignment.progress.total}</StatusPill>
                </div>

                <div className="grid gap-4 xl:grid-cols-3">
                  {assignment.candidates.map((candidate) => (
                    <article key={candidate.label} className="min-w-0 rounded-xl border border-[var(--border-default)] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="font-semibold">候选 {candidate.label}</h3>
                        <label className="flex items-center gap-2 text-xs">
                          <input type="radio" name="preferred" checked={preferredLabel === candidate.label} onChange={() => setPreferredLabel(candidate.label)} /> 整体更优
                        </label>
                      </div>
                      <div className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface-muted)] p-3 text-sm leading-7">{candidate.content}</div>
                      <div className="mt-4 space-y-2">
                        {AGENT_EVAL_DIMENSIONS.map((dimension) => (
                          <label key={dimension} className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
                            {DIMENSION_LABELS[dimension]}
                            <select
                              value={candidateRatings[candidate.label]?.[dimension] ?? 3}
                              onChange={(event) => setCandidateRatings((current) => ({
                                ...current,
                                [candidate.label]: { ...current[candidate.label], [dimension]: Number(event.target.value) as AgentEvalRating },
                              }))}
                              className="h-8 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-2 text-[var(--text-primary)]"
                            >
                              {[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}</option>)}
                            </select>
                          </label>
                        ))}
                      </div>
                      <label className="mt-4 block text-xs text-[var(--text-secondary)]">
                        你判断的来源
                        <select
                          value={guessedOrigins[candidate.label] ?? 'unsure'}
                          onChange={(event) => setGuessedOrigins((current) => ({ ...current, [candidate.label]: event.target.value as AgentEvalGuessedOrigin }))}
                          className={`${inputClass} mt-1`}
                        >
                          <option value="unsure">无法判断</option>
                          <option value="agent2">Agent 2</option>
                          <option value="agent3">Agent 3</option>
                          <option value="human">人类作者</option>
                        </select>
                      </label>
                      <fieldset className="mt-4">
                        <legend className="text-xs text-[var(--text-secondary)]">机械感问题（可多选）</legend>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {AGENT_EVAL_MECHANICAL_REASONS.map((reason) => {
                            const checked = mechanicalReasons[candidate.label]?.includes(reason) ?? false
                            return (
                              <label key={reason} className="flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-2 py-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => setMechanicalReasons((current) => ({
                                    ...current,
                                    [candidate.label]: checked
                                      ? (current[candidate.label] ?? []).filter((value) => value !== reason)
                                      : [...(current[candidate.label] ?? []), reason],
                                  }))}
                                />
                                {REASON_LABELS[reason]}
                              </label>
                            )
                          })}
                        </div>
                      </fieldset>
                    </article>
                  ))}
                </div>

                <label className="mt-4 block text-sm text-[var(--text-secondary)]">
                  评审备注（可选）
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className={`${textareaClass} mt-1`} />
                </label>
                <div className="mt-4 flex justify-end"><Button type="submit" variant="primary" disabled={submitMutation.isPending}>{submitMutation.isPending ? '提交中…' : '提交并进入下一份'}</Button></div>
              </form>
            ) : selectedSuite.reviewCount > 0 ? <p className="py-12 text-center text-sm text-[var(--text-secondary)]">当前套件已没有待你评审的样本。</p> : null}
          </AdminPanelState>
        </AdminCard>
      ) : null}

      {admin?.isSuperAdmin && selectedSuite ? <ResultsPanel query={resultsQuery} /> : null}
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)]/40 p-3"><p className="text-xs text-[var(--text-secondary)]">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-[11px] text-[var(--text-tertiary)]">{detail}</p></div>
}

function SuiteCreator() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', datasetVersion: 'cn-fiction-v1', rubricVersion: 'humanization-v1' })
  const mutation = useMutation({
    mutationFn: () => createAdminAgentEvalSuite(form),
    onSuccess: async () => {
      setForm((current) => ({ ...current, name: '' }))
      toast.success('评测套件已创建。')
      await queryClient.invalidateQueries({ queryKey: ['admin', 'evals'] })
    },
    onError: (error) => toast.error(errorMessage(error, '套件创建失败。')),
  })
  return (
    <AdminCard>
      <h2 className="mb-3 text-sm font-semibold">新建评测套件</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <TextInput placeholder="套件名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <TextInput placeholder="数据集版本" value={form.datasetVersion} onChange={(event) => setForm({ ...form, datasetVersion: event.target.value })} />
        <TextInput placeholder="量表版本" value={form.rubricVersion} onChange={(event) => setForm({ ...form, rubricVersion: event.target.value })} />
      </div>
      <Button className="mt-3" variant="primary" disabled={!form.name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>创建草稿套件</Button>
    </AdminCard>
  )
}

function SampleCreator({ suiteId }: { suiteId: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Omit<AdminCreateAgentEvalSampleRequest, 'candidates'>>({
    code: '', title: '', genre: '', task: '', style: '', evaluationBrief: '', sourceClass: 'synthetic', sourceReference: '', consentReceiptId: '',
  })
  const [contents, setContents] = useState<Record<AgentEvalCandidateOrigin, string>>({ agent2: '', agent3: '', human: '' })
  const mutation = useMutation({
    mutationFn: () => addAdminAgentEvalSample(suiteId, {
      ...form,
      candidates: (Object.keys(contents) as AgentEvalCandidateOrigin[]).map((origin) => ({ origin, content: contents[origin] })),
    }),
    onSuccess: async () => {
      setForm((current) => ({ ...current, code: '', title: '', evaluationBrief: '', sourceReference: '', consentReceiptId: '' }))
      setContents({ agent2: '', agent3: '', human: '' })
      toast.success('匿名样本已加入草稿套件。')
      await queryClient.invalidateQueries({ queryKey: ['admin', 'evals'] })
    },
    onError: (error) => toast.error(errorMessage(error, '样本添加失败。')),
  })
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    mutation.mutate()
  }
  return (
    <AdminCard>
      <h2 className="text-sm font-semibold">添加匿名样本</h2>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">来源引用只保存不可逆 HMAC；用户授权文本必须填写授权凭据。候选标签由服务端随机分配。</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(['code', 'title', 'genre', 'task', 'style'] as const).map((key) => (
            <TextInput key={key} required placeholder={{ code: '样本编号', title: '标题', genre: '题材', task: '任务类型', style: '文风' }[key]} value={form[key]} onChange={(event) => update(key, event.target.value)} />
          ))}
        </div>
        <textarea required rows={2} placeholder="统一评审说明（不包含来源暗示）" value={form.evaluationBrief} onChange={(event) => update('evaluationBrief', event.target.value)} className={textareaClass} />
        <div className="grid gap-3 md:grid-cols-3">
          <select value={form.sourceClass} onChange={(event) => update('sourceClass', event.target.value)} className={inputClass}>
            <option value="synthetic">自建合成样本</option><option value="public_domain">公共领域</option><option value="licensed">已获许可</option><option value="user_opt_in">用户主动授权</option>
          </select>
          <TextInput required placeholder="内部来源引用（不会明文保存）" value={form.sourceReference} onChange={(event) => update('sourceReference', event.target.value)} />
          <TextInput required={form.sourceClass === 'user_opt_in'} placeholder="授权凭据编号（授权样本必填）" value={form.consentReceiptId} onChange={(event) => update('consentReceiptId', event.target.value)} />
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {(Object.keys(contents) as AgentEvalCandidateOrigin[]).map((origin) => (
            <label key={origin} className="text-sm font-medium">{ORIGIN_LABELS[origin]} 原文（仅建样管理员可见）
              <textarea required minLength={20} rows={10} value={contents[origin]} onChange={(event) => setContents((current) => ({ ...current, [origin]: event.target.value }))} className={`${textareaClass} mt-1 font-normal`} />
            </label>
          ))}
        </div>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? '保存中…' : '加入草稿套件'}</Button>
      </form>
    </AdminCard>
  )
}

function ResultsPanel({ query }: { query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAdminAgentEvalResults>>>> }) {
  const data = query.data
  return (
    <AdminCard>
      <h2 className="text-sm font-semibold">揭盲汇总（超级管理员）</h2>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">真实来源仅在此聚合视图展示，不进入专家分配响应。</p>
      <AdminPanelState state={query.isLoading ? 'loading' : query.isError ? 'error' : !data || data.variants.every((variant) => variant.reviewCount === 0) ? 'empty' : 'ready'}>
        {data ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {data.variants.map((variant) => (
              <div key={variant.origin} className="rounded-xl border border-[var(--border-default)] p-4">
                <h3 className="font-semibold">{ORIGIN_LABELS[variant.origin]}</h3>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{variant.reviewCount} 次评分 · 偏好率 {(variant.preferenceRate * 100).toFixed(1)}% · 机械感标记率 {(variant.mechanicalMarkRate * 100).toFixed(1)}%</p>
                <dl className="mt-3 space-y-1 text-xs">
                  {AGENT_EVAL_DIMENSIONS.map((dimension) => (
                    <div key={dimension} className="flex justify-between gap-2"><dt className="text-[var(--text-secondary)]">{DIMENSION_LABELS[dimension]}</dt><dd>{variant.averageRatings[dimension]?.toFixed(2) ?? '—'}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        ) : null}
      </AdminPanelState>
    </AdminCard>
  )
}
