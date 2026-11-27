// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useChapterPersistence } from '../../src/features/studio/components/use-chapter-persistence'
import { useChapterSnapshot } from '../../src/features/studio/components/use-chapter-snapshot'
import LocalFirstTextarea from '../../src/features/studio/components/LocalFirstTextarea'
import { adoptChapterResult } from '../../src/features/studio/components/chapter-stream-handoff'
import { getChapterContent } from '../../src/features/studio/api'
import { ApiClientError } from '../../src/app/api-client'
import { chapterRecoveryKey, listChapterCopies, readChapterEdits, retireChapterCopy, storeChapterEdits, viewSyncedChapter } from '../../src/features/studio/lib/chapter-recovery'
import ChapterDraftChoice from '../../src/features/studio/components/ChapterDraftChoice'
import type { AgentStreamEvent, Chapter } from '../../shared/contracts/index.js'
import type { ChapterDraftState, ChapterPendingReview, SaveState } from '../../src/features/studio/types'

const api = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }))
vi.mock('../../src/features/studio/api', () => ({ getChapterContent: api.read, createChapterDraft: vi.fn(), updateChapterDraft: api.update }))
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks() })
const base = { title: '章', summary: '', status: 'draft' as const, visibility: 'private' as const, orderIndex: 1, revision: 1, localOnly: false }
const saved = (id: string, content: string, novelId = 'novel', revision = 1) => ({ ...base, id, content, novelId, revision, updatedAt: '2026-10-03T00:00:00Z', wordCount: content.length } as unknown as Chapter)
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

it('selects review evidence only when it uniquely matches the visible chapter text', () => {
  const onCommit = vi.fn()
  const onSelectionChange = vi.fn()
  const text = '钥匙交给老陈。钥匙放在门边。'
  const update = (quote: string) => <LocalFirstTextarea aria-label="审阅正文" value={text} onCommit={onCommit}
    onSelectionChange={onSelectionChange} reviewEvidence={{ text: quote }} />
  const view = render(update('钥匙交给老陈。'))
  const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '审阅正文' })
  expect(textarea.selectionStart).toBe(0)
  expect(textarea.selectionEnd).toBe(7)
  expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 0, end: 7, text: '钥匙交给老陈。' })
  textarea.setSelectionRange(2, 2)
  view.rerender(update('钥匙'))
  view.rerender(update('没有这句原文。'))
  expect(textarea.selectionStart).toBe(2)
  expect(textarea.selectionEnd).toBe(2)
  expect(textarea.value).toBe(text)
  expect(onCommit).not.toHaveBeenCalled()
})

it.each([false, true])('preserves chapter input against its original revision when a newer snapshot arrives before commit (IME %s)', async ime => {
  const original = vi.fn(), newer = vi.fn()
  const editor = (value: string, commit: (text: string) => void) =>
    <LocalFirstTextarea aria-label="正文" resetKey="chapter" recoveryKey="author-chapter" value={value} onCommit={commit} />
  const view = render(editor('初稿', original))
  const input = screen.getByRole('textbox', { name: '正文' })
  if (ime) fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: '作者正在输入' } })
  view.rerender(editor('其他位置已保存', newer))
  if (ime) {
    fireEvent.change(input, { target: { value: '作者正在输入的' } })
    fireEvent.compositionEnd(input)
    fireEvent.change(input, { target: { value: '作者正在输入的字' } })
  }
  await waitFor(() => expect(original).toHaveBeenCalledWith(ime ? '作者正在输入的字' : '作者正在输入'))
  expect(newer).not.toHaveBeenCalled()
})

