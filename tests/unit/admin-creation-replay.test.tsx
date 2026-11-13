// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AdminAgentRunDetailsPayload, AdminAgentRunRow, AgentMessagePart } from '../../shared/contracts/index.js'
import AdminCreationRecordsPage from '../../src/features/admin/pages/AdminCreationRecordsPage'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../src/app/api-client', () => ({ requestJson: request }))

const at = '2026-11-12T16:04:21Z'
const session = { id: 'session-synthetic', title: '沙漠探险小说筹备', novelTitle: '未命名作品', displayTitle: null, createdAt: at }
const tool = (index: number, toolName: string, options: Partial<Extract<AgentMessagePart, { type: 'tool-call' }>> = {}): AgentMessagePart => ({
  type: 'tool-call', callId: `call-${index}`, toolName, title: toolName, args: {}, status: 'failed', ...options,
})
const run: AdminAgentRunRow = {
  id: 'run-synthetic', status: 'failed', mode: 'act', action: 'workspaceAgent', inputSummary: null, outputSummary: null,
  errorMessage: '今日创作额度已用尽，任务已停止。', createdAt: at, startedAt: at, finishedAt: '2026-11-12T16:37:21Z',
  usage: { promptTokens: 17_000_000, completionTokens: 32_000, totalTokens: 17_032_000 }, usageRecorded: true,
  messages: [
    { id: 'request', runId: 'run-synthetic', role: 'user', createdAt: at, parts: [{ type: 'text', text: '帮我创建一部沙漠探险小说' }] },
    { id: 'question', runId: 'run-synthetic', role: 'assistant', createdAt: at, parts: [
      ...Array.from({ length: 286 }, (): AgentMessagePart => ({ type: 'reasoning', text: '仅用于压力夹具的内部记录' })),
      tool(1, 'ask_user', { status: 'success', durationMs: 600_000, display: {
        kind: 'question', question: '你想选择哪条探险路线？', options: [{ label: '古城' }, { label: '绿洲' }], unanswered: true,
      } }),
      ...Array.from({ length: 21 }, (_, index) => tool(index + 2, 'novel_create')),
      tool(23, 'plan_save', { status: 'success', args: { planId: 'plan-synthetic' },
        display: { kind: 'planFile', artifactId: 'plan-synthetic', title: '远征计划', content: '合成计划' } }),
    ] },
    { id: 'reply', runId: 'run-synthetic', role: 'assistant', createdAt: '2026-11-12T16:36:41Z', parts: [{ type: 'text', text: '**方向还未确认。**' }] },
  ],
}
const runDetails: AdminAgentRunDetailsPayload = {
  models: ['fixture-model'], creditsMilli: 450_000, nextAfter: 5,
  events: [
    { seq: 1, type: 'tool.call', at, toolName: 'ask_user', callId: 'call-1', outcome: 'dispatched', failureCode: null, summary: null, durationMs: null },
    { seq: 3, type: 'tool.result', at, toolName: 'ask_user', callId: 'call-1', outcome: 'unanswered', failureCode: null, summary: '提问未获回答', durationMs: 600_000 },
    { seq: 5, type: 'tool.result', at, toolName: 'novel_create', callId: 'call-2', outcome: 'failed', failureCode: 'NOVEL_DIRECTION_REQUIRED', summary: '需要作者确认', durationMs: 50 },
  ],
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/admin/users/author-synthetic/creation-records']}>
      <Routes><Route path="/admin/users/:userId/creation-records" element={<AdminCreationRecordsPage />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>)
}

