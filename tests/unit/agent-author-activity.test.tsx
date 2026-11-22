// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMessagePart, AgentUIMessage } from '../../shared/contracts/index.js'
import { AuthorActivityParts, AuthorActivitySummary } from '../../src/features/studio/agent/components/AuthorActivityParts'

import { getMessageText } from '../../src/features/studio/agent/lib/panel-helpers'
import { activityAnswerText, activityReportVisibility, projectActivityGroups, type ActivityCall } from '../../src/features/studio/agent/lib/activity-groups'
import { isRunActive, restoreActiveRunHistory, useAgentStore } from '../../src/features/studio/agent/agentStore'

afterEach(() => { cleanup(); vi.useRealTimers() })
it('updates the inline compression status in place without displaying a tool card', () => {
  const row = (state: 'running' | 'completed') => <AuthorActivityParts parts={[{ type: 'context-compaction', state }]} messageId="compression" runActive />
  const view = render(row('running'))
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('正在自动压缩上下文')
  view.rerender(row('completed'))
  expect(screen.getByRole('status')).toBe(status)
  expect(status.textContent).toBe('上下文已自动压缩')
})

const title = '风从窗台进来'
const chapters = new Map([['internal-chapter-id', { title, orderIndex: 1 }]])
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

function Transcript({ messages, active, awaitingApprovalCallId, liveToolReceiptIds, textRevealTargets, finishTextReveal }: {
  messages: AgentUIMessage[]
  active?: string
  awaitingApprovalCallId?: string
  liveToolReceiptIds?: ReadonlySet<string>
  textRevealTargets?: Record<string, string>
  finishTextReveal?: (messageId: string, text: string) => void
}) {
  const projection = projectActivityGroups(messages)
  return <>{messages.map(item => {
    const runActive = (item.runTiming?.sourceRunId ?? item.runId) === active
    return <AuthorActivityParts key={item.id} messageId={item.id}
      parts={item.parts} groups={projection.byMessage.get(item.id)} activeGroupId={active ? projection.activeByRun.get(active)?.id : undefined}
      runActive={runActive} activityChapters={chapters} awaitingApprovalCallId={awaitingApprovalCallId}
      liveToolReceiptIds={runActive ? liveToolReceiptIds : undefined}
      revealText={textRevealTargets?.[item.id]} onTextRevealed={finishTextReveal}
      reportVisibility={activityReportVisibility(projection.reportsByMessage.get(item.id), runActive, awaitingApprovalCallId)} />
  })}</>
}

const goalTitle = '核对老周的出场时间'
const activity: AgentMessagePart = { type: 'activity-title', title: goalTitle }
const completed = (messages: AgentUIMessage[]) => messages.map(item => ({ ...item, completedAt: '2026-11-19T16:31:00.000Z' }))

it('keeps a titled progress row in place through three overlapping tools and a later turn, then completes with the reply intact', () => {
  const first = call('search', 'project_search', { status: 'running' })
  const second = call('card', 'memory_search', { status: 'running' })
  const third = call('chapter', 'chapter_read', { status: 'running' })
  const final = { type: 'text', text: '老周在第三章首次出场。' } as const
  const asSuccess = (part: ActivityCall) => ({ ...part, status: 'success' as const })
  const view = render(<Transcript active="r" messages={[message('batch', [activity, first, second, third])]} />)
  const button = screen.getByRole('button', { name: `正在${goalTitle}` })
  fireEvent.click(button)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(3)
  view.rerender(<Transcript active="r" messages={[message('batch', [activity, asSuccess(first), asSuccess(second), third])]} />)
  expect(screen.getByRole('button', { name: `正在${goalTitle}`, expanded: true })).toBe(button)
  const followUp = { type: 'text', text: '前三章的出场时间仍需要对照卷内日期。' } as const
  view.rerender(<Transcript active="r" messages={[
    message('batch', [activity, asSuccess(first), asSuccess(second), asSuccess(third)]),
    message('follow-up', [followUp]),
  ]} />)
  expect(screen.getByRole('button', { name: `正在${goalTitle}`, expanded: true })).toBe(button)
  expect(button.querySelector('.agent-processing-shimmer')?.textContent).toBe(`正在${goalTitle}`)
  expect(button.querySelector('[data-activity-running]')).toBeNull()
  expect(screen.queryByText(followUp.text)).toBeNull()
  const last = call('check', 'chapter_read')
  const beforeFinish = [
    message('batch', [activity, asSuccess(first), asSuccess(second), asSuccess(third)]),
    message('follow-up', [followUp, last]),
    message('answer', [final]),
  ]
  view.rerender(<Transcript active="r" messages={JSON.parse(JSON.stringify(beforeFinish))} />)
  expect(screen.getByText(followUp.text).closest('[data-activity-report]')).toBeTruthy()
  expect(screen.queryByText(final.text)).toBeNull()

  const settled = completed(beforeFinish)
  view.rerender(<Transcript messages={settled} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}`, expanded: true })).toBe(button)
  expect(Array.from(view.container.querySelectorAll('[data-activity-tool]'), node => node.getAttribute('data-activity-tool')))
    .toEqual(['project_search', 'memory_search', 'chapter_read', 'chapter_read'])
  expect(button.compareDocumentPosition(screen.getByText(followUp.text)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText(final.text)).toBeTruthy()
  expect(button.querySelector('.agent-processing-shimmer')).toBeNull()
  expect(activityAnswerText(settled.at(-1)!.parts)).toBe(final.text)
  view.rerender(<Transcript key="refreshed" messages={JSON.parse(JSON.stringify(settled))} />)
  const restored = screen.getByRole('button', { name: `已${goalTitle}`, expanded: false })
  expect(screen.queryByText(followUp.text)).toBeNull()
  expect(screen.getByText(final.text)).toBeTruthy()
  fireEvent.click(restored)
  expect(screen.getByText(followUp.text).closest('[data-activity-report]')).toBeTruthy()
})

it('keeps a failed review in details until an actual current-version report exists for the same target', () => {
  const chapterId = 'internal-chapter-id'
  const review = (callId: string, id: string, revision: number, status: ActivityCall['status'] = 'success') => call(callId, 'continuity_validate', {
    status, args: { chapterId: id }, reviewedChapter: { chapterId: id, revision },
    ...(status === 'success' ? { reviewOutcome: 'decision_required' as const,
      display: { kind: 'storyCompiler' as const, phase: 'repair' as const, title: '章节衔接复查', detail: '发现一处矛盾', items: ['需要核对原文'], errorCount: 1 } } : {}),
  })
  const failed = review('failed', chapterId, 4, 'failed')
  const unrelated = review('other', 'other-chapter', 5)
  const row = (calls: ActivityCall[]) => completed([message('review', [activity, failed, ...calls]), message('reply', [{ type: 'text', text: '出场时间仍有一处待核。' }])])
  const view = render(<Transcript active="r" messages={[message('review', [activity, failed, unrelated])]} />)
  expect(screen.getByRole('button', { name: `正在${goalTitle}` })).toBeTruthy()
  expect(screen.queryByText('章节衔接复查未完成')).toBeNull()
  view.rerender(<Transcript messages={row([unrelated])} />)
  const button = screen.getByRole('button', { name: `${goalTitle}未完成` })
  expect(screen.getByText('出场时间仍有一处待核。')).toBeTruthy()
  fireEvent.click(button)
  expect(screen.getByText('章节衔接复查未完成')).toBeTruthy()
  view.rerender(<Transcript messages={row([unrelated, review('retry', chapterId, 4)])} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}`, expanded: true })).toBe(button)
  const currentDraft = call('current', 'chapter_read', { display: { kind: 'chapterRef', chapterId, title, wordCount: 300, revision: 5 } })
  view.rerender(<Transcript messages={row([unrelated, review('retry', chapterId, 4), currentDraft])} />)
  expect(screen.getByRole('button', { name: `${goalTitle}未完成`, expanded: true })).toBe(button)
  view.rerender(<Transcript messages={row([unrelated, review('retry', chapterId, 4), saved('revision')])} />)
  expect(screen.getByRole('button', { name: `${goalTitle}未完成`, expanded: true })).toBe(button)
  expect(screen.getByText('章节衔接复查 · 正文有新改动')).toBeTruthy()
  view.rerender(<Transcript messages={row([unrelated, review('retry', chapterId, 4), saved('revision'), review('verify', chapterId, 5)])} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}`, expanded: true })).toBe(button)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(5)
})

it.each([
  ['memory_save', { memoryId: 'old-zhou', section: '当前处境', content: '合成处境' },
    { memoryId: 'old-zhou', section: '关键经历', content: '合成经历' }],
  ['chapter_edit_range', { chapterId: 'internal-chapter-id', oldText: '原文第一处。', newText: '改写第一处。' },
    { chapterId: 'internal-chapter-id', oldText: '原文第二处。', newText: '改写第二处。' }],
  ['continuity_validate', { chapterId: 'internal-chapter-id', focus: '出场时间' },
    { chapterId: 'internal-chapter-id', focus: '人物是否知道这封信' }],
] as const)('keeps a failed %s step unresolved after another successful step at the same object', (toolName, first, other) => {
  const failed = call('failed', toolName, { status: 'failed', args: first })
  const unrelated = call('unrelated', toolName, { args: other })
  const finished = (calls: ActivityCall[]) => completed([message('batch', [activity, ...calls])])
  const view = render(<Transcript messages={finished([failed, unrelated])} />)
  const row = screen.getByRole('button', { name: `${goalTitle}未完成` })
  fireEvent.click(row)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(2)
  const sameInput = Object.fromEntries(Object.entries(first).reverse())
  view.rerender(<Transcript messages={finished([failed, unrelated, call('retry', toolName, { args: sameInput })])} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}`, expanded: true })).toBe(row)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(3)
})

