/**
 * 创作区表单状态构造与脏检查
 * 由 StudioWorkspace.tsx 模块级拆分而来（声明顺序与原文件一致）。
 */
import type { Chapter, Novel, UpdateNovelRequest } from '../../../../shared/contracts/index.js'
import { FIXED_NOVEL_COVER_SIZE } from '../../../../shared/contracts/index.js'
import { plainChapterTitle } from '../../../../shared/structure/chapter-title'
import type { AgentRunState, ChapterDraftState, CoverFormState, NovelFormState, ProjectNotesState } from '../types'



export function buildNovelFormState(novel: Novel): NovelFormState {
  return {
    title: novel.title,
    displayTitle: novel.displayTitle ?? '',
    summary: novel.summary,
    tagsText: novel.tags.join(' / '),
    visibility: novel.visibility,
    // 四种状态原样保留：此前折叠成 published/draft 二选一，completed 会在保存后回退成 draft
    status: novel.status,
  }
}



export function buildNovelUpdatePayload(novelForm: NovelFormState): UpdateNovelRequest {
  return {
    title: novelForm.title.trim(),
    displayTitle: novelForm.displayTitle.trim() || undefined,
    summary: novelForm.summary.trim(),
    tags: novelForm.tagsText
      .split(/[、/\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    visibility: novelForm.visibility,
    status: novelForm.status,
  }
}



export function isNovelFormDirty(currentNovel: Novel | null, novelForm: NovelFormState | null) {
  if (!currentNovel || !novelForm) {
    return false
  }

  return JSON.stringify(buildNovelUpdatePayload(novelForm)) !== JSON.stringify(buildNovelUpdatePayload(buildNovelFormState(currentNovel)))
}



export function buildProjectNotes(novel: Novel): ProjectNotesState {
  return {
    genre: novel.categoryName ?? '科幻',
    protagonist: '',
    tone: '克制、悬疑、留白充足',
    outlineLength: 'medium',
    stylePreference: '克制电影感',
  }
}



export function createIdleAgentRunState(): AgentRunState {
  return {
    active: false,
    task: null,
    title: '',
    statusText: '',
    activeAgent: null,
    routeDecision: null,
    executionMode: null,
  }
}


export function buildCoverForm(novel: Novel, notes: ProjectNotesState): CoverFormState {
  return {
    novelTitle: novel.title,
    summary: novel.summary,
    genre: notes.genre,
    protagonist: notes.protagonist,
    stylePreference: notes.stylePreference,
    prompt: novel.coverPrompt ?? '',
    negativePrompt: '',
    size: FIXED_NOVEL_COVER_SIZE,
    count: 1,
  }
}



export function buildChapterDraft(chapter: Chapter): ChapterDraftState {
  return {
    id: chapter.id,
    title: plainChapterTitle(chapter.title) || chapter.title,
    summary: chapter.summary ?? '',
    content: chapter.content,
    status: chapter.status,
    visibility: chapter.visibility,
    orderIndex: chapter.orderIndex,
    revision: chapter.revision,
    localOnly: false,
  }
}
