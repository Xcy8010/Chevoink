/**
 * 创作区工作区常量与会话窗装配
 * 由 StudioWorkspace.tsx 模块级拆分而来（声明顺序与原文件一致）。
 */
import type { Novel, AgentSession } from '../../../../shared/contracts/index.js'
import { BOOTSTRAP_NOVEL_SUMMARY } from '../../../../shared/contracts/novel-publish.js'
import type { AgentTaskWindowState } from './workspace-types.js'



export const DEFAULT_NOVEL_ID = 'novel-aurora'


// 新建默认名；旧名「我的第一部作品」保留识别，兼容存量引导作品
export const BOOTSTRAP_NOVEL_TITLE = '未命名作品'


export const BOOTSTRAP_NOVEL_TITLES = new Set([BOOTSTRAP_NOVEL_TITLE, '我的第一部作品'])


export { BOOTSTRAP_NOVEL_SUMMARY }


export const AGENT_WORKSPACE_STORAGE_PREFIX = 'studio-agent-workspace'


export const STUDIO_LAST_NOVEL_STORAGE_KEY = 'studio-last-novel-id'


export const DEFAULT_AGENT_TASK_TITLE = '新任务'



export function formatWordCount(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)} 万字`
  }

  return `${value} 字`
}



export function formatDateTime(value?: string | null): string {
  if (!value) {
    return '待更新'
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}



export function resolveNovelTitleState(novel: Novel): { title: string; missing: boolean } {
  const displayTitle = novel.displayTitle?.trim()

  if (displayTitle) {
    return {
      title: displayTitle,
      missing: false,
    }
  }

  const title = novel.title?.trim() ?? ''
  if (title && !BOOTSTRAP_NOVEL_TITLES.has(title)) {
    return {
      title,
      missing: false,
    }
  }

  return {
    title: '还没给这部作品命名',
    missing: true,
  }
}



export function isBootstrapNovel(novel: Pick<Novel, 'title' | 'displayTitle' | 'summary' | 'chapterCount' | 'wordCount'>) {
  return (
    !novel.displayTitle?.trim() &&
    BOOTSTRAP_NOVEL_TITLES.has(novel.title) &&
    novel.summary === BOOTSTRAP_NOVEL_SUMMARY &&
    novel.chapterCount === 0 &&
    novel.wordCount === 0
  )
}

/** 引导作品只有在完全没有真实会话时才可从导航隐藏。 */
export function shouldShowWorkspaceNovel(
  novel: Pick<Novel, 'title' | 'displayTitle' | 'summary' | 'chapterCount' | 'wordCount'>,
  hasAgentSession: boolean,
) {
  return !isBootstrapNovel(novel) || hasAgentSession
}



export function getAgentWorkspaceStorageKey(novelId: string) {
  return `${AGENT_WORKSPACE_STORAGE_PREFIX}:${novelId}`
}



export function createLocalAgentTaskWindow(overrides?: Partial<AgentTaskWindowState>): AgentTaskWindowState {
  const createdAt = overrides?.createdAt ?? new Date().toISOString()

  return {
    id: overrides?.id ?? `local-agent-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: overrides?.sessionId ?? null,
    title: overrides?.title?.trim() || DEFAULT_AGENT_TASK_TITLE,
    prompt: overrides?.prompt ?? '',
    artifacts: overrides?.artifacts ?? [],
    activeArtifactId: overrides?.activeArtifactId ?? overrides?.artifacts?.[0]?.id ?? null,
    loaded: overrides?.loaded ?? false,
    temporary: overrides?.temporary ?? true,
    customNamed: overrides?.customNamed ?? false,
    firstPromptSubmitted: overrides?.firstPromptSubmitted ?? false,
    createdAt,
    updatedAt: overrides?.updatedAt ?? createdAt,
  }
}



export function buildAgentTaskWindowFromSession(session: AgentSession): AgentTaskWindowState {
  return createLocalAgentTaskWindow({
    id: session.id,
    sessionId: session.id,
    title: session.title,
    temporary: false,
    loaded: false,
    customNamed: session.title.trim() !== DEFAULT_AGENT_TASK_TITLE && !session.title.includes('写作会话'),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  })
}