it('preserves independently running work even when a second call with the same arguments succeeds', () => {
  const running = call('pending', 'chapter_read', { status: 'running' })
  const success = { ...running, callId: 'success', status: 'success' as const }
  const records = [message('batch', [activity, running, success])]
  const view = render(<Transcript active="r" messages={records} />)
  const row = screen.getByRole('button', { name: `正在${goalTitle}` })
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
  expect(projectActivityGroups(records).byMessage.get('batch')?.get('pending')?.unfinished).toBe(true)
  view.rerender(<Transcript messages={completed(records)} />)
  expect(screen.getByRole('button', { name: `${goalTitle}未完成` })).toBe(row)
})

it('keeps separate provider call IDs reused in different turns and their own subagent details', () => {
  const first = call('call_0', 'subagent_run')
  const second = call('call_0', 'subagent_run', { status: 'running' })
  const childA = call('inner_0', 'project_search', { subagentCallId: 'call_0' })
  const childB = call('inner_0', 'memory_search', { subagentCallId: 'call_0' })
  const records = [message('one', [activity, first, childA]), message('two', [second, childB])]
  const view = render(<Transcript active="r" messages={records} />)
  const row = screen.getByRole('button', { name: `正在${goalTitle}` })
  fireEvent.click(row)
  expect(Array.from(view.container.querySelectorAll('[data-activity-tool]'), node => node.getAttribute('data-activity-tool')))
    .toEqual(['subagent_run', 'project_search', 'subagent_run', 'memory_search'])
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
  const settled = completed([records[0], message('two', [{ ...second, status: 'success' }, childB])])
  view.rerender(<Transcript key="reloaded" messages={JSON.parse(JSON.stringify(settled))} />)
  fireEvent.click(screen.getByRole('button', { name: `已${goalTitle}` }))
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(4)
})

it('shows and copies the saved answer without the legacy progress header on reload', () => {
  const header = '<activity-title>交付渡口细纲</activity-title>'
  const answer = '渡口的细纲已保存。'
  const parts = [reasoning, { type: 'text' as const, text: header + '\n\n' + answer }]
  const history = completed([message('saved', [call('save', 'plan_save')]), message('answer', parts)])
  const view = render(<Transcript messages={JSON.parse(JSON.stringify(history))} />)
  expect(screen.getByText(answer)).toBeTruthy()
  expect(view.container.textContent).not.toContain('交付渡口细纲')
  expect(activityAnswerText(parts)).toBe(answer)
  expect(getMessageText(parts, 'assistant')).toBe(answer)
  expect(getMessageText(parts, 'user')).toBe(header + '\n\n' + answer)
  expect(view.container.querySelectorAll('[data-author-step]')).toHaveLength(1)
  expect(history[1].parts).toEqual([reasoning, { type: 'text', text: header + '\n\n' + answer }])
})

it('holds a split legacy header during event replay without flashing it before the body', () => {
  const store = useAgentStore.getState()
  const runId = 'old-stream'
  const base = { runId, messageId: 'reply', ts: new Date().toISOString() }
  const marker = '<activity-title>交付渡口细纲</activity-title>'
  const body = '细纲已经保存。'
  const text = () => getMessageText(useAgentStore.getState().messages.find(message => message.id === base.messageId)?.parts ?? [])
  store.beginRun(runId, '写一份细纲。', 'session')
  try {
    store.applyEvent({ ...base, type: 'message.start', role: 'assistant', seq: 1 })
    for (const [index, delta] of [marker.slice(0, 8), marker.slice(8), '\n\n'].entries()) {
      store.applyEvent({ ...base, type: 'text.delta', delta, seq: index + 2 })
      expect(text()).toBe('')
    }
    store.applyEvent({ ...base, type: 'text.delta', delta: body, seq: 5 })
    expect(text()).not.toContain('交付渡口细纲')
    store.applyEvent({ ...base, type: 'text.final', text: marker + '\n\n' + body, asReasoning: false, seq: 6 })
    expect(text()).toBe(body)
  } finally {
    store.resetRun()
  }
})

it('preserves the Markdown indentation when copying an intentional code example', () => {
  const text = '    <activity-title>示例</activity-title>\n\n下面是说明。'
  const parts: AgentMessagePart[] = [{ type: 'text', text }]
  expect(activityAnswerText(parts)).toBe(text)
  expect(getMessageText(parts)).toBe(text)
})

it('renders a literal reserved line returned as an ordinary tool-free answer', () => {
  const text = '<activity-title>保留原样 & 原文</activity-title>'
  const parts = [{ type: 'text' as const, text }]
  render(<Transcript messages={completed([message('answer', parts)])} />)
  expect(screen.getByText(text)).toBeTruthy()
  expect(activityAnswerText(parts)).toBe(text)
})

