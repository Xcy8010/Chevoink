// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render as renderReact, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentMemoryCards from '../../src/features/studio/agent/components/AgentMemoryCards'
import AgentMemoryCenter from '../../src/features/studio/agent/components/AgentMemoryCenter'
import { AgentApiError, compactAgentContext, fetchAgentContextState, fetchStoryMemories, fetchStoryMemorySets, updateStoryMemory } from '../../src/features/studio/agent/agentApi'
import type { StoryMemoryCard } from '../../shared/contracts'
import type { AgentStreamEvent } from '../../shared/contracts/agent-events'

const store = vi.hoisted(() => ({ addComposerReference: vi.fn(), requestToolNavigation: vi.fn(), composerDraft: '',
  activeSessionId: null as string | null, runId: null as string | null, phase: 'idle',
  requestContext: null as Extract<AgentStreamEvent, { type: 'context.usage' }> | null,
  memorySpotlight: null as null | { nonce: number; memoryType: string; title: string; memoryId?: string } }))
vi.mock('../../src/features/studio/agent/agentStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/features/studio/agent/agentStore')>(),
  useAgentStore: (select: (s: unknown) => unknown) => select(store),
}))
const viewer = vi.hoisted(() => ({ id: 'u' as string | undefined }))
vi.mock('../../src/store/useShellStore', () => ({ useShellStore: (select: (s: unknown) => unknown) => select({ sessionUser: viewer }) }))
vi.mock('../../src/features/studio/agent/agentApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/features/studio/agent/agentApi')>(),
  compactAgentContext: vi.fn(), fetchAgentContextState: vi.fn(), fetchStoryMemories: vi.fn(),
  fetchStoryMemorySets: vi.fn(), deleteStoryMemory: vi.fn(), updateStoryMemory: vi.fn(),
}))
let queryClient: QueryClient
function render(ui: ReactElement) {
  return renderReact(ui, { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> })
}
const firstCard: StoryMemoryCard = { id: 'card', title: '真正的卡片', content: '内容', memoryType: 'worldbuilding', layer: 'L1', importance: 50, status: 'inferred', reviewStatus: 'pending', version: 1, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }
const secondCard = { ...firstCard, id: 'second', title: '第二张卡片', content: '另一段正文', version: 2 }
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

beforeEach(() => {
  viewer.id = 'u'
  queryClient = new QueryClient()
  vi.clearAllMocks(); store.memorySpotlight = null
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
  vi.mocked(fetchStoryMemorySets).mockResolvedValue({ sets: [{ memoryType: 'worldbuilding', count: 1, latestUpdatedAt: '2026-09-12T00:00:00Z', previews: ['真正的卡片'] }] })
  vi.mocked(fetchStoryMemories).mockResolvedValue({ total: 1, typeCounts: { worldbuilding: 1 }, items: [firstCard] })
})
afterEach(() => {
  cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear()
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})
const openWorldbuilding = async () => {
  const category = await screen.findByRole('button', { name: '世界观卡片集 1 张' })
  fireEvent.click(category)
  return category
}
it('opens readable legacy cards without review notices and keeps actions available while reading', async () => {
  const legacy = { ...firstCard, content: '临海的旧灯塔\n只在退潮后亮灯。\n\n\n第三章才揭晓缘由。' }
  vi.mocked(fetchStoryMemories).mockResolvedValueOnce({ total: 1, typeCounts: {}, items: [legacy] })
  render(<AgentMemoryCards novelId="n" />)
  await openWorldbuilding()
  const article = await screen.findByRole('article')
  expect(within(article).getByRole('heading', { name: firstCard.title })).toBeTruthy()
  expect(screen.queryByText(/待审核|待作者审核|需核对原文|未生效/)).toBeNull()
  const actions = screen.getByRole('group', { name: '卡片操作' })
  expect(article.querySelector('.memory-markdown p')?.textContent).toBe(legacy.content)
  fireEvent.click(within(article).getByText(/第三章才揭晓缘由/))
  fireEvent.scroll(article)
  expect(screen.getByRole('article')).toBe(article)
  expect(screen.getByRole('group', { name: '卡片操作' })).toBe(actions)
  for (const label of ['编辑卡片', '删除卡片', '引用到对话']) {
    const button = within(actions).getByRole('button', { name: label })
    expect(button.getAttribute('title')).toBe(label)
    expect(button.querySelector('svg')).toBeTruthy()
  }
  fireEvent.click(within(actions).getByRole('button', { name: '引用到对话' }))
  expect(store.addComposerReference).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'memory:card', text: legacy.content }))
  expect(screen.queryByRole('dialog', { name: '创作记忆' })).toBeNull()
})

