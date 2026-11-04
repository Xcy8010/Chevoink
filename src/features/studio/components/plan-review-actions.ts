import type { Dispatch, SetStateAction } from 'react'
import { updateNovelPlanFile } from '../api'
import { useAgentStore } from '../agent/agentStore'
import { buildReviewDiff, resolveReviewHunk } from './diff'
import type { AgentArtifact, PlanPendingReview, SaveState, WorkspaceConfirmation, WorkspacePlanFile } from '../types'

type PlanReviewActions = {
  savedPlanFiles?: WorkspacePlanFile[]
  isCurrentNovel?: () => boolean
  onSaved?: () => void
  pendingPlanReview: PlanPendingReview | null
  pendingPlanReviewBusy: boolean
  setPendingPlanReview: Dispatch<SetStateAction<PlanPendingReview | null>>
  setPendingPlanReviewBusy: Dispatch<SetStateAction<boolean>>
  setServerPlanFiles: Dispatch<SetStateAction<WorkspacePlanFile[]>>
  setAgentArtifacts: Dispatch<SetStateAction<AgentArtifact[]>>
  setSelectedTreeItemId: Dispatch<SetStateAction<string | null>>
  setChapterSaveState: Dispatch<SetStateAction<SaveState>>
  setChapterSaveMessage: Dispatch<SetStateAction<string>>
  setWorkspaceDialog: (dialog: WorkspaceConfirmation) => void
}