it('shows one row per reported stage and preserves the opening, details and short closing after reload', () => {
  const readTitle = { type: 'activity-title', title: '核对前章和父大纲' } as const
  const opening = { type: 'text', text: '我先核对前一章和父大纲，确认细纲该从哪里接上。' } as const
  const handoff = { type: 'text', text: '前一章停在渡口。我会把新细纲保存到原大纲下。' } as const
  const answer = { type: 'text', text: '第十章细纲已保存到原大纲下。' } as const
  const read = call('outline', 'plan_read')
  const memory = call('memory', 'memory_search', { status: 'failed' })
  const appendix = call('report', 'quality_report_get', { status: 'running' })
  const plan = call('save', 'plan_save', { status: 'running', preparing: true })
  const first = message('research', [readTitle, opening, read, memory, appendix])
  const view = render(<Transcript messages={[first]} active="r" />)
  const row = screen.getByRole('button', { name: /正在/ })
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
  expect(screen.getByText(opening.text).compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(row)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(3)
  const checked = { ...first, parts: [readTitle, opening, read, memory, { ...appendix, status: 'success' as const }] }

  view.rerender(<Transcript messages={[checked, message('plan', [handoff])]} active="r" />)
  expect(screen.queryByText(handoff.text)).toBeNull()
  expect(row.querySelector('.agent-processing-shimmer')).toBeTruthy()
  view.rerender(<Transcript messages={[checked, message('plan', [handoff, plan])]} active="r" />)
  const second = screen.getByRole('button', { name: '正在准备 · 保存创作计划' })
  const report = screen.getByText(handoff.text)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(2)
  expect(view.container.querySelectorAll('[data-activity-preparing], [data-activity-running]')).toHaveLength(1)
  expect(row.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(report.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  const savedPlan = { ...plan, preparing: false, status: 'success' as const }
  const history = completed([checked, message('plan', [handoff, savedPlan]), message('answer', [answer])])
  view.rerender(<Transcript key="reload" messages={JSON.parse(JSON.stringify(history))} />)
  expect(screen.getByText(opening.text)).toBeTruthy()
  expect(screen.getByText(handoff.text)).toBeTruthy()
  expect(screen.getByText(answer.text)).toBeTruthy()
  expect(screen.getByRole('button', { name: '已完成创作计划' })).toBeTruthy()
  expect(view.container.querySelectorAll('[data-activity-preparing], [data-activity-running]')).toHaveLength(0)
  expect(activityAnswerText(history[2].parts)).toBe(answer.text)
})

it('does not release a later-stage report while a previous stage still has an actual running receipt', () => {
  const initial = call('read', 'chapter_read', { status: 'running' })
  const report = { type: 'text', text: '相关情节停在仓库门口。' } as const
  const next = message('outline', [report, call('plan', 'plan_save', { status: 'running' })])
  const view = render(<Transcript active="r" messages={[message('read', [activity, initial]), next]} />)
  expect(screen.queryByText(report.text)).toBeNull()
  expect(screen.queryByRole('button', { name: `已${goalTitle}` })).toBeNull()
  view.rerender(<Transcript active="r" messages={[message('read', [activity, { ...initial, status: 'success' }]), next]} />)
  const finished = screen.getByRole('button', { name: `已${goalTitle}` })
  const narrative = screen.getByText(report.text)
  const saving = screen.getByRole('button', { name: '正在写入创作计划' })
  expect(finished.compareDocumentPosition(narrative) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(narrative.compareDocumentPosition(saving) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it.each([
  { tool: 'plan_save', running: '正在写入创作计划', finished: '已完成创作计划', named: false },
  { tool: 'chapter_write', running: `正在写入《${title}》正文`, finished: `已写入《${title}》正文 · 6 字`, named: false },
  { tool: 'chapter_write', running: '正在撰写雨夜开场', finished: '已撰写雨夜开场', named: true },
])('updates the same row when a silent $tool stage follows a failed read ($named)', ({ tool, running, finished, named }) => {
  const opening = { type: 'text', text: '先核对前章，再接上雨夜。' } as const
  const final = { type: 'text', text: '雨沿着窗框流了下来，门外却有人在敲玻璃。' } as const
  const read = message('read', [opening, activity, call('read', 'chapter_read', { status: 'failed' })])
  const next = tool === 'chapter_write' ? saved('new-action') : call('new-action', tool)
  const staged = (part: ActivityCall) => message('write', named
    ? [{ type: 'activity-title', title: '撰写雨夜开场' }, part] : [part])
  const view = render(<Transcript active="r" messages={[read]} />)
  const button = screen.getByRole('button', { name: `正在${goalTitle}` })
  fireEvent.click(button)
  view.rerender(<Transcript active="r" messages={[read, staged({ ...next, status: 'running' })]} />)
  expect(screen.getByRole('button', { name: running, expanded: true })).toBe(button)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
  expect(view.container.querySelectorAll('.agent-processing-shimmer')).toHaveLength(1)
  expect(screen.getByText('查看章节未完成')).toBeTruthy()
  expect(screen.getByText(opening.text)).toBeTruthy()

  const history = completed([read, staged(next), message('answer', [final])])
  view.rerender(<Transcript messages={history} />)
  expect(screen.getByRole('button', { name: finished, expanded: true })).toBe(button)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(2)
  expect(screen.getByText('查看章节未完成')).toBeTruthy()
  expect(screen.getByText(final.text)).toBeTruthy()
  view.rerender(<Transcript key="reload" messages={JSON.parse(JSON.stringify(history))} />)
  expect(screen.getByRole('button', { name: finished, expanded: false })).toBeTruthy()
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
})

it('publishes a confirmed terminal passage once the actual calls settle and preserves it after replay', () => {
  const actual = call('read', 'chapter_read', { status: 'running' })
  const ending = { type: 'text', text: '月光被云层挡住了。她把来信折好，塞进从未开启的旧铁盒。', afterTools: true } as const
  const records = (part: ActivityCall) => [message('batch', [activity, part, ending])]
  const view = render(<Transcript active="r" messages={records(actual)} />)
  expect(screen.queryByText(ending.text)).toBeNull()
  expect(screen.getByRole('button', { name: `正在${goalTitle}` })).toBeTruthy()
  view.rerender(<Transcript active="r" messages={records({ ...actual, status: 'success' })} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}` })).toBeTruthy()
  expect(screen.getByText(ending.text).closest('[data-activity-report]')).toBeNull()
  const restored = JSON.parse(JSON.stringify(records({ ...actual, status: 'failed' })))
  view.rerender(<Transcript key="cancelled" messages={restored} />)
  expect(screen.getByRole('button', { name: `${goalTitle}未完成` })).toBeTruthy()
  expect(screen.getByText(ending.text).closest('[data-activity-report]')).toBeNull()
})

it('keeps approval and cancellation legible when a stage has a held report', () => {
  const pending = call('pending', 'chapter_read', { status: 'running' })
  const report = { type: 'text', text: '发现两个同名人物，请指定北岸或南岸的那一位。' } as const
  const records = [message('first', [activity, pending]), message('review', [report])]
  const view = render(<Transcript active="r" messages={records} />)
  expect(screen.queryByText(report.text)).toBeNull()
  view.rerender(<Transcript active="r" awaitingApprovalCallId="pending" messages={records} />)
  expect(screen.getByRole('button', { name: `等待你确认 · ${goalTitle}` })).toBeTruthy()
  expect(screen.getByText(report.text)).toBeTruthy()
  expect(view.container.querySelector('.agent-processing-shimmer')).toBeNull()
  view.rerender(<Transcript messages={records} />)
  expect(screen.getByRole('button', { name: `${goalTitle}未完成` })).toBeTruthy()
  expect(screen.getByText(report.text)).toBeTruthy()
})

it('falls back from a saved meta title and retains an authored chapter-summary title', () => {
  const meta = { type: 'activity-title', title: '总结这一步的结果' } as const
  const chapter = { type: 'activity-title', title: '撰写章节摘要' } as const
  const running = call('read', 'chapter_read', { status: 'running' })
  const view = render(<Transcript active="r" messages={[message('first', [meta, running])]} />)
  expect(screen.queryByText(/总结这一步的结果/)).toBeNull()
  expect(screen.getByRole('button', { name: `正在查看《${title}》` })).toBeTruthy()
  view.rerender(<Transcript active="r" messages={[message('first', [chapter, running])]} />)
  expect(screen.getByRole('button', { name: '正在撰写章节摘要' })).toBeTruthy()
})

it('keeps the same activity while awaiting approval or an answer, and does not claim completion on cancellation', () => {
  const pending = call('waiting', 'chapter_read', { status: 'running' })
  const view = render(<Transcript active="r" awaitingApprovalCallId={pending.callId} messages={[message('a', [activity, pending])]} />)
  const button = screen.getByRole('button', { name: `等待你确认 · ${goalTitle}` })
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(0)
  const question = call('question', 'ask_user', { status: 'running' })
  view.rerender(<Transcript active="r" messages={[message('a', [activity, { ...pending, status: 'success' }]), message('b', [question])]} />)
  expect(screen.getByRole('button', { name: `等待你回答 · ${goalTitle}` })).toBe(button)
  view.rerender(<Transcript messages={[message('a', [activity, { ...pending, status: 'success' }]), message('b', [{ ...question, status: 'failed' }])]} />)
  expect(screen.getByRole('button', { name: `${goalTitle}未完成` })).toBe(button)
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(0)
})

it('projects the same title and receipt after a stream disconnect and a fresh history load', () => {
  const store = useAgentStore.getState()
  const runId = 'reconnection'
  const base = { runId, messageId: 'original', ts: '2026-11-19T16:35:00.000Z' }
  try {
    store.resetRun()
    store.beginRun(runId, '核对人物', 'session')
    const apply = store.applyEvent
    act(() => {
      apply({ ...base, seq: 1, type: 'message.start', role: 'assistant' })
      apply({ ...base, seq: 2, type: 'activity.title', title: goalTitle })
      apply({ ...base, seq: 3, type: 'tool.call', callId: 'read', toolName: 'continuity_validate', title: '检查', args: { compilationId: 'draft' } })
    })
    const snapshot = JSON.parse(JSON.stringify(useAgentStore.getState().messages))
    const view = render(<Transcript active={runId} messages={snapshot} />)
    const activeRow = screen.getByRole('button', { name: `正在${goalTitle}` })
    act(() => {
      restoreActiveRunHistory(snapshot, runId, 'session')
      apply({ ...base, seq: 2, type: 'activity.title', title: goalTitle })
      apply({ ...base, seq: 3, type: 'tool.call', callId: 'read', toolName: 'continuity_validate', title: '检查', args: { compilationId: 'draft' } })
      apply({ ...base, seq: 4, type: 'tool.result', callId: 'read', toolName: 'continuity_validate', ok: true,
        summary: '连续性检查完成', durationMs: 25, reviewedChapter: { chapterId: 'internal-chapter-id', revision: 7 } })
      apply({ ...base, messageId: 'answer', seq: 5, type: 'text.final', text: '老周先收到电报。', asReasoning: false })
      apply({ ...base, seq: 6, type: 'run.finished', status: 'succeeded', artifacts: [], outputSummary: '',
        usage: { completionTokens: 10, promptTokens: 20, totalTokens: 30 } })
    })
    const history = JSON.parse(JSON.stringify(useAgentStore.getState().messages)) as AgentUIMessage[]
    view.rerender(<Transcript messages={history} />)
    expect(screen.getByRole('button', { name: `已${goalTitle}` })).toBe(activeRow)
    const parts = history.find(item => item.id === base.messageId)?.parts ?? []
    expect(parts.filter(part => part.type === 'activity-title')).toEqual([activity])
    expect(parts.filter(part => part.type === 'tool-call')).toEqual([expect.objectContaining({
      status: 'success', callId: 'read', args: { compilationId: 'draft' }, reviewedChapter: { chapterId: 'internal-chapter-id', revision: 7 },
    })])
    expect(screen.getByText('老周先收到电报。')).toBeTruthy()
  } finally {
    act(() => store.resetRun())
  }
})

it('keeps a resumed durable goal together and gives a separate request its own row even with the same title', () => {
  const runTiming = { scopeId: 'root:root-one', sourceRunId: 'resumed', elapsedMs: 120, activeSince: null, status: 'running' as const, lastSeq: 3 }
  const before = { ...message('original', [activity, call('one', 'chapter_read')], 'original-run'), runTiming }
  const continued = { ...message('continued', [call('two', 'memory_search')], 'resumed'), runTiming }
  const user = { id: 'request', runId: 'resumed', role: 'user' as const, parts: [{ type: 'text' as const, text: '现在按修改过的正文再核对一次。' }], createdAt: '', runTiming }
  const next = { ...message('next', [activity, call('three', 'project_search', { status: 'running' })], 'resumed'), runTiming }
  const view = render(<Transcript active="resumed" messages={[before, continued]} />)
  const previous = screen.getByRole('button', { name: `正在${goalTitle}` })
  fireEvent.click(previous)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(2)
  view.rerender(<Transcript active="resumed" messages={[before, continued, user, next]} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}`, expanded: true })).toBe(previous)
  expect(screen.getByRole('button', { name: `正在${goalTitle}` })).not.toBe(previous)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(2)
})

it('upgrades one focused disclosure from preparation to persisted write, without showing thought or parameters', () => {
  const preview = call('write', 'chapter_write', { status: 'running', preparing: true, args: null })
  const view = render(<Transcript active="r" messages={[message('a', [reasoning, preview])]} />)
  const toggle = screen.getByRole('button', { name: '正在准备 · 撰写章节' })
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
  const args = { chapterId: 'internal-chapter-id', oldText: '原文。', newText: '正文写好了。' }
  const failed = call('failed', 'chapter_edit_range', { status: 'failed', args, summary: failureReceipt })
  const view = render(<Transcript messages={[message('a', [failed])]} />)
  const toggle = screen.getByRole('button', { name: `《${title}》正文修改未保存` })
  fireEvent.click(toggle)
  view.rerender(<Transcript messages={[message('a', [failed]), message('b', [reasoning, { ...saved('retry', 'chapter_edit_range'), args }])]} />)
  const group = view.container.querySelector('[data-author-activity]')!
  expect(within(group as HTMLElement).getByRole('button', { name: '已完成修改', expanded: true })).toBe(toggle)
  expect(within(group as HTMLElement).getByText(failureReceipt)).toBeTruthy()
  expect(group.textContent).not.toMatch(/已允许|INTERNAL_FAILURE_CODE/)
  expect(group.querySelectorAll('[data-activity-tool="chapter_edit_range"]')).toHaveLength(2)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
})

it('groups a 49-call timeline through replay, preserving author-facing paragraphs and every receipt in details', () => {
  const actions = [
    ...Array.from({ length: 12 }, (_, i) => call(`read-${i}`, i < 6 ? 'chapter_read' : 'project_search')),
    ...Array.from({ length: 12 }, (_, i) => saved(`write-${i}`)),
    ...Array.from({ length: 12 }, (_, i) => call(`review-${i}`, i < 6 ? 'quality_analyze' : 'continuity_validate')),
    ...Array.from({ length: 13 }, (_, i) => saved(`edit-${i}`, 'chapter_edit_range')),
  ]
  const reports = new Map([
    [24, '初稿写好了。我现在核对人物前后的行动。'],
    [30, '行动顺序已经对齐。我再检查前章留下的线索。'],
    [36, '确认有一处线索提前交代了。我把它移回原来的位置。'],
  ])
  const messages = actions.map((part, i) => message(`m${i}`, reports.has(i)
    ? [{ type: 'text', text: reports.get(i)! }, reasoning, part] : [reasoning, part]))
  const replayed = [{ ...messages[0], parts: [...messages[0].parts, { ...actions[0], status: 'running' as const, preparing: true }] }, ...messages.slice(1)]
  const view = render(<Transcript messages={messages} />)
  const summary = () => Array.from(view.container.querySelectorAll('[data-author-activity] > button'), button => button.textContent)
  expect(summary()).toHaveLength(5)
  expect(screen.getByText('初稿写好了。我现在核对人物前后的行动。')).toBeTruthy()
  const before = summary()
  view.rerender(<Transcript key="reopen" messages={replayed} />)
  expect(summary()).toEqual(before)
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(0)
  view.container.querySelectorAll('[data-author-activity] > button').forEach(button => fireEvent.click(button))
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(49)
  expect(view.container.textContent).not.toMatch(/RAW_THOUGHT_ONLY|RAW_PARAMETER_ONLY|internal-chapter-id|已允许|INTERNAL_FAILURE_CODE/)
})

it('groups different targets and separates public progress and task ownership with one active animation', () => {
  const a = call('a', 'chapter_read', { status: 'running', args: { chapterId: 'chapter-a' } })
  const b = call('b', 'chapter_read', { status: 'running', args: { chapterId: 'chapter-b' } })
  const messages = (first: ActivityCall, second: ActivityCall) => [
    message('a', [first, second]), message('b', [{ type: 'text', text: '这段已看完。' }, call('c', 'chapter_read')]),
    message('c', [call('a', 'chapter_read')], 'another-run'),
  ]
  const view = render(<Transcript active="r" messages={messages(a, b)} />)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(3)
  const toggle = screen.getByRole('button', { name: '正在核对前文' })
  fireEvent.click(toggle)
  expect(toggle.closest('[data-author-activity]')?.querySelectorAll('[data-activity-tool="chapter_read"]')).toHaveLength(2)
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
  view.rerender(<Transcript messages={messages({ ...a, status: 'failed' }, { ...b, status: 'success' })} />)
  expect(screen.getByRole('button', { name: '核对前文有未完成项', expanded: true })).toBe(toggle)
})

it('folds related reads in order and starts a fresh group after an update or unrelated tool', () => {
  const first = call('outline', 'plan_read', { args: { planId: 'outline' } })
  const second = call('chapter-plan', 'plan_read', { args: { planId: 'detail' } })
  const skill = call('craft-skill', 'skill_load')
  const chapter = call('previous', 'chapter_read')
  const structure = call('structure', 'structure_outline')
  const setting = call('setting', 'story_charter_get')
  const last = call('later-plan', 'plan_read')
  const save = call('save', 'plan_save')
  const next = call('after-save', 'plan_read')
  const projection = projectActivityGroups([
    message('first', [first]), message('second', [reasoning, second]),
    message('skill', [skill, chapter, structure, setting]),
    message('last', [{ type: 'text', text: '资料已核对。' }, last]),
    message('save', [{ type: 'text', text: '大纲里已有对应章节，我会把新细纲存进去。' }, save]),
    message('recheck', [{ type: 'text', text: '细纲已保存，我再核对它的位置。' }, next]),
  ])
  const group = projection.byMessage.get('first')?.get(first.callId)
  expect(group?.calls.map(part => part.callId)).toEqual(['outline', 'chapter-plan', 'craft-skill', 'previous', 'structure', 'setting'])
  expect(projection.byMessage.get('second')?.get(second.callId)).toBe(group)
  expect(projection.byMessage.get('skill')?.get(skill.callId)).toBe(group)
  expect(group?.readLabel).toBe('查看创作资料')
  expect(projection.byMessage.get('last')?.get(last.callId)?.calls.map(part => part.callId)).toEqual([last.callId])
  expect(projection.byMessage.get('save')?.get(save.callId)?.calls.map(part => part.callId)).toEqual([save.callId])
  expect(projection.byMessage.get('recheck')?.get(next.callId)?.calls.map(part => part.callId)).toEqual([next.callId])
})

it('shows one parameter preview and uses actual call events to advance the visible step', () => {
  const preview = (id: string, name: string) => call(id, name, { status: 'running', preparing: true, args: null })
  const plan = preview('plan', 'plan_read')
  const chapter = preview('read', 'chapter_read')
  const next = preview('save', 'plan_save')
  const recent = new Set([JSON.stringify(['batch', null, plan.callId]), JSON.stringify(['batch', null, chapter.callId])])
  const timeline = (...parts: ActivityCall[]) => <Transcript active="r" messages={[message('batch', parts)]} liveToolReceiptIds={recent} />
  const view = render(timeline(plan, chapter, next))
  const toggle = screen.getByRole('button', { name: '正在准备 · 查看创作资料' })
  const animate = vi.fn(() => ({ cancel: vi.fn() }))
  Object.defineProperty(toggle.firstElementChild, 'animate', { value: animate })
  toggle.focus()
  fireEvent.click(toggle)
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
  expect(view.container.querySelectorAll('[data-activity-preparing]')).toHaveLength(1)
  expect(view.container.querySelector('[data-activity-running]')).toBeNull()
  expect(view.container.querySelectorAll('[data-activity-tool]')).toHaveLength(1)
  view.rerender(timeline({ ...plan, preparing: false }, chapter, next))
  expect(screen.getByRole('button', { name: '正在查看创作资料', expanded: true })).toBe(toggle)
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
  expect(view.container.querySelector('[data-activity-preparing]')).toBeNull()
  view.rerender(timeline({ ...plan, status: 'success', preparing: false }, { ...chapter, preparing: false }, next))
  expect(view.container.querySelectorAll('[data-author-activity]')).toHaveLength(1)
  expect(Array.from(view.container.querySelectorAll('[data-activity-tool]'), node => node.getAttribute('data-activity-tool')))
    .toEqual(['plan_read', 'chapter_read'])
  expect(screen.getByRole('button', { name: '正在查看章节', expanded: true })).toBe(toggle)
  expect(document.activeElement).toBe(toggle)
  expect(animate).toHaveBeenCalledTimes(2)
})

it('keeps a live opening visible and revealing when its tool arrives in the same paint', () => {
  vi.useFakeTimers()
  const store = useAgentStore.getState()
  store.resetRun()
  store.beginRun('r', '核对上一章', 'session')
  const base = { runId: 'r', messageId: 'opening', ts: '2026-11-19T16:35:00.000Z' }
  const opening = '我先核对渡口一节的出场人物，再确认信件从哪里转交。'
  function LiveTranscript() {
    const { messages, phase, liveToolReceiptIds, textRevealTargets, finishTextReveal } = useAgentStore()
    return <Transcript messages={messages.filter(item => item.role === 'assistant')} active={isRunActive(phase) ? base.runId : undefined}
      liveToolReceiptIds={liveToolReceiptIds} textRevealTargets={textRevealTargets} finishTextReveal={finishTextReveal} />
  }
  try {
    const view = render(<LiveTranscript />)
    act(() => {
      store.applyEvent({ ...base, seq: 1, type: 'message.start', role: 'assistant' })
      store.applyEvent({ ...base, seq: 2, type: 'text.final', text: opening, asReasoning: false })
      store.applyEvent({ ...base, seq: 3, type: 'tool.delta', callId: 'call_0', toolName: 'chapter_read', argsChars: 4 })
    })
    const row = screen.getByRole('button', { name: '正在准备 · 核对前文' })
    const paragraph = view.container.querySelector('p')!
    const firstFrame = paragraph.textContent!
    expect(firstFrame).toBe(opening.slice(0, 3))
    expect(paragraph.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.querySelector('.agent-tool-enter')).toBeTruthy()
    act(() => vi.advanceTimersByTime(48))
    expect(paragraph.textContent!.length).toBeGreaterThan(firstFrame.length)
    expect(paragraph.textContent!.length).toBeLessThan(opening.length)
    act(() => {
      store.applyEvent({ ...base, seq: 4, type: 'tool.call', callId: 'call_0', toolName: 'chapter_read', title: '读取', args: {} })
      store.applyEvent({ ...base, seq: 5, type: 'tool.result', callId: 'call_0', toolName: 'chapter_read', ok: true, summary: '已读取' })
    })
    expect(screen.getByRole('button', { name: '已核对前文' })).toBe(row)
    expect(paragraph.textContent).not.toBe(opening)
    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByText(opening)).toBe(paragraph)
    expect(useAgentStore.getState().textRevealTargets).toEqual({})
  } finally {
    act(() => store.resetRun())
  }
})

it('animates new receipts only in their own message even when a replayed receipt has the same provider ID', () => {
  const sharedId = 'call_0'
  const old = { ...message('old', [call(sharedId, 'chapter_read')]), goalId: 'previous-goal' }
  const fresh = { ...message('fresh', [activity, call(sharedId, 'memory_search', { status: 'running' })]), goalId: 'new-goal' }
  const messages = [old, fresh]
  const recent = new Set([JSON.stringify([fresh.id, null, sharedId])])
  const view = render(<Transcript active="r" messages={messages} liveToolReceiptIds={recent} />)
  expect(screen.getByRole('button', { name: /已查看/ }).querySelector('.agent-tool-enter')).toBeNull()
  expect(screen.getByRole('button', { name: `正在${goalTitle}` }).querySelector('.agent-tool-enter')).toBeTruthy()
  view.rerender(<Transcript key="restored" active="r" messages={JSON.parse(JSON.stringify(messages))} />)
  expect(view.container.querySelector('.agent-tool-enter')).toBeNull()
})

it('animates a held handoff as soon as the next real stage makes it visible', () => {
  vi.useFakeTimers()
  const read = message('read', [activity, call('read', 'chapter_read')])
  const prose = { type: 'text', text: '上一章停在渡口。新细纲从没拆开的信接起。' } as const
  const textRevealTargets = { next: prose.text }
  const finishTextReveal = vi.fn()
  const timeline = (parts: AgentMessagePart[]) => <Transcript active="r" messages={[read, message('next', parts)]}
    textRevealTargets={textRevealTargets} finishTextReveal={finishTextReveal} />
  const view = render(timeline([prose]))
  act(() => vi.advanceTimersByTime(400))
  expect(view.container.querySelector('p')).toBeNull()
  expect(finishTextReveal).not.toHaveBeenCalled()

  view.rerender(timeline([prose, call('plan', 'plan_save', { status: 'running' })]))
  const report = view.container.querySelector('p')!
  const saving = screen.getByRole('button', { name: '正在写入创作计划' })
  expect(report.textContent).toBe(prose.text.slice(0, 3))
  expect(report.compareDocumentPosition(saving) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  act(() => vi.advanceTimersByTime(48))
  expect(report.textContent!.length).toBeGreaterThan(3)
  expect(report.textContent).not.toBe(prose.text)
  act(() => vi.advanceTimersByTime(600))
  expect(report.textContent).toBe(prose.text)
  expect(finishTextReveal).toHaveBeenCalledWith('next', prose.text)
})

it('preserves two chapter receipts through parallel reads, a silent gap and interrupted replay', () => {
  const chapterDirectory = new Map([['a', { title: '渡口', orderIndex: 1 }], ['b', { title: '灯火', orderIndex: 2 }]])
  const read = (id: string, status: ActivityCall['status']) => call(id, 'chapter_read', { args: { chapterId: id }, status })
  const frame = (first: ActivityCall['status'], second: ActivityCall['status'], live = true) => {
    const parts = [read('a', first), read('b', second)]
    const projection = projectActivityGroups([message('m', parts)])
    return <AuthorActivityParts parts={parts} messageId="m" groups={projection.byMessage.get('m')}
      activeGroupId={live ? projection.activeByRun.get('r')?.id : undefined} runActive={live} showRunIndicator={live} activityChapters={chapterDirectory} />
  }
  const view = render(frame('running', 'running'))
  const row = screen.getByRole('button', { name: '正在查看《灯火》' })
  fireEvent.click(row)
  view.rerender(frame('running', 'success'))
  expect(screen.getByRole('button', { name: '正在查看《渡口》', expanded: true })).toBe(row)
  expect(screen.queryByRole('status', { name: '任务仍在运行' })).toBeNull()
  view.rerender(frame('success', 'success'))
  expect(screen.getByRole('button', { name: '已查看 2 章正文', expanded: true })).toBe(row)
  expect(screen.getByText('已查看《渡口》')).toBeTruthy()
  expect(screen.getByText('已查看《灯火》')).toBeTruthy()
  expect(screen.getByRole('status', { name: '任务仍在运行' }).closest('button')).toBeNull()
  expect(view.container.textContent).not.toContain('正在处理')
  view.rerender(frame('failed', 'success', false))
  expect(screen.getByRole('button', { name: '核对前文有未完成项', expanded: true })).toBe(row)
  expect(screen.queryByRole('status', { name: '任务仍在运行' })).toBeNull()
})

it('keeps the settled goal title and details while the run continues', () => {
  const ending = { type: 'text', text: '信件送抵了渡口。', afterTools: true } as const
  const parts = [activity, call('read', 'chapter_read'), ending]
  const groups = projectActivityGroups([message('batch', parts)]).byMessage.get('batch')
  const view = render(<AuthorActivityParts parts={parts} messageId="batch" groups={groups} runActive showRunIndicator activityChapters={chapters} />)
  const row = screen.getByRole('button', { name: `已${goalTitle}` })
  expect(row.querySelector('.agent-processing-shimmer')).toBeNull()
  expect(screen.getByRole('status', { name: '任务仍在运行' }).closest('button')).toBeNull()
  fireEvent.click(row)
  expect(screen.getByText(`已查看《${title}》`)).toBeTruthy()
  view.rerender(<AuthorActivityParts parts={parts} messageId="batch" groups={groups} runActive={false} activityChapters={chapters} />)
  expect(screen.getByRole('button', { name: `已${goalTitle}`, expanded: true })).toBe(row)
  expect(row.querySelector('.agent-processing-shimmer')).toBeNull()
  expect(screen.getByText(ending.text)).toBeTruthy()
})

it('folds creation settings and the cover workflow while keeping the live row and ordered receipts', () => {
  const setup = [
    call('charter', 'story_charter_get'),
    call('style', 'style_profile_get', { status: 'failed' }),
    call('voice', 'character_voice_get', { status: 'running' }),
  ]
  const cover = call('prompt', 'cover_prompt_set', { display: { kind: 'markdown', markdown: '合成封面提示词。' } })
  const generate = call('generate', 'cover_generate', { status: 'running' })
  const messages = (settings: ActivityCall[], picture: ActivityCall) => [
    message('settings', settings),
    message('prompt', [cover]),
    message('cover', [{ type: 'text', text: '用刚保存的构图生成候选。' }, picture]),
  ]
  const view = render(<Transcript active="r" messages={messages(setup, generate)} />)
  const settingsRow = screen.getByRole('button', { name: '查看创作设定有未完成项', exact: true })
  const coverRow = screen.getByRole('button', { name: '正在制作封面', exact: true })
  fireEvent.click(settingsRow)
  fireEvent.click(coverRow)
  expect(view.container.querySelectorAll('[data-activity-running]')).toHaveLength(1)
  expect(screen.queryByText('核对记忆冲突')).toBeNull()
  expect(screen.getByText('查看文风画像未完成')).toBeTruthy()
  expect(screen.getByText('正在查看人物声口')).toBeTruthy()
  expect(screen.getByText('合成封面提示词。')).toBeTruthy()
  const image = { ...generate, status: 'success' as const, display: { kind: 'coverImages' as const, images: [{ id: 'fixture', url: '/images/fixture.png' }] } }
  view.rerender(<Transcript messages={messages(setup.map(item => item.status === 'running' ? { ...item, status: 'success' } : item), image)} />)
  expect(screen.getByRole('button', { name: '查看创作设定有未完成项', expanded: true })).toBe(settingsRow)
  expect(screen.getByRole('button', { name: '已制作封面', expanded: true })).toBe(coverRow)
  expect(Array.from(view.container.querySelectorAll('[data-activity-tool]'), el => el.getAttribute('data-activity-tool')))
    .toEqual(['story_charter_get', 'style_profile_get', 'character_voice_get', 'cover_prompt_set', 'cover_generate'])
})

it('combines writing and appending on one chapter but separates a different chapter', () => {
  const projection = projectActivityGroups([message('a', [
    saved('write'), saved('append', 'chapter_append'), call('other', 'chapter_write', { args: { chapterId: 'other-chapter' } }),
  ])]).byMessage.get('a')
  expect(projection?.get('write')?.calls.map(item => item.callId)).toEqual(['write', 'append'])
  expect(projection?.get('other')?.calls.map(item => item.callId)).toEqual(['other'])
})

it('names review types and groups consecutive matching checks without exposing finding totals', () => {
  const continuity = call('continuity', 'continuity_validate', { display: {
    kind: 'storyCompiler', phase: 'check', title: '章节衔接复查', detail: '已检查', items: ['检查项仍可展开'], errorCount: 2, warningCount: 3,
  } })
  const quality = call('quality', 'quality_analyze', { display: {
    kind: 'qualityReport', reportId: 'PRIVATE_REVIEW', chapterId: 'internal-chapter-id', chapterRevision: 2,
    status: 'passed', repairRound: 0,
    findings: [{ id: 'advice', signal: 'wording', label: '人物表达', severity: 'advisory',
      evidence: '合成片段。', explanation: '可收紧语气。', suggestion: '精简。', disposition: 'pending' }],
  } })
  const pending = { ...quality, callId: 'quality-pending', status: 'running' as const, display: undefined }
  const view = render(<Transcript active="r" messages={[
    message('a', [continuity]), message('b', [{ ...continuity, callId: 'continuity-again' }, quality]), message('c', [pending]),
  ]} />)
  expect(screen.getByRole('button', { name: '正在进行行文自然度复查', exact: true })).toBeTruthy()
  const continuityRow = screen.getByRole('button', { name: '章节衔接复查完成', exact: true })
  fireEvent.click(continuityRow)
  expect(continuityRow.closest('[data-author-activity]')?.querySelectorAll('[data-activity-tool="continuity_validate"]')).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: '展开检查详情' })[0])
  expect(screen.getByText('检查项仍可展开')).toBeTruthy()
  view.rerender(<Transcript messages={[
    message('a', [continuity]), message('b', [{ ...continuity, callId: 'continuity-again' }, quality]),
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: '行文自然度复查完成', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '展开质量报告' }))
  expect(screen.getByText('人物表达')).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/\d+\s*(?:条建议|条需关注|处待核对|错误)/)
})

