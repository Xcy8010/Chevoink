// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { projectAnalysisGroups } from '../../src/features/studio/agent/lib/process-groups'
import { projectResearchGroups } from '../../src/features/studio/agent/lib/research-groups'
import type { AgentUIMessage, AgentMessagePart } from '../../shared/contracts/index'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const reason = (): AgentMessagePart => ({ type: 'reasoning', text: '核对人物动机。\n\n调用 chapter_write，chapterId=secret。\n\n保留伏笔与因果。' })
const tool = (id: string, toolName = 'web_search'): AgentMessagePart => ({ type: 'tool-call', callId: id, title: toolName, toolName, status: 'failed', summary: '查询服务暂不可用' })
const message = (id: string, parts: AgentMessagePart[]): AgentUIMessage => ({ id, runId: 'r', role: 'assistant', createdAt: '', parts })
function Transcript({ messages }: { messages: AgentUIMessage[] }) {
  const analysis = projectAnalysisGroups(messages), research = projectResearchGroups(messages)
  return <>{messages.map(item => <AgentMessageParts key={item.id} messageId={item.id} parts={item.parts} analysisGroups={analysis.get(item.id)} researchGroups={research.get(item.id)} streaming={false} runActive summaryExpanded />)}</>
}
it('merges sanitized expandable thinking across research without hiding real failure', () => {
  const messages = [message('a', [reason(), tool('search')]), message('b', [reason(), tool('read', 'web_read'), reason()])]
  const original = JSON.stringify(messages)
  const { container } = render(<Transcript messages={messages} />)
  expect(container.querySelectorAll('[data-agent-analysis]')).toHaveLength(1)
  expect(container.textContent).toContain('3 段')
  expect(screen.getByRole('button', { name: '思考过程' }).textContent).toContain('保留伏笔与因果。')
  expect(container.textContent).not.toContain('分析：')
  const toggle = screen.getByRole('button', { name: '思考过程' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(container.querySelector('.max-h-44')?.textContent?.match(/保留伏笔与因果/g)).toHaveLength(3)
  expect(container.textContent).not.toMatch(/chapter_write|chapterId|secret/)
  expect(container.querySelectorAll('[data-agent-research-id]')).toHaveLength(1)
  expect(container.textContent).toContain('本次未取得参考资料')
  expect(JSON.stringify(messages)).toBe(original)
})

it('updates the safe live preview and retains expansion through streamed updates and completion', () => {
  const view = render(<AgentMessageParts parts={[{ type: 'reasoning', text: '先核对人物动机。' }]} streaming runActive />)
  expect(view.container.textContent).toContain('正在分析… · 先核对人物动机。')
  fireEvent.click(screen.getByRole('button', { name: '思考过程' }))
  view.rerender(<AgentMessageParts parts={[{ type: 'reasoning', text: '先核对人物动机。\n\n再检查伏笔，chapterId=private-id。\n\n保持因果一致。' }]} streaming runActive />)
  expect(screen.getByRole('button', { name: '思考过程' }).getAttribute('aria-expanded')).toBe('true')
  expect(view.container.textContent).toContain('正在分析… · 保持因果一致。')
  expect(view.container.textContent).not.toMatch(/chapterId|private-id/)
  view.rerender(<AgentMessageParts parts={[{ type: 'reasoning', text: '先核对人物动机。\n\n保持因果一致。' }]} streaming={false} runActive summaryExpanded />)
  expect(screen.getByRole('button', { name: '思考过程' }).textContent).toBe('保持因果一致。')
  expect(view.container.textContent).not.toContain('正在分析')
  expect(view.container.querySelector('.max-h-44')?.textContent).toContain('保持因果一致。')
})
it('summarizes the latest safe judgment instead of the opening plan without changing expanded thinking', () => {
  const text = '先核对上一章结尾的人物位置，再确认本章冲突怎样承接。\n\n人物尚未拿到关键线索，这一章应先让调查碰到阻力。保留伏笔，把真相放到后续章节揭示。'
  const { container } = render(<AgentMessageParts parts={[{ type: 'reasoning', text }]} streaming={false} runActive summaryExpanded />)
  const toggle = screen.getByRole('button', { name: '思考过程' })
  expect(toggle.textContent).toBe('保留伏笔，把真相放到后续章节揭示。')
  fireEvent.click(toggle)
  expect(container.querySelector('.max-h-44')?.textContent).toBe(text)
})
it('keeps the count and chevron in a fixed right rail while only the preview flexes', () => {
  const parts = (text: string): AgentMessagePart[] => [{ type: 'reasoning', text: '保留人物动机。' }, { type: 'reasoning', text }]
  const { rerender } = render(<AgentMessageParts parts={parts('保留伏笔。')} streaming runActive />)
  const button = screen.getByRole('button', { name: '思考过程' })
  const controls = button.querySelector('[data-analysis-controls]')!
  const chevron = controls.querySelector('svg')
  expect(button.className).toContain('w-full')
  expect(button.children[1].className).toContain('flex-1')
  expect(button.children[1].className).toContain('truncate')
  expect(controls.className).toContain('ml-auto')
  expect(controls.className).toContain('shrink-0')
  expect(controls.textContent).toBe('2 段')
  rerender(<AgentMessageParts parts={parts('保留伏笔，让尚未公开的线索在后续章节自然衔接，并把人物选择与实际后果联系起来。')} streaming runActive />)
  expect(button.querySelector('[data-analysis-controls]')).toBe(controls)
  expect(controls.querySelector('svg')).toBe(chevron)
  expect(controls.textContent).toBe('2 段')
  expect(button.children[1].textContent).toContain('正在分析… · 保留伏笔，让尚未公开的线索')
})

it('follows expanded thinking until an upward scroll, resumes only at bottom, and resets the scroll owner on reopen', () => {
  let height = 500
  const positions = new WeakMap<Element, number>()
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('max-h-44') ? height : 0 })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('max-h-44') ? 100 : 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return positions.get(this) ?? 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, top: number) { positions.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight))) })
  let text = '保留人物动机。'
  const { container, rerender, unmount } = render(<AgentMessageParts parts={[{ type: 'reasoning', text }]} streaming runActive />)
  const toggle = screen.getByRole('button', { name: '思考过程' })
  const append = (nextHeight: number) => {
    height = nextHeight; text += '\n\n保留新的因果线索。'
    rerender(<AgentMessageParts parts={[{ type: 'reasoning', text }]} streaming runActive />)
  }
  fireEvent.click(toggle)
  const content = container.querySelector<HTMLDivElement>('.max-h-44')!
  expect(content.scrollTop).toBe(400)
  append(700); expect(content.scrollTop).toBe(600)
  content.scrollTop = 590; fireEvent.scroll(content)
  append(900); expect(content.scrollTop).toBe(590)
  // Moving down near the bottom does not erase the author's deliberate detach.
  content.scrollTop = 790; fireEvent.scroll(content)
  append(1000); expect(content.scrollTop).toBe(790)
  content.scrollTop = 900; fireEvent.scroll(content)
  append(1200); expect(content.scrollTop).toBe(1100)
  // Browser clamping after a height reduction at bottom is not an upward gesture.
  height = 800; content.scrollTop = 700; fireEvent.scroll(content)
  append(1000); expect(content.scrollTop).toBe(900)
  height = 1200; text += '\n\n伏笔应在后续章节揭示。'
  rerender(<AgentMessageParts parts={[{ type: 'reasoning', text }]} streaming={false} runActive summaryExpanded />)
  expect(content.scrollTop).toBe(1100)
  expect(toggle.textContent).toBe('伏笔应在后续章节揭示。')
  fireEvent.click(toggle)
  expect(container.querySelector('.max-h-44')).toBeNull()
  fireEvent.click(toggle)
  const reopened = container.querySelector<HTMLDivElement>('.max-h-44')!
  expect(reopened).not.toBe(content)
  expect(reopened.scrollTop).toBe(1100)
  unmount()
  expect(container.querySelector('.max-h-44')).toBeNull()
})

