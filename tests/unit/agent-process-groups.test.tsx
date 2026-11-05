// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { projectAnalysisGroups } from '../../src/features/studio/agent/lib/process-groups'
import { projectResearchGroups } from '../../src/features/studio/agent/lib/research-groups'
import type { AgentUIMessage, AgentMessagePart } from '../../shared/contracts/index'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const reason = (): AgentMessagePart => ({ type: 'reasoning', text: '好。开始。已全部修复。\\n调用 chapter_write，chapterId=secret。' })
const tool = (id: string, toolName = 'web_search', summary = '查询服务暂不可用'): Extract<AgentMessagePart, { type: 'tool-call' }> => ({ type: 'tool-call', callId: id, title: toolName, toolName, status: 'failed', summary })
const message = (id: string, parts: AgentMessagePart[]): AgentUIMessage => ({ id, runId: 'r', role: 'assistant', createdAt: '', parts })
function Transcript({ messages }: { messages: AgentUIMessage[] }) {
  const analysis = projectAnalysisGroups(messages), research = projectResearchGroups(messages)
  return <>{messages.map(item => <AgentMessageParts key={item.id} messageId={item.id} parts={item.parts} analysisGroups={analysis.get(item.id)} researchGroups={research.get(item.id)} streaming={false} runActive summaryExpanded />)}</>
}
it('merges receipt progress across research without publishing private reasoning or hiding failures', () => {
  const messages = [message('a', [reason(), tool('search')]), message('b', [reason(), tool('read', 'web_read'), reason()])]
  const original = JSON.stringify(messages)
  const { container } = render(<Transcript messages={messages} />)
  expect(container.querySelectorAll('[data-agent-analysis]')).toHaveLength(1)
  expect(container.textContent).toContain('3 段')
  const toggle = screen.getByRole('button', { name: '任务进度' })
  expect(toggle.textContent).toContain('未完成：查询服务暂不可用')
  fireEvent.click(toggle)
  expect(container.querySelector('.max-h-44')?.textContent).toContain('查询服务暂不可用')
  expect(container.textContent).not.toMatch(/已全部修复|好。|开始。|chapter_write|chapterId|secret/)
  expect(container.querySelectorAll('[data-agent-research-id]')).toHaveLength(1)
  expect(container.textContent).toContain('本次未取得参考资料')
  expect(JSON.stringify(messages)).toBe(original)
})
it('shows neutral current work before receipts, then upgrades the same episode through prepare/run/result', () => {
  const view = render(<AgentMessageParts parts={[reason()]} streaming runActive />)
  expect(screen.getByRole('button', { name: '任务进度' }).textContent).toBe('正在梳理当前任务')
  expect(view.container.textContent).not.toContain('开始')
  for (const [part, expected] of [
    [{ ...tool('read', 'chapter_read'), status: 'running', preparing: true }, '正在准备核对前文'],
    [{ ...tool('read', 'chapter_read'), status: 'running' }, '正在核对前文'],
    [{ ...tool('read', 'chapter_read'), status: 'success', summary: '已读取上一章结尾。\\n人物尚未获得线索。' }, '已读取上一章结尾。\n人物尚未获得线索。'],
  ] as const) {
    view.rerender(<AgentMessageParts parts={[reason(), part]} streaming runActive />)
    expect(screen.getByRole('button', { name: '任务进度' }).textContent).toBe(expected)
  }
  fireEvent.click(screen.getByRole('button', { name: '任务进度' }))
  expect(view.container.querySelector('.max-h-44')?.textContent).toBe('已读取上一章结尾。\n人物尚未获得线索。')
})
it.each(['success', 'failed', 'denied', 'running'] as const)('uses actual %s tool state without converting the model plan to completion', status => {
  const part = { ...tool('read', 'chapter_read'), status, summary: status === 'success' ? '已读取章节，人物位置仍需核对。' : '未取得章节。' }
  render(<AgentMessageParts parts={[reason(), part]} streaming={false} runActive summaryExpanded />)
  const title = screen.getByRole('button', { name: '任务进度' }).textContent
  expect(title).toBe(status === 'success' ? part.summary : status === 'running' ? '正在核对前文' : `核对前文${status === 'failed' ? '未完成' : '未获准'}：未取得章节。`)
  expect(title).not.toMatch(/已全部修复|已核对章节|开始/)
})
it('keeps report receipt findings unresolved and does not infer repaired issues from success', () => {
  render(<AgentMessageParts parts={[reason(), { ...tool('review', 'quality_analyze'), status: 'success', summary: '已取得报告，仍有两处表达意见。' }]} streaming={false} runActive summaryExpanded />)
  expect(screen.getByRole('button', { name: '任务进度' }).textContent).toBe('已取得报告，仍有两处表达意见。')
})
it('keeps expansion, right rail and scroll ownership through receipt updates and completion', () => {
  let height = 500
  const positions = new WeakMap<Element, number>()
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('max-h-44') ? height : 0 })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('max-h-44') ? 100 : 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return positions.get(this) ?? 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, top: number) { positions.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight))) })
  let summary = '已读取前文。'
  const parts = (): AgentMessagePart[] => [reason(), { ...tool('read', 'web_search'), status: 'success', summary }, reason()]
  const view = render(<AgentMessageParts parts={parts()} streaming runActive />)
  const toggle = screen.getByRole('button', { name: '任务进度' })
  const controls = toggle.querySelector('[data-analysis-controls]')!
  expect(controls.textContent).toBe('2 段')
  expect(controls.className).toContain('shrink-0')
  fireEvent.click(toggle)
  const content = view.container.querySelector<HTMLDivElement>('.max-h-44')!
  expect(content.scrollTop).toBe(400)
  const append = (nextHeight: number) => { height = nextHeight; summary += '已取得新的参考资料。'; view.rerender(<AgentMessageParts parts={parts()} streaming runActive />) }
  append(700); expect(content.scrollTop).toBe(600)
  content.scrollTop = 590; fireEvent.scroll(content)
  append(900); expect(content.scrollTop).toBe(590)
  content.scrollTop = 800; fireEvent.scroll(content)
  append(1000); expect(content.scrollTop).toBe(900)
  view.rerender(<AgentMessageParts parts={parts()} streaming={false} runActive summaryExpanded />)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.querySelector('[data-analysis-controls]')).toBe(controls)
  fireEvent.click(toggle); expect(view.container.querySelector('.max-h-44')).toBeNull()
  fireEvent.click(toggle); expect(view.container.querySelector('.max-h-44')?.scrollTop).toBe(900)
})
it('deduplicates the same receipt call within an episode', () => {
  const receipt = { ...tool('read', 'web_search'), status: 'success' as const, summary: '已取得两份资料。' }
  const group = projectAnalysisGroups([message('a', [reason(), receipt, receipt])]).get('a')!.get(0)!
  expect(group.actions).toEqual(['已取得两份资料。'])
})
it('preserves protocol-looking literary prose and literal manuscript escapes', () => {
  const prose = '人物写下 chapterId=abc123，字符\\n仍是原文，数学线索 x=1。'
  const { container } = render(<AgentMessageParts parts={[{ type: 'text', text: prose }]} streaming={false} runActive={false} summaryExpanded />)
  expect(container.textContent).toContain(prose)
})
it.each(['text', 'tool', 'user', 'run', 'goal'] as const)('keeps %s episode boundaries', boundary => {
  const a = message('a', [reason()]), b = message('b', [reason()])
  const between = boundary === 'text' ? [message('middle', [{ type: 'text', text: '已核对的资料。' }])]
    : boundary === 'tool' ? [message('middle', [tool('write', 'chapter_write')])]
    : boundary === 'user' ? [{ ...message('user', []), role: 'user' as const }] : []
  if (boundary === 'run') b.runId = 'r2'
  if (boundary === 'goal') b.goalId = 'g2'
  const { container } = render(<Transcript messages={[a, ...between, b]} />)
  expect(container.querySelectorAll('[data-agent-analysis]')).toHaveLength(2)
})