it('uses completion labels for saved actions while keeping all grouped receipts available', () => {
  const view = render(<Transcript messages={[message('save', [
    call('plan-1', 'plan_save'), call('plan-2', 'plan_save'),
    call('setting', 'memory_save'), call('progress', 'chapter_bridge_commit'),
    call('rename', 'plan_rename'), call('delete', 'plan_delete'),
    call('failed-plan', 'plan_save', { status: 'failed' }),
  ])]} />)
  const plan = screen.getByRole('button', { name: '已完成创作计划', exact: true })
  expect(screen.getByRole('button', { name: '已完成创作设定' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '已完成章节进展' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '已完成计划重命名' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '已完成计划删除' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '保存创作计划未完成' })).toBeTruthy()
  fireEvent.click(plan)
  expect(plan.closest('[data-author-activity]')?.querySelectorAll('[data-activity-tool="plan_save"]')).toHaveLength(2)
  expect(view.container.textContent).not.toMatch(/已保存| · 2 次/)
})

it('keeps grouped subagent receipts associated with the correct call', () => {
  const a = call('a', 'subagent_run')
  const b = call('b', 'subagent_run')
  const childA = call('child', 'plan_read', { subagentCallId: 'a' })
  const childB = call('child', 'chapter_read', { subagentCallId: 'b' })
  const view = render(<Transcript messages={[message('a', [a, childA]), message('b', [childB, b])]} />)
  const rows = view.container.querySelectorAll('[data-author-activity] > button')
  expect(rows).toHaveLength(1)
  fireEvent.click(rows[0])
  expect(Array.from(view.container.querySelectorAll('[data-activity-tool]'), el => el.getAttribute('data-activity-tool')))
    .toEqual(['subagent_run', 'plan_read', 'subagent_run', 'chapter_read'])
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

it('shows elapsed processing time and folds the completed process without hiding the final reply', () => {
  const parts: AgentMessagePart[] = [
    reasoning,
    { type: 'text', text: '我会先查看前文。' },
    call('read', 'chapter_read'),
    { type: 'text', text: '这是最终回复。' },
  ]
  function TimedReply({ active }: { active: boolean }) {
    const [expanded, setExpanded] = useState(false)
    const open = active || expanded
    return <>
      <AuthorActivitySummary active={active} open={open}
        timing={{ elapsedMs: 65000, activeSince: active ? new Date().toISOString() : null, lastSeq: 2, status: active ? 'running' : 'finished' }}
        onToggle={active ? undefined : () => setExpanded(value => !value)} />
      <AuthorActivityParts parts={parts} messageId="mixed" runActive={active} processOpen={open} activityChapters={chapters} />
    </>
  }
  const view = render(<TimedReply active />)
  const readLabel = `已查看《${title}》`
  expect(document.querySelector('[data-process-duration]')?.textContent).toBe('已处理 1 分钟 5 秒')
  expect(screen.getByRole('button', { name: readLabel })).toBeTruthy()

  view.rerender(<TimedReply active={false} />)
  const summary = screen.getByRole('button', { name: /^用时/, expanded: false })
  expect(summary.textContent).toBe('用时 1 分钟 5 秒')
  expect(screen.queryByRole('button', { name: readLabel })).toBeNull()
  expect(screen.getByText('我会先查看前文。').closest('[aria-hidden="true"]')).toBeTruthy()
  expect(screen.getByText('这是最终回复。').closest('[aria-hidden="true"]')).toBeNull()

  fireEvent.click(summary)
  const step = screen.getByRole('button', { name: readLabel })
  const arrow = step.querySelector('.agent-activity-chevron')
  expect(arrow?.previousElementSibling?.textContent).toBe(readLabel)
  fireEvent.click(step)
  expect(screen.getByRole('button', { name: '打开章节' })).toBeTruthy()
  fireEvent.click(summary)
  expect(screen.queryByRole('button', { name: readLabel })).toBeNull()
  expect(screen.getByText('这是最终回复。')).toBeTruthy()
})

it('keeps an actual saved result on silent legacy outlines without inserting transition prose', () => {
  const plan = call('plan', 'plan_save', {
    display: { kind: 'planFile', artifactId: 'INTERNAL_PLAN', title: '第四章细纲', content: '合成细纲。' },
  })
  const read = message('read', [reasoning, call('read', 'plan_read')])
  const outline = message('outline', [plan])
  const silent = projectActivityGroups([read, outline])
  const view = render(<Transcript messages={[read, outline]} />)
  expect(view.container.querySelector('[data-author-progress]')).toBeNull()
  expect(silent.savedReplyByRun.get('r')).toBe('已完成《第四章细纲》的更新。')

  const prose: AgentMessagePart = { type: 'text', text: '我会让第四章承接上一章的来访。' }
  const final: AgentMessagePart = { type: 'text', text: '细纲保留了来访者未说明的目的。' }
  const narrated = projectActivityGroups([message('read', [prose, ...read.parts]), message('outline', [prose, plan, final])])
  expect(narrated.authorSpokeByRun.has('r')).toBe(true)
  expect(activityAnswerText([prose, plan, final])).toBe(final.text)
  expect(activityAnswerText([prose, plan])).toBe('')
  expect(projectActivityGroups([message('failed', [{ ...plan, status: 'failed' }])]).savedReplyByRun.has('r')).toBe(false)
  expect(projectActivityGroups([message('preview', [saved('candidate', 'chapter_edit_range'), {
    ...saved('candidate', 'chapter_edit_range'),
    display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '候选', before: '', after: '候选正文', appliedDirectly: false },
  }])]).savedReplyByRun.has('r')).toBe(false)
})

it('hands the shimmer between model work, tool execution and the next step, then shows the final reply', () => {
  const opening: AgentMessagePart = { type: 'text', text: '我先核对前文，再写这章。' }
  const read = call('read', 'chapter_read', { status: 'running' })
  const view = render(<AuthorActivityParts parts={[opening, reasoning]} messageId="run" runActive showRunIndicator />)
  const shimmer = () => view.container.querySelectorAll('.agent-processing-shimmer')
  expect(shimmer()).toHaveLength(0)
  expect(screen.getByRole('status', { name: '任务仍在运行' })).toBeTruthy()
  const slot = view.container.querySelector('[data-author-step]')
  const openingNode = screen.getByText(opening.text)
  expect(slot?.querySelector('button')).toBeNull()
  const group = projectActivityGroups([message('run', [opening, read])])
  view.rerender(<AuthorActivityParts parts={[opening, read]} messageId="run" runActive activeGroupId={group.runningByRun.get('r')?.id}
    groups={group.byMessage.get('run')} liveToolReceiptIds={new Set([JSON.stringify(['run', null, 'read'])])} activityChapters={chapters} />)
  expect(shimmer()).toHaveLength(1)
  const step = screen.getByRole('button', { name: `正在查看《${title}》` })
  expect(step.closest('[data-author-step]')).toBe(slot)
  expect(step.querySelector('.agent-tool-enter')).toBeTruthy()
  expect(screen.getByText(opening.text)).toBe(openingNode)
  fireEvent.click(step!)
  expect(step?.getAttribute('aria-expanded')).toBe('true')
  expect(shimmer()[0].closest('button')?.className).not.toMatch(/hover:bg|rounded/)
  expect(view.container.querySelector('[data-author-working]')).toBeNull()
  const done = { ...read, status: 'success' as const }
  view.rerender(<AuthorActivityParts parts={[opening, done]} messageId="run" runActive showRunIndicator />)
  expect(shimmer()).toHaveLength(0)
  expect(screen.getByRole('button', { name: '已核对前文' })).toBe(step)
  expect(screen.getByRole('status', { name: '任务仍在运行' }).closest('button')).toBeNull()
  expect(step?.getAttribute('aria-expanded')).toBe('true')
  view.rerender(<AuthorActivityParts parts={[opening, done, { type: 'text', text: '这是正文信道的答复。' }]} messageId="run" runActive={false} />)
  expect(shimmer()).toHaveLength(0)
  expect(screen.getByText('这是正文信道的答复。')).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/RAW_THOUGHT_ONLY|正在处理/)
})

