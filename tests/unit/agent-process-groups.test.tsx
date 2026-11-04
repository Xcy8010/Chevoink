// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { projectAnalysisGroups } from '../../src/features/studio/agent/lib/process-groups'
import { projectResearchGroups } from '../../src/features/studio/agent/lib/research-groups'
import type { AgentUIMessage, AgentMessagePart } from '../../shared/contracts/index'
afterEach(cleanup)
const reason = (): AgentMessagePart => ({ type: 'reasoning', text: 'private reasoning chapter_write chapterId=secret 原始思考' })
const tool = (id: string, toolName = 'web_search'): AgentMessagePart => ({ type: 'tool-call', callId: id, title: toolName, toolName, status: 'failed', summary: '查询服务暂不可用' })
const message = (id: string, parts: AgentMessagePart[]): AgentUIMessage => ({ id, runId: 'r', role: 'assistant', createdAt: '', parts })
function Transcript({ messages }: { messages: AgentUIMessage[] }) {
  const analysis = projectAnalysisGroups(messages), research = projectResearchGroups(messages)
  return <>{messages.map(item => <AgentMessageParts key={item.id} messageId={item.id} parts={item.parts} analysisGroups={analysis.get(item.id)} researchGroups={research.get(item.id)} streaming={false} runActive summaryExpanded />)}</>
}
it('merges analysis exposed by research grouping across assistant messages without publishing raw thought or hiding failure', () => {
  const messages = [message('a', [reason(), tool('search')]), message('b', [reason(), tool('read', 'web_read'), reason()])]
  const original = JSON.stringify(messages)
  const { container } = render(<Transcript messages={messages} />)
  expect(container.querySelectorAll('[data-agent-analysis]')).toHaveLength(1)
  expect(container.textContent).toContain('3 段')
  expect(container.textContent).toContain('查看参考资料相关分析')
  expect(container.textContent).not.toMatch(/private reasoning|chapter_write|chapterId|原始思考|secret/)
  expect(container.querySelectorAll('[data-agent-research-id]')).toHaveLength(1)
  expect(container.textContent).toContain('本次未取得参考资料')
  expect(JSON.stringify(messages)).toBe(original)
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