function Workflow({ novelId = 'novel', userId, scope = 'task-a', hydratedScope = scope }: { novelId?: string; userId?: string; scope?: string; hydratedScope?: string }) {
  const [draft, setDraft] = useState<ChapterDraftState | null>({ ...base, id: 'a', content: 'A原文' })
  const [dirty, setDirty] = useState(false), [selected, setSelected] = useState<string | null>('a')
  const [saveState, setSaveState] = useState<SaveState>('idle'), [, setMessage] = useState(''), [, setSavedAt] = useState<string | null>(null)
  const draftRef = useRef(draft), dirtyRef = useRef(dirty), selectedRef = useRef(selected), reviews = useRef<ChapterPendingReview[]>([])
  draftRef.current = draft; dirtyRef.current = dirty; selectedRef.current = selected
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['workflow', novelId, scope, selected], queryFn: () => getChapterContent(novelId, selected!), enabled: Boolean(scope && scope === hydratedScope && selected === 'b'), retry: false })
  const choice = useChapterSnapshot({ data: query.data, selectedChapterId: selected, novelId, userId, scope, hydratedScope, draftRef, dirtyRef,
    setDraft, setDirty, setSaveState, setLastSavedAt: setSavedAt, setSaveMessage: setMessage })
  const persist = useChapterPersistence({ activeNovelId: novelId, userId, chapterDraft: draft, chapterDirty: dirty,
    recoveryPending: Boolean(choice), syncSavedChapter: row => client.setQueryData(['workflow', novelId, scope, row.id], row),
    chapterDraftStateRef: draftRef, pendingChapterReviewsRef: reviews, selectedChapterIdStateRef: selectedRef,
    setChapterDraft: setDraft, setChapterDirty: setDirty, setSelectedChapterId: setSelected,
    setChapterSaveState: setSaveState, setChapterSaveMessage: setMessage, setChapterLastSavedAt: setSavedAt,
    setChapters: vi.fn(), setSelectedTreeItemId: vi.fn(), setCurrentNovel: vi.fn(), syncStudioPayload: vi.fn(), promptConfirmPendingChapterReview: vi.fn() })
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
    {choice && <ChapterDraftChoice {...choice} />}
    {draft ? <LocalFirstTextarea aria-label="正文" resetKey={`${scope}:${draft.id}`} recoveryKey={choice ? undefined : chapterRecoveryKey(userId, novelId, draft.id)} value={draft.content} onCommit={content => {
      const next = { ...draft, content }
      storeChapterEdits(chapterRecoveryKey(userId, novelId, draft.id), next)
      draftRef.current = next; dirtyRef.current = true; setDraft(next); setDirty(true)
    }} /> : <span>载入中</span>}</>
}
function mount(props: Parameters<typeof Workflow>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><Workflow {...props} /></QueryClientProvider>)
  return { ...view, rerenderWorkflow: (next: Parameters<typeof Workflow>[0]) => view.rerender(<QueryClientProvider client={client}><Workflow {...next} /></QueryClientProvider>) }
}

it('captures typing and selection before debounce on expiry and resumes only the original account, preserving revision conflicts', async () => {
  const key = chapterRecoveryKey('writer', 'novel', 'b')
  const open = async (userId: string) => {
    const view = mount({ userId })
    fireEvent.click(screen.getByRole('button', { name: '打开B' }))
    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '正文' })
    return { ...view, input }
  }
  api.read.mockResolvedValue(saved('b', '已同步'))
  const original = await open('writer')
  original.input.focus()
  fireEvent.compositionStart(original.input)
  fireEvent.change(original.input, { target: { value: '仍未同步的最后输入' } })
  original.input.setSelectionRange(2, 6)
  original.input.scrollTop = 125
  act(() => window.dispatchEvent(new Event('chevoink:session-expired')))
  expect(readChapterEdits(key)).toMatchObject({ content: '仍未同步的最后输入', revision: 1 })
  original.unmount()
  sessionStorage.clear()
  const other = await open('other')
  expect(other.input.value).toBe('已同步')
  expect(other.input.scrollTop).toBe(0)
  other.unmount()
  api.read.mockResolvedValue(saved('b', '服务端新版本', 'novel', 2))
  api.update.mockResolvedValue(saved('b', '仍未同步的最后输入', 'novel', 3))
  const resumed = await open('writer')
  expect(resumed.input.value).toBe('服务端新版本')
  expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '所选草稿正文' })).value).toBe('仍未同步的最后输入')
  expect(api.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '恢复所选草稿' }))
  expect(resumed.input.value).toBe('仍未同步的最后输入')
  expect([resumed.input.selectionStart, resumed.input.selectionEnd, resumed.input.scrollTop]).toEqual([2, 6, 125])
  expect(document.activeElement).toBe(resumed.input)
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('b:clean:saved'), { timeout: 2400 })
  expect(api.update).toHaveBeenCalledExactlyOnceWith('novel', 'b', expect.objectContaining({ expectedRevision: 2, content: '仍未同步的最后输入' }))
  expect(readChapterEdits(key)).toBeUndefined()
})

