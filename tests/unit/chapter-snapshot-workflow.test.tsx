// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useChapterPersistence } from '../../src/features/studio/components/use-chapter-persistence'
import { useChapterSnapshot } from '../../src/features/studio/components/use-chapter-snapshot'
import LocalFirstTextarea from '../../src/features/studio/components/LocalFirstTextarea'
import { adoptChapterResult } from '../../src/features/studio/components/chapter-stream-handoff'
import { getChapterContent } from '../../src/features/studio/api'
import type { AgentStreamEvent, Chapter } from '../../shared/contracts/index.js'
import type { ChapterDraftState, ChapterPendingReview, SaveState } from '../../src/features/studio/types'

const api = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }))
vi.mock('../../src/features/studio/api', () => ({ getChapterContent: api.read, createChapterDraft: vi.fn(), updateChapterDraft: api.update }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const base = { title: '章', summary: '', status: 'draft' as const, visibility: 'private' as const, orderIndex: 1, revision: 1, localOnly: false }
const saved = (id: string, content: string, novelId = 'novel', revision = 1) => ({ ...base, id, content, novelId, revision, updatedAt: '2026-10-03T00:00:00Z', wordCount: content.length } as unknown as Chapter)
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

function Workflow({ novelId = 'novel', scope = 'task-a', hydratedScope = scope }: { novelId?: string; scope?: string; hydratedScope?: string }) {
  const [draft, setDraft] = useState<ChapterDraftState | null>({ ...base, id: 'a', content: 'A原文' })
  const [dirty, setDirty] = useState(false), [selected, setSelected] = useState<string | null>('a')
  const [saveState, setSaveState] = useState<SaveState>('idle'), [, setMessage] = useState(''), [, setSavedAt] = useState<string | null>(null)
  const draftRef = useRef(draft), dirtyRef = useRef(dirty), selectedRef = useRef(selected), reviews = useRef<ChapterPendingReview[]>([])
  draftRef.current = draft; dirtyRef.current = dirty; selectedRef.current = selected
  const persist = useChapterPersistence({ activeNovelId: novelId, chapterDraft: draft, chapterDirty: dirty,
    chapterDraftStateRef: draftRef, pendingChapterReviewsRef: reviews, selectedChapterIdStateRef: selectedRef,
    setChapterDraft: setDraft, setChapterDirty: setDirty, setSelectedChapterId: setSelected,
    setChapterSaveState: setSaveState, setChapterSaveMessage: setMessage, setChapterLastSavedAt: setSavedAt,
    setChapters: vi.fn(), setSelectedTreeItemId: vi.fn(), setCurrentNovel: vi.fn(), syncStudioPayload: vi.fn(), promptConfirmPendingChapterReview: vi.fn() })
  const query = useQuery({ queryKey: ['workflow', novelId, scope, selected], queryFn: () => getChapterContent(novelId, selected!), enabled: Boolean(scope && scope === hydratedScope && selected === 'b'), retry: false })
  useChapterSnapshot({ data: query.data, selectedChapterId: selected, novelId, scope, hydratedScope, draftRef, dirtyRef,
    setDraft, setDirty, setSaveState, setLastSavedAt: setSavedAt, setSaveMessage: setMessage })
  return <><button onClick={() => { if (dirtyRef.current) void persist('auto'); setSelected('b'); setDraft(null) }}>打开B</button>
    <button onClick={() => {
      const owner = { novelId, scope, sessionId: 'session' }
      const event = { type: 'tool.result', runId: 'run', callId: 'call', toolName: 'chapter_write', ok: true, ts: '',
        display: { kind: 'chapterDiff', chapterId: 'b', chapterTitle: '章', before: '旧B', after: 'B工具已保存', appliedDirectly: true, revision: 2 } } as Extract<AgentStreamEvent, { type: 'tool.result' }>
      adoptChapterResult({ event, origin: owner, current: owner, activeSessionId: 'session', activeRunId: 'run',
        selectedChapterId: selectedRef.current, dirty: dirtyRef.current, draft: draftRef.current },
      { ...base, id: 'b', content: 'B工具已保存', revision: 2 }, { draftRef, dirtyRef, setDraft, setDirty, setSaveState })
    }}>B工具结果</button>
    <span data-testid="state">{selected}:{dirty ? 'dirty' : 'clean'}:{saveState}</span>
    {draft ? <LocalFirstTextarea aria-label="正文" resetKey={`${scope}:${draft.id}`} value={draft.content} onCommit={content => {
      const next = { ...draft, content }; draftRef.current = next; dirtyRef.current = true; setDraft(next); setDirty(true)
    }} /> : <span>载入中</span>}</>
}
function mount(props: Parameters<typeof Workflow>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><Workflow {...props} /></QueryClientProvider>)
  return { ...view, rerenderWorkflow: (next: Parameters<typeof Workflow>[0]) => view.rerender(<QueryClientProvider client={client}><Workflow {...next} /></QueryClientProvider>) }
}

it('loads B through a null draft and inherited dirty while A saves, preserving A payload and newer B typing', async () => {
  const saveA = deferred<Chapter>(), readB = deferred<Chapter>()
  api.update.mockReturnValue(saveA.promise); api.read.mockReturnValue(readB.promise)
  mount()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A作者修改' } })
  fireEvent.blur(screen.getByRole('textbox'))
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  expect(screen.getByText('载入中')).toBeTruthy()
  expect(api.update).toHaveBeenCalledWith('novel', 'a', expect.objectContaining({ content: 'A作者修改', expectedRevision: 1 }))
  await act(async () => { readB.resolve(saved('b', 'B已保存正文')); await readB.promise })
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('B已保存正文'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B新输入' } })
  fireEvent.blur(screen.getByRole('textbox'))
  await act(async () => { saveA.resolve(saved('a', 'A作者修改', 'novel', 2)); await saveA.promise })
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('B新输入')
  expect(screen.getByTestId('state').textContent).toContain('b:dirty')
})

it('does not hydrate an unowned transition or accept a previous novel response, then restores the incoming scope', async () => {
  const old = deferred<Chapter>(), next = deferred<Chapter>()
  api.read.mockImplementation(novel => novel === 'novel' ? old.promise : next.promise)
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  view.rerenderWorkflow({ novelId: 'novel-2', scope: 'task-b', hydratedScope: 'task-a' })
  await act(async () => { old.resolve(saved('b', '旧作品晚到正文')); await old.promise })
  expect(screen.queryByRole('textbox')).toBeNull()
  view.rerenderWorkflow({ novelId: 'novel-2', scope: 'task-b', hydratedScope: 'task-b' })
  await act(async () => { next.resolve(saved('b', '新任务正文', 'novel-2')); await next.promise })
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新任务正文'))
  view.rerenderWorkflow({ novelId: 'novel', scope: 'task-a', hydratedScope: 'task-a' })
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('旧作品晚到正文'))
  view.rerenderWorkflow({ novelId: 'novel-2', scope: 'task-b', hydratedScope: 'task-b' })
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新任务正文'))
})

it('clears inherited A dirty when B commits before its query, rejects old snapshots and preserves later B input', async () => {
  const saveA = deferred<Chapter>(), readB = deferred<Chapter>()
  api.update.mockReturnValue(saveA.promise); api.read.mockReturnValue(readB.promise)
  mount()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A待保存修改' } })
  fireEvent.blur(screen.getByRole('textbox'))
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  expect(screen.getByTestId('state').textContent).toContain('b:dirty')
  fireEvent.click(screen.getByRole('button', { name: 'B工具结果' }))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('B工具已保存')
  expect(screen.getByTestId('state').textContent).toBe('b:clean:saved')
  await act(async () => { readB.resolve(saved('b', 'B旧请求', 'novel', 1)); await readB.promise })
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('B工具已保存')
  await act(async () => { saveA.resolve(saved('a', 'A待保存修改', 'novel', 2)); await saveA.promise })
  expect(screen.getByTestId('state').textContent).toBe('b:clean:saved')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B作者新输入' } })
  fireEvent.blur(screen.getByRole('textbox'))
  fireEvent.click(screen.getByRole('button', { name: 'B工具结果' }))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('B作者新输入')
  expect(screen.getByTestId('state').textContent).toContain('b:dirty')
  expect(api.update).toHaveBeenCalledExactlyOnceWith('novel', 'a', expect.objectContaining({ content: 'A待保存修改' }))
})
