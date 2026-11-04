import { useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { cn } from '@/lib/utils'
import type { PlanMetadataPatch } from '../../../../shared/contracts/novel-plans'
import type { StudioPayload } from '../../../../shared/contracts/index'
import type { WorkspacePlanFile } from '../types'
import { getSavedPlanSnapshot } from '../lib/plan-review'
import { InputLabel } from './StudioControls'

type PlanSettingsPanelProps = {
  plan: WorkspacePlanFile
  onRename: (title: string) => void
  plans?: WorkspacePlanFile[]
  chapters?: StudioPayload['chapters']
  onSave?: (patch: PlanMetadataPatch & { title?: string }) => Promise<void>
  onRequestDelete: () => void
  onClose: () => void
  /** 遮罩层级：编辑器内 z-40，沉浸区 portal 内 z-[110] */
  overlayClassName?: string
}

/**
 * 计划设置抽屉面板（对齐章节设置的分组卡片样式）：
 * 基本信息 / 危险操作两个分组，编辑器与沉浸创作区共用。
 */
export default function PlanSettingsPanel({
  plan,
  onRename,
  plans = [],
  chapters = [],
  onSave,
  onRequestDelete,
  onClose,
  overlayClassName,
}: PlanSettingsPanelProps) {
  // 计划标题在派生时有「创作计划」兜底，直接受控会导致清空输入框时跳字，这里用本地 state 承载
  const [title, setTitle] = useState(plan.title)
  const [kind, setKind] = useState(plan.planKind ?? 'legacy')
  const [parentId, setParentId] = useState(plan.parentPlanId ?? '')
  const [targetId, setTargetId] = useState(plan.target?.kind === 'chapter' ? plan.target.chapterId : plan.target?.kind === 'future' ? 'future' : '')
  const [futureOrder, setFutureOrder] = useState(plan.target?.kind === 'future' ? String(plan.target.targetOrderIndex) : '')
  const [reviewed, setReviewed] = useState(false)
  const [parentRead, setParentRead] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const parent = plans.find(item => item.backendArtifactId === parentId && item.planKind === 'outline')
  const parentSnapshot = parent ? getSavedPlanSnapshot(parent) : null
  const needsReview = Boolean(parentId) && (parentId !== plan.parentPlanId || plan.reviewState !== 'current')
  const selectClass = 'w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-default)] px-3 py-2 text-sm'
  async function save() {
    const target = targetId === 'future' ? { kind: 'future' as const, targetOrderIndex: Number(futureOrder) } : targetId ? { kind: 'chapter' as const, chapterId: targetId } : null
    if (kind === 'detail' && target?.kind === 'future' && (!Number.isInteger(target.targetOrderIndex) || target.targetOrderIndex < 1 || target.targetOrderIndex > 2147483647)) { setError('请输入有效的全书章节序号。'); return }
    if (kind === 'detail' && parentId !== (plan.parentPlanId ?? '') && parentId && (!parentSnapshot?.planHash || !reviewed)) { setError('请阅读并确认父大纲。'); return }
    setBusy(true); setError(''); setSaved(false)
    try {
      if (onSave) {
        const patch: PlanMetadataPatch & { title?: string } = { title: title.trim() || plan.title }
        if (kind !== 'legacy') patch.planKind = kind
        if (kind === 'detail') {
          patch.target = target
          if (parentId !== (plan.parentPlanId ?? '') || reviewed) {
            patch.parentPlanId = parentId || null
            if (parentId && parentSnapshot?.planHash) patch.expectedParentPlanHash = parentSnapshot.planHash
          }
        }
        await onSave(patch)
      } else onRename(title)
      setSaved(true); setReviewed(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，请重试。') }
    finally { setBusy(false) }
  }

  useEffect(() => {
    setTitle(plan.title)
    setKind(plan.planKind ?? 'legacy')
    setParentId(plan.parentPlanId ?? '')
    setTargetId(plan.target?.kind === 'chapter' ? plan.target.chapterId : plan.target?.kind === 'future' ? 'future' : '')
    setFutureOrder(plan.target?.kind === 'future' ? String(plan.target.targetOrderIndex) : '')
    setReviewed(false); setParentRead(false); setError(''); setSaved(false)
    // 仅在切换计划时同步外部标题，避免输入过程被回写打断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id])

  useEffect(() => { setReviewed(false); setParentRead(false) }, [parentSnapshot?.planHash])

  const wordCount = plan.content.replace(/\s/g, '').length

  return (
    <div
      className={cn('fixed inset-0 bg-[rgba(15,23,42,0.18)]', overlayClassName ?? 'z-40')}
      onClick={onClose}
    >
      <div
        className="absolute inset-y-4 right-4 w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] shadow-[0_24px_64px_rgba(15,23,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-full min-h-0 flex-col p-5">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
            <div>
              <h3 className="text-base font-semibold text-[var(--text-primary)]">计划设置</h3>

            </div>
            <Button
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="关闭计划设置"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {/* 分组一：基本信息 */}
            <section className="space-y-3 rounded-[18px] border border-[var(--border-subtle)] p-4">
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">基本信息</h4>
              <label className="block space-y-2">
                <InputLabel label="计划标题" />
                <TextInput
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value)
                    setSaved(false)
                  }}
                  placeholder="例如：第 21 章细纲"
                />
              </label>
              <label className="block space-y-2"><InputLabel label="计划类型" />
                <select aria-label="计划类型" className={selectClass} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setSaved(false) }} disabled={busy}>
                  {kind === 'legacy' ? <option value="legacy">历史未分类</option> : null}
                  <option value="outline">大纲</option><option value="detail">细纲</option>
                </select>
              </label>
              <p className="text-xs text-[var(--text-secondary)]">正文约 {wordCount} 字</p>
            </section>

            {kind === 'detail' ? <section className="space-y-3 rounded-[18px] border border-[var(--border-subtle)] p-4">
              <h4 className="text-sm font-semibold">关联设置</h4>
              <p className="text-xs text-[var(--text-secondary)]">{plan.reviewState === 'stale' ? '待复核' : plan.reviewState === 'missing_parent' ? '父大纲已移除' : plan.reviewState === 'current' ? '已关联' : '未关联'}</p>
              <label className="block space-y-2"><InputLabel label="父大纲" />
                <select aria-label="父大纲" className={selectClass} value={parentId} disabled={busy} onChange={event => { setParentId(event.target.value); setReviewed(false); setParentRead(false); setSaved(false) }}>
                  <option value="">未关联</option>
                  {parentId && !parent ? <option value={parentId}>父大纲已移除</option> : null}
                  {plans.filter(item => item.planKind === 'outline' && item.backendArtifactId && item.id !== plan.id).map(item => <option key={item.id} value={item.backendArtifactId!}>{item.title}</option>)}
                </select>
              </label>
              <label className="block space-y-2"><InputLabel label="目标章节" />
                <select aria-label="目标章节" className={selectClass} value={targetId} disabled={busy} onChange={event => { setTargetId(event.target.value); setSaved(false) }}>
                  <option value="">未关联</option>
                  {targetId && targetId !== 'future' && !chapters.some(chapter => chapter.id === targetId) ? <option value={targetId}>章节已移除</option> : null}
                  {[...chapters].sort((a,b) => a.orderIndex - b.orderIndex).map(chapter => <option key={chapter.id} value={chapter.id}>第 {chapter.orderIndex} 章 · {chapter.title}</option>)}
                  <option value="future">未来章节</option>
                </select>
              </label>
              {targetId === 'future' ? <label className="block space-y-2"><InputLabel label="全书章节序号" /><TextInput aria-label="全书章节序号" type="number" min={1} max={2147483647} step={1} value={futureOrder} onChange={event => { setFutureOrder(event.target.value); setSaved(false) }} /></label> : null}
              {parentSnapshot ? <details key={parentSnapshot.planHash} onToggle={event => { if (event.currentTarget.open) setParentRead(true) }}>
                <summary className="cursor-pointer text-sm">阅读父大纲：{parentSnapshot.title}</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{parentSnapshot.content}</pre>
              </details> : null}
              {parentSnapshot && needsReview ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={!parentRead || busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已阅读并确认依照当前大纲</label> : null}
            </section> : null}
            {/* 分组二：危险操作 */}
            <section className="space-y-3 rounded-[18px] border border-[rgba(190,18,60,0.25)] p-4">
              <h4 className="text-sm font-semibold text-[rgb(153,27,27)]">危险操作</h4>
              <p className="text-xs leading-5 text-[var(--text-secondary)]">
                删除后这份计划会从计划文件夹移除，Agent 将无法再读取其中的内容。
              </p>
              <Button
                onClick={onRequestDelete}
                variant="ghost"
                size="sm"
                className="text-[rgb(153,27,27)] hover:bg-[rgba(127,29,29,0.08)] hover:text-[rgb(127,29,29)]"
              >
                <Trash2 className="h-4 w-4" />
                删除这份计划
              </Button>
            </section>
          </div>

          <div className="mt-4 flex items-center justify-end border-t border-[var(--border-subtle)] pt-4">
            {error ? <p role="alert" className="mr-auto text-sm text-[rgb(153,27,27)]">{error}</p> : null}
            {saved ? <p role="status" className="mr-auto text-sm">已保存</p> : null}
            <Button onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : reviewed ? '保存并确认复核' : '保存'}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