it('reopens independent drafts from closed browser tabs and saves only the explicitly selected copy', async () => {
  // Each isolated module represents a separate page's JS heap, sharing this origin's localStorage.
  const key = chapterRecoveryKey('reopened-writer', 'novel', 'b')!
  vi.resetModules()
  const tab1 = await import('../../src/features/studio/lib/chapter-recovery')
  vi.resetModules()
  const tab2 = await import('../../src/features/studio/lib/chapter-recovery')
  tab1.storeChapterEdits(key, { ...base, content: '第一份未同步正文' })
  tab2.adoptChapterCopy(key, tab2.listChapterCopies(key)[0])
  tab2.storeChapterEdits(key, { ...base, content: '第二份未同步正文' })
  sessionStorage.clear()
  api.read.mockResolvedValue(saved('b', '服务端正文'))
  api.update.mockResolvedValue(saved('b', '第一份未同步正文', 'novel', 2))
  mount({ userId: 'reopened-writer' })
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  const selector = await screen.findByRole('combobox', { name: '本地草稿' })
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(api.update).not.toHaveBeenCalled()
  const first = listChapterCopies(key).find(copy => copy.edits.content === '第一份未同步正文')!
  fireEvent.change(selector, { target: { value: first.slot } })
  expect((screen.getByRole('textbox', { name: '所选草稿正文' }) as HTMLTextAreaElement).value).toBe('第一份未同步正文')
  fireEvent.click(screen.getByRole('button', { name: '恢复所选草稿' }))
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('b:clean:saved'), { timeout: 2400 })
  expect(api.update).toHaveBeenCalledExactlyOnceWith('novel', 'b', expect.objectContaining({ content: '第一份未同步正文', expectedRevision: 1 }))
  expect(listChapterCopies(key).map(copy => copy.edits.content)).toEqual(['第二份未同步正文'])
})

it('keeps a quota-failed draft in memory through reauthentication and prompts before closing until it is backed up', () => {
  const key = chapterRecoveryKey('limited-storage-writer', 'novel', 'b')!
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  expect(storeChapterEdits(key, { ...base, content: '待备份' })).toBe(false)
  expect(listChapterCopies(key).map(copy => copy.edits.content)).toEqual(['待备份'])
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
  failure.mockRestore()
  expect(storeChapterEdits(key, { ...base, content: '待备份' })).toBe(true)
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
  expect(listChapterCopies(key)).toHaveLength(1)
})

it('keeps a shelved memory-only draft after typing into the synced chapter', () => {
  const key = chapterRecoveryKey('full-storage', 'novel', 'b')!
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  storeChapterEdits(key, { ...base, content: '未落盘的草稿' })
  const [original] = listChapterCopies(key)
  viewSyncedChapter(key, [original])
  expect(readChapterEdits(key)).toBeUndefined()
  failure.mockRestore()
  storeChapterEdits(key, { ...base, revision: 2, content: '从已同步版本继续' })
  expect(listChapterCopies(key).map(c => c.edits.content)).toContain('未落盘的草稿')
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
  retireChapterCopy(key, original)
  expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
})