/** Plan review decisions, preserving confirmation and server-write ordering. */
export function createPlanReviewActions({
  savedPlanFiles = [], isCurrentNovel = () => true, onSaved, pendingPlanReview, pendingPlanReviewBusy, setPendingPlanReview, setPendingPlanReviewBusy, setServerPlanFiles, setAgentArtifacts, setSelectedTreeItemId, setChapterSaveState, setChapterSaveMessage, setWorkspaceDialog,
}: PlanReviewActions) {
  function handleKeepPendingPlanReview() {
    if (!pendingPlanReview || pendingPlanReviewBusy) {
      return
    }
    useAgentStore.getState().markWorkspaceActivitiesAccepted({ toolNames: ['plan_save'] })
    setPendingPlanReview(null)
    setChapterSaveState('saved')
    setChapterSaveMessage(`已保留对计划《${pendingPlanReview.title}》的修订。`)
  }

  async function handleRevertPendingPlanReview() {
    if (!pendingPlanReview || pendingPlanReviewBusy) {
      return
    }

    const review = pendingPlanReview
    setPendingPlanReviewBusy(true)
    try {
      // 新建计划的撤销：直接从计划夹移除，而非回写空内容
      if (review.isCreate) {
        await updateNovelPlanFile(review.backendArtifactId, { saved: false })

        if (!isCurrentNovel()) return
        onSaved?.()
        setServerPlanFiles((current) =>
          current.filter((plan) => plan.backendArtifactId !== review.backendArtifactId),
        )
        setAgentArtifacts((current) =>
          current.map((artifact) =>
            artifact.backendArtifactId === review.backendArtifactId
              ? { ...artifact, savedAsPlan: false }
              : artifact,
          ),
        )
        setSelectedTreeItemId((current) =>
          current && current.startsWith('plan:') ? null : current,
        )

        setPendingPlanReview(null)
        setChapterSaveState('saved')
        setChapterSaveMessage(`已撤销新建的计划《${review.title}》。`)
        return
      }

      const planHash = savedPlanFiles.find(plan => plan.backendArtifactId === review.backendArtifactId)?.planHash
      const item = await updateNovelPlanFile(review.backendArtifactId, {
        title: review.beforeTitle,
        content: review.before,
        ...(planHash ? { expectedPlanHash: planHash } : {}),
      })
      if (!isCurrentNovel()) return
      onSaved?.()

      // 本地计划夹/产物列表同步回修订前的内容
      setServerPlanFiles((current) =>
        current.map((plan) =>
          plan.backendArtifactId === review.backendArtifactId
            ? { ...plan, planHash: item?.planHash ?? plan.planHash, localDraft: undefined, hasRemoteConflict: false,
                savedSnapshot: item?.planHash ? { title: review.beforeTitle, content: review.before, planHash: item.planHash } : undefined,
                title: review.beforeTitle, content: review.before }
            : plan,
        ),
      )
      setAgentArtifacts((current) =>
        current.map((artifact) =>
          artifact.backendArtifactId === review.backendArtifactId
            ? {
                ...artifact,
                title: review.beforeTitle,
                content: review.before,
                rawContent: review.before,
                planLocalDraft: undefined,
              }
            : artifact,
        ),
      )

      setPendingPlanReview(null)
      setChapterSaveState('saved')
      setChapterSaveMessage(`计划《${review.beforeTitle}》已恢复到本次修订前。`)
    } catch (error) {
      if (!isCurrentNovel()) return
      setChapterSaveState('error')
      setChapterSaveMessage(
        error instanceof Error ? error.message : '撤销计划修订失败，请稍后重试。',
      )
    } finally {
      if (isCurrentNovel()) setPendingPlanReviewBusy(false)
    }
  }

  function handleRequestRejectPendingPlanReview() {
    if (!pendingPlanReview || pendingPlanReviewBusy) {
      return
    }

    setWorkspaceDialog({
      title: pendingPlanReview.isCreate ? '撤销这份新建的计划？' : '撤销本次计划修订？',
      description: pendingPlanReview.isCreate
        ? `《${pendingPlanReview.title}》是 AI 本次新建的计划，撤销后会从计划文件夹移除。`
        : `《${pendingPlanReview.title}》将恢复到本次修订前的内容，AI 新写的这部分计划会被移除。`,
      confirmLabel: '撤销修订',
      cancelLabel: '再想想',
      tone: 'danger',
      onConfirm: () => handleRevertPendingPlanReview(),
    })
  }

  // 计划块级采纳（片段右下角✓）：把该变更块写进审查基线；全部块定夺完毕即视为整份保留
  function handleAcceptPlanReviewHunk(hunkIndex: number) {
    const review = pendingPlanReview
    if (!review || pendingPlanReviewBusy) {
      return
    }

    const resolved = resolveReviewHunk(review.before, review.after, hunkIndex, 'accept')
    if (buildReviewDiff(resolved.before, review.after).hunkCount === 0) {
      handleKeepPendingPlanReview()
      return
    }

    setPendingPlanReview({ ...review, before: resolved.before })
  }

  // 计划块级撤回：把该变更块从计划内容中还原并回写云端；全部块定夺完毕即结束审查
  async function handleRejectPlanReviewHunk(hunkIndex: number) {
    const review = pendingPlanReview
    if (!review || pendingPlanReviewBusy) {
      return
    }

    const { hunkCount } = buildReviewDiff(review.before, review.after)
    // 新建计划只剩这一个变更块时，撤回等价于撤销整份新建计划
    if (review.isCreate && hunkCount <= 1) {
      await handleRevertPendingPlanReview()
      return
    }

    const resolved = resolveReviewHunk(review.before, review.after, hunkIndex, 'reject')
    setPendingPlanReviewBusy(true)
    try {
      const planHash = savedPlanFiles.find(plan => plan.backendArtifactId === review.backendArtifactId)?.planHash
      const item = await updateNovelPlanFile(review.backendArtifactId, { content: resolved.after, ...(planHash ? { expectedPlanHash: planHash } : {}) })
      if (!isCurrentNovel()) return
      onSaved?.()

      // 本地计划夹/产物列表同步到撤回后的内容
      setServerPlanFiles((current) =>
        current.map((plan) =>
          plan.backendArtifactId === review.backendArtifactId
            ? { ...plan, planHash: item?.planHash ?? plan.planHash, localDraft: undefined, hasRemoteConflict: false,
                savedSnapshot: item?.planHash ? { title: plan.title, content: resolved.after, planHash: item.planHash } : undefined,
                content: resolved.after }
            : plan,
        ),
      )
      setAgentArtifacts((current) =>
        current.map((artifact) =>
          artifact.backendArtifactId === review.backendArtifactId
            ? { ...artifact, content: resolved.after, rawContent: resolved.after, planLocalDraft: undefined }
            : artifact,
        ),
      )

      if (buildReviewDiff(review.before, resolved.after).hunkCount === 0) {
        setPendingPlanReview(null)
        setChapterSaveState('saved')
        setChapterSaveMessage(`已撤回该处变更，计划《${review.title}》审查完成。`)
      } else {
        setPendingPlanReview({ ...review, after: resolved.after })
        setChapterSaveState('saved')
        setChapterSaveMessage('已撤回该处计划变更。')
      }
    } catch (error) {
      if (!isCurrentNovel()) return
      setChapterSaveState('error')
      setChapterSaveMessage(error instanceof Error ? error.message : '撤回该处计划变更失败，请稍后重试。')
    } finally {
      if (isCurrentNovel()) setPendingPlanReviewBusy(false)
    }
  }

  // 计划块级✕撤回入口：自定义弹窗确认后才真正回滚该处片段
  function handleRequestRejectPlanReviewHunk(hunkIndex: number) {
    if (!pendingPlanReview || pendingPlanReviewBusy) {
      return
    }

    setWorkspaceDialog({
      title: '撤回这一处计划变更？',
      description: '这一处绿色/红色片段将恢复为 AI 修订前的内容，撤回后不可恢复。',
      confirmLabel: '撤回',
      cancelLabel: '再想想',
      tone: 'danger',
      onConfirm: () => handleRejectPlanReviewHunk(hunkIndex),
    })
  }
  return { handleKeepPendingPlanReview, handleRevertPendingPlanReview, handleRequestRejectPendingPlanReview, handleAcceptPlanReviewHunk, handleRequestRejectPlanReviewHunk }
}
