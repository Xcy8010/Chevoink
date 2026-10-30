// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentMessagePart, AgentUIMessage, AgentStreamEventBody } from '../../shared/contracts/index.js'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { isRunActive, useAgentStore } from '../../src/features/studio/agent/agentStore'
import { projectResearchGroups, summarizeResearchGroup, type ResearchCall } from '../../src/features/studio/agent/lib/research-groups'

beforeAll(async () => { await Promise.all([import('react-markdown'), import('remark-gfm')]) }, 30000)
afterEach(() => { cleanup(); useAgentStore.getState().resetRun() })
const search = (id: string, overrides: Partial<ResearchCall> = {}): ResearchCall => ({
  type: 'tool-call', callId: id, toolName: 'web_search', title: '联网搜索', status: 'success', args: { query: '河谷纪事 作者' },
  display: { kind: 'webSearch', query: '河谷纪事 作者', provider: 'fixture', results: [{ title: '河谷纪事 · 出版信息', url: 'https://example.com/book', snippet: '公开书目信息', source: '示例来源' }] }, ...overrides,
})
const page = (id: string, overrides: Partial<ResearchCall> = {}): ResearchCall => search(id, {
  toolName: 'web_read', args: { url: 'https://example.com/book' }, display: { kind: 'markdown', markdown: '已读取的示例页面原文。' }, ...overrides,
})
const message = (id: string, parts: AgentMessagePart[], overrides: Partial<AgentUIMessage> = {}): AgentUIMessage => ({ id, parts, runId: 'run', role: 'assistant', createdAt: '', ...overrides })
function Transcript({ messages, runActive = true, animate = false, live = new Set<string>(), scope = 'task-a' }: {
  messages: AgentUIMessage[]; runActive?: boolean; animate?: boolean; live?: ReadonlySet<string>; scope?: string
}) {
  const groups = projectResearchGroups(messages)
  return <div key={scope}>{messages.filter(item => item.role === 'assistant').map(item => <AgentMessageParts key={item.id} messageId={item.id}
    parts={item.parts} researchGroups={groups.get(item.id)} streaming={false} runActive={runActive} summaryExpanded animateLive={animate} liveToolCallIds={live} />)}</div>
}
const cards = (container: HTMLElement) => container.querySelectorAll('[data-agent-research-id]')