export function getAgentTaskWindowTimestamp(taskWindow: Pick<AgentTaskWindowState, 'updatedAt' | 'createdAt'>) {
  const timestamp = new Date(taskWindow.updatedAt || taskWindow.createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}



export function choosePreferredAgentTaskWindow(
  left: AgentTaskWindowState,
  right: AgentTaskWindowState,
): AgentTaskWindowState {
  const preferredByTime =
    getAgentTaskWindowTimestamp(right) > getAgentTaskWindowTimestamp(left) ? right : left
  const alternate = preferredByTime === right ? left : right

  return {
    ...alternate,
    ...preferredByTime,
    title: preferredByTime.customNamed ? preferredByTime.title : alternate.customNamed ? alternate.title : preferredByTime.title,
    prompt:
      preferredByTime.prompt.trim().length >= alternate.prompt.trim().length ? preferredByTime.prompt : alternate.prompt,
    artifacts:
      preferredByTime.artifacts.length >= alternate.artifacts.length ? preferredByTime.artifacts : alternate.artifacts,
    activeArtifactId: preferredByTime.activeArtifactId ?? alternate.activeArtifactId,
    loaded: preferredByTime.loaded || alternate.loaded,
    temporary: preferredByTime.temporary && alternate.temporary,
    customNamed: preferredByTime.customNamed || alternate.customNamed,
    firstPromptSubmitted: preferredByTime.firstPromptSubmitted || alternate.firstPromptSubmitted,
  }
}



export function dedupeAgentTaskWindows(taskWindows: AgentTaskWindowState[]) {
  const deduped = new Map<string, AgentTaskWindowState>()

  for (const taskWindow of taskWindows) {
    const key = taskWindow.sessionId ? `session:${taskWindow.sessionId}` : `local:${taskWindow.id}`
    const existingTaskWindow = deduped.get(key)

    if (!existingTaskWindow) {
      deduped.set(key, taskWindow)
      continue
    }

    deduped.set(key, choosePreferredAgentTaskWindow(existingTaskWindow, taskWindow))
  }

  return Array.from(deduped.values()).sort(
    (left, right) => getAgentTaskWindowTimestamp(right) - getAgentTaskWindowTimestamp(left),
  )
}



export function shouldDisplayListedAgentSession(
  session: Pick<AgentSession, 'title' | 'lastRunAt'>,
  hasLocalMatch: boolean,
) {
  if (hasLocalMatch) {
    return true
  }

  const normalizedTitle = session.title.trim()
  return Boolean(session.lastRunAt) || (normalizedTitle && normalizedTitle !== DEFAULT_AGENT_TASK_TITLE)
}



/** 「有记录」的判据：已落库的会话，或本地临时窗口里已经产生过对话/产物 */
function hasAgentTaskRecord(taskWindow: AgentTaskWindowState) {
  return (
    Boolean(taskWindow.sessionId)
    || taskWindow.firstPromptSubmitted
    || taskWindow.prompt.trim().length > 0
    || taskWindow.artifacts.length > 0
  )
}

/** A local task can own a composer draft before it has a server session or legacy prompt. */
export function shouldRetainAgentTaskWindow(task: AgentTaskWindowState, activeTaskId: string | null, hasDraft: boolean) {
  return task.id === activeTaskId || !task.temporary || task.customNamed || hasDraft
    || hasAgentTaskRecord(task) || Boolean(task.activeArtifactId)
}



/**
 * 删除任务窗口后应该回落到哪个窗口：优先最近一个「有记录」的任务，
 * 剩下的全是空白临时窗口时取最近的那个，一个都不剩才返回 null（由调用方补空白窗口）。
 * 修复点：此前删任务直接新建空白窗口，作者删一个就被丢到欢迎页，看不到上一个任务。
 */
export function pickFallbackAgentTaskWindow(
  taskWindows: AgentTaskWindowState[],
  deletedTaskId: string,
): AgentTaskWindowState | null {
  const candidates = taskWindows.filter(
    (taskWindow) => taskWindow.id !== deletedTaskId && taskWindow.sessionId !== deletedTaskId,
  )
  const recorded = candidates.filter(hasAgentTaskRecord)
  const pool = recorded.length > 0 ? recorded : candidates

  return (
    [...pool].sort(
      (left, right) => getAgentTaskWindowTimestamp(right) - getAgentTaskWindowTimestamp(left),
    )[0] ?? null
  )
}