it('shows one compact location per matching chapter and keeps read targets accessible', () => {
  const hits = call('search', 'project_search', {
    display: { kind: 'projectSearch', query: '旧钥匙', total: 3, matches: [{
      volumeTitle: '归途卷', chapterId: 'PRIVATE_CHAPTER', chapterTitle: '关门前', field: 'content', offset: 41,
      length: 3, contextBefore: '她摸到一把', match: '旧钥匙', contextAfter: '。',
    }, {
      volumeTitle: '归途卷', chapterId: 'PRIVATE_CHAPTER', chapterTitle: '关门前', field: 'content', offset: 81,
      length: 3, contextBefore: '门后的长段摘录', match: '旧钥匙', contextAfter: '。',
    }, {
      chapterId: 'PRIVATE_NEXT', chapterTitle: '交接', field: 'summary', offset: 0,
      length: 3, contextBefore: '', match: '旧钥匙', contextAfter: '',
    }] },
  })
  const legacy = call('older', 'project_search', { summary: '全书检索“收据” · 0 处' })
  const read = call('chapter', 'chapter_read', { display: {
    kind: 'chapterRef', chapterId: 'PRIVATE_CHAPTER', title: '关门前', wordCount: 920, range: { start: 20, end: 75 },
  } })
  const plan = call('plan-read', 'plan_read', { display: {
    kind: 'readSources', items: [{ title: '全书大纲', preview: '计划的长段摘录', target: { kind: 'plan', id: 'PRIVATE_PLAN' } }],
  } })
  const view = render(<Transcript messages={[message('read', [hits, legacy, read, plan])]} />)
  for (const toggle of view.container.querySelectorAll('[data-author-activity] > button')) fireEvent.click(toggle)
  expect(screen.getByText('搜索「旧钥匙」 · 3 处')).toBeTruthy()
  expect(screen.getByText('搜索「收据」 · 无匹配')).toBeTruthy()
  expect(screen.getByText(/正文第 42 字等/)).toBeTruthy()
  expect(screen.getByText(/正文第 21–75 字/)).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '《关门前》' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: '《交接》' })).toBeTruthy()
  expect(screen.getByText('· 章节摘要')).toBeTruthy()
  expect(screen.getByRole('button', { name: '《全书大纲》' })).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/PRIVATE_|她摸到一把|长段摘录|正文第 82 字/)
  fireEvent.click(screen.getByRole('button', { name: '《全书大纲》' }))
  expect(useAgentStore.getState().toolNavigationRequest).toMatchObject({ toolName: 'plan_read', args: { planId: 'PRIVATE_PLAN' } })
  fireEvent.click(screen.getByRole('button', { name: '《交接》' }))
  expect(useAgentStore.getState().toolNavigationRequest).toMatchObject({ toolName: 'project_search', args: { chapterId: 'PRIVATE_NEXT' } })
  act(() => useAgentStore.getState().clearToolNavigationRequest())
})