describe('ordered research lifecycle projection', () => {
  it('continues across model messages, reasoning and reworded queries without modifying canonical history', () => {
    const messages = [message('one', [search('search')]), message('thinking', [{ type: 'reasoning', text: '核对书目后读取来源。' }]),
      message('two', [search('reworded', { args: { query: '河谷纪事 官方' } })]), message('three', [page('read')])]
    const before = JSON.stringify(messages)
    const groups = projectResearchGroups(messages)
    const group = groups.get('one')!.get('search')!
    expect(group.calls.map(call => call.callId)).toEqual(['search', 'reworded', 'read'])
    expect(groups.get('three')!.get('read')).toBe(group)
    expect(JSON.stringify(messages)).toBe(before)
    expect(group.calls[0]).toBe(messages[0].parts[0])
  })

  it.each(['answer', 'non-web', 'reply-receipt', 'user', 'run', 'goal'] as const)('starts a new card after %s even for identical queries', boundary => {
    const between = boundary === 'answer' ? message('boundary', [{ type: 'text', text: '已核对第一项资料。' }])
      : boundary === 'non-web' || boundary === 'reply-receipt' ? message('boundary', [search('other', { toolName: boundary === 'non-web' ? 'chapter_read' : 'task_respond' })])
        : boundary === 'user' ? message('boundary', [{ type: 'text', text: '查询第二项。' }], { role: 'user' }) : undefined
    const messages = [message('first', [search('a')]), ...(between ? [between] : []), message('last', [search('b')], {
      ...(boundary === 'run' ? { runId: 'new-run' } : {}), ...(boundary === 'goal' ? { goalId: 'new-goal' } : {}),
    })]
    const groups = projectResearchGroups(messages)
    expect(groups.get('first')!.get('a')).not.toBe(groups.get('last')!.get('b'))
  })

  it('keeps interleaved branches independent and closes only the branch that performs a non-web action', () => {
    const messages = [message('one', [search('a', { subagentCallId: 'branch-a' }), search('b', { subagentCallId: 'branch-b' }), search('main')]),
      message('two', [page('b-read', { subagentCallId: 'branch-b' }), search('a-save', { toolName: 'research_report_save', subagentCallId: 'branch-a' }),
        page('a-next', { subagentCallId: 'branch-a' }), page('main-read')])]
    const groups = projectResearchGroups(messages), first = groups.get('one')!, second = groups.get('two')!
    expect(first.get('a')!.calls.map(call => call.callId)).toEqual(['a'])
    expect(first.get('b')!.calls.map(call => call.callId)).toEqual(['b', 'b-read'])
    expect(first.get('main')!.calls.map(call => call.callId)).toEqual(['main', 'main-read'])
    expect(second.get('a-next')).not.toBe(first.get('a'))
  })

  it('keeps a late result in its original episode and recreates the same grouping after refresh', () => {
    const initial = [message('one', [search('old', { status: 'running', display: undefined })]), message('answer', [{ type: 'text', text: '第一项答复。' }]), message('two', [search('new')])]
    const before = projectResearchGroups(initial)
    const restored = JSON.parse(JSON.stringify(initial)) as AgentUIMessage[]
    restored[0].parts = [search('old', { status: 'failed', display: undefined, summary: 'HTTP 403 provider raw error' })]
    const after = projectResearchGroups(restored)
    expect(after.get('one')!.get('old')!.id).toBe(before.get('one')!.get('old')!.id)
    expect(after.get('two')!.get('new')!.id).toBe(before.get('two')!.get('new')!.id)
    expect(after.get('two')!.get('new')!.calls.map(call => call.callId)).toEqual(['new'])
  })
})