it('removes a local draft when the server already has the same edits after a lost save response', async () => {
  const key = chapterRecoveryKey('writer', 'novel', 'b')
  storeChapterEdits(key, { ...base, content: '已经落盘' })
  api.read.mockResolvedValue(saved('b', '已经落盘', 'novel', 2))
  mount({ userId: 'writer' })
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  await screen.findByDisplayValue('已经落盘')
  expect(readChapterEdits(key)).toBeUndefined()
  expect(screen.getByTestId('state').textContent).toBe('b:clean:saved')
  expect(api.update).not.toHaveBeenCalled()
})

it('reads a concurrent save once, lets the author view the server version, and keeps the local copy across refresh', async () => {
  const userId = 'concurrent-writer'
  const key = chapterRecoveryKey(userId, 'novel', 'b')
  api.read.mockResolvedValueOnce(saved('b', '共同底稿')).mockResolvedValue(saved('b', '另一个窗口的修订', 'novel', 2))
  api.update.mockRejectedValue(new ApiClientError('版本冲突', 409, undefined, 'CHAPTER_REVISION_CONFLICT'))
  const open = () => fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  const view = mount({ userId })
  open()
  const input = await screen.findByDisplayValue('共同底稿')
  fireEvent.change(input, { target: { value: '本窗口未提交的修改' } })
  fireEvent.blur(input)
  await waitFor(() => expect(screen.getByRole('button', { name: '查看已同步正文' })).toBeTruthy(), { timeout: 2400 })
  expect(api.read).toHaveBeenCalledTimes(2)
  expect(api.update).toHaveBeenCalledTimes(1)
  expect(readChapterEdits(key)?.content).toBe('本窗口未提交的修改')
  fireEvent.click(screen.getByRole('button', { name: '查看已同步正文' }))
  expect(await screen.findByDisplayValue('另一个窗口的修订')).toBeTruthy()
  view.unmount()
  mount({ userId })
  open()
  expect(await screen.findByDisplayValue('另一个窗口的修订')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '恢复所选草稿' })).toBeNull()
  expect(listChapterCopies(key).map(copy => copy.edits.content)).toEqual(['本窗口未提交的修改'])
  const current = screen.getByRole('textbox', { name: '正文' })
  fireEvent.change(current, { target: { value: '接着同步稿编辑' } })
  fireEvent.blur(current)
  expect(listChapterCopies(key).map(copy => copy.edits.content)).toContain('本窗口未提交的修改')
  expect(api.update).toHaveBeenCalledTimes(1)
})

it('restores text against the selected current revision without publishing a previously public local copy', async () => {
  const userId = 'changed-visibility'
  const key = chapterRecoveryKey(userId, 'novel', 'b')
  storeChapterEdits(key, { ...base, content: '保留此正文', status: 'published', visibility: 'public' })
  api.read.mockResolvedValue(saved('b', '已撤回的章节', 'novel', 5))
  api.update.mockResolvedValue(saved('b', '保留此正文', 'novel', 6))
  mount({ userId })
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  fireEvent.click(await screen.findByRole('button', { name: '恢复所选草稿' }))
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('b:clean:saved'), { timeout: 2400 })
  expect(api.update).toHaveBeenCalledExactlyOnceWith('novel', 'b', expect.objectContaining({
    expectedRevision: 5, content: '保留此正文', status: 'draft', visibility: 'private',
  }))
})

it('accepts an identical conflict readback after a lost acknowledgement without a second write', async () => {
  api.read.mockResolvedValueOnce(saved('b', '旧稿')).mockResolvedValue(saved('b', '已保存的输入', 'novel', 2))
  api.update.mockRejectedValue(new ApiClientError('版本冲突', 409, undefined, 'CHAPTER_REVISION_CONFLICT'))
  mount({ userId: 'lost-ack' })
  fireEvent.click(screen.getByRole('button', { name: '打开B' }))
  const input = await screen.findByDisplayValue('旧稿')
  fireEvent.change(input, { target: { value: '已保存的输入' } })
  fireEvent.blur(input)
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('b:clean:saved'), { timeout: 2400 })
  expect(api.update).toHaveBeenCalledTimes(1)
  expect(api.read).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: '恢复所选草稿' })).toBeNull()
})

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