it('keeps the selected card through an edit and supports keyboard and button navigation', async () => {
  vi.mocked(fetchStoryMemories).mockResolvedValueOnce({ total: 2, typeCounts: { worldbuilding: 2 }, items: [firstCard, secondCard] })
  vi.mocked(updateStoryMemory).mockResolvedValueOnce({ memory: { ...secondCard, title: '修订第二张', version: 3 } })
  render(<AgentMemoryCards novelId="n" />)
  const category = await openWorldbuilding()
  const dialog = screen.getByRole('dialog', { name: '创作记忆' })
  const previous = await screen.findByRole<HTMLButtonElement>('button', { name: '上一张' })
  expect(previous.disabled).toBe(true)
  fireEvent.keyDown(dialog, { key: 'ArrowRight' })
  await screen.findByRole('heading', { name: secondCard.title })
  fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }))
  const editor = screen.getByRole('dialog', { name: '编辑记忆卡片' })
  fireEvent.keyDown(editor, { key: 'ArrowLeft' })
  expect(within(editor).getByLabelText<HTMLInputElement>('标题').value).toBe(secondCard.title)
  fireEvent.change(within(editor).getByLabelText('标题'), { target: { value: '修订第二张' } })
  fireEvent.click(within(editor).getByRole('button', { name: '保存修订' }))
  await screen.findByRole('heading', { name: '修订第二张' })
  expect(updateStoryMemory).toHaveBeenCalledExactlyOnceWith('second', expect.objectContaining({ title: '修订第二张', expectedVersion: 2 }))
  fireEvent.click(previous)
  expect(screen.getByRole('heading', { name: firstCard.title })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭创作记忆' }))
  expect(document.activeElement).toBe(category)
})

