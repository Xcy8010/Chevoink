// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import type { AgentMessagePart, AgentToolDisplayPayload } from '../../shared/contracts/index.js'

afterEach(cleanup)

const continuity: Extract<AgentToolDisplayPayload, { kind: 'storyCompiler' }> = {
  kind: 'storyCompiler', phase: 'check', title: '连续性检查', detail: '发现需要核对的问题',
  errorCount: 4, warningCount: 6, items: ['错误：人物状态与前章冲突', '警告：时间线需要核对'],
}
const quality: Extract<AgentToolDisplayPayload, { kind: 'qualityReport' }> = {
  kind: 'qualityReport', reportId: 'report', chapterId: 'chapter', chapterRevision: 2,
  status: 'needs_repair', repairRound: 0,
  findings: [{ id: 'finding', signal: 'explanation', label: '重复解释', severity: 'warning',
    evidence: '他再次解释了刚刚发生的事。', explanation: '叙述重复了已呈现的动作。',
    suggestion: '删去重复说明。', disposition: 'pending' }],
}
function tool(display: AgentToolDisplayPayload): Extract<AgentMessagePart, { type: 'tool-call' }> {
  return { type: 'tool-call', callId: display.kind, toolName: display.kind === 'storyCompiler' ? 'story_compiler_check' : 'quality_analyze',
    title: display.kind === 'storyCompiler' ? '连续性检查' : '人类感质量检查', status: 'success',
    summary: '检查报告已取得', args: { chapterId: 'chapter' }, display }
}

it.each([true, false])('keeps report summaries visible and details folded in an open execution block (active=%s)', runActive => {
  render(<AgentMessageParts parts={[tool(continuity), tool(quality)]} streaming={false} runActive={runActive} summaryExpanded />)
  expect(screen.getByText('检查 · 发现需要核对的问题')).toBeTruthy()
  expect(screen.getByText('4 错误')).toBeTruthy()
  expect(screen.getByText('质量报告 · r2 · 1 条证据')).toBeTruthy()
  expect(screen.getByText('1 条需关注')).toBeTruthy()
  expect(screen.getAllByText('检查报告已取得')).toHaveLength(2)
  expect(screen.queryByText(continuity.items[0])).toBeNull()
  expect(screen.queryByText(continuity.items[1])).toBeNull()
  expect(screen.queryByText(quality.findings[0].evidence)).toBeNull()
  expect(screen.getByRole('button', { name: '展开检查详情' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: '展开质量报告' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: '展开工具详情' })).toBeNull()
})

it('expands and folds each real report with one click, independently of the other report', () => {
  render(<AgentMessageParts parts={[tool(continuity), tool(quality)]} streaming={false} runActive />)
  const checkButton = screen.getByRole('button', { name: '展开检查详情' })
  const qualityButton = screen.getByRole('button', { name: '展开质量报告' })
  fireEvent.click(checkButton)
  expect(checkButton.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(checkButton.getAttribute('aria-controls')!)?.textContent).toContain(continuity.items[0])
  expect(screen.getByText(continuity.items[1])).toBeTruthy()
  expect(screen.queryByText(quality.findings[0].evidence)).toBeNull()
  fireEvent.click(qualityButton)
  expect(qualityButton.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(qualityButton.getAttribute('aria-controls')!)?.textContent).toContain(quality.findings[0].evidence)
  expect(screen.getByText(quality.findings[0].label)).toBeTruthy()
  expect(screen.getByText(quality.findings[0].explanation)).toBeTruthy()
  expect(screen.getByText(`最小修法：${quality.findings[0].suggestion}`)).toBeTruthy()
  fireEvent.click(qualityButton)
  expect(qualityButton.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(quality.findings[0].evidence)).toBeNull()
  expect(screen.getByText(continuity.items[0])).toBeTruthy()
  fireEvent.click(checkButton)
  expect(checkButton.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(continuity.items[0])).toBeNull()
})

it('supports keyboard focus, Enter expansion and Space collapse', async () => {
  const user = userEvent.setup()
  render(<AgentMessageParts parts={[tool(quality)]} streaming={false} runActive />)
  const button = screen.getByRole('button', { name: '展开质量报告' })
  await user.tab()
  expect(document.activeElement).toBe(button)
  await user.keyboard('{Enter}')
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(quality.findings[0].evidence)).toBeTruthy()
  await user.keyboard(' ')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(button)
})

it('does not auto-open a report when its running tool receives an error-filled result', () => {
  const finished = tool(continuity)
  const view = render(<AgentMessageParts parts={[{ ...finished, status: 'running', display: undefined, summary: undefined }]} streaming={false} runActive />)
  expect(screen.getByText('执行中…')).toBeTruthy()
  view.rerender(<AgentMessageParts parts={[finished]} streaming={false} runActive />)
  expect(screen.queryByText('执行中…')).toBeNull()
  expect(screen.getByText('4 错误')).toBeTruthy()
  expect(screen.queryByText(continuity.items[0])).toBeNull()
  expect(screen.getByRole('button', { name: '展开检查详情' }).getAttribute('aria-expanded')).toBe('false')
})

it('keeps failure summaries, reasoning and prose visible while report details remain folded', async () => {
  render(<AgentMessageParts parts={[
    { type: 'reasoning', text: '先核对章节状态。' },
    { ...tool(quality), status: 'failed', summary: '质量检查失败，请稍后重试' },
    { type: 'text', text: '已保存本章正文。' },
  ]} streaming={false} runActive />)
  expect(screen.getByText('质量检查失败，请稍后重试')).toBeTruthy()
  expect(screen.getByText('先核对章节状态。')).toBeTruthy()
  expect(await screen.findByText('已保存本章正文。')).toBeTruthy()
  expect(screen.queryByText(quality.findings[0].evidence)).toBeNull()
})

it('shows a passed empty report summary and allows its empty-result detail to be opened', () => {
  render(<AgentMessageParts parts={[tool({ ...quality, status: 'passed', findings: [] })]} streaming={false} runActive />)
  expect(screen.getByText('质量报告 · r2 · 0 条证据')).toBeTruthy()
  expect(screen.getByText('通过')).toBeTruthy()
  expect(screen.queryByText('没有发现可定位的问题。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '展开质量报告' }))
  expect(screen.getByText('没有发现可定位的问题。')).toBeTruthy()
})