beforeEach(() => {
  request.mockReset().mockImplementation(async (path: string) => {
    const url = new URL(path, 'https://fixture.example.com')
    if (url.pathname.endsWith('/creation-records')) return {
      user: { id: 'author-synthetic', nickname: '合成作者', avatarUrl: null },
      novels: [{ novelId: 'novel-synthetic', title: '未命名作品', displayTitle: null, status: 'draft', chapterCount: 0, wordCount: 0,
        updatedAt: at, totalTokens: 17_032_000, sessions: [{ id: session.id, title: session.title, status: 'active', runCount: 2, lastRunAt: at, createdAt: at, totalTokens: 17_032_000 }] }],
    }
    if (url.pathname.endsWith('/messages')) return url.searchParams.has('before') ? {
      session, hasMore: false, nextCursor: null,
      runs: [{ ...run, id: 'older', status: 'completed', errorMessage: null, messages: [
        { id: 'older-prompt', runId: 'older', role: 'user', createdAt: at, parts: [{ type: 'text', text: '更早的作者请求' }] },
      ] }],
    } : { session, runs: [run], hasMore: true, nextCursor: run.id }
    if (url.pathname.endsWith('/runs/run-synthetic')) return url.searchParams.has('after')
      ? { ...runDetails, events: [{ ...runDetails.events[2], seq: 6, failureCode: 'NOVEL_SETUP_AUTHORITY_REQUIRED' }], nextAfter: null } : runDetails
    throw new Error(`Unexpected test request ${path}`)
  })
})
afterEach(cleanup)

it('replays saved author-facing conversation with Studio controls and loads raw chronological receipts only on demand', async () => {
  mount()
  const entry = await screen.findByRole('link', { name: /沙漠探险小说筹备/ })
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('17,032,000')).toBeNull()
  fireEvent.click(entry)
  expect(await screen.findByRole('heading', { name: session.title })).toBeTruthy()
  expect(screen.getByText('帮我创建一部沙漠探险小说').closest('.agent-conversation-width')).toBeTruthy()
  expect(screen.getByText('方向还未确认。').tagName).toBe('STRONG')
  const prompt = screen.getByText('帮我创建一部沙漠探险小说').closest('.group\\/replay-message') as HTMLElement
  const reply = screen.getByText('方向还未确认。').closest('.group\\/replay-message') as HTMLElement
  expect(within(prompt).getByLabelText('发送时间 2026-11-13 00:04:21 香港时间').getAttribute('datetime')).toBe(at)
  expect(within(reply).getByLabelText('回复时间 2026-11-13 00:36:41 香港时间').getAttribute('datetime')).toBe('2026-11-12T16:36:41Z')
  expect(screen.getByText(run.errorMessage!)).toBeTruthy()
  expect(screen.queryByText(/309 项操作|内部记录/)).toBeNull()
  expect(request.mock.lastCall?.[0]).toContain('view=replay')
  expect(request.mock.lastCall?.[0]).toContain('userId=author-synthetic')
  expect(screen.queryByRole('complementary', { name: '运行详情' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '查看处理过程' }))
  fireEvent.click(await screen.findByRole('button', { name: '提问未获回答' }))
  expect(await screen.findByText('你想选择哪条探险路线？')).toBeTruthy()
  expect(screen.getByText('古城')).toBeTruthy()
  expect(screen.getByText('尚未收到回答')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '古城' })).toBeNull()
  expect(screen.queryByRole('button', { name: /继续任务|创建分支|回退到此|删除这轮|打开计划/ })).toBeNull()
  expect(request.mock.calls.every(([path]) => !path.includes('/runs/'))).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: '运行详情' }))
  const detail = await screen.findByRole('complementary', { name: '运行详情' })
  expect(await within(detail).findByText('fixture-model')).toBeTruthy()
  expect(within(detail).getByText('450')).toBeTruthy()
  expect(within(detail).getAllByText(/2026-11-13 00:04:21 香港时间/).length).toBeGreaterThan(0)
  expect(within(detail).getAllByRole('listitem').map(item => item.textContent).join('|')).toMatch(/#1.+#3.+#5/)
  expect(within(detail).getByText('NOVEL_DIRECTION_REQUIRED')).toBeTruthy()
  fireEvent.click(within(detail).getByRole('button', { name: '加载更多工具回执' }))
  expect(await within(detail).findByText('NOVEL_SETUP_AUTHORITY_REQUIRED')).toBeTruthy()
  expect(request.mock.lastCall?.[0]).toContain('after=5')

  fireEvent.click(screen.getByRole('button', { name: '加载更早对话' }))
  const older = await screen.findByText('更早的作者请求')
  expect(older.compareDocumentPosition(screen.getByText('帮我创建一部沙漠探险小说')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText('尚未收到回答')).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: '返回创作记录' }))
  await waitFor(() => expect(screen.getByRole('link', { name: /沙漠探险小说筹备/ })).toBeTruthy())
})
