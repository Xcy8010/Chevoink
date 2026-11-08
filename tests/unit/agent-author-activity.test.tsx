// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentMessagePart, AgentUIMessage } from '../../shared/contracts/index.js'
import { AuthorActivityParts, AuthorActivitySummary } from '../../src/features/studio/agent/components/AuthorActivityParts'
import { activityAnswerText, activityWorkingLabel, projectActivityGroups, type ActivityCall } from '../../src/features/studio/agent/lib/activity-groups'

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
      <AuthorActivityParts parts={parts} messageId="mixed" runActive={active} processOpen={open} activityChapterTitles={titles} />
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

it('uses visible prose first, with short milestone and saved-result fallbacks for a silent outline', () => {
  const plan = call('plan', 'plan_save', {
    display: { kind: 'planFile', artifactId: 'INTERNAL_PLAN', title: '第四章细纲', content: '合成细纲。' },
  })
  const read = message('read', [reasoning, call('read', 'plan_read')])
  const outline = message('outline', [plan])
  const silent = projectActivityGroups([read, outline])
  expect(silent.openingByRun.get('r')).toBe('我会先核对与这次任务有关的资料。')
  expect(silent.byMessage.get('outline')?.get('plan')?.transition).toMatch(/接下来整理创作计划/)
  expect(silent.savedReplyByRun.get('r')).toBe('已将《第四章细纲》保存到计划。')

  const prose: AgentMessagePart = { type: 'text', text: '我会让第四章承接上一章的来访。' }
  const final: AgentMessagePart = { type: 'text', text: '细纲保留了来访者未说明的目的。' }
  const narrated = projectActivityGroups([message('read', [prose, ...read.parts]), message('outline', [prose, plan, final])])
  expect(narrated.openingByRun.get('r')).toBeNull()
  expect(narrated.byMessage.get('outline')?.get('plan')?.transition).toBeUndefined()
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
  const view = render(<AuthorActivityParts parts={[opening, reasoning]} messageId="run" runActive workingLabel={activityWorkingLabel(undefined)} />)
  const shimmer = () => view.container.querySelectorAll('.agent-processing-shimmer')
  expect(shimmer()).toHaveLength(1)
  expect(shimmer()[0].textContent).toBe('梳理这次的创作要求')
  const step = view.container.querySelector('[data-author-step] > button')
  const openingNode = screen.getByText(opening.text)
  expect(step?.querySelector('.lucide-brain')).toBeTruthy()
  const group = projectActivityGroups([message('run', [opening, read])])
  view.rerender(<AuthorActivityParts parts={[opening, read]} messageId="run" runActive activeGroupId={group.runningByRun.get('r')?.id}
    groups={group.byMessage.get('run')} activityChapterTitles={titles} />)
  expect(shimmer()).toHaveLength(1)
  expect(shimmer()[0].textContent).toBe('正在核对前文')
  expect(shimmer()[0].closest('button')).toBe(step)
  expect(screen.getByText(opening.text)).toBe(openingNode)
  fireEvent.click(step!)
  expect(step?.getAttribute('aria-expanded')).toBe('true')
  expect(shimmer()[0].closest('button')?.className).not.toMatch(/hover:bg|rounded/)
  expect(view.container.querySelector('[data-author-working]')).toBeNull()
  const done = { ...read, status: 'success' as const }
  view.rerender(<AuthorActivityParts parts={[opening, done]} messageId="run" runActive workingLabel={activityWorkingLabel(done)} />)
  expect(shimmer()).toHaveLength(1)
  expect(shimmer()[0].textContent).toBe('梳理刚查到的资料')
  expect(shimmer()[0].closest('button')).toBe(step)
  expect(step?.getAttribute('aria-expanded')).toBe('true')
  view.rerender(<AuthorActivityParts parts={[opening, done, { type: 'text', text: '这是正文信道的答复。' }]} messageId="run" runActive={false} />)
  expect(shimmer()).toHaveLength(0)
  expect(screen.getByText('这是正文信道的答复。')).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/RAW_THOUGHT_ONLY|正在处理/)
})

it('shows distinct search terms, actual matching chapter locations, and other read results', () => {
  const hits = call('search', 'project_search', {
    display: { kind: 'projectSearch', query: '旧钥匙', total: 1, matches: [{
      volumeTitle: '归途卷', chapterId: 'PRIVATE_CHAPTER', chapterTitle: '关门前', field: 'content', offset: 41,
      length: 3, contextBefore: '她摸到一把', match: '旧钥匙', contextAfter: '。',
    }] },
  })
  const legacy = call('older', 'project_search', { summary: '全书检索“收据” · 0 处' })
  const read = call('chapter', 'chapter_read', { display: {
    kind: 'chapterRef', chapterId: 'PRIVATE_CHAPTER', title: '关门前', wordCount: 920, range: { start: 20, end: 75 },
  } })
  const view = render(<Transcript messages={[message('read', [hits, legacy, read])]} />)
  for (const toggle of view.container.querySelectorAll('[data-author-activity] > button')) fireEvent.click(toggle)
  expect(screen.getByText('搜索「旧钥匙」 · 1 处')).toBeTruthy()
  expect(screen.getByText('搜索「收据」 · 无匹配')).toBeTruthy()
  expect(screen.getByText(/正文第 42 字/)).toBeTruthy()
  expect(screen.getByText(/正文第 21–75 字/)).toBeTruthy()
  expect(screen.getByText('旧钥匙').tagName).toBe('MARK')
  expect(screen.getByRole('button', { name: '《关门前》' })).toBeTruthy()
  expect(view.container.textContent).not.toContain('PRIVATE_CHAPTER')
})

it('keeps a visible thinking step before a newly emitted report and opens a later tool below it', () => {
  const text: AgentMessagePart = { type: 'text', text: '前文已经有来访情节。' }
  const tool = call('new-check', 'chapter_read', { status: 'running' })
  const view = render(<AuthorActivityParts parts={[reasoning]} messageId="work" runActive workingLabel="梳理前文" />)
  const original = view.container.querySelector('[data-author-step] > button')!
  view.rerender(<AuthorActivityParts parts={[reasoning, text]} messageId="work" runActive workingLabel="梳理前文" />)
  const paragraph = screen.getByText(text.text)
  expect(view.container.querySelector('[data-author-step] > button')).toBe(original)
  expect(original.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  const projection = projectActivityGroups([message('work', [reasoning, text, tool])])
  view.rerender(<AuthorActivityParts parts={[reasoning, text, tool]} messageId="work" runActive
    groups={projection.byMessage.get('work')} activeGroupId={projection.runningByRun.get('r')?.id} />)
  const activeTool = screen.getByRole('button', { name: '正在核对前文' })
  expect(view.container.querySelector('[data-author-step] > button')).toBe(original)
  expect(paragraph.compareDocumentPosition(activeTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.container.querySelectorAll('.agent-processing-shimmer')).toHaveLength(1)
})

it('keeps the import confirmation reachable without opening the activity', () => {
  const part = call('import', 'novel_import', {
    status: 'running', importWaiting: { url: '/studio/novel/work?import=ready', expiresAt: '2099-01-01' },
  })
  render(<Transcript active="r" messages={[message('a', [part])]} />)
  expect(screen.getByRole('button', { name: '等待你确认导入', expanded: false })).toBeTruthy()
  expect(screen.getByRole('link', { name: '核对原文并确认导入' }).getAttribute('href')).toBe('/studio/novel/work?import=ready')
})