it.each([
  ['success', '已执行'], ['failed', '未完成'], ['denied', '未获准'], ['running', '进行中'],
] as const)('uses real tool state for plan-only thinking after %s rather than claiming the plan was completed', (status, label) => {
  const { container } = render(<AgentMessageParts parts={[
    { type: 'reasoning', text: '我会先核对章节。\n\n需要确认人物位置。' },
    { ...tool('check', 'chapter_read'), status },
  ]} streaming={false} runActive summaryExpanded />)
  const toggle = screen.getByRole('button', { name: '思考过程' })
  expect(toggle.textContent).toBe(`分析记录 · 核对前文：${label}`)
  expect(toggle.textContent).not.toMatch(/已核对章节|已确认人物|chapter_read|需要|我会/)
  fireEvent.click(toggle)
  expect(container.querySelector('.max-h-44')?.textContent).toContain('我会先核对章节。')
})
it.each([
  ['expectedPlanHash', 'abc123'], ['contentHash', 'abc123'], ['planKind', 'detail'],
  ['expectedParentPlanHash', 'abc123'], ['targetOrderIndex', '12345'],
  ['arguments', '{"target":{"chapterId":"private-chapter"},"planKind":"detail"}'],
] as const)('redacts embedded reasoning %s assignments at every stream split without discarding natural analysis', (field, value) => {
  const opening = '这个人物反应需要一致。数学线索 x=1 仍然成立，'
  const thought = `${opening}${field}=${value}，保留伏笔。`
  const source = message('thinking', [{ type: 'reasoning', text: thought }])
  const original = JSON.stringify(source)
  for (let end = opening.length; end <= thought.length; end++) {
    const partial = { ...source, parts: [{ type: 'reasoning' as const, text: thought.slice(0, end) }] }
    const visible = projectAnalysisGroups([partial], partial.id).get(partial.id)!.get(0)!.text
    expect(visible).toContain('这个人物反应需要一致。')
    expect(visible).toContain('x=1')
    expect(visible).not.toMatch(/expectedPlanHash|contentHash|planKind|expectedParentPlanHash|targetOrderIndex|arguments|chapterId|abc123|detail|12345|private-chapter/)
  }
  const historical = projectAnalysisGroups([source]).get(source.id)!.get(0)!.text
  expect(historical).toContain('这个人物反应需要一致。')
  expect(historical).toContain('保留伏笔。')
  expect(historical).toContain('x=1')
  expect(historical).not.toContain(value)
  expect(JSON.stringify(source)).toBe(original)
})

it('keeps protocol-looking literary prose unchanged outside the reasoning projection', () => {
  const prose = '人物在纸上写下 expectedPlanHash=abc123，这是小说中的原文；数学线索 x=1。'
  const { container } = render(<AgentMessageParts parts={[{ type: 'text', text: prose }]} streaming={false} runActive={false} summaryExpanded />)
  expect(container.textContent).toContain(prose)
})
it.each(['text', 'tool', 'user', 'run', 'goal'] as const)('keeps %s boundaries between analysis episodes', boundary => {
  const a = message('a', [reason()]), b = message('b', [reason()])
  const between = boundary === 'text' ? [message('middle', [{ type: 'text', text: '先说明已经核对的资料。' }])]
    : boundary === 'tool' ? [message('middle', [tool('write', 'chapter_write')])]
    : boundary === 'user' ? [{ ...message('user', []), role: 'user' as const }] : []
  if (boundary === 'run') b.runId = 'r2'
  if (boundary === 'goal') b.goalId = 'g2'
  const { container } = render(<Transcript messages={[a, ...between, b]} />)
  expect(container.querySelectorAll('[data-agent-analysis]')).toHaveLength(2)
  if (boundary === 'text') expect(container.textContent).toContain('先说明已经核对的资料。')
})
