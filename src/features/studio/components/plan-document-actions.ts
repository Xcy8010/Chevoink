import type { PlanMetadataPatch } from '../../../../shared/contracts/novel-plans'
import type { Dispatch, SetStateAction } from 'react'
import { createNovelPlanFile, updateNovelPlanFile } from '../api'
import { buildServerPlanFile, getSavedPlanSnapshot } from '../lib/plan-review'
import type { AgentArtifact, AgentRunState, MobileView, SaveState, WorkspacePlanFile } from '../types'

type PlanDocumentActions = {
  onPlansChanged?: () => void
  syncScope?: string
  isCurrentNovel?: () => boolean
  onRequestCreate?: () => void
  savePlanMetadata?: (artifactId: string, patch: PlanMetadataPatch & { title?: string }, novelId?: string) => Promise<unknown>
  activeNovelId: string
  savedPlanFiles: WorkspacePlanFile[]
  agentArtifacts: AgentArtifact[]
  selectedTreeItemId: string | null
  catalogPreview: { title: string; content: string }
  setSelectedTreeItemId: Dispatch<SetStateAction<string | null>>
  setWorkViewer: Dispatch<SetStateAction<'chapter' | 'document' | null>>
  setMobileView: Dispatch<SetStateAction<MobileView>>
  setActiveAgentArtifactId: Dispatch<SetStateAction<string | null>>
  setAgentArtifacts: Dispatch<SetStateAction<AgentArtifact[]>>
  setServerPlanFiles: Dispatch<SetStateAction<WorkspacePlanFile[]>>
  setChapterSaveState: Dispatch<SetStateAction<SaveState>>
  setChapterSaveMessage: Dispatch<SetStateAction<string>>
  setAgentRunState: Dispatch<SetStateAction<AgentRunState>>
  setWorkspaceDialog: (dialog: { title: string; description: string; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger'; onConfirm: () => void | Promise<void> }) => void
  setCatalogDocument: Dispatch<SetStateAction<{ title: string; content: string; manualTitle: boolean; manualContent: boolean } | null>>
  updateAgentArtifact: (id: string, updater: (current: AgentArtifact) => AgentArtifact) => void
  schedulePlanServerSync: (artifactId: string, title: string, content?: string, expectedPlanHash?: string, novelId?: string) => void
}

/** Plan/catalog editing and confirmations. Does not own the editor's current chapter. */
export function createPlanDocumentActions({
  onPlansChanged, syncScope, isCurrentNovel = () => true, onRequestCreate, savePlanMetadata, activeNovelId, savedPlanFiles, agentArtifacts, selectedTreeItemId, catalogPreview, setSelectedTreeItemId, setWorkViewer, setMobileView, setActiveAgentArtifactId, setAgentArtifacts, setServerPlanFiles, setChapterSaveState, setChapterSaveMessage, setAgentRunState, setWorkspaceDialog, setCatalogDocument, updateAgentArtifact, schedulePlanServerSync,
}: PlanDocumentActions) {
  function handleSelectPlanFromTree(planId: string) {
    const artifactId = savedPlanFiles.find(plan => plan.id === planId)?.artifactId ?? planId
    setSelectedTreeItemId(`plan:${planId}`)
    setWorkViewer('document')
    if (agentArtifacts.some((artifact) => artifact.id === artifactId)) {
      setActiveAgentArtifactId(artifactId)
    }
    setMobileView('editor')
  }

  function handleRequestDeletePlan(planId: string) {
    const targetPlan = savedPlanFiles.find((plan) => plan.id === planId)

    if (!targetPlan) {
      return
    }

    const targetArtifact =
      agentArtifacts.find((artifact) => artifact.id === targetPlan.artifactId && artifact.savedAsPlan) ?? null
    const planTitle = targetPlan.title.trim() || '这份计划'
    if (targetArtifact) {
      setActiveAgentArtifactId(targetArtifact.id)
    }

    setWorkspaceDialog({
      title: '确认删除这份计划',
      description: `删除后，“${planTitle}”会从左侧计划文件夹移除，但不会影响这轮 Agent 对话记录。`,
      confirmLabel: '确认删除',
      cancelLabel: '取消',
      tone: 'danger',
      onConfirm: async () => {
        if (!isCurrentNovel()) return
        if (targetPlan.backendArtifactId) {
          try { await updateNovelPlanFile(targetPlan.backendArtifactId, { saved: false }) }
          catch (error) {
            if (!isCurrentNovel()) return
            setChapterSaveState('error')
            setChapterSaveMessage(error instanceof Error ? error.message : '删除失败，请重试。')
            throw error
          }
        }
        if (!isCurrentNovel()) return
        if (targetArtifact) setAgentArtifacts(current => current.map(artifact => artifact.id === targetArtifact.id ? { ...artifact, savedAsPlan: false } : artifact))
        setServerPlanFiles(current => current.filter(plan => targetPlan.backendArtifactId ? plan.backendArtifactId !== targetPlan.backendArtifactId : plan.id !== planId))
        onPlansChanged?.()
        setChapterSaveState('saved')
        setChapterSaveMessage('这份计划已从计划文件夹移除。')
        setAgentRunState((current) => ({
          ...current,
          statusText: '已删除这份计划。',
        }))
      },
    })
  }

  /** 手工新建空白计划：落到云端后直接选中，作者可在编辑区改名/补充内容 */
  async function handleCreatePlanFile(planKind: 'outline' | 'detail' = 'outline') {
    setChapterSaveState('saving')
    setChapterSaveMessage('正在新建计划...')

    try {
      const item = await createNovelPlanFile(activeNovelId, undefined, { planKind })
      if (!isCurrentNovel()) return
      const nextPlan = buildServerPlanFile(item)
      setServerPlanFiles((current) => [...current, nextPlan])
      onPlansChanged?.()
      setSelectedTreeItemId(`plan:${nextPlan.id}`)
      setMobileView('editor')
      setWorkViewer('document')
      setChapterSaveState('saved')
      setChapterSaveMessage('已新建一份空白计划，可直接改名或补充内容。')
    } catch (error) {
      if (!isCurrentNovel()) return
      setChapterSaveState('error')
      setChapterSaveMessage(error instanceof Error ? error.message : '新建计划失败，请稍后重试。')
      throw error
    }
  }

  function handleRequestCreatePlan() {
    if (onRequestCreate) { onRequestCreate(); return }
    setWorkspaceDialog({
      title: '确认新建计划',
      description: '将会在计划文件夹新建一份空白计划，Agent 后续可直接读取它。确定现在新建吗？',
      confirmLabel: '确认新建',
      cancelLabel: '取消',
      tone: 'default',
      onConfirm: async () => {
        await handleCreatePlanFile()
      },
    })
  }

  /** 计划设置面板内改名：本地产物与云端列表同步更新，再去抖 PATCH */
  function handleRenamePlan(planId: string, nextTitle: string) {
    const targetPlan = savedPlanFiles.find((plan) => plan.id === planId)

    if (!targetPlan) {
      return
    }

    updateAgentArtifact(targetPlan.artifactId, (current) => ({
      ...current,
      title: nextTitle.trim() || current.title,
    }))
    setServerPlanFiles((current) =>
      current.map((plan) =>
        plan.id === planId ||
        Boolean(targetPlan.backendArtifactId && plan.backendArtifactId === targetPlan.backendArtifactId)
          ? { ...plan, title: nextTitle.trim() || plan.title }
          : plan,
      ),
    )
    if (targetPlan.backendArtifactId) {
      schedulePlanServerSync(
        targetPlan.backendArtifactId,
        nextTitle.trim() || targetPlan.title,
        undefined,
        undefined,
        syncScope ?? activeNovelId,
      )
    }
    setChapterSaveState('saved')
    setChapterSaveMessage('计划名称已更新。')
  }


  function handleWorkspaceDocumentChange(next: { title: string; content: string }) {
    if (selectedTreeItemId === 'catalog') {
      setCatalogDocument((current) => {
        const fallbackTitle = current?.title ?? catalogPreview.title
        const nextTitle = next.title || fallbackTitle

        return {
          title: nextTitle,
          content: next.content,
          manualTitle: Boolean(nextTitle.trim()) && nextTitle.trim() !== catalogPreview.title,
          manualContent: next.content.trim() !== catalogPreview.content.trim(),
        }
      })
      setChapterSaveState('saved')
      setChapterSaveMessage('目录已更新。')
      return
    }

    if (selectedTreeItemId?.startsWith('plan:')) {
      const artifactId = selectedTreeItemId.slice('plan:'.length)
      const targetPlan = savedPlanFiles.find((plan) => plan.id === artifactId)
      updateAgentArtifact(targetPlan?.artifactId ?? artifactId, (current) => ({
        ...current,
        title: next.title.trim() || current.title,
        content: next.content,
        rawContent: next.content,
        planLocalDraft: current.planLocalDraft ?? { basePlanHash: targetPlan?.planHash },
      }))
      setServerPlanFiles((current) =>
        current.map((plan) =>
          plan.id === artifactId ||
          Boolean(targetPlan?.backendArtifactId && plan.backendArtifactId === targetPlan.backendArtifactId)
            ? { ...plan, title: next.title.trim() || plan.title, content: next.content,
                planHash: plan.localDraft?.basePlanHash ?? targetPlan?.planHash,
                localDraft: plan.localDraft ?? { basePlanHash: targetPlan?.planHash },
                savedSnapshot: getSavedPlanSnapshot(plan) ?? (targetPlan ? getSavedPlanSnapshot(targetPlan) ?? undefined : undefined),
                hasRemoteConflict: Boolean(getSavedPlanSnapshot(plan)?.planHash && getSavedPlanSnapshot(plan)?.planHash !== (plan.localDraft?.basePlanHash ?? targetPlan?.planHash)) }
            : plan,
        ),
      )
      if (targetPlan?.backendArtifactId) {
        schedulePlanServerSync(
          targetPlan.backendArtifactId,
          next.title.trim() || targetPlan.title,
          next.content,
          targetPlan.planHash,
          syncScope ?? activeNovelId,
        )
      }
      setChapterSaveState('saved')
      setChapterSaveMessage('创作计划已更新。')
    }
  }
  async function handleSavePlanSettings(planId: string, patch: PlanMetadataPatch & { title?: string }) {
    const plan = savedPlanFiles.find(item => item.id === planId)
    if (!plan?.backendArtifactId || !savePlanMetadata) throw new Error('计划尚未保存，请稍后重试。')
    await savePlanMetadata(plan.backendArtifactId, { ...patch, expectedPlanHash: plan.planHash }, syncScope ?? activeNovelId)
    if (!isCurrentNovel()) return
    if (patch.title !== undefined) setServerPlanFiles(current => current.map(item => item.backendArtifactId === plan.backendArtifactId ? { ...item, title: patch.title!.trim() || item.title } : item))
    if (patch.title !== undefined) updateAgentArtifact(plan.artifactId, current => ({ ...current, title: patch.title!.trim() || current.title }))
  }
  return { handleCreatePlanFile, handleSavePlanSettings, handleSelectPlanFromTree, handleRequestDeletePlan, handleRequestCreatePlan, handleRenamePlan, handleWorkspaceDocumentChange }
}
