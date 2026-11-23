import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession, Chapter, Novel } from '../../shared/contracts/index.js'
import type { AgentArtifact } from '../../src/features/studio/types'
import {
  BOOTSTRAP_NOVEL_SUMMARY,
  BOOTSTRAP_NOVEL_TITLE,
  DEFAULT_AGENT_TASK_TITLE,
  buildAgentTaskWindowFromSession,
  choosePreferredAgentTaskWindow,
  createLocalAgentTaskWindow,
  dedupeAgentTaskWindows,
  formatDateTime,
  formatWordCount,
  getAgentTaskWindowTimestamp,
  getAgentWorkspaceStorageKey,
  isBootstrapNovel,
  pickFallbackAgentTaskWindow,
  resolveNovelTitleState,
  shouldDisplayListedAgentSession,
} from '../../src/features/studio/lib/agent-session.js'
import {
  buildNovelFormState,
  buildNovelUpdatePayload,
  buildChapterDraft,
  createIdleAgentRunState,
  isNovelFormDirty,
} from '../../src/features/studio/lib/form-state.js'
import {
  buildCatalogPreview,
  buildChapterReviewDescription,
  buildServerPlanFile,
  buildWorkspacePlanFiles,
  mergeCatalogContentWithChapters,
  readStoredPendingReviewList,
  removeChapterItem,
  removeChapterAndCompact,
  replaceChapterItem,
  toChapterListItem,
  upsertChapterItem,
  writeStoredPendingReview,
} from '../../src/features/studio/lib/plan-review.js'

/** 阶段 N2 护栏：StudioWorkspace 抽出的模块级纯函数行为锚定 */

function fakeNovel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'n1',
    title: '测试作品',
    displayTitle: null,
    summary: '简介',
    tags: ['科幻', '悬疑'],
    visibility: 'public',
    status: 'draft',
    wordCount: 0,
    chapterCount: 0,
    categoryName: null,
    coverPrompt: null,
    ...overrides,
  } as unknown as Novel
}

function fakeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'c1',
    novelId: 'n1',
    title: '第一章',
    summary: null,
    content: '正文',
    status: 'draft',
    visibility: 'public',
    orderIndex: 1,
    wordCount: 2,
    commentCount: 0,
    revision: 1,
    publishedAt: null,
    ...overrides,
  } as unknown as Chapter
}

function chapterItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    novelId: 'n1',
    title: '第一章',
    summary: null,
    orderIndex: 1,
    wordCount: 0,
    status: 'draft',
    visibility: 'public',
    commentCount: 0,
    publishedAt: null,
    ...overrides,
  } as ReturnType<typeof toChapterListItem>
}

describe('agent-session：格式化与引导作品识别', () => {
  it('formatWordCount：万字阈值与原文', () => {
    expect(formatWordCount(9999)).toBe('9999 字')
    expect(formatWordCount(10000)).toBe('1.0 万字')
    expect(formatWordCount(12345)).toBe('1.2 万字')
  })

  it('formatDateTime：空值回退「待更新」', () => {
    expect(formatDateTime(null)).toBe('待更新')
    expect(formatDateTime(undefined)).toBe('待更新')
    expect(formatDateTime('2026-08-16T10:00:00')).toContain('10:00')
  })

  it('resolveNovelTitleState：displayTitle 优先，引导名视为未命名', () => {
    expect(resolveNovelTitleState(fakeNovel({ displayTitle: '   展示名  ' }))).toEqual({ title: '展示名', missing: false })
    expect(resolveNovelTitleState(fakeNovel({ title: '自定义书名' }))).toEqual({ title: '自定义书名', missing: false })
    expect(resolveNovelTitleState(fakeNovel({ title: BOOTSTRAP_NOVEL_TITLE }))).toEqual({ title: '还没给这部作品命名', missing: true })
  })

  it('isBootstrapNovel：全条件命中才为引导作品', () => {
    const bootstrap = fakeNovel({ title: BOOTSTRAP_NOVEL_TITLE, summary: BOOTSTRAP_NOVEL_SUMMARY })
    expect(isBootstrapNovel(bootstrap)).toBe(true)
    expect(isBootstrapNovel(fakeNovel({ title: BOOTSTRAP_NOVEL_TITLE, summary: BOOTSTRAP_NOVEL_SUMMARY, chapterCount: 1 }))).toBe(false)
    expect(isBootstrapNovel(fakeNovel({ title: '别的名字', summary: BOOTSTRAP_NOVEL_SUMMARY }))).toBe(false)
  })

  it('getAgentWorkspaceStorageKey：前缀拼接', () => {
    expect(getAgentWorkspaceStorageKey('novel-x')).toBe('studio-agent-workspace:novel-x')
  })
})

