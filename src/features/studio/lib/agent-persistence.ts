/**
 * 创作区本地快照与 Agent 历史产物还原
 * 由 StudioWorkspace.tsx 模块级拆分而来（声明顺序与原文件一致）。
 */
import type { AgentActionHandoff, AgentActionPlan, AgentExecutionAgent, AgentExecutionMode, AgentRouteDecision, AgentRuleBundle, AgentStoryMemoryDigest, AgentWorkspaceToolPolicy } from '../../../../shared/contracts/index.js'
import type { AgentSessionHistoryItem } from '../api'
import type { AgentArtifact, AgentRunStatusItem, AgentTaskType } from '../types'
import type { StoredAgentTaskWindowSnapshot, StoredAgentWorkspaceSnapshot } from './workspace-types.js'
import { DEFAULT_AGENT_TASK_TITLE, createLocalAgentTaskWindow, getAgentWorkspaceStorageKey } from './agent-session.js'



export function readStoredAgentWorkspace(novelId: string): StoredAgentWorkspaceSnapshot | null {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(getAgentWorkspaceStorageKey(novelId))
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as
      | (StoredAgentWorkspaceSnapshot & {
          sessionId?: string | null
          prompt?: string
          artifacts?: AgentArtifact[]
          activeArtifactId?: string | null
        })
      | null

    const tasks = Array.isArray(parsed?.tasks)
      ? parsed.tasks
          .filter((task): task is StoredAgentTaskWindowSnapshot => Boolean(task && typeof task === 'object'))
          .map((task) =>
            createLocalAgentTaskWindow({
              ...task,
              id: typeof task.id === 'string' ? task.id : undefined,
              sessionId: typeof task.sessionId === 'string' ? task.sessionId : null,
              title: typeof task.title === 'string' ? task.title : DEFAULT_AGENT_TASK_TITLE,
              prompt: typeof task.prompt === 'string' ? task.prompt : '',
              artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
              activeArtifactId: typeof task.activeArtifactId === 'string' ? task.activeArtifactId : null,
              loaded: Boolean(task.loaded),
              temporary: Boolean(task.temporary),
              customNamed: Boolean(task.customNamed),
              firstPromptSubmitted: Boolean(task.firstPromptSubmitted),
            }),
          )
      : Array.isArray(parsed?.artifacts)
        ? [
            createLocalAgentTaskWindow({
              id: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
              sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
              title: DEFAULT_AGENT_TASK_TITLE,
              prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
              artifacts: parsed.artifacts,
              activeArtifactId: typeof parsed.activeArtifactId === 'string' ? parsed.activeArtifactId : null,
              loaded: true,
              temporary: !parsed.sessionId,
            }),
          ]
        : []

    return {
      tasks,
      activeTaskId: typeof parsed?.activeTaskId === 'string' ? parsed.activeTaskId : tasks[0]?.id ?? null,
      selectedTreeItemId: typeof parsed?.selectedTreeItemId === 'string' ? parsed.selectedTreeItemId : null,
      catalogDocument:
        parsed?.catalogDocument && typeof parsed.catalogDocument === 'object'
          ? {
              title: typeof parsed.catalogDocument.title === 'string' ? parsed.catalogDocument.title : '目录',
              content: typeof parsed.catalogDocument.content === 'string' ? parsed.catalogDocument.content : '',
              manualTitle: Boolean(parsed.catalogDocument.manualTitle),
              manualContent: Boolean(parsed.catalogDocument.manualContent),
            }
          : null,
    }
  } catch {
    return null
  }
}



export function mapHistoryActionToTask(action: AgentSessionHistoryItem['run']['action']): AgentTaskType {
  switch (action) {
    case 'planChapter':
      return 'plan-chapter'
    case 'draftChapter':
      return 'draft-chapter'
    case 'continueChapter':
      return 'continue-chapter'
    case 'rewriteSelection':
      return 'rewrite-selection'
    case 'polishSelection':
      return 'polish-selection'
    case 'reviewContinuity':
      return 'review-continuity'
    case 'generateCoverPrompt':
      return 'generate-cover-prompt'
    default:
      return 'workspace-agent'
  }
}