it('updates one stable card across cross-message Search/Fetch preparation, completion and later research, preserving disclosure state', () => {
  const messages = [message('one', [search('a', { preparing: true, status: 'running', display: undefined })])]
  const view = render(<Transcript messages={messages} animate live={new Set(['a'])} />)
  const card = cards(view.container)[0]
  expect(card.getAttribute('data-agent-research-phase')).toBe('preparing')
  fireEvent.click(screen.getByRole('button', { name: /查看参考资料/ }))
  const next = [message('one', [search('a')]), message('two', [{ type: 'reasoning', text: '继续读取原页面。' }, page('b', { status: 'running', display: undefined })])]
  view.rerender(<Transcript messages={next} animate live={new Set(['b'])} />)
  expect(cards(view.container)).toHaveLength(1)
  expect(cards(view.container)[0]).toBe(card)
  expect(card.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  expect(card.textContent).toContain('正在读取')
  expect(card.querySelector('.agent-research-update')).toBeTruthy()
  const finished = [next[0], message('two', [page('b')])]
  view.rerender(<Transcript messages={finished} runActive={false} />)
  expect(cards(view.container)[0]).toBe(card)
  expect(card.getAttribute('data-agent-research-phase')).toBe('settled')
  expect(card.querySelector('.agent-tool-progress')).toBeNull()
  expect(card.querySelector('.agent-research-update')).toBeNull()
  expect(screen.getByText('查看资料内容')).toBeTruthy()
  fireEvent.click(screen.getByText('查看资料内容'))
  expect(screen.getByText('已读取的示例页面原文。')).toBeTruthy()
  view.rerender(<Transcript messages={[...finished, message('answer', [{ type: 'text', text: '第一项结论。' }]), message('later', [search('c')])]} />)
  expect(cards(view.container)).toHaveLength(2)
})

it('renders partial and all-failed research neutrally, keeping non-web terminal failures visible', () => {
  const failure = page('failed', { status: 'failed', summary: 'HTTP 403 provider secret-looking error', display: undefined })
  const view = render(<Transcript messages={[message('one', [search('good'), failure])]} />)
  expect(cards(view.container)[0].textContent).toContain('1 项资料未能获取')
  fireEvent.click(screen.getByRole('button', { name: /查看参考资料/ }))
  expect(screen.getByText('河谷纪事 · 出版信息')).toBeTruthy()
  expect(view.container.querySelector('[data-agent-call-id="failed"]')).toBeNull()
  expect(view.container.textContent).not.toContain('HTTP')
  view.rerender(<Transcript messages={[message('one', [failure, search('unavailable', { display: { kind: 'webSearch', query: '新查询', provider: 'unavailable', results: [] } })])]} />)
  const card = cards(view.container)[0]
  expect(card.getAttribute('data-agent-research-phase')).toBe('unavailable')
  expect(card.textContent).toContain('本次未取得参考资料')
  expect(card.querySelector('.agent-tool-running')).toBeNull()
  expect(card.querySelector('.text-rose-500')).toBeNull()
  view.rerender(<Transcript messages={[message('one', [failure, search('terminal', { toolName: 'chapter_write', status: 'failed', summary: '正文写入失败', display: undefined })])]} />)
  expect(screen.getByText('正文写入失败')).toBeTruthy()
})

it('does not certify zero results or unknown legacy payloads as success, or leave restored pending calls animated', () => {
  const empty = search('empty', { display: { kind: 'webSearch', query: '无结果', provider: 'fixture', results: [] } })
  expect(summarizeResearchGroup([empty], false)).toMatchObject({ status: 'unavailable', outcome: '未找到参考资料', running: false })
  const view = render(<Transcript runActive={false} messages={[message('one', [page('legacy', { display: undefined, status: 'running' })])]} />)
  expect(cards(view.container)[0].getAttribute('data-agent-research-phase')).toBe('unknown')
  expect(view.container.textContent).toContain('结果待确认')
  expect(view.container.querySelector('.agent-tool-progress')).toBeNull()
  view.rerender(<Transcript runActive={false} messages={[message('one', [page('legacy', { display: undefined, summary: '已读取页面' })])]} />)
  expect(cards(view.container)[0].getAttribute('data-agent-research-phase')).toBe('unavailable')
})

it('isolates card collapse state on task switches even when queries and call IDs match', () => {
  const messages = [message('one', [search('a')])]
  const view = render(<Transcript messages={messages} />)
  fireEvent.click(screen.getByRole('button', { name: /查看参考资料/ }))
  expect(screen.getByRole('button', { name: /查看参考资料/ }).getAttribute('aria-expanded')).toBe('true')
  view.rerender(<Transcript scope="task-b" messages={messages} />)
  expect(screen.getByRole('button', { name: /查看参考资料/ }).getAttribute('aria-expanded')).toBe('false')
})

it('groups nested research in its owning subagent card without mixing branches', () => {
  render(<Transcript messages={[message('one', [search('parent', { toolName: 'subagent_run', display: undefined }), search('a', { subagentCallId: 'parent' }),
    page('b', { subagentCallId: 'parent' }), search('main')])]} />)
  expect(screen.getAllByText('查看参考资料')).toHaveLength(2)
})

it('provides reduced-motion rules for research updates and the running indicator', () => {
  const css = readFileSync(resolve('src/features/studio/agent/components/research-card.css'), 'utf8')
  expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  expect(css).toContain('.agent-research-card .agent-tool-progress')
  expect(css).toContain('animation: none')
})

it('projects real streamed tool turns and refreshed canonical history into the same card lifecycle', () => {
  let seq = 0
  const send = (body: AgentStreamEventBody) => useAgentStore.getState().applyEvent({ ...body, runId: 'live-run', seq: ++seq, ts: '2026-10-31T00:00:00Z' })
  function LiveTranscript() {
    const messages = useAgentStore(state => state.messages)
    const phase = useAgentStore(state => state.phase)
    return <Transcript messages={messages} runActive={isRunActive(phase)} />
  }
  useAgentStore.getState().beginRun('live-run', '核对公开参考资料', 'synthetic-session')
  send({ type: 'message.start', messageId: 'one' })
  send({ type: 'tool.call', messageId: 'one', callId: 'search', toolName: 'web_search', title: '联网搜索', args: { query: '河谷纪事 作者' } })
  const view = render(<LiveTranscript />)
  const firstCard = cards(view.container)[0]
  act(() => {
    send({ type: 'tool.result', messageId: 'one', callId: 'search', toolName: 'web_search', ok: true, summary: '已取得书目信息', display: search('search').display })
    send({ type: 'message.start', messageId: 'two' })
    send({ type: 'reasoning.delta', messageId: 'two', delta: '继续核对公开页面。' })
    send({ type: 'tool.call', messageId: 'two', callId: 'read', toolName: 'web_read', title: '读取网页', args: { url: 'https://example.com/book' } })
  })
  expect(cards(view.container)).toHaveLength(1)
  expect(cards(view.container)[0]).toBe(firstCard)
  expect(firstCard.getAttribute('data-agent-research-phase')).toBe('running')
  act(() => {
    send({ type: 'tool.result', messageId: 'two', callId: 'read', toolName: 'web_read', ok: false, summary: 'HTTP 403 provider error' })
    send({ type: 'run.finished', status: 'succeeded', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, artifacts: [] })
  })
  expect(cards(view.container)[0].getAttribute('data-agent-research-phase')).toBe('settled')
  expect(view.container.textContent).toContain('1 项资料未能获取')
  const id = firstCard.getAttribute('data-agent-research-id')
  const restored = JSON.parse(JSON.stringify(useAgentStore.getState().messages)) as AgentUIMessage[]
  act(() => { useAgentStore.getState().resetRun(); useAgentStore.getState().restoreMessages(restored, 'synthetic-session') })
  expect(cards(view.container)).toHaveLength(1)
  expect(cards(view.container)[0].getAttribute('data-agent-research-id')).toBe(id)
  expect(cards(view.container)[0].getAttribute('data-agent-research-phase')).toBe('settled')
  expect(view.container.textContent).not.toContain('HTTP')
})


it('counts source and content windows as read operations without claiming distinct pages or body retrieval', () => {
  const calls = [
    page('source-read', { args: { sourceId: 'source-a' }, display: { kind: 'markdown', markdown: '来源初始读取范围。' } }),
    page('first-window', { args: { contentRef: 'content-a', revision: 2, offset: 0 }, display: { kind: 'markdown', markdown: '同一来源第一段。' } }),
    page('second-window', { args: { contentRef: 'content-a', revision: 2, offset: 6000 }, display: { kind: 'markdown', markdown: '同一来源第二段。' } }),
    page('links-window', { args: { contentRef: 'content-a', revision: 2, linksOffset: 0 }, display: { kind: 'markdown', markdown: '仅返回导航链接，本次未读取正文。' } }),
  ]
  expect(summarizeResearchGroup(calls, false).outcome).toBe('已完成 4 次资料读取')
  const view = render(<Transcript runActive={false} messages={[message('windows', calls)]} />)
  expect(view.container.textContent).not.toContain('个页面')
  fireEvent.click(screen.getByRole('button', { name: /查看参考资料/ }))
  expect(screen.getAllByText('查看资料内容')).toHaveLength(4)
  expect(screen.getByText('同一来源第一段。')).toBeTruthy()
  expect(screen.getByText('同一来源第二段。')).toBeTruthy()
  expect(screen.getByText('仅返回导航链接，本次未读取正文。')).toBeTruthy()
})