it('renders a growing Markdown profile, keeps the list excerpt readable and leaves table scrolling to the reader', async () => {
  const profile = {
    ...firstCard, title: '林汐', sourceChapter: { id: 'chapter-2', title: '雾里的渡船' }, content: [
      '# 林汐', '', '她在**潮汐邮局**送信。', '', '## 眼下的处境', '', '- 追查消失的船票', '',
      '| 章节 | 关键经历 |', '| --- | --- |', '| 2 | 登上渡船 |', '',
      '> 第三声汽笛前下船。', '', '![外部图片](https://example.com/tracker.png)', '',
      '[不安全](javascript:alert(1))', '<img src="https://example.com/x">',
    ].join('\n'),
  }
  vi.mocked(fetchStoryMemories).mockResolvedValueOnce({ total: 2, typeCounts: {}, items: [profile, secondCard] })
  render(<AgentMemoryCards novelId="n" />)
  const trigger = await openWorldbuilding()
  const article = await screen.findByRole('article')
  expect(screen.getByRole('button', { name: '林汐', description: '她在潮汐邮局送信。' })).toBeTruthy()
  expect(within(article).getAllByRole('heading', { name: '林汐' })).toHaveLength(1)
  expect(within(article).getByRole('heading', { name: '眼下的处境' })).toBeTruthy()
  expect(article.querySelector('strong')?.textContent).toBe('潮汐邮局')
  expect(article.querySelector('blockquote')?.textContent).toContain('第三声汽笛前下船')
  expect(article.querySelector('img, script, a[href^="javascript:"]')).toBeNull()
  const table = within(article).getByRole('region', { name: '卡片表格，可横向滚动' })
  expect(within(table).getByRole('cell', { name: '登上渡船' })).toBeTruthy()
  fireEvent.keyDown(table, { key: 'ArrowRight' })
  expect(within(article).getByRole('heading', { name: '林汐' })).toBeTruthy()
  fireEvent.click(within(article).getByRole('button', { name: '来源章节 · 《雾里的渡船》' }))
  expect(store.requestToolNavigation).toHaveBeenCalledWith('chapter_read', { chapterId: 'chapter-2' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('shows category counts and keeps the same open dialog through rapid category changes', async () => {
  const character = { ...firstCard, id: 'character', memoryType: 'characterCard' as const, title: '林夕' }
  const characterPage = { total: 1, items: [character], typeCounts: { characterCard: 1 } }
  let completeCharacter!: (value: typeof characterPage) => void
  const pending = new Promise<typeof characterPage>(resolve => { completeCharacter = resolve })
  vi.mocked(fetchStoryMemorySets).mockResolvedValueOnce({ sets: [
    { memoryType: 'worldbuilding', count: 1, latestUpdatedAt: firstCard.updatedAt, previews: [firstCard.title] },
    { memoryType: 'characterCard', count: 3, latestUpdatedAt: character.updatedAt, previews: [character.title] },
  ] })
  vi.mocked(fetchStoryMemories).mockImplementation(async (_novelId, options) => options?.memoryType === 'characterCard'
    ? pending : { total: 1, items: [firstCard], typeCounts: { worldbuilding: 1 } })
  render(<AgentMemoryCards novelId="n" />)
  const tile = await screen.findByRole('button', { name: '人物卡片集 3 张' })
  expect(tile.textContent).toContain('共 3 个')
  expect(within(tile).queryByText(character.title)).toBeNull()
  await openWorldbuilding()
  const dialog = screen.getByRole('dialog', { name: '创作记忆' })
  const tabs = within(dialog).getByRole('navigation', { name: '记忆分类' })
  await within(dialog).findByRole('heading', { name: firstCard.title })
  const characterTab = within(tabs).getByRole('button', { name: /人物/ })
  characterTab.focus()
  fireEvent.click(characterTab)
  expect(screen.getByRole('dialog', { name: '创作记忆' })).toBe(dialog)
  expect(document.activeElement).toBe(characterTab)
  expect(characterTab.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(within(tabs).getByRole('button', { name: /世界观/ }))
  await act(async () => { completeCharacter(characterPage) })
  expect(within(dialog).getByRole('heading', { name: firstCard.title })).toBeTruthy()
  expect(within(dialog).queryByRole('heading', { name: character.title })).toBeNull()
})

it('navigates a profile appearance by chapter identity even when two chapter titles match', async () => {
  const appearances = [{ id: 'ch-1', title: '来信' }, { id: 'ch-9', title: '来信' }]
  const profile = { ...firstCard, sourceChapter: appearances[0], appearances }
  vi.mocked(fetchStoryMemories).mockResolvedValueOnce({ total: 1, typeCounts: {}, items: [profile] })
  render(<AgentMemoryCards novelId="n" />)
  await openWorldbuilding()
  const reader = await screen.findByRole('article')
  expect(within(reader).queryByRole('button', { name: /来源章节/ })).toBeNull()
  fireEvent.click(within(reader).getByText('出场记录 · 2 章'))
  fireEvent.click(within(reader).getAllByRole('button', { name: '来信' })[1])
  expect(store.requestToolNavigation).toHaveBeenCalledWith('chapter_read', { chapterId: 'ch-9' })
})

it('returns from the mobile reader to the same list and preserves a draft when switching cards', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 767px)' }))
  vi.mocked(fetchStoryMemories).mockResolvedValueOnce({ total: 2, typeCounts: {}, items: [firstCard, secondCard] })
  render(<AgentMemoryCards novelId="n" />)
  await openWorldbuilding()
  const dialog = screen.getByRole('dialog', { name: '创作记忆' })
  const second = await screen.findByRole('button', { name: new RegExp(secondCard.title) })
  const list = within(dialog).getByRole('complementary')
  expect(dialog.hasAttribute('data-reading')).toBe(false)
  fireEvent.click(second)
  expect(dialog.hasAttribute('data-reading')).toBe(true)
  const heading = screen.getByRole('heading', { name: secondCard.title })
  expect(document.activeElement).toBe(heading)
  fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }))
  fireEvent.change(screen.getByLabelText('内容'), { target: { value: '第二张草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并关闭' }))
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(dialog.hasAttribute('data-reading')).toBe(false)
  expect(within(dialog).getByRole('complementary')).toBe(list)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(firstCard.title) }))
  fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }))
  expect(screen.getByLabelText<HTMLTextAreaElement>('内容').value).toBe(firstCard.content)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  fireEvent.click(screen.getByRole('button', { name: '下一张' }))
  fireEvent.click(screen.getByRole('button', { name: '编辑卡片' }))
  expect(screen.getByLabelText<HTMLTextAreaElement>('内容').value).toBe('第二张草稿')
})

