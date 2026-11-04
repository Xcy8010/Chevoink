/**
 * 创作区待审持久化与章节目录操作
 * 由 StudioWorkspace.tsx 模块级拆分而来（声明顺序与原文件一致）。
 */
import type { Chapter, StudioPayload } from '../../../../shared/contracts/index.js'
import type { NovelPlanFileItem } from '../api'
import type { AgentArtifact, AgentLocalRollbackSnapshot, ChapterDraftState, ChapterPendingReview, PlanSavedSnapshot, WorkspacePlanFile } from '../types'



// Agent 审查态持久化：刷新/重开页面后恢复未定夺的章节与计划审查（按作品键控）
export const PENDING_CHAPTER_REVIEW_STORAGE_PREFIX = 'chevoink-pending-chapter-review:'


export const PENDING_PLAN_REVIEW_STORAGE_PREFIX = 'chevoink-pending-plan-review:'



export function readStoredPendingReview<T extends { id: string }>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as T
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : null
  } catch {
    return null
  }
}



// 章节审查已改为多章并存的数组；兼容历史遗留的单对象存储格式
export function readStoredPendingReviewList<T extends { id: string }>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as T[] | T | null
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) => item && typeof item === 'object' && typeof item.id === 'string',
      )
    }
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? [parsed] : []
  } catch {
    return []
  }
}



