import { useEffect, useId, useState } from 'react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import type { PlanMetadataPatch } from '../../../../shared/contracts/novel-plans'
import type { StudioPayload } from '../../../../shared/contracts/index'
import type { WorkspacePlanFile } from '../types'
import { getSavedPlanSnapshot } from '../lib/plan-review'
import { formatNumberedChapterTitle } from '../lib/document-title'
import StudioDocumentSettingsDrawer from './StudioDocumentSettingsDrawer'

type PlanSettingsPanelProps = {
  plan: WorkspacePlanFile
  onRename: (title: string) => void
  plans?: WorkspacePlanFile[]
  chapters?: StudioPayload['chapters']
  onSave?: (patch: PlanMetadataPatch & { title?: string }) => Promise<void>
  onRequestDelete: () => void
  onClose: () => void
  /** 沉浸区可以单独设置遮罩层级。 */
  overlayClassName?: string
}

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
  const titleId = useId()
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

  const reviewLabel = plan.reviewState === 'stale' ? '待复核' : plan.reviewState === 'missing_parent' ? '父大纲已移除' : plan.reviewState === 'current' ? '已关联' : '未关联'

  return (
    <StudioDocumentSettingsDrawer
      title="计划设置"
      documentName={title.trim() || plan.title.trim() || '未命名计划'}
      insetOnMobile
      onClose={onClose}
      overlayClassName={overlayClassName ?? 'z-40 lg:z-[90]'}
      deleteAction={{ label: '删除这份计划', description: '删除后这份计划会从计划文件夹移除，Agent 将无法再读取其中的内容。', onClick: onRequestDelete }}
      footer={<>
        {error && <p role="alert" className="document-settings-error">{error}</p>}
        {saved && <p role="status" className="document-settings-note">已保存</p>}
        <Button onClick={() => void save()} variant="primary" className="shrink-0 rounded-lg" disabled={busy}>
          {busy ? '保存中…' : reviewed ? '保存并确认复核' : '保存'}
        </Button>
      </>}
    >
      <div className="document-settings-columns document-settings-columns--primary">
        <div className="document-settings-field">
          <label htmlFor={titleId} className="document-settings-label">计划标题</label>
          <TextInput
            id={titleId}
            wrapperAs="span"
            value={title}
            onChange={(event) => { setTitle(event.target.value); setSaved(false) }}
            placeholder="例如：第 21 章细纲"
            className="rounded-lg px-3"
          />
          <p className="document-settings-note">正文约 {wordCount} 字</p>
        </div>
        <label className="document-settings-field">
          <span className="document-settings-label">计划类型</span>
          <select className="document-settings-select" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setSaved(false) }} disabled={busy}>
            {kind === 'legacy' && <option value="legacy">历史未分类</option>}
            <option value="outline">大纲</option>
            <option value="detail">细纲</option>
          </select>
        </label>
      </div>

      {kind === 'detail' && <section className="document-settings-section">
        <div className="flex items-center justify-between gap-3">
          <h3 className="document-settings-label">关联设置</h3>
          <span className="document-settings-note">{reviewLabel}</span>
        </div>
        <div className="document-settings-columns">
          <label className="document-settings-field">
            <span className="document-settings-label">父大纲</span>
            <select className="document-settings-select" value={parentId} disabled={busy} onChange={event => {
              setParentId(event.target.value); setReviewed(false); setParentRead(false); setSaved(false)
            }}>
              <option value="">未关联</option>
              {parentId && !parent && <option value={parentId}>父大纲已移除</option>}
              {plans.filter(item => item.planKind === 'outline' && item.backendArtifactId && item.id !== plan.id).map(item =>
                <option key={item.id} value={item.backendArtifactId!}>{item.title}</option>)}
            </select>
          </label>
          <div className="grid content-start gap-3">
            <label className="document-settings-field">
              <span className="document-settings-label">目标章节</span>
              <select className="document-settings-select" value={targetId} disabled={busy} onChange={event => { setTargetId(event.target.value); setSaved(false) }}>
                <option value="">未关联</option>
                {targetId && targetId !== 'future' && !chapters.some(chapter => chapter.id === targetId) && <option value={targetId}>章节已移除</option>}
                {[...chapters].sort((a, b) => a.orderIndex - b.orderIndex).map(chapter =>
                  <option key={chapter.id} value={chapter.id}>{formatNumberedChapterTitle(chapter.title, chapter.orderIndex)}</option>)}
                <option value="future">未来章节</option>
              </select>
            </label>
            {targetId === 'future' && <label className="document-settings-field">
              <span className="document-settings-label">全书章节序号</span>
              <TextInput wrapperAs="span" className="rounded-lg px-3" type="number" min={1} max={2147483647} step={1} value={futureOrder}
                onChange={event => { setFutureOrder(event.target.value); setSaved(false) }} />
            </label>}
          </div>
        </div>
        {parentSnapshot && <details key={parentSnapshot.planHash} onToggle={event => { if (event.currentTarget.open) setParentRead(true) }}>
          <summary tabIndex={0} className="cursor-pointer text-sm">阅读父大纲：{parentSnapshot.title}</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6">{parentSnapshot.content}</pre>
        </details>}
        {parentSnapshot && needsReview && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!parentRead || busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
          已阅读并确认依照当前大纲
        </label>}
      </section>}
    </StudioDocumentSettingsDrawer>
  )
}