describe('agent-session：任务窗构造与去重', () => {
  it('不会为从未运行过的命名会话请求空历史', () => {
    const emptySession = {
      id: 'empty', userId: 'user', novelId: 'novel', title: '已命名空任务', status: 'active', pinnedAt: null,
      toolPolicy: null, sandboxMode: 'workspace', lastRunAt: null, hasAgentHistory: false, createdAt: '2026-11-23T08:00:00.000Z',
      updatedAt: '2026-11-23T08:00:00.000Z',
    } as AgentSession
    const usedSession = { ...emptySession, id: 'used', lastRunAt: null, hasAgentHistory: true }
    expect(buildAgentTaskWindowFromSession(emptySession).loaded).toBe(true)
    expect(buildAgentTaskWindowFromSession(usedSession).loaded).toBe(false)
  })

  it('createLocalAgentTaskWindow：空白标题回退默认名，updatedAt 默认取 createdAt', () => {
    const window = createLocalAgentTaskWindow({ title: '   ', createdAt: '2026-08-16T00:00:00.000Z' })
    expect(window.title).toBe(DEFAULT_AGENT_TASK_TITLE)
    expect(window.updatedAt).toBe('2026-08-16T00:00:00.000Z')
    expect(window.temporary).toBe(true)
  })

  it('dedupeAgentTaskWindows：同 sessionId 合并且按更新时间降序', () => {
    const older = createLocalAgentTaskWindow({ id: 'a', sessionId: 's1', updatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' })
    const newer = createLocalAgentTaskWindow({ id: 'b', sessionId: 's1', title: '新名字', customNamed: true, updatedAt: '2026-08-10T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' })
    const standalone = createLocalAgentTaskWindow({ id: 'c', sessionId: null, updatedAt: '2026-08-05T00:00:00.000Z', createdAt: '2026-08-05T00:00:00.000Z' })

    const deduped = dedupeAgentTaskWindows([older, standalone, newer])
    expect(deduped).toHaveLength(2)
    expect(deduped[0].sessionId).toBe('s1')
    expect(deduped[0].title).toBe('新名字')
    expect(deduped[1].id).toBe('c')
  })

  it('choosePreferredAgentTaskWindow：customNamed 标题优先、artifacts 取多者', () => {
    const left = createLocalAgentTaskWindow({ id: 'l', title: '左侧命名', customNamed: true, updatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' })
    const right = createLocalAgentTaskWindow({
      id: 'r',
      artifacts: [{ id: 'art1' } as unknown as AgentArtifact],
      updatedAt: '2026-08-10T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    })

    const merged = choosePreferredAgentTaskWindow(left, right)
    expect(merged.title).toBe('左侧命名')
    expect(merged.artifacts).toHaveLength(1)
    expect(merged.activeArtifactId).toBe('art1')
    expect(merged.customNamed).toBe(true)
  })

  it('getAgentTaskWindowTimestamp：非法时间归零', () => {
    expect(getAgentTaskWindowTimestamp({ updatedAt: 'bogus', createdAt: 'bogus' })).toBe(0)
    expect(getAgentTaskWindowTimestamp({ updatedAt: '', createdAt: '2026-08-16T00:00:00.000Z' })).toBeGreaterThan(0)
  })

  it('shouldDisplayListedAgentSession：本地匹配直通，默认名且无运行记录则隐藏', () => {
    const session = { title: DEFAULT_AGENT_TASK_TITLE, lastRunAt: null } as unknown as AgentSession
    expect(shouldDisplayListedAgentSession(session, true)).toBe(true)
    expect(shouldDisplayListedAgentSession(session, false)).toBe(false)
    expect(shouldDisplayListedAgentSession({ ...session, title: '我的会话' }, false)).toBe(true)
    expect(shouldDisplayListedAgentSession({ ...session, lastRunAt: '2026-08-16' }, false)).toBe(true)
  })

  it('pickFallbackAgentTaskWindow：删除后优先回落到最近一个有记录的任务，而不是更新的空白窗口', () => {
    const deleted = createLocalAgentTaskWindow({ id: 'del', sessionId: 'session-del', updatedAt: '2026-09-03T10:00:00.000Z', createdAt: '2026-09-03T10:00:00.000Z' })
    const blankNewer = createLocalAgentTaskWindow({ id: 'blank', updatedAt: '2026-09-03T09:00:00.000Z', createdAt: '2026-09-03T09:00:00.000Z' })
    const recordedOlder = createLocalAgentTaskWindow({ id: 'kept', sessionId: 'session-kept', temporary: false, updatedAt: '2026-09-03T08:00:00.000Z', createdAt: '2026-09-03T08:00:00.000Z' })

    expect(pickFallbackAgentTaskWindow([deleted, blankNewer, recordedOlder], 'del')?.id).toBe('kept')
    // 侧栏传回的可能是 sessionId，也要能排除被删的那个窗口
    expect(pickFallbackAgentTaskWindow([deleted, recordedOlder], 'session-del')?.id).toBe('kept')
  })

  it('pickFallbackAgentTaskWindow：剩下的全是空白窗口时取最近的，一个不剩才返回 null', () => {
    const blankOlder = createLocalAgentTaskWindow({ id: 'b1', updatedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' })
    const blankNewer = createLocalAgentTaskWindow({ id: 'b2', updatedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-02T00:00:00.000Z' })

    expect(pickFallbackAgentTaskWindow([blankOlder, blankNewer], 'del')?.id).toBe('b2')
    expect(pickFallbackAgentTaskWindow([blankOlder], 'b1')).toBeNull()
    expect(pickFallbackAgentTaskWindow([], 'del')).toBeNull()
  })

  it('pickFallbackAgentTaskWindow：未落库但已有对话的临时窗口也算有记录', () => {
    const blankNewer = createLocalAgentTaskWindow({ id: 'blank', updatedAt: '2026-09-03T09:00:00.000Z', createdAt: '2026-09-03T09:00:00.000Z' })
    const promptedOlder = createLocalAgentTaskWindow({ id: 'prompted', prompt: '写第三章', updatedAt: '2026-09-03T08:00:00.000Z', createdAt: '2026-09-03T08:00:00.000Z' })

    expect(pickFallbackAgentTaskWindow([blankNewer, promptedOlder], 'del')?.id).toBe('prompted')
  })
})

describe('form-state：表单构造与脏检查', () => {
  it('buildNovelUpdatePayload：标签多分隔符切分、displayTitle 空白归 undefined', () => {
    const form = buildNovelFormState(fakeNovel())
    const payload = buildNovelUpdatePayload({ ...form, tagsText: ' 科幻 、 悬疑/冒险 喜剧 ', displayTitle: '   ' })
    expect(payload.tags).toEqual(['科幻', '悬疑', '冒险', '喜剧'])
    expect(payload.displayTitle).toBeUndefined()
  })

  it('isNovelFormDirty：未改动为 false，改标题为 true', () => {
    const novel = fakeNovel()
    expect(isNovelFormDirty(novel, buildNovelFormState(novel))).toBe(false)
    expect(isNovelFormDirty(novel, { ...buildNovelFormState(novel), title: '改了' })).toBe(true)
    expect(isNovelFormDirty(null, null)).toBe(false)
  })

  it('buildChapterDraft：summary 空值归空串、localOnly 恒 false', () => {
    const draft = buildChapterDraft(fakeChapter())
    expect(draft.summary).toBe('')
    expect(draft.localOnly).toBe(false)
  })

  it('createIdleAgentRunState：空闲态字段全空', () => {
    expect(createIdleAgentRunState()).toEqual({
      active: false,
      task: null,
      title: '',
      statusText: '',
      activeAgent: null,
      routeDecision: null,
      executionMode: null,
    })
  })
})

describe('plan-review：目录预览与合并', () => {
  it('buildCatalogPreview：空章节提示与章节清单拼接', () => {
    const empty = buildCatalogPreview('  ', [])
    expect(empty.description).toBe('《当前作品》的目录文件会放在这里。')

    const withChapters = buildCatalogPreview('星海', [
      chapterItem({ id: 'c1', orderIndex: 1, title: '起点' }),
      chapterItem({ id: 'c2', orderIndex: 2, title: '  ', summary: '转折' }),
    ] as never)
    expect(withChapters.description).toBe('共 2 章，写新章节或修改章节标题后会自动更新。')
    expect(withChapters.content).toContain('第 1 章  起点')
    expect(withChapters.content).toContain('第 2 章  第 2 章')
    expect(withChapters.content).toContain('摘要：转折')
  })

  it('buildCatalogPreview：按卷展示章节并保留未分卷章节', () => {
    const preview = buildCatalogPreview('星海', [
      chapterItem({ id: 'c3', volumeId: 'missing', orderIndex: 3, orderInVolume: 1, title: '遗章' }),
      chapterItem({ id: 'c2', volumeId: 'v1', orderIndex: 2, orderInVolume: 2, title: '回声' }),
      chapterItem({ id: 'c1', volumeId: 'v1', orderIndex: 1, orderInVolume: 1, title: '起点' }),
    ] as never, [
      { id: 'v1', title: '启航', orderIndex: 1 },
      { id: 'v2', title: '第二卷 深海', orderIndex: 2 },
    ] as never)

    expect(preview.description).toBe('共 2 卷 3 章，卷章结构或标题变更后会自动更新。')
    expect(preview.content).toContain('第 1 卷  启航\n\n第 1 章  起点\n\n第 2 章  回声')
    expect(preview.content).toContain('第二卷 深海\n\n当前卷还没有已保存章节。')
    expect(preview.content).toContain('未分卷\n\n第 3 章  遗章')

    const emptyVolume = buildCatalogPreview('星海', [], [
      { id: 'v1', title: '启航', orderIndex: 1 },
    ] as never)
    expect(emptyVolume.content).toContain('第 1 卷  启航\n\n当前卷还没有已保存章节。')
  })

  it('mergeCatalogContentWithChapters：保留用户手写前缀，替换生成章节段', () => {
    const next = ['《星海》目录', '', '第 1 章  新生成'].join('\n')
    expect(mergeCatalogContentWithChapters('   ', next)).toBe(next)
    const merged = mergeCatalogContentWithChapters('我的自定义开头\n第 1 章  旧章节', next)
    expect(merged).toContain('我的自定义开头')
    expect(merged).toContain('第 1 章  新生成')
    expect(merged).not.toContain('旧章节')

    const volumeNext = ['《星海》目录', '', '第 1 卷  新卷', '', '第 1 章  新章节'].join('\n')
    const volumeMerged = mergeCatalogContentWithChapters('我的自定义开头\n第 1 卷  旧卷\n第 1 章  旧章节', volumeNext)
    expect(volumeMerged).toContain('第 1 卷  新卷')
    expect(volumeMerged).not.toContain('旧卷')
  })

  it('buildChapterReviewDescription：三种模式文案', () => {
    expect(buildChapterReviewDescription('create', '第一章')).toBe('已创建新章节《第一章》并写入正文，请确认是否采纳。')
    expect(buildChapterReviewDescription('append', '第一章')).toBe('已将新内容追加到《第一章》，请确认是否采纳。')
    expect(buildChapterReviewDescription('replace', '第一章')).toBe('已更新《第一章》的正文内容，请确认是否采纳。')
  })
})

describe('plan-review：章节列表操作', () => {
  it('upsertChapterItem：同 id 覆盖并按 orderIndex 排序', () => {
    const list = [chapterItem({ id: 'c1', orderIndex: 1 }), chapterItem({ id: 'c2', orderIndex: 2 })]
    const next = upsertChapterItem(list as never, chapterItem({ id: 'c2', orderIndex: 0, title: '提前' }))
    expect(next.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(next[0].title).toBe('提前')
  })

  it('replaceChapterItem：同时剔除旧 id 与新 id', () => {
    const list = [chapterItem({ id: 'c1' }), chapterItem({ id: 'c2', orderIndex: 2 })]
    const next = replaceChapterItem(list as never, 'c1', chapterItem({ id: 'c1-new', orderIndex: 1 }))
    expect(next.map((c) => c.id)).toEqual(['c1-new', 'c2'])
  })

  it('removeChapterItem：按 id 过滤', () => {
    const list = [chapterItem({ id: 'c1' }), chapterItem({ id: 'c2', orderIndex: 2 })]
    expect(removeChapterItem(list as never, 'c1').map((c) => c.id)).toEqual(['c2'])
  })

  it('removeChapterAndCompact：删除后连续编号并递增受影响章节 revision', () => {
    const items = [fakeChapter({ id: 'c1', orderIndex: 1, revision: 2 }), fakeChapter({ id: 'c2', orderIndex: 2, revision: 4 }), fakeChapter({ id: 'c3', orderIndex: 3, revision: 7 })].map(toChapterListItem)
    expect(removeChapterAndCompact(items, 'c2').map((item) => [item.id, item.orderIndex, item.revision])).toEqual([
      ['c1', 1, 2],
      ['c3', 2, 8],
    ])
  })

  it('toChapterListItem：字段白名单映射', () => {
    const item = toChapterListItem(fakeChapter())
    expect(Object.keys(item).sort()).toEqual(
      ['commentCount', 'id', 'novelId', 'volumeId', 'orderInVolume', 'orderIndex', 'publishedAt', 'publishedRevision', 'revision', 'status', 'summary', 'title', 'visibility', 'wordCount'].sort(),
    )
  })
})

describe('plan-review：计划文件与待审持久化', () => {
  it('buildWorkspacePlanFiles：仅留 savedAsPlan、标题兜底、时间降序', () => {
    const artifacts = [
      { id: 'a1', savedAsPlan: true, title: '  ', content: '旧', createdAt: '2026-08-01T00:00:00.000Z', backendArtifactId: null },
      { id: 'a2', savedAsPlan: false, title: '不算', content: 'x', createdAt: '2026-08-10T00:00:00.000Z', backendArtifactId: null },
      { id: 'a3', savedAsPlan: true, title: '新计划', rawContent: '新 ', createdAt: '2026-08-10T00:00:00.000Z', backendArtifactId: 'b3' },
    ] as unknown as AgentArtifact[]
    const files = buildWorkspacePlanFiles(artifacts)
    expect(files.map((f) => f.id)).toEqual(['a3', 'a1'])
    expect(files[0].content).toBe('新 ')
    expect(files[1].title).toBe('创作计划')
  })

  it('buildServerPlanFile：id 加 server- 前缀', () => {
    const file = buildServerPlanFile({ id: 'p1', runId: 'r1', title: ' ', content: ' 内容 ', orderIndex: null, createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z' })
    expect(file.id).toBe('server-p1')
    expect(file.backendArtifactId).toBe('p1')
    expect(file.title).toBe('创作计划')
    expect(file.content).toBe(' 内容 ')
  })

  it('待审持久化：兼容历史单对象格式，写入空值即删除', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    })

    store.set('k-single', JSON.stringify({ id: 'r1' }))
    expect(readStoredPendingReviewList('k-single')).toEqual([{ id: 'r1' }])
    store.set('k-list', JSON.stringify([{ id: 'r1' }, { broken: true }, { id: 'r2' }]))
    expect(readStoredPendingReviewList('k-list').map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(readStoredPendingReviewList('k-missing')).toEqual([])

    writeStoredPendingReview('k-write', { id: 'r3' })
    expect(store.get('k-write')).toBe(JSON.stringify({ id: 'r3' }))
    writeStoredPendingReview('k-write', null)
    expect(store.has('k-write')).toBe(false)

    vi.unstubAllGlobals()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
