import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, FlaskConical, LoaderCircle, ShieldAlert, Trash2, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import type {
  AgentSkillDraftInput,
  AgentSkillListItem,
  AgentSkillPhase,
  NovelSkillsPayload,
} from '../../../../shared/contracts/index.js'
import {
  createNovelSkill,
  createNovelSkillVersion,
  deleteNovelSkillApi,
  getNovelSkillDetailApi,
  importThirdPartyNovelSkillApi,
  publishNovelSkill,
  testNovelSkillApi,
  updateNovelSkill,
} from '../api'

const phases: Array<{ value: AgentSkillPhase; label: string }> = [
  { value: 'research', label: '调研' }, { value: 'plan', label: '规划' }, { value: 'scene', label: '场景' },
  { value: 'draft', label: '正文' }, { value: 'critique', label: '审阅' }, { value: 'revision', label: '修订' }, { value: 'commit', label: '落库' },
]
const inputClass = 'h-10 w-full rounded-[9px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)]'
const textareaClass = 'w-full resize-y rounded-[9px] border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2 text-sm leading-6 text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)]'

type EditorState = {
  name: string
  description: string
  phase: AgentSkillPhase
  triggerPhrases: string
  negativeTriggerPhrases: string
  instructions: string
  version: string
  license: 'MIT' | 'Apache-2.0' | 'BSD-2-Clause' | 'BSD-3-Clause' | 'CC0-1.0' | 'Unlicense'
  attribution: string
  sourcePackage: string
}

const emptyEditor: EditorState = {
  name: '', description: '', phase: 'draft', triggerPhrases: '', negativeTriggerPhrases: '', instructions: '', version: '0.2.0',
  license: 'MIT', attribution: '', sourcePackage: '',
}