it('resolves memory search chapter references from the current directory when expanding persisted results', () => {
  const chapterId = 'cm' + '1'.repeat(23)
  const untitledId = 'cm' + '2'.repeat(23)
  const absentId = 'af9d6970-0d7c-4a3c-81b2-ad9346657dfa'
  const namedCharacterId = 'ba6fe7fa-66e6-4286-ad4c-4c1d346c2fa5'
  const characterName = `章节:${namedCharacterId}`
  const stored = call('memory', 'memory_search', {
    args: { query: '梳理伏笔' },
    summary: '检索"梳理伏笔" · 命中 6 条',
    display: { kind: 'readSources', items: [
      { title: `章节:${chapterId}`, preview: '历史摘要', memoryType: 'chapterSummary' },
      { title: `chapter：${absentId}`, memoryType: 'chapterSummary' },
      { title: '沈秋', memoryType: 'characterCard' },
      { title: '章节：守门人的旧事', memoryType: 'storyArc' },
      { title: `章节:${untitledId}`, memoryType: 'chapterSummary' },
      { title: characterName, preview: '同名章节：旧日故事。', memoryType: 'characterCard' },
    ] },
  })
  const restoredParts = JSON.parse(JSON.stringify([stored])) as AgentMessagePart[]
  const directory = new Map([
    [chapterId, { title: '第四章 《沿岸的灯》', orderIndex: 11 }],
    [untitledId, { title: '', orderIndex: 12 }],
    [namedCharacterId, { title: '同名章节', orderIndex: 13 }],
  ])
  const show = (activityChapters?: typeof directory) => <AuthorActivityParts
    parts={restoredParts} messageId="restored-memory" runActive={false} activityChapters={activityChapters}
  />
  const view = render(show(directory))
  fireEvent.click(screen.getByRole('button', { name: '已核对前文' }))
  expect(screen.queryByText('第 11 章 · 沿岸的灯')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '已查找作品设定' }))
  expect(screen.getByText('第 11 章 · 沿岸的灯')).toBeTruthy()
  expect(screen.getByText('第 12 章')).toBeTruthy()
  expect(screen.getByText('章节摘要（无法定位章节）')).toBeTruthy()
  expect(screen.getByText('沈秋')).toBeTruthy()
  expect(screen.getByText('章节：守门人的旧事')).toBeTruthy()
  expect(screen.getByText(characterName)).toBeTruthy()
  expect(screen.queryByText('第 13 章 · 同名章节')).toBeNull()
  for (const id of [chapterId, untitledId, absentId]) expect(view.container.textContent).not.toContain(id)

  view.rerender(show(new Map([[untitledId, { title: '渡口', orderIndex: 11 }]])))
  expect(screen.queryByText('第 11 章 · 沿岸的灯')).toBeNull()
  expect(screen.getByText('第 11 章 · 渡口')).toBeTruthy()
  expect(screen.getAllByText('章节摘要（无法定位章节）')).toHaveLength(2)
  expect(view.container.textContent).not.toContain(chapterId)
  expect(restoredParts).toEqual([stored])
})