export function mapHistoryArtifactType(
  artifactType: AgentSessionHistoryItem['artifacts'][number]['artifactType'],
): AgentArtifact['type'] {
  switch (artifactType) {
    case 'chapterPlan':
      return 'chapter_plan'
    case 'coverPrompt':
      return 'cover_prompt'
    case 'continuityReview':
      return 'review_report'
    default:
      return 'draft_text'
  }
}



export function asArtifactActionPlan(value: unknown): AgentActionPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentActionPlan>
  if (
    (candidate.mode !== 'plan' && candidate.mode !== 'execute' && candidate.mode !== 'review') ||
    typeof candidate.summary !== 'string' ||
    !Array.isArray(candidate.steps)
  ) {
    return null
  }

  return candidate as AgentActionPlan
}



export function asArtifactHandoff(value: unknown): AgentActionHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentActionHandoff>
  if (
    (candidate.sourceMode !== 'plan' && candidate.sourceMode !== 'build' && candidate.sourceMode !== 'review') ||
    (candidate.targetMode !== 'plan' && candidate.targetMode !== 'build' && candidate.targetMode !== 'review') ||
    typeof candidate.title !== 'string' ||
    typeof candidate.summary !== 'string' ||
    typeof candidate.confirmLabel !== 'string'
  ) {
    return null
  }

  return candidate as AgentActionHandoff
}



export function asArtifactExecutionMode(value: unknown): AgentExecutionMode | null {
  return value === 'plan' || value === 'build' || value === 'review' ? value : null
}



export function asArtifactExecutionAgent(value: unknown): AgentExecutionAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentExecutionAgent>
  if (
    (candidate.agentType !== 'writingOrchestrator' &&
      candidate.agentType !== 'storyPlanner' &&
      candidate.agentType !== 'draftWriter' &&
      candidate.agentType !== 'continuityEditor' &&
      candidate.agentType !== 'styleEditor' &&
      candidate.agentType !== 'loreLibrarian' &&
      candidate.agentType !== 'coverPromptAgent') ||
    (candidate.role !== 'primary' && candidate.role !== 'specialist') ||
    typeof candidate.title !== 'string' ||
    typeof candidate.description !== 'string'
  ) {
    return null
  }

  return candidate as AgentExecutionAgent
}



export function asArtifactRouteDecision(value: unknown): AgentRouteDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentRouteDecision>
  if (
    !asArtifactExecutionAgent(candidate.sourceAgent) ||
    !asArtifactExecutionAgent(candidate.targetAgent) ||
    typeof candidate.task !== 'string' ||
    typeof candidate.intentLabel !== 'string' ||
    typeof candidate.summary !== 'string'
  ) {
    return null
  }

  return candidate as AgentRouteDecision
}



export function buildHistoryStatusItems(
  actionPlan: AgentActionPlan | null,
  routeDecision: AgentRouteDecision | null,
  runId: string,
  createdAt: string,
): AgentRunStatusItem[] {
  const thinkingItems = Array.isArray(actionPlan?.thinking)
    ? actionPlan.thinking
        .map((item, index) =>
          typeof item === 'string' && item.trim()
            ? {
                id: `${runId}-thinking-${index + 1}`,
                event: 'task.thinking',
                text: item.trim(),
                createdAt,
              }
            : null,
        )
        .filter((item): item is AgentRunStatusItem => Boolean(item))
    : []
  const stepItems =
    actionPlan?.steps.flatMap((step, index) => {
      const reasoning =
        typeof step.payload?.reasoning === 'string' && step.payload.reasoning.trim()
          ? [
              {
                id: `${runId}-step-thinking-${index + 1}`,
                event: 'task.thinking',
                text: step.payload.reasoning.trim(),
                createdAt,
              } satisfies AgentRunStatusItem,
            ]
          : []

      const title =
        typeof step.title === 'string' && step.title.trim() ? step.title.trim() : '按顺序执行一项工作台操作。'

      return [
        ...reasoning,
        {
          id: `${runId}-step-${index + 1}`,
          event: 'task.step',
          text: title,
          createdAt,
        } satisfies AgentRunStatusItem,
      ]
    }) ?? []

  if (thinkingItems.length > 0 || stepItems.length > 0) {
    return [
      ...(actionPlan?.summary?.trim()
        ? [
            {
              id: `${runId}-task-summary`,
              event: 'task.decomposed',
              text: actionPlan.summary.trim(),
              createdAt,
            } satisfies AgentRunStatusItem,
          ]
        : []),
      ...thinkingItems,
      ...stepItems,
    ]
  }

  if (!routeDecision) {
    return []
  }

  return [
    {
      id: `${runId}-route-decided`,
      event: 'route.decided',
      text: routeDecision.summary,
      createdAt,
    },
  ]
}