function lines(value: string): string[] {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function phaseIntent(phase: AgentSkillPhase): AgentSkillDraftInput['intents'][number] {
  if (phase === 'plan' || phase === 'research' || phase === 'scene') return 'plan'
  if (phase === 'critique') return 'review'
  if (phase === 'revision') return 'revise'
  return 'write'
}

function phaseMode(phase: AgentSkillPhase): AgentSkillDraftInput['modes'][number] {
  if (phase === 'plan' || phase === 'research') return 'plan'
  if (phase === 'critique') return 'review'
  return 'build'
}

function payloadFromEditor(editor: EditorState): AgentSkillDraftInput {
  return {
    name: editor.name,
    description: editor.description,
    intents: [phaseIntent(editor.phase)],
    modes: [phaseMode(editor.phase)],
    phases: [editor.phase],
    triggerPhrases: lines(editor.triggerPhrases),
    negativeTriggerPhrases: lines(editor.negativeTriggerPhrases),
    instructions: { [editor.phase]: editor.instructions },
    tokenBudget: 500,
    priority: 70,
  }
}

export default function SkillManagerDialog({
  novelId,
  skill,
  onClose,
  onPayload,
  importMode = false,
}: {
  novelId: string
  skill: AgentSkillListItem | null
  onClose: () => void
  onPayload: (payload: NovelSkillsPayload) => void
  importMode?: boolean
}) {
  const toast = useToast()
  const [selectedVersion, setSelectedVersion] = useState(skill?.activeVersion ?? '')
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [editingVersion, setEditingVersion] = useState(false)
  const [testPrompt, setTestPrompt] = useState('')
  const [expectMatch, setExpectMatch] = useState(true)
  const detailQuery = useQuery({
    queryKey: ['studio', novelId, 'skill-detail', skill?.id, selectedVersion],
    queryFn: () => getNovelSkillDetailApi(novelId, skill!.id, selectedVersion || undefined),
    enabled: Boolean(skill),
  })
  const detail = detailQuery.data
  const activeVersionStatus = skill?.versions.find((version) => version.version === selectedVersion)?.status
  const latestEval = detail?.recentEvals[0]
  const hasPositiveTest = detail?.recentEvals.some((evaluation) => evaluation.passed && evaluation.expected) ?? false
  const hasNegativeTest = detail?.recentEvals.some((evaluation) => evaluation.passed && !evaluation.expected) ?? false
  const auditPassed = detail?.audits[0]?.status === 'passed'

  useEffect(() => {
    setSelectedVersion(skill?.activeVersion ?? '')
    setEditingVersion(false)
    setTestPrompt('')
  }, [skill?.id, skill?.activeVersion])

  const seedVersionEditor = () => {
    if (!detail || !skill) return
    const manifest = detail.manifest
    const phase = strings(manifest.phases)[0] as AgentSkillPhase | undefined
    const selectedPhase = phase ?? 'draft'
    setEditor({
      name: skill.name,
      description: skill.description,
      phase: selectedPhase,
      triggerPhrases: strings(manifest.triggerPhrases).join('\n'),
      negativeTriggerPhrases: strings(manifest.negativeTriggerPhrases).join('\n'),
      instructions: detail.instructions[selectedPhase] ?? '',
      version: nextVersion(selectedVersion),
      license: (typeof manifest.license === 'string' ? manifest.license : 'MIT') as EditorState['license'],
      attribution: typeof manifest.attribution === 'string' ? manifest.attribution : '',
      sourcePackage: typeof manifest.sourcePackage === 'string' ? manifest.sourcePackage : '',
    })
    setEditingVersion(true)
  }

  const createMutation = useMutation({
    mutationFn: () => createNovelSkill(novelId, payloadFromEditor(editor)),
    onSuccess: (payload) => { onPayload(payload); toast.success('技能草稿已创建，需测试通过后发布。'); onClose() },
    onError: (error) => toast.error(error instanceof Error ? error.message : '技能创建失败。'),
  })
  const importMutation = useMutation({
    mutationFn: () => importThirdPartyNovelSkillApi(novelId, {
      ...payloadFromEditor(editor),
      license: editor.license,
      attribution: editor.attribution,
      sourcePackage: editor.sourcePackage,
    }),
    onSuccess: (payload) => { onPayload(payload); toast.success('第三方技能已导入为关闭的私有草稿，请测试后发布。'); onClose() },
    onError: (error) => toast.error(error instanceof Error ? error.message : '第三方技能导入失败。'),
  })
  const versionMutation = useMutation({
    mutationFn: () => createNovelSkillVersion(novelId, skill!.id, { ...payloadFromEditor(editor), version: editor.version }),
    onSuccess: (payload) => {
      onPayload(payload)
      setSelectedVersion(editor.version)
      setEditingVersion(false)
      toast.success('不可变新版本已创建，请先测试。')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '版本创建失败。'),
  })
  const testMutation = useMutation({
    mutationFn: () => testNovelSkillApi(novelId, skill!.id, {
      version: selectedVersion,
      prompt: testPrompt,
      intent: phaseIntent((strings(detail?.manifest.phases)[0] as AgentSkillPhase | undefined) ?? 'draft'),
      mode: phaseMode((strings(detail?.manifest.phases)[0] as AgentSkillPhase | undefined) ?? 'draft'),
      phase: (strings(detail?.manifest.phases)[0] as AgentSkillPhase | undefined) ?? 'draft',
      expectMatch,
    }),
    onSuccess: (result) => {
      toast[result.passed ? 'success' : 'error'](result.passed ? '测试通过，可以发布。' : `测试失败：实际${result.matched ? '命中' : '未命中'}。`)
      void detailQuery.refetch()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '测试失败。'),
  })
  const publishMutation = useMutation({
    mutationFn: () => publishNovelSkill(novelId, skill!.id, selectedVersion),
    onSuccess: (payload) => { onPayload(payload); toast.success('技能版本已发布并启用。'); void detailQuery.refetch() },
    onError: (error) => toast.error(error instanceof Error ? error.message : '发布失败。'),
  })
  const rollbackMutation = useMutation({
    mutationFn: (version: string) => updateNovelSkill(novelId, skill!.id, { lockedVersion: version }),
    onSuccess: (payload) => { onPayload(payload); toast.success('作品已锁定到所选历史版本。') },
    onError: (error) => toast.error(error instanceof Error ? error.message : '回滚失败。'),
  })
  const deleteMutation = useMutation({
    mutationFn: () => deleteNovelSkillApi(novelId, skill!.id),
    onSuccess: (payload) => { onPayload(payload); toast.success('自定义技能已删除。'); onClose() },
    onError: (error) => toast.error(error instanceof Error ? error.message : '删除失败。'),
  })

  const title = skill ? skill.name : importMode ? '导入第三方技能' : '创建作品技能'
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-stretch justify-center bg-black/45 md:items-center md:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <section className="flex h-full w-full flex-col bg-[var(--surface-default)] md:h-[min(820px,90vh)] md:w-[min(920px,calc(100vw-48px))] md:max-w-none md:rounded-[14px] md:border md:border-[var(--border-default)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3 md:px-5">
          <div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">{importMode ? '只导入明确许可的来源；先留作草稿，再测试发布。' : '把会反复使用的写作规则存为私有草稿；发布前可测试与回滚。'}</p></div>
          <button type="button" onClick={onClose} className="ml-auto flex h-9 w-9 items-center justify-center rounded-[9px] hover:bg-[var(--surface-muted)]" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-5">
          {!skill || editingVersion ? (
            <SkillEditor
              editor={editor}
              setEditor={setEditor}
              submitting={createMutation.isPending || versionMutation.isPending}
              submitLabel={skill ? '创建新版本' : importMode ? '导入为草稿' : '创建草稿'}
              importMode={importMode}
              onCancel={skill ? () => setEditingVersion(false) : onClose}
              onSubmit={() => skill ? versionMutation.mutate() : importMode ? importMutation.mutate() : createMutation.mutate()}
            />
          ) : detailQuery.isLoading ? (
            <div className="flex h-56 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]"><LoaderCircle className="h-4 w-4 animate-spin" />载入技能详情…</div>
          ) : detail ? (
            <div className="space-y-5">
              <div className="grid gap-4 border-b border-[var(--border-subtle)] pb-5 md:grid-cols-[1fr_240px]">
                <div>
                  <p className="text-sm leading-6 text-[var(--text-secondary)]">{skill.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-[var(--text-tertiary)]">
                    {skill.phases.map((phase) => <span key={phase} className="rounded-full bg-[var(--surface-muted)] px-2 py-1">{phases.find((item) => item.value === phase)?.label ?? phase}</span>)}
                    <span className="rounded-full bg-[var(--surface-muted)] px-2 py-1">{skill.license}</span>
                  </div>
                </div>
                <div className="text-xs md:border-l md:border-[var(--border-subtle)] md:pl-4">
                  <label className="text-[var(--text-secondary)]">查看版本<select value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)} className={`${inputClass} mt-1`}>
                    {skill.versions.map((version) => <option key={version.version} value={version.version}>{version.version} · {version.status}</option>)}
                  </select></label>
                  {skill.canEdit ? <Button size="sm" className="mt-3 w-full" onClick={seedVersionEditor}>基于此版本创建新版</Button> : null}
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <section>
                  <h3 className="text-xs font-semibold">触发与不触发</h3>
                  <p className="mt-3 text-[10px] text-[var(--text-tertiary)]">触发</p><p className="mt-1 text-xs leading-6">{strings(detail.manifest.triggerPhrases).join('、') || '—'}</p>
                  <p className="mt-3 text-[10px] text-[var(--text-tertiary)]">明确不触发</p><p className="mt-1 text-xs leading-6">{strings(detail.manifest.negativeTriggerPhrases).join('、') || '—'}</p>
                  <p className="mt-3 text-[10px] text-[var(--text-tertiary)]">阶段说明</p>
                  {Object.entries(detail.instructions).map(([phase, content]) => <pre key={phase} className="mt-1 whitespace-pre-wrap rounded-[9px] bg-[var(--surface-muted)] p-3 font-sans text-xs leading-6">[{phase}] {content}</pre>)}
                </section>
                <section className="border-t border-[var(--border-subtle)] pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                  <div className="flex items-center gap-2"><h3 className="text-xs font-semibold">安全与许可证审计</h3>{auditPassed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <ShieldAlert className="h-4 w-4 text-amber-500" />}</div>
                  <p className="mt-2 text-xs text-[var(--text-secondary)]">{auditPassed ? '该版本静态审计通过。' : '该版本尚未通过静态审计，不能发布。'}</p>
                  {detail.audits[0]?.findings.map((finding) => <p key={finding} className="mt-2 rounded-[8px] bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600">{finding}</p>)}
                  <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
                    <div className="flex items-center gap-2"><FlaskConical className="h-4 w-4" /><h3 className="text-xs font-semibold">测试沙箱</h3></div>
                    <textarea rows={4} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} placeholder="输入一条真实提示词；内容只保存哈希" className={`${textareaClass} mt-2`} />
                    <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={expectMatch} onChange={(event) => setExpectMatch(event.target.checked)} />预期应该命中</label>
                    <Button size="sm" className="mt-3" disabled={!testPrompt.trim() || testMutation.isPending || !skill.canEdit} onClick={() => testMutation.mutate()}>{testMutation.isPending ? '测试中…' : '运行测试'}</Button>
                    {latestEval ? <p className={`mt-2 text-xs ${latestEval.passed ? 'text-emerald-500' : 'text-[var(--color-error)]'}`}>最近测试：{latestEval.passed ? '通过' : '失败'} · 实际{latestEval.matched ? '命中' : '未命中'}</p> : null}
                  </div>
                </section>
              </div>

              {skill.canEdit ? <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
                {activeVersionStatus !== 'active' ? <Button variant="primary" disabled={!auditPassed || !hasPositiveTest || !hasNegativeTest || publishMutation.isPending} title={!hasPositiveTest || !hasNegativeTest ? '需各通过一条应命中与不应命中测试' : undefined} onClick={() => publishMutation.mutate()}>发布并启用此版本</Button> : null}
                <select aria-label="回滚版本" value={skill.activeVersion} onChange={(event) => rollbackMutation.mutate(event.target.value)} disabled={rollbackMutation.isPending} className={`${inputClass} w-auto min-w-44`}>
                  <option value={skill.activeVersion}>当前锁定 {skill.activeVersion}</option>
                  {skill.versions.filter((version) => version.status === 'active' && version.version !== skill.activeVersion).map((version) => <option key={version.version} value={version.version}>回滚到 {version.version}</option>)}
                </select>
                <Button className="ml-auto" size="sm" onClick={() => { if (window.confirm(`确认删除技能「${skill.name}」及全部历史版本？`)) deleteMutation.mutate() }}><Trash2 className="h-3.5 w-3.5" />删除</Button>
              </div> : null}
            </div>
          ) : <p className="py-16 text-center text-sm text-[var(--color-error)]">技能详情载入失败。</p>}
        </div>
      </section>
    </div>,
    document.body,
  )
}

function nextVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : '0.2.0'
}

function SkillEditor({ editor, setEditor, submitting, submitLabel, importMode, onCancel, onSubmit }: {
  editor: EditorState
  setEditor: (value: EditorState) => void
  submitting: boolean
  submitLabel: string
  importMode: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  const valid = useMemo(() => Boolean(editor.name.trim() && editor.description.trim() && lines(editor.triggerPhrases).length && lines(editor.negativeTriggerPhrases).length && editor.instructions.trim() && (!importMode || (editor.attribution.trim() && /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:@[a-f0-9_.-]+)?$/i.test(editor.sourcePackage)))), [editor, importMode])
  const submit = (event: FormEvent) => { event.preventDefault(); if (valid) onSubmit() }
  return <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4">
    <div className="border-b border-[var(--border-subtle)] pb-3 text-[11px] leading-5 text-[var(--text-secondary)]">
      <p className="font-medium text-[var(--text-primary)]">从一条可复用规则开始</p>
      <p className="mt-0.5">填写“何时用、何时不用、怎么做”即可。下面的灰色文字都是示例提示，不会写入技能。</p>
    </div>
    <div className="grid gap-3 md:grid-cols-2"><label className="text-xs text-[var(--text-secondary)]">名称<TextInput className="mt-1" placeholder="例如：紧张追逐场景（示例）" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label><label className="text-xs text-[var(--text-secondary)]">语义版本<TextInput className="mt-1" placeholder="0.1.0" value={editor.version} disabled={submitLabel === '创建草稿'} onChange={(event) => setEditor({ ...editor, version: event.target.value })} /></label></div>
    <label className="block text-xs text-[var(--text-secondary)]">用途<textarea rows={2} placeholder="例如：让追逐段落以人物目标和连续动作推进，避免堆砌环境描写。" className={`${textareaClass} mt-1`} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></label>
    <label className="block text-xs text-[var(--text-secondary)]">何时使用<select className={`${inputClass} mt-1`} value={editor.phase} onChange={(event) => setEditor({ ...editor, phase: event.target.value as AgentSkillPhase })}>{phases.map((phase) => <option key={phase.value} value={phase.value}>{phase.label}</option>)}</select></label>
    {importMode ? <div className="grid gap-3 md:grid-cols-3">
      <label className="text-xs text-[var(--text-secondary)]">许可证<select className={`${inputClass} mt-1`} value={editor.license} onChange={(event) => setEditor({ ...editor, license: event.target.value as EditorState['license'] })}>{['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'Unlicense'].map((license) => <option key={license} value={license}>{license}</option>)}</select></label>
      <label className="text-xs text-[var(--text-secondary)]">固定来源包<TextInput className="mt-1" placeholder="例如：owner/repo@commit" value={editor.sourcePackage} onChange={(event) => setEditor({ ...editor, sourcePackage: event.target.value })} /></label>
      <label className="text-xs text-[var(--text-secondary)]">归属说明<TextInput className="mt-1" placeholder="例如：原作者与本次改写范围" value={editor.attribution} onChange={(event) => setEditor({ ...editor, attribution: event.target.value })} /></label>
    </div> : null}
    <div className="grid gap-3 md:grid-cols-2"><label className="text-xs text-[var(--text-secondary)]">出现什么时用（每行一个）<textarea rows={5} placeholder={'例如：\n写追逐场景\n主角正在逃亡'} className={`${textareaClass} mt-1`} value={editor.triggerPhrases} onChange={(event) => setEditor({ ...editor, triggerPhrases: event.target.value })} /></label><label className="text-xs text-[var(--text-secondary)]">出现什么时不用（每行一个）<textarea rows={5} placeholder={'例如：\n只改错别字\n只整理目录'} className={`${textareaClass} mt-1`} value={editor.negativeTriggerPhrases} onChange={(event) => setEditor({ ...editor, negativeTriggerPhrases: event.target.value })} /></label></div>
    <label className="block text-xs text-[var(--text-secondary)]">怎么做<textarea rows={10} placeholder={'例如：\n先明确人物要到哪里、谁在阻拦。\n每段至少有一个可观察动作或选择。\n不要用环境描写替代事件推进。'} className={`${textareaClass} mt-1`} value={editor.instructions} onChange={(event) => setEditor({ ...editor, instructions: event.target.value })} /></label>
    <p className="text-[10px] leading-5 text-[var(--text-tertiary)]">技能只能提供软创作方法，不能覆盖作者硬约束、故事事实、权限、确认流程或系统安全边界。创建后默认关闭。</p>
    <div className="flex justify-end gap-2"><Button onClick={onCancel}>取消</Button><Button type="submit" variant="primary" disabled={!valid || submitting}>{submitting ? '保存中…' : submitLabel}</Button></div>
  </form>
}