it.each([
  { label: 'character filter', memoryType: 'characterCard', preview: '雁归时：人物提及当章。', expected: 'literal' },
  { label: 'chapter filter', memoryType: 'chapterSummary', preview: undefined, expected: '第 7 章 · 雁归时' },
  { label: 'matching summary preview', memoryType: undefined, preview: '雁归时：抵达旧驿站。', expected: '第 7 章 · 雁归时' },
  { label: 'ambiguous preview', memoryType: undefined, preview: '人物只在结尾出场。', expected: '历史设定（名称暂不可用）' },
])('uses original filter and preview evidence in legacy memory search results ($label)', ({ memoryType, preview, expected }) => {
  const chapterId = 'af9d6970-0d7c-4a3c-81b2-ad9346657dfa'
  const title = `章节:${chapterId}`
  const stored = call('legacy-memory', 'memory_search', {
    args: { query: '梳理伏笔', memoryType },
    display: { kind: 'readSources', items: [{ title, preview }] },
  })
  const view = render(<AuthorActivityParts parts={[stored]} messageId="legacy" runActive={false}
    activityChapters={new Map([[chapterId, { title: '雁归时', orderIndex: 7 }]])} />)
  fireEvent.click(screen.getByRole('button', { name: '已核对前文' }))
  expect(screen.getByText(expected === 'literal' ? title : expected)).toBeTruthy()
  if (expected !== 'literal') expect(view.container.textContent).not.toContain(chapterId)
})

