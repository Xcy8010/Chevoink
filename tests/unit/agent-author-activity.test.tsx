// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentMessagePart, AgentUIMessage } from '../../shared/contracts/index.js'
import { AuthorActivityParts } from '../../src/features/studio/agent/components/AuthorActivityParts'
import { projectActivityGroups, type ActivityCall } from '../../src/features/studio/agent/lib/activity-groups'

afterEach(cleanup)
const title = '风从窗台进来'
const titles = new Map([['internal-chapter-id', title]])
const reasoning: AgentMessagePart = { type: 'reasoning', text: 'RAW_THOUGHT_ONLY。已全部修复。' }
const message = (id: string, parts: AgentMessagePart[], runId = 'r'): AgentUIMessage => ({ id, runId, role: 'assistant', createdAt: '', parts })
const call = (callId: string, toolName: string, fields: Partial<ActivityCall> = {}): ActivityCall => ({
  type: 'tool-call', callId, toolName, status: 'success', title: '内部工具',
  args: { chapterId: 'internal-chapter-id', content: 'RAW_PARAMETER_ONLY' },
  summary: '已允许 INTERNAL_FAILURE_CODE',
  ...fields,
})
const saved = (callId: string, toolName = 'chapter_write') => call(callId, toolName, {
  display: { kind: 'chapterDiff', chapterId: 'internal-chapter-id', chapterTitle: title, before: '原文。', after: '正文写好了。', appliedDirectly: true, revision: 5 },
})

function Transcript({ messages, active }: { messages: AgentUIMessage[]; active?: string }) {
  const projection = projectActivityGroups(messages)
  return <>{messages.map(item => <AuthorActivityParts key={item.id} messageId={item.id}
    parts={item.parts} groups={projection.byMessage.get(item.id)} activeGroupId={active ? projection.runningByRun.get(active)?.id : undefined}
    runActive={item.runId === active} activityChapterTitles={titles} />)}</>
}

it('upgrades one focused disclosure from preparation to persisted write, without showing thought or parameters', () => {
  const preview = call('write', 'chapter_write', { status: 'running', preparing: true, args: null })
  const view = render(<Transcript active="r" messages={[message('a', [reasoning, preview])]} />)
  const toggle = screen.getByRole('button', { name: '准备写入正文' })
  toggle.focus()
  fireEvent.click(toggle)
  view.rerender(<Transcript active="r" messages={[message('a', [reasoning, call('write', 'chapter_write', { status: 'running' })])]} />)
  expect(screen.getByRole('button', { name: `正在写入《${title}》正文`, expanded: true })).toBe(toggle)
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
  view.rerender(<Transcript messages={[message('a', [reasoning, saved('write')])]} />)
  expect(screen.getByRole('button', { name: `已写入《${title}》正文 · 6 字`, expanded: true })).toBe(toggle)
  expect(document.activeElement).toBe(toggle)
  expect(view.container.querySelector('[data-activity-running]')).toBeNull()
  expect(screen.getByRole('button', { name: '查看修改' })).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/RAW_THOUGHT_ONLY|RAW_PARAMETER_ONLY|internal-chapter-id|已允许|INTERNAL_FAILURE_CODE|r5/)
})

it('preserves only the latest terminal status in the headline and the failed attempt in details', () => {
  const failureReceipt = '这批修改未保存，第 3 处未找到对应原文'
  const failed = call('failed', 'chapter_edit_range', { status: 'failed', summary: failureReceipt })
  const view = render(<Transcript messages={[message('a', [failed])]} />)
  const toggle = screen.getByRole('button', { name: `《${title}》正文修改未保存` })
  fireEvent.click(toggle)
  view.rerender(<Transcript messages={[message('a', [failed]), message('b', [reasoning, call('reread', 'chapter_read')]),
    message('c', [saved('retry', 'chapter_edit_range')])]} />)
  const group = view.container.querySelector('[data-author-activity]')!
  expect(within(group as HTMLElement).getByRole('button', { name: `已保存《${title}》的修改`, expanded: true })).toBe(toggle)
  expect(within(group as HTMLElement).getByText(failureReceipt)).toBeTruthy()
  expect(group.textContent).not.toMatch(/已允许|INTERNAL_FAILURE_CODE/)
  expect(group.querySelectorAll('[data-activity-tool="chapter_edit_range"]')).toHaveLength(2)
  expect(group.querySelector('[data-activity-tool="chapter_read"]')).toBeTruthy()
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
})

