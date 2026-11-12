// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
  const failed = call('failed', 'chapter_edit_range', { status: 'failed', summary: failureReceipt })
  const view = render(<Transcript messages={[message('a', [failed])]} />)
  const toggle = screen.getByRole('button', { name: `《${title}》正文修改未保存` })
  fireEvent.click(toggle)
  view.rerender(<Transcript messages={[message('a', [failed]), message('b', [reasoning, saved('retry', 'chapter_edit_range')])]} />)
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
  const messages = actions.map((part, i) => message(`m${i}`, i === 24
    ? [{ type: 'text', text: '初稿写好了。我现在核对人物前后的行动。' }, reasoning, part]
    : [reasoning, part]))
  const replayed = [...messages, message('replay', [{ ...actions[0], status: 'running', preparing: true }])]
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
    message('last', [{ type: 'text', text: '资料已核对。' }, last, save, next]),
  ])
  const group = projection.byMessage.get('first')?.get(first.callId)
  expect(group?.calls.map(part => part.callId)).toEqual(['outline', 'chapter-plan', 'craft-skill', 'previous', 'structure', 'setting'])
  expect(projection.byMessage.get('second')?.get(second.callId)).toBe(group)
  expect(projection.byMessage.get('skill')?.get(skill.callId)).toBe(group)
  expect(group?.readLabel).toBe('查看创作资料')
  expect(projection.byMessage.get('last')?.get(last.callId)?.calls.map(part => part.callId)).toEqual([last.callId])
  expect(projection.byMessage.get('last')?.get(next.callId)?.calls.map(part => part.callId)).toEqual([next.callId])
})

it('shows one parameter preview and uses actual call events to advance the visible step', () => {
  const preview = (id: string, name: string) => call(id, name, { status: 'running', preparing: true, args: null })
  const plan = preview('plan', 'plan_read')
  const chapter = preview('read', 'chapter_read')
  const next = preview('save', 'plan_save')
  const timeline = (...parts: ActivityCall[]) => <Transcript active="r" messages={[message('batch', parts)]} />
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
  const settingsRow = screen.getByRole('button', { name: '正在查看创作设定', exact: true })
  const coverRow = screen.getByRole('button', { name: '正在制作封面', exact: true })
  fireEvent.click(settingsRow)
  fireEvent.click(coverRow)
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
  expect(screen.getByRole('button', { name: '正在进行章节人类感复查', exact: true })).toBeTruthy()
  const continuityRow = screen.getByRole('button', { name: '章节衔接复查完成', exact: true })
  fireEvent.click(continuityRow)
  expect(continuityRow.closest('[data-author-activity]')?.querySelectorAll('[data-activity-tool="continuity_validate"]')).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: '展开检查详情' })[0])
  expect(screen.getByText('检查项仍可展开')).toBeTruthy()
  view.rerender(<Transcript messages={[
    message('a', [continuity]), message('b', [{ ...continuity, callId: 'continuity-again' }, quality]),
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: '章节人类感复查完成', exact: true }))
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
  expect(silent.savedReplyByRun.get('r')).toBe('已完成《第四章细纲》的更新。')

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
  expect(shimmer()[0].textContent).toBe('正在思考')
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
  const view = render(<AuthorActivityParts parts={[reasoning]} messageId="work" runActive workingLabel="梳理前文" />)
  const original = view.container.querySelector('[data-author-step] > button')!
  view.rerender(<AuthorActivityParts parts={[reasoning, text]} messageId="work" runActive workingLabel="梳理前文" />)
  const paragraph = screen.getByText(text.text)
  expect(view.container.querySelector('[data-author-step] > button')).toBe(original)
  expect(paragraph.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  const projection = projectActivityGroups([message('work', [reasoning, text, tool])])
  view.rerender(<AuthorActivityParts parts={[reasoning, text, tool]} messageId="work" runActive
    groups={projection.byMessage.get('work')} activeGroupId={projection.runningByRun.get('r')?.id} />)
  const activeTool = screen.getByRole('button', { name: '正在核对前文' })
  expect(view.container.querySelector('[data-author-step] > button')).toBe(original)
  expect(activeTool).toBe(original)
  expect(paragraph.compareDocumentPosition(activeTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.container.querySelectorAll('[data-author-step]')).toHaveLength(1)
  expect(view.container.querySelectorAll('.agent-processing-shimmer')).toHaveLength(1)

  const followup: AgentMessagePart = { type: 'text', text: '我已经查到来访的位置。' }
  const finished = { ...tool, status: 'success' as const }
  view.rerender(<AuthorActivityParts parts={[reasoning, text, finished, followup]} messageId="work" runActive={false} />)
  expect(view.container.querySelectorAll('[data-author-step]')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '已核对前文' })).toBe(original)
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