it('keeps lengthy read receipts collapsed and signals remaining content independently in each scroll area', () => {
  const count = 12
  const search = call('search', 'project_search', {
    display: { kind: 'projectSearch', query: '钥匙', total: count, matches: Array.from({ length: count }, (_, index) => ({
      chapterId: `chapter-${index}`, chapterTitle: `合成章节 ${index}`, field: 'content', offset: index,
      length: 2, contextBefore: '', match: '钥匙', contextAfter: '',
    })) },
  })
  const view = render(<Transcript messages={[message('read', [search, ...Array.from({ length: count }, (_, index) => call(`read-${index}`, 'chapter_read'))])]} />)
  fireEvent.click(screen.getByRole('button', { name: '已核对前文' }))
  const records = view.container.querySelector<HTMLElement>('[data-activity-scroll="records"]')!
  const toggle = screen.getByRole('button', { name: '搜索「钥匙」 · 12 处', expanded: false })
  expect(screen.queryByRole('button', { name: '《合成章节 11》' })).toBeNull()
  expect(records.hasAttribute('tabindex')).toBe(false)

  Object.defineProperties(records, { clientHeight: { value: 224 }, scrollHeight: { value: 364 } })
  fireEvent.scroll(records)
  expect(screen.getByRole('group', { name: '工具记录' })).toBe(records)
  expect(records.parentElement?.getAttribute('data-activity-scroll-more')).toBe('true')
  expect(records.tabIndex).toBe(0)

  toggle.focus()
  fireEvent.click(toggle)
  const detail = records.querySelector<HTMLElement>('[data-activity-scroll="detail"]')!
  Object.defineProperties(detail, { clientHeight: { value: 168 }, scrollHeight: { value: 264 } })
  fireEvent.scroll(detail)
  expect(screen.getByRole('group', { name: '工具详情' })).toBe(detail)
  expect(detail.parentElement?.getAttribute('data-activity-scroll-more')).toBe('true')
  expect(screen.getByRole('button', { name: '《合成章节 11》' })).toBeTruthy()
  detail.scrollTop = 96
  fireEvent.scroll(detail)
  expect(detail.parentElement?.hasAttribute('data-activity-scroll-more')).toBe(false)
  expect(detail.tabIndex).toBe(0)
  expect(records.parentElement?.getAttribute('data-activity-scroll-more')).toBe('true')

  fireEvent.click(toggle)
  expect(screen.queryByRole('group', { name: '工具详情' })).toBeNull()
  expect(document.activeElement).toBe(toggle)
})

it('shows the opening report before the pending activity and reuses that activity for the first tool', () => {
  const text: AgentMessagePart = { type: 'text', text: '前文已经有来访情节。' }
  const tool = call('new-check', 'chapter_read', { status: 'running' })
  const view = render(<AuthorActivityParts parts={[reasoning]} messageId="work" runActive showRunIndicator />)
  const original = view.container.querySelector('[data-author-step]')!
  view.rerender(<AuthorActivityParts parts={[reasoning, text]} messageId="work" runActive showRunIndicator />)
  const paragraph = screen.getByText(text.text)
  expect(view.container.querySelector('[data-author-step]')).toBe(original)
  expect(paragraph.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  const projection = projectActivityGroups([message('work', [reasoning, text, tool])])
  view.rerender(<AuthorActivityParts parts={[reasoning, text, tool]} messageId="work" runActive
    groups={projection.byMessage.get('work')} activeGroupId={projection.runningByRun.get('r')?.id} />)
  const activeTool = screen.getByRole('button', { name: '正在核对前文' })
  expect(view.container.querySelector('[data-author-step]')).toBe(original)
  expect(activeTool.closest('[data-author-step]')).toBe(original)
  expect(paragraph.compareDocumentPosition(activeTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.container.querySelectorAll('[data-author-step]')).toHaveLength(1)
  expect(view.container.querySelectorAll('.agent-processing-shimmer')).toHaveLength(1)

  const followup: AgentMessagePart = { type: 'text', text: '我已经查到来访的位置。' }
  const finished = { ...tool, status: 'success' as const }
  view.rerender(<AuthorActivityParts parts={[reasoning, text, finished, followup]} messageId="work" runActive={false} />)
  expect(view.container.querySelectorAll('[data-author-step]')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '已核对前文' })).toBe(activeTool)
  expect(original.compareDocumentPosition(screen.getByText(followup.text)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/梳理前文|RAW_THOUGHT_ONLY/)
})

it('keeps the import confirmation reachable without opening the activity', () => {
  const part = call('import', 'novel_import', {
    status: 'running', importWaiting: { url: '/studio/novel/work?import=ready', expiresAt: '2099-01-01' },
  })
  render(<Transcript active="r" messages={[message('a', [part])]} />)
  expect(screen.getByRole('button', { name: '等待你确认导入', expanded: false })).toBeTruthy()
  expect(screen.getByRole('link', { name: '核对原文并确认导入' }).getAttribute('href')).toBe('/studio/novel/work?import=ready')
})