it('groups a 49-call timeline through replay, preserving author-facing paragraphs and every receipt in details', () => {
  const actions = [
    ...Array.from({ length: 12 }, (_, i) => call(`read-${i}`, i % 2 ? 'chapter_read' : 'project_search')),
    ...Array.from({ length: 12 }, (_, i) => saved(`write-${i}`)),
    ...Array.from({ length: 12 }, (_, i) => call(`review-${i}`, i % 2 ? 'quality_analyze' : 'continuity_validate')),
    ...Array.from({ length: 13 }, (_, i) => saved(`edit-${i}`, 'chapter_edit_range')),
  ]
  const messages = actions.map((part, i) => message(`m${i}`, i === 24
    ? [{ type: 'text', text: '初稿写好了。我现在核对人物前后的行动。' }, reasoning, part]
    : [reasoning, part]))
  const replayed = [...messages, message('replay', [{ ...actions[0], status: 'running', preparing: true }])]
  const view = render(<Transcript messages={messages} />)
  const summary = () => Array.from(view.container.querySelectorAll('[data-author-activity] > button'), button => button.textContent)
  expect(summary()).toHaveLength(4)
  expect(screen.getByText('初稿写好了。我现在核对人物前后的行动。')).toBeTruthy()
  const before = summary()
  view.rerender(<Transcript key="reopen" messages={replayed} />)
  expect(summary()).toEqual(before)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(0)
  view.container.querySelectorAll('[data-author-activity] > button').forEach(button => fireEvent.click(button))
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(49)
  expect(view.container.textContent).not.toMatch(/RAW_THOUGHT_ONLY|RAW_PARAMETER_ONLY|internal-chapter-id|已允许|INTERNAL_FAILURE_CODE/)
})

it('separates targets, author progress and task ownership while showing only one active animation', () => {
  const a = call('a', 'chapter_read', { status: 'running', args: { chapterId: 'chapter-a' } })
  const b = call('b', 'chapter_read', { status: 'running', args: { chapterId: 'chapter-b' } })
  const view = render(<Transcript active="r" messages={[
    message('a', [a, b]), message('b', [{ type: 'text', text: '这段已看完。' }, call('c', 'chapter_read')]),
    message('c', [call('a', 'chapter_read')], 'another-run'),
  ]} />)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(4)
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
})

it('opens useful cover, plan and report details without displaying their internal identifiers', () => {
  const view = render(<Transcript messages={[message('a', [
    call('cover', 'cover_generate', { display: { kind: 'coverImages', images: [{ id: 'PRIVATE_COVER', url: '/images/example.png' }] } }),
    call('plan', 'plan_save', { display: { kind: 'planFile', artifactId: 'PRIVATE_PLAN', title: '后续大纲', content: '公开大纲示例' } }),
    call('report', 'quality_analyze', { display: { kind: 'qualityReport', reportId: 'PRIVATE_REPORT', chapterId: 'internal-chapter-id',
      chapterRevision: 222, status: 'passed', repairRound: 0, findings: [{ id: 'PRIVATE_FINDING', signal: 'PRIVATE_SIGNAL', label: '表达建议',
        severity: 'advisory', evidence: '一句合成正文。', explanation: '这句话可以更简练。', suggestion: '删去重复用词。', disposition: 'pending' }] } }),
  ])]} />)
  view.container.querySelectorAll('[data-author-activity] > button').forEach(button => fireEvent.click(button))
  expect(screen.getByText('后续大纲')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '展开质量报告' }))
  expect(screen.getByText('表达建议')).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/PRIVATE_|internal-chapter-id|r222|已允许|INTERNAL_FAILURE_CODE/)
})

it('keeps the import confirmation reachable without opening the activity', () => {
  const part = call('import', 'novel_import', {
    status: 'running', importWaiting: { url: '/studio/novel/work?import=ready', expiresAt: '2099-01-01' },
  })
  render(<Transcript active="r" messages={[message('a', [part])]} />)
  expect(screen.getByRole('button', { name: '等待你确认导入', expanded: false })).toBeTruthy()
  expect(screen.getByRole('link', { name: '核对原文并确认导入' }).getAttribute('href')).toBe('/studio/novel/work?import=ready')
})