export function asArtifactToolPolicy(value: unknown): AgentWorkspaceToolPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentWorkspaceToolPolicy>
  if (
    (candidate.mode !== 'plan' && candidate.mode !== 'build' && candidate.mode !== 'review') ||
    !Array.isArray(candidate.tools)
  ) {
    return null
  }

  return candidate as AgentWorkspaceToolPolicy
}



export function asArtifactRuleBundle(value: unknown): AgentRuleBundle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentRuleBundle>
  if (typeof candidate.summary !== 'string' || !Array.isArray(candidate.rules)) {
    return null
  }

  return candidate as AgentRuleBundle
}



export function asArtifactStoryMemoryDigest(value: unknown): AgentStoryMemoryDigest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<AgentStoryMemoryDigest>
  if (typeof candidate.summary !== 'string' || !Array.isArray(candidate.items)) {
    return null
  }

  return candidate as AgentStoryMemoryDigest
}



export function mapRunModeToExecutionMode(mode: 'plan' | 'act' | 'review'): AgentExecutionMode {
  return mode === 'act' ? 'build' : mode
}



export function buildArtifactsFromHistory(items: AgentSessionHistoryItem[]): AgentArtifact[] {
  return items.flatMap((item) => {
    const task = mapHistoryActionToTask(item.run.action)
    const promptText =
      typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt : item.run.inputSummary ?? ''

    return item.artifacts.map((artifact) => {
      const actionPlan =
        item.actionPlan ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactActionPlan((artifact.metadata as Record<string, unknown>).actionPlan)
          : null)
      const handoff =
        item.handoff ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactHandoff((artifact.metadata as Record<string, unknown>).handoff)
          : null)
      const executionMode =
        item.executionMode ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactExecutionMode((artifact.metadata as Record<string, unknown>).executionMode)
          : mapRunModeToExecutionMode(item.run.mode))
      const toolPolicy =
        item.toolPolicy ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactToolPolicy((artifact.metadata as Record<string, unknown>).toolPolicy)
          : null)
      const activeAgent =
        item.activeAgent ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactExecutionAgent((artifact.metadata as Record<string, unknown>).activeAgent)
          : null)
      const routeDecision =
        item.routeDecision ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactRouteDecision((artifact.metadata as Record<string, unknown>).routeDecision)
          : null)
      const ruleBundle =
        item.ruleBundle ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactRuleBundle((artifact.metadata as Record<string, unknown>).ruleBundle)
          : null)
      const storyMemoryDigest =
        item.storyMemoryDigest ??
        (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
          ? asArtifactStoryMemoryDigest((artifact.metadata as Record<string, unknown>).storyMemoryDigest)
          : null)
      const routeStatuses = buildHistoryStatusItems(actionPlan, routeDecision, item.run.id, item.run.createdAt)

      return {
        id: `history-${item.run.id}-${artifact.id}`,
        task,
        type: mapHistoryArtifactType(artifact.artifactType),
        title: artifact.title,
        content: artifact.content,
        rawContent: artifact.content,
        // plan_save 落库时在 metadata 标记 savedAsPlan，刷新后据此恢复到计划文件夹
        savedAsPlan:
          artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata) &&
          (artifact.metadata as Record<string, unknown>).savedAsPlan === true
            ? true
            : undefined,
        promptText,
        createdAt: artifact.createdAt,
        status: item.run.status === 'running' ? 'streaming' : 'ready',
        runId: item.run.id,
        sessionId: item.run.sessionId,
        runStatusMode: item.run.status === 'running' ? 'live' : 'history',
        runStatuses: routeStatuses,
        memoryEntries: item.memoryEntries.map((entry) => ({
          id: entry.id,
          memoryType: entry.memoryType,
          title: entry.title,
          content: entry.content,
          importance: entry.importance,
          createdAt: entry.createdAt,
        })),
        backendArtifactId: artifact.id,
        availableApplyStrategies: Array.isArray(artifact.availableApplyStrategies)
          ? artifact.availableApplyStrategies
          : undefined,
        actionPlan,
        handoff,
        activeAgent,
        routeDecision,
        ruleBundle,
        storyMemoryDigest,
        executionMode,
        toolPolicy,
      }
    })
  })
}