export function writeStoredPendingReview(key: string, review: unknown) {
  try {
    if (review) {
      window.localStorage.setItem(key, JSON.stringify(review))
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // localStorage 不可用/超限时静默降级为内存态
  }
}



export function buildWorkspacePlanFiles(artifacts: AgentArtifact[]): WorkspacePlanFile[] {
  return artifacts
    .filter((artifact) => artifact.savedAsPlan)
    .map((artifact) => ({
      id: artifact.id,
      title: artifact.title?.trim() || '创作计划',
      // 正文必须逐字保留；trim 会在每次受控编辑回写后移除首尾换行，触发富文本编辑器
      // replaceAll，导致光标跳回其他位置。
      content: artifact.rawContent ?? artifact.content,
      createdAt: artifact.createdAt,
      artifactId: artifact.id,
      backendArtifactId: artifact.backendArtifactId ?? null,
      ...(artifact.planLocalDraft ? { localDraft: artifact.planLocalDraft, planHash: artifact.planLocalDraft.basePlanHash } : {}),
    }))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}



/** 云端计划列表项 → 计划文件视图：id 加 server- 前缀避免与本地产物 id 碰撞 */
export function buildServerPlanFile(item: NovelPlanFileItem): WorkspacePlanFile {
  return {
    id: `server-${item.id}`,
    title: item.title.trim() || '创作计划',
    content: item.content,
    createdAt: item.createdAt,
    artifactId: `server-${item.id}`,
    backendArtifactId: item.id,
    orderIndex: item.orderIndex,
    planKind: item.planKind,
    planHash: item.planHash,
    parentPlanId: item.parentPlanId,
    parentPlanHash: item.parentPlanHash,
    target: item.target,
    reviewState: item.reviewState,
  }
}



export function buildCatalogPreview(
  novelTitle: string,
  chapters: StudioPayload['chapters'],
  volumes: StudioPayload['volumes'] = [],
) {
  const normalizedTitle = novelTitle.trim() || '当前作品'

  if (chapters.length === 0 && volumes.length === 0) {
    return {
      title: '目录',
      description: `《${normalizedTitle}》的目录文件会放在这里。`,
      content: ['《' + normalizedTitle + '》目录', '', '当前还没有已保存章节。', '写入第一章或重命名章节后，这里会自动更新。'].join('\n'),
    }
  }

  const orderedChapters = [...chapters].sort((left, right) => left.orderIndex - right.orderIndex)
  const orderedVolumes = [...volumes].sort((left, right) => left.orderIndex - right.orderIndex)
  const volumeIds = new Set(orderedVolumes.map((volume) => volume.id))
  const formatChapter = (chapter: StudioPayload['chapters'][number], order: number) => {
    const title = chapter.title.trim() || `第 ${order} 章`
    const summary = chapter.summary?.trim()
    return summary
      ? `第 ${order} 章  ${title}\n摘要：${summary}`
      : `第 ${order} 章  ${title}`
  }
  const catalogEntries = orderedVolumes.length > 0
    ? [
        ...orderedVolumes.map((volume) => {
          const fallbackTitle = `第 ${volume.orderIndex} 卷`
          const normalizedVolumeTitle = volume.title.trim()
          const volumeTitle = normalizedVolumeTitle
            ? /^第\s*[0-9零一二三四五六七八九十百两]+\s*卷/u.test(normalizedVolumeTitle)
              ? normalizedVolumeTitle
              : `${fallbackTitle}  ${normalizedVolumeTitle}`
            : fallbackTitle
          const volumeChapters = orderedChapters
            .filter((chapter) => chapter.volumeId === volume.id)
            .sort((left, right) => left.orderInVolume - right.orderInVolume || left.orderIndex - right.orderIndex)
          const chapterLines = volumeChapters.length > 0
            ? volumeChapters.map((chapter) => formatChapter(chapter, chapter.orderInVolume))
            : ['当前卷还没有已保存章节。']
          return [volumeTitle, ...chapterLines].join('\n\n')
        }),
        ...(() => {
          const ungroupedChapters = orderedChapters.filter((chapter) => !volumeIds.has(chapter.volumeId))
          return ungroupedChapters.length > 0
            ? [['未分卷', ...ungroupedChapters.map((chapter) => formatChapter(chapter, chapter.orderIndex))].join('\n\n')]
            : []
        })(),
      ]
    : orderedChapters.map((chapter) => formatChapter(chapter, chapter.orderIndex))

  return {
    title: '目录',
    description: volumes.length > 0
      ? `共 ${volumes.length} 卷 ${chapters.length} 章，卷章结构或标题变更后会自动更新。`
      : `共 ${chapters.length} 章，写新章节或修改章节标题后会自动更新。`,
    content: [
      `《${normalizedTitle}》目录`,
      '',
      ...catalogEntries,
    ].join('\n\n'),
  }
}



export function mergeCatalogContentWithChapters(currentContent: string, nextCatalogContent: string) {
  const normalizedCurrent = currentContent.trim()
  if (!normalizedCurrent) {
    return nextCatalogContent
  }

  const lines = normalizedCurrent.split('\n')
  const firstGeneratedLineIndex = lines.findIndex((line) =>
    /^(?:第\s*[0-9零一二三四五六七八九十百两]+\s*[卷章]|未分卷)/u.test(line.trim()),
  )

  if (firstGeneratedLineIndex < 0) {
    return [normalizedCurrent, '', nextCatalogContent.split('\n').slice(2).join('\n')].filter(Boolean).join('\n')
  }

  const prefix = lines.slice(0, firstGeneratedLineIndex).join('\n').trimEnd()
  const generatedChapterSection = nextCatalogContent.split('\n').slice(2).join('\n')

  return [prefix, generatedChapterSection].filter(Boolean).join('\n\n')
}



export function cloneChapterDraftState(chapter: ChapterDraftState): ChapterDraftState {
  return {
    ...chapter,
  }
}



export function buildPendingChapterReview(options: {
  before: ChapterDraftState | null
  after: ChapterDraftState
  rollbackSnapshot: AgentLocalRollbackSnapshot
  description: string
  artifactId?: string | null
  runId?: string | null
}): ChapterPendingReview {
  return {
    id: `chapter-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chapterId: options.after.id,
    artifactId: options.artifactId ?? null,
    runId: options.runId ?? null,
    before: options.before ? cloneChapterDraftState(options.before) : null,
    after: cloneChapterDraftState(options.after),
    rollbackSnapshot: options.rollbackSnapshot,
    description: options.description,
    createdAt: new Date().toISOString(),
  }
}



export function buildChapterReviewDescription(
  mode: 'create' | 'append' | 'replace',
  chapterTitle: string,
) {
  if (mode === 'create') {
    return `已创建新章节《${chapterTitle}》并写入正文，请确认是否采纳。`
  }

  if (mode === 'append') {
    return `已将新内容追加到《${chapterTitle}》，请确认是否采纳。`
  }

  return `已更新《${chapterTitle}》的正文内容，请确认是否采纳。`
}



export function toChapterListItem(chapter: Chapter): StudioPayload['chapters'][number] {
  return {
    id: chapter.id,
    novelId: chapter.novelId,
    title: chapter.title,
    summary: chapter.summary,
    orderIndex: chapter.orderIndex,
    volumeId: chapter.volumeId,
    orderInVolume: chapter.orderInVolume,
    wordCount: chapter.wordCount,
    status: chapter.status,
    visibility: chapter.visibility,
    commentCount: chapter.commentCount,
    revision: chapter.revision,
    publishedRevision: chapter.publishedRevision,
    publishedAt: chapter.publishedAt,
  }
}



export function upsertChapterItem(
  current: StudioPayload['chapters'],
  item: StudioPayload['chapters'][number],
): StudioPayload['chapters'] {
  const next = current.filter((chapter) => chapter.id !== item.id)
  next.push(item)
  return next.sort((left, right) => left.orderIndex - right.orderIndex)
}



export function replaceChapterItem(
  current: StudioPayload['chapters'],
  previousId: string | null,
  item: StudioPayload['chapters'][number],
): StudioPayload['chapters'] {
  const next = current.filter((chapter) => chapter.id !== item.id && chapter.id !== previousId)
  next.push(item)
  return next.sort((left, right) => left.orderIndex - right.orderIndex)
}



export function removeChapterItem(
  current: StudioPayload['chapters'],
  chapterId: string,
): StudioPayload['chapters'] {
  return current.filter((chapter) => chapter.id !== chapterId)
}

/** 与服务端删除后的 compactChapterOrder 保持一致；仅被前移的章节递增 revision。 */
export function removeChapterAndCompact(
  current: StudioPayload['chapters'],
  chapterId: string,
): StudioPayload['chapters'] {
  const removed = current.find((chapter) => chapter.id === chapterId)
  if (!removed) {
    return current
  }

  return current
    .filter((chapter) => chapter.id !== chapterId)
    .map((chapter) =>
      chapter.orderIndex > removed.orderIndex
        ? { ...chapter, orderIndex: chapter.orderIndex - 1, revision: chapter.revision + 1 }
        : chapter,
    )
}

/** The text shown for a parent confirmation must belong to the submitted saved hash. */
export function getSavedPlanSnapshot(plan: WorkspacePlanFile): PlanSavedSnapshot | null {
  if (plan.savedSnapshot) return plan.savedSnapshot
  return !plan.localDraft && plan.planHash ? { title: plan.title, content: plan.content, planHash: plan.planHash } : null
}

/** List refreshes never grant a remote version to an unsaved local body. */
export function mergeServerPlanFile(item: NovelPlanFileItem, previous?: WorkspacePlanFile, savedContent?: string): WorkspacePlanFile {
  const server = buildServerPlanFile(item)
  if (!previous?.localDraft) return server
  if (savedContent !== undefined && !previous.hasRemoteConflict && previous.content === item.content && previous.title === item.title) return server
  const basePlanHash = savedContent !== undefined ? item.planHash : previous.localDraft.basePlanHash
  const savedSnapshot = previous.hasRemoteConflict && savedContent !== undefined
    ? previous.savedSnapshot
    : getSavedPlanSnapshot(server) ?? undefined
  return {
    ...(previous.hasRemoteConflict && savedContent !== undefined ? previous : server),
    title: previous.title,
    content: previous.content,
    planHash: basePlanHash,
    localDraft: { basePlanHash },
    savedSnapshot,
    hasRemoteConflict: Boolean(savedSnapshot && savedSnapshot.planHash !== basePlanHash),
  }
}

/** Saved server text replaces historical caches; only explicit author drafts keep their body and baseline. */
export function mergeWorkspacePlanFiles(localPlans: WorkspacePlanFile[], serverPlanFiles: WorkspacePlanFile[]): WorkspacePlanFile[] {
  const serverByBackendId = new Map(serverPlanFiles.filter(plan => plan.backendArtifactId).map(plan => [plan.backendArtifactId, plan]))
  const orderedLocalPlans = localPlans.map(plan => {
    const server = plan.backendArtifactId ? serverByBackendId.get(plan.backendArtifactId) : undefined
    const id = plan.backendArtifactId ? `server-${plan.backendArtifactId}` : plan.id
    if (!server) return { ...plan, id }
    if (!plan.localDraft) return { ...server, id, artifactId: plan.artifactId }
    const savedSnapshot = getSavedPlanSnapshot(server) ?? undefined
    return {
      ...server, id, artifactId: plan.artifactId,
      title: plan.title, content: plan.content,
      planHash: plan.localDraft.basePlanHash,
      localDraft: plan.localDraft,
      savedSnapshot,
      hasRemoteConflict: Boolean(savedSnapshot && savedSnapshot.planHash !== plan.localDraft.basePlanHash),
    }
  })
  const localBackendIds = new Set(orderedLocalPlans.map(plan => plan.backendArtifactId).filter(Boolean))
  return [...orderedLocalPlans, ...serverPlanFiles.filter(plan => !plan.backendArtifactId || !localBackendIds.has(plan.backendArtifactId))]
    .sort((left, right) => (left.orderIndex ?? Number.MAX_SAFE_INTEGER) - (right.orderIndex ?? Number.MAX_SAFE_INTEGER)
      || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
}
