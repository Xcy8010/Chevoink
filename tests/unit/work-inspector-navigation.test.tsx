// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentMessagePart } from '../../shared/contracts/index'
import WorkInspector from '../../src/features/studio/components/WorkInspector'
import { useAgentStore, type WorkspaceActivity } from '../../src/features/studio/agent/agentStore'
import { resolveActivityNavigation } from '../../src/features/studio/agent/activity-navigation'

type ToolPart = Extract<AgentMessagePart, { type: 'tool-call' }>
const activity = (overrides: Partial<WorkspaceActivity> = {}): WorkspaceActivity => ({
  callId: 'call-a', toolName: 'memory_save', label: '更新作品记忆', chapterId: null,
  deltaChars: null, status: 'done', summary: '沉淀记忆「四卷结构规划」', ...overrides,
})
const part = (overrides: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool-call', callId: 'call-a', toolName: 'memory_save', title: '更新作品记忆',
  status: 'success', args: { title: '四卷结构规划', memoryType: 'worldRule' }, ...overrides,
})
beforeEach(() => useAgentStore.setState({ messages: [], toolNavigationRequest: null, memorySpotlight: null }))
afterEach(cleanup)
function mount(items: WorkspaceActivity[], parts: ToolPart[] = []) {
  useAgentStore.setState({ messages: [{ id: 'm', runId: 'r', role: 'assistant', createdAt: '', parts }] })
  render(<WorkInspector tab="changes" onTabChange={() => {}} workTree={null} contextPanel={null}
    novelTitle="作品" chapterTitle="章节" chapterCount={2} wordCount="0" pendingReviewCount={0} activities={items} />)
  for (const item of items) fireEvent.click(screen.getAllByRole('button', { name: new RegExp(item.toolName) })[items.filter((a) => a.toolName === item.toolName).indexOf(item)])
}
it('underlines only the target name and opens the exact memory without collapsing the detail', () => {
  mount([activity()], [part()])
  const link = screen.getByRole('button', { name: '查看记忆：四卷结构规划' })
  expect(link.className).toContain('underline')
  expect(link.parentElement?.textContent).toBe('沉淀记忆「四卷结构规划」')
  fireEvent.click(link)
  expect(useAgentStore.getState().memorySpotlight).toMatchObject({ memoryType: 'worldRule', title: '四卷结构规划' })
  expect(screen.getByText('call call-a')).toBeTruthy()
})
it('retains a safe exact-title lookup for legacy memory summaries without args', () => {
  mount([activity()])
  fireEvent.click(screen.getByRole('button', { name: '查看记忆：四卷结构规划' }))
  expect(useAgentStore.getState().memorySpotlight).toMatchObject({ memoryType: '', title: '四卷结构规划' })
})
it('opens the exact saved card from its receipt even if the model supplied a scene as its title', () => {
  mount([activity({ summary: '更新记忆「老周」' })], [part({
    args: { memoryId: 'zhou-a', memoryType: 'characterCard', title: '十七号上午，在他的住处' },
    display: { kind: 'memoryCard', memoryId: 'zhou-a', memoryType: 'characterCard', title: '老周' },
  })])
  fireEvent.click(screen.getByRole('button', { name: '查看记忆：老周' }))
  expect(useAgentStore.getState().memorySpotlight).toMatchObject({ memoryId: 'zhou-a', title: '老周', memoryType: 'characterCard' })
})
it.each([
  ['memory_event_save', { title: '夜袭' }, 'timelineEvent', '夜袭'],
  ['memory_relation_save', { fromName: '甲', toName: '乙', relationType: '盟友' }, 'relationshipState', '甲→乙:盟友'],
] as const)('locates %s with its actual memory type and canonical title', (toolName, args, memoryType, title) => {
  mount([activity({ toolName, summary: '记忆已更新' })], [part({ toolName, args })])
  fireEvent.click(screen.getByRole('button', { name: `查看记忆：${title}` }))
  expect(useAgentStore.getState().memorySpotlight).toMatchObject({ memoryType, title })
})
it('uses chapter IDs for identically named targets, not whichever chapter is selected', () => {
  const items = ['c1', 'c2'].map((chapterId) => activity({ callId: chapterId, toolName: 'chapter_write', chapterId,
    display: { kind: 'chapterRef', chapterId, title: '归来', wordCount: 100 }, summary: '写入章节「归来」' }))
  mount(items)
  const links = screen.getAllByRole('button', { name: '查看文档：归来' })
  fireEvent.click(links[1])
  expect(useAgentStore.getState().toolNavigationRequest?.args).toEqual({ chapterId: 'c2' })
  fireEvent.click(links[0])
  expect(useAgentStore.getState().toolNavigationRequest?.args).toEqual({ chapterId: 'c1' })
})
it('uses the renamed plan artifact ID even when the args and old summary have another title', () => {
  mount([activity({ toolName: 'plan_rename', summary: '旧规划已重命名', display: {
    kind: 'planRename', artifactId: 'plan-b', beforeTitle: '旧规划', title: '新规划',
  } })], [part({ toolName: 'plan_rename', args: { planId: 'plan-b', title: '旧规划' } })])
  fireEvent.click(screen.getByRole('button', { name: '查看文档：新规划' }))
  expect(useAgentStore.getState().toolNavigationRequest?.args).toEqual({ planId: 'plan-b' })
})
it.each(['running', 'failed', 'denied'] as const)('does not turn %s tool attempts into saved-object links', (status) => {
  mount([activity()], [part({ status })])
  expect(screen.queryByRole('button', { name: /^查看记忆/ })).toBeNull()
})
it('does not guess missing document IDs or link deleted plans', () => {
  expect(resolveActivityNavigation(activity({ toolName: 'plan_save' }), part({ toolName: 'plan_save', args: { title: '规划' } }))).toBeNull()
  expect(resolveActivityNavigation(activity({ toolName: 'plan_delete', display: { kind: 'planDelete', artifactId: 'gone', title: '已删除' } }))).toBeNull()
})