export function mergeRestoredArtifactsWithSnapshot(
  restoredArtifacts: AgentArtifact[],
  snapshotArtifacts: AgentArtifact[],
): AgentArtifact[] {
  if (snapshotArtifacts.length === 0) {
    return restoredArtifacts
  }

  const snapshotByBackendArtifactId = new Map(
    snapshotArtifacts
      .filter((artifact) => typeof artifact.backendArtifactId === 'string' && artifact.backendArtifactId)
      .map((artifact) => [artifact.backendArtifactId as string, artifact]),
  )

  return restoredArtifacts.map((artifact) => {
    const snapshotArtifact =
      (artifact.backendArtifactId ? snapshotByBackendArtifactId.get(artifact.backendArtifactId) : null) ??
      snapshotArtifacts.find(
        (candidate) =>
          candidate.runId === artifact.runId &&
          candidate.promptText === artifact.promptText &&
          candidate.createdAt === artifact.createdAt,
      ) ??
      null

    if (!snapshotArtifact) {
      return artifact
    }

    const snapshotStatuses =
      Array.isArray(snapshotArtifact.runStatuses) && snapshotArtifact.runStatuses.length > 0
        ? snapshotArtifact.runStatuses
        : null
    const snapshotMemoryEntries =
      Array.isArray(snapshotArtifact.memoryEntries) && snapshotArtifact.memoryEntries.length > 0
        ? snapshotArtifact.memoryEntries
        : null
    const snapshotApplyStrategies = Array.isArray(snapshotArtifact.availableApplyStrategies)
      ? snapshotArtifact.availableApplyStrategies
      : artifact.availableApplyStrategies

    return {
      ...artifact,
      content: snapshotArtifact.content?.trim() ? snapshotArtifact.content : artifact.content,
      rawContent: snapshotArtifact.rawContent ?? artifact.rawContent ?? artifact.content,
      runStatusMode: snapshotArtifact.runStatusMode ?? artifact.runStatusMode,
      runStatuses: snapshotStatuses ?? artifact.runStatuses,
      memoryEntries: snapshotMemoryEntries ?? artifact.memoryEntries,
      availableApplyStrategies: snapshotApplyStrategies,
      replacedChapterContent: snapshotArtifact.replacedChapterContent ?? artifact.replacedChapterContent,
      appendedToChapter: snapshotArtifact.appendedToChapter ?? artifact.appendedToChapter,
      renamedNovel: snapshotArtifact.renamedNovel ?? artifact.renamedNovel,
      renamedChapter: snapshotArtifact.renamedChapter ?? artifact.renamedChapter,
      savedAsPlan: snapshotArtifact.savedAsPlan ?? artifact.savedAsPlan,
      planLocalDraft: snapshotArtifact.planLocalDraft,
      catalogUpdated: snapshotArtifact.catalogUpdated ?? artifact.catalogUpdated,
      appliedToCover: snapshotArtifact.appliedToCover ?? artifact.appliedToCover,
      coverPreviewAssetIds: snapshotArtifact.coverPreviewAssetIds ?? artifact.coverPreviewAssetIds,
      actionSummary: snapshotArtifact.actionSummary ?? artifact.actionSummary,
      handoff: snapshotArtifact.handoff ?? artifact.handoff,
      activeAgent: snapshotArtifact.activeAgent ?? artifact.activeAgent,
      routeDecision: snapshotArtifact.routeDecision ?? artifact.routeDecision,
      ruleBundle: snapshotArtifact.ruleBundle ?? artifact.ruleBundle,
      storyMemoryDigest: snapshotArtifact.storyMemoryDigest ?? artifact.storyMemoryDigest,
      executionMode: snapshotArtifact.executionMode ?? artifact.executionMode,
      toolPolicy: snapshotArtifact.toolPolicy ?? artifact.toolPolicy,
      actionPlan: snapshotArtifact.actionPlan ?? artifact.actionPlan,
    }
  })
}