it('keeps the loaded cards navigable when fetching the next page fails and can retry', async () => {
  const cards = [firstCard, { ...firstCard, id: 'two', title: '第二张' }, { ...firstCard, id: 'three', title: '第三张' }]
  vi.mocked(fetchStoryMemories)
    .mockResolvedValueOnce({ total: 4, typeCounts: { worldbuilding: 4 }, items: cards })
    .mockRejectedValueOnce(new Error('下一页读取失败'))
    .mockResolvedValueOnce({ total: 4, typeCounts: { worldbuilding: 4 }, items: [{ ...firstCard, id: 'four', title: '第四张' }] })
  render(<AgentMemoryCards novelId="n" />)
  await openWorldbuilding()
  const next = await screen.findByRole<HTMLButtonElement>('button', { name: '下一张' })
  fireEvent.click(next)
  await screen.findByRole('alert')
  expect(screen.getByRole('heading', { name: '第二张' })).toBeTruthy()
  fireEvent.click(next)
  expect(screen.getByRole('heading', { name: '第三张' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(next.disabled).toBe(false))
  fireEvent.click(next)
  expect(screen.getByRole('heading', { name: '第四张' })).toBeTruthy()
})

it('searches the stored category and shows returned cards outside the initial page', async () => {
  vi.mocked(fetchStoryMemories)
    .mockResolvedValueOnce({ total: 50, typeCounts: {}, items: [firstCard] })
    .mockResolvedValueOnce({ total: 1, typeCounts: {}, items: [secondCard] })
  render(<AgentMemoryCards novelId="n" />)
  await openWorldbuilding()
  await screen.findByRole('heading', { name: firstCard.title })
  fireEvent.change(screen.getByRole('textbox', { name: '搜索本分类记忆' }), { target: { value: '  另一段  ' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await screen.findByRole('heading', { name: secondCard.title })
  expect(fetchStoryMemories).toHaveBeenLastCalledWith('n', expect.objectContaining({ query: '另一段', memoryType: 'worldbuilding', page: 1 }))
  expect(screen.queryByRole('heading', { name: firstCard.title })).toBeNull()
})

it('missing spotlight does not silently navigate to the newest unrelated card', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(() => document.body)
  store.memorySpotlight = { nonce: Date.now(), memoryType: 'worldbuilding', title: '并不存在的目标卡' }
  vi.mocked(fetchStoryMemories).mockResolvedValue({ total: 0, items: [], typeCounts: {} })
  render(<AgentMemoryCards novelId="n" />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('未能唯一定位该记忆'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fetchStoryMemories).toHaveBeenCalledWith('n', expect.objectContaining({ title: '并不存在的目标卡' }))
})

it('opens the saved card by ID even when the current name has changed', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(() => document.body)
  store.memorySpotlight = { nonce: Date.now(), memoryType: 'worldbuilding', title: '旧称', memoryId: firstCard.id }
  vi.mocked(fetchStoryMemories).mockResolvedValue({ total: 1, items: [firstCard], typeCounts: { worldbuilding: 2 } })
  render(<AgentMemoryCards novelId="n" />)
  await screen.findByRole('heading', { name: firstCard.title })
  expect(fetchStoryMemories).toHaveBeenCalledWith('n', { memoryType: 'worldbuilding', memoryId: firstCard.id, page: 1, pageSize: 2 })
})

const contextA = { usageRatio: 0.42, estimatedTokens: 4200, contextWindowTokens: 10_000,
  compactionThreshold: 0.85, warningThreshold: 0.75, activeDirectiveCount: 3, checkpoint: null }

it('displays a newer live model estimate only for the owning task and rejects an older replay', async () => {
  const sample = { ...contextA, requestSample: { runId: 'r', seq: 7 } }
  vi.mocked(fetchAgentContextState).mockResolvedValue(sample)
  store.activeSessionId = 'a'
  store.runId = 'r'
  store.phase = 'running'
  store.requestContext = { type: 'context.usage', estimatedTokens: 99840, compactAtTokens: 99840, contextWindowTokens: 128000,
    runId: 'r', seq: 8, ts: new Date().toISOString() }
  try {
    const panel = render(<AgentMemoryCenter sessionId="a" novelId="n" />)
    await screen.findByText('最近一次模型输入估算')
    expect(screen.getAllByText('78%')).toHaveLength(2)
    store.requestContext = { ...store.requestContext, seq: 6 }
    panel.rerender(<AgentMemoryCenter sessionId="a" novelId="n" />)
    expect(screen.getByText('42%')).toBeTruthy()
    store.requestContext = { ...store.requestContext, seq: 9 }
    panel.rerender(<AgentMemoryCenter sessionId="b" novelId="n" />)
    await screen.findByText('42%')
    expect(screen.queryByText('78%')).toBeNull()
  } finally {
    store.requestContext = null
    store.activeSessionId = null
    store.runId = null
    store.phase = 'idle'
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

it('paints a scoped cache immediately on revisit and keeps values through transient failures', async () => {
  vi.mocked(fetchAgentContextState).mockResolvedValueOnce(contextA)
  const initial = render(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  expect(screen.getByText('正在读取上下文状态')).toBeTruthy()
  await screen.findByText('42%')
  await screen.findByRole('button', { name: '世界观卡片集 1 张' })
  initial.unmount()
  const fresh = render(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  expect(screen.getByText('42%').className).not.toContain('studio-metric-updating')
  expect(fetchAgentContextState).toHaveBeenCalledTimes(1)
  expect(fetchStoryMemorySets).toHaveBeenCalledTimes(1)
  fresh.unmount()
  await queryClient.invalidateQueries({ queryKey: ['studio'], refetchType: 'none' })
  const contextRead = deferred<typeof contextA>()
  const setsRead = deferred<Awaited<ReturnType<typeof fetchStoryMemorySets>>>()
  vi.mocked(fetchAgentContextState).mockReturnValueOnce(contextRead.promise)
  vi.mocked(fetchStoryMemorySets).mockReturnValueOnce(setsRead.promise)
  render(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  expect(screen.getByText('42%').className).toContain('studio-metric-updating')
  expect(within(screen.getByRole('button', { name: '世界观卡片集 1 张' })).getByText('1').className).toContain('studio-metric-updating')
  await act(async () => {
    contextRead.reject(new Error('连接暂时中断'))
    setsRead.reject(new Error('数量暂不可更新'))
  })
  await screen.findByText('数量暂不可更新')
  expect(screen.getByText('42%').className).not.toContain('studio-metric-updating')
  expect(screen.getByRole('button', { name: '世界观卡片集 1 张' })).toBeTruthy()
})

it('discards an inaccessible snapshot even if the next retry fails, and isolates the next user and task', async () => {
  vi.mocked(fetchAgentContextState).mockResolvedValueOnce(contextA)
  const panel = render(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  await screen.findByText('42%')
  const response = deferred<Awaited<ReturnType<typeof compactAgentContext>>>()
  vi.mocked(compactAgentContext).mockReturnValueOnce(response.promise)
  fireEvent.click(screen.getByRole('button', { name: '手动压缩当前会话' }))
  const pending = deferred<typeof contextA>()
  vi.mocked(fetchAgentContextState).mockReturnValueOnce(pending.promise)
  panel.rerender(<AgentMemoryCenter sessionId="task-b" novelId="n" />)
  expect(screen.queryByText('42%')).toBeNull()
  await act(async () => response.resolve({ state: contextA, checkpoint: null }))
  expect(screen.queryByText('当前有效对话较短，暂时无需压缩。')).toBeNull()
  await act(async () => pending.resolve({ ...contextA, usageRatio: 0.25 }))
  await screen.findByText('25%')
  vi.mocked(fetchAgentContextState).mockRejectedValueOnce(new AgentApiError('无权访问', 403, null))
  fireEvent.click(screen.getByRole('button', { name: '刷新上下文状态' }))
  await screen.findByText('无权访问')
  expect(screen.queryByText('25%')).toBeNull()
  vi.mocked(fetchAgentContextState).mockRejectedValueOnce(new Error('断线'))
  fireEvent.click(screen.getByRole('button', { name: '刷新上下文状态' }))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '刷新上下文状态' }).disabled).toBe(false))
  expect(screen.queryByText('25%')).toBeNull()
  viewer.id = undefined
  panel.rerender(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  expect(screen.queryByText('42%')).toBeNull()
  expect(screen.queryByRole('button', { name: '世界观卡片集 1 张' })).toBeNull()
  viewer.id = 'reader-b'
  vi.mocked(fetchAgentContextState).mockRejectedValueOnce(new Error('暂不可用'))
  vi.mocked(fetchStoryMemorySets).mockResolvedValueOnce({ sets: [] })
  panel.rerender(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  await screen.findByText('还没有创作记忆。')
  expect(screen.queryByText('42%')).toBeNull()
})

it('supersedes a pending first memory read when the run finishes', async () => {
  const oldRead = deferred<Awaited<ReturnType<typeof fetchStoryMemorySets>>>()
  vi.mocked(fetchStoryMemorySets).mockReturnValueOnce(oldRead.promise)
  const panel = render(<AgentMemoryCards novelId="n" sessionId="task-a" active />)
  panel.rerender(<AgentMemoryCards novelId="n" sessionId="task-a" active={false} />)
  await screen.findByRole('button', { name: '世界观卡片集 1 张' })
  await act(async () => oldRead.resolve({ sets: [] }))
  expect(screen.getByRole('button', { name: '世界观卡片集 1 张' })).toBeTruthy()
})

it('does not restore a revoked checkpoint when an earlier compaction finishes', async () => {
  vi.mocked(fetchAgentContextState).mockResolvedValueOnce(contextA)
  const late = deferred<Awaited<ReturnType<typeof compactAgentContext>>>()
  vi.mocked(compactAgentContext).mockReturnValueOnce(late.promise)
  render(<AgentMemoryCenter sessionId="task-a" novelId="n" />)
  await screen.findByText('42%')
  fireEvent.click(screen.getByRole('button', { name: '手动压缩当前会话' }))
  vi.mocked(fetchAgentContextState).mockRejectedValueOnce(new AgentApiError('无权访问', 403, null))
  fireEvent.click(screen.getByRole('button', { name: '刷新上下文状态' }))
  await screen.findByText('无权访问')
  await act(async () => late.resolve({ state: contextA, checkpoint: null }))
  expect(screen.getByText('无权访问')).toBeTruthy()
  expect(screen.queryByText('42%')).toBeNull()
  expect(fetchAgentContextState).toHaveBeenCalledTimes(2)
})

it('closes a revoked catalog and never shows the first novel while a second novel is pending', async () => {
  const panel = render(<AgentMemoryCards novelId="first" />)
  vi.mocked(fetchStoryMemories).mockRejectedValueOnce(new AgentApiError('作品已不可访问', 404, null))
  await openWorldbuilding()
  await screen.findByText('作品已不可访问')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: '世界观卡片集 1 张' })).toBeNull()
  const next = deferred<Awaited<ReturnType<typeof fetchStoryMemorySets>>>()
  vi.mocked(fetchStoryMemorySets).mockReturnValueOnce(next.promise)
  panel.rerender(<AgentMemoryCards novelId="second" />)
  expect(screen.queryByText('作品已不可访问')).toBeNull()
  expect(screen.getByRole('status', { name: '正在读取创作记忆' })).toBeTruthy()
  await act(async () => next.resolve({ sets: [] }))
  await screen.findByText('还没有创作记忆。')
})
