import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import type { AgentMessagePart, AgentUIMessage } from '../../shared/contracts/index.js'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { projectResearchGroups, type ResearchCall } from '../../src/features/studio/agent/lib/research-groups'
import '../../src/index.css'

const modes = ['连续检索', '第二次查询', '并行分支', '部分不可用', '全部不可用'] as const
type Mode = typeof modes[number]
const search = (id: string, query: string, overrides: Partial<ResearchCall> = {}): ResearchCall => ({ type: 'tool-call', callId: id,
  toolName: 'web_search', title: '联网搜索', args: { query }, status: 'success',
  display: { kind: 'webSearch', query, provider: 'fixture', results: [{ title: '河谷纪事 · 公开出版目录', url: 'https://example.com/book',
    source: '示例出版机构', snippet: '这是专门用于界面回归的合成书目摘要，展示搜索证据和公开来源。' }] }, ...overrides })
const read = (id: string, overrides: Partial<ResearchCall> = {}): ResearchCall => ({ type: 'tool-call', callId: id, toolName: 'web_read', title: '读取网页',
  args: { url: 'https://example.com/book' }, status: 'success', display: { kind: 'markdown', markdown: '### 合成页面原文\n\n在河谷小城中，人物沿着旧信件寻找家族的来路。\n\n- 来源：[公开出版目录](https://example.com/book)\n- 阅读范围：本次实际取得的示例段落。' }, ...overrides })
const msg = (id: string, parts: AgentMessagePart[]): AgentUIMessage => ({ id, role: 'assistant', runId: 'synthetic-run', parts, createdAt: '' })
function fixture(mode: Mode, stage: number): AgentUIMessage[] {
  const pending = { status: 'running' as const, display: undefined }
  if (mode === '全部不可用') return [msg('one', [search('a', '河谷纪事 作者', { status: 'failed', summary: 'HTTP 403 raw provider error', display: undefined })]),
    msg('two', [read('b', { status: 'failed', summary: 'HTTP 404 upstream response', display: undefined })])]
  if (mode === '并行分支') return [msg('branches', [
    search('branch-a', '', { toolName: 'subagent_run', display: undefined }), search('branch-b', '', { toolName: 'subagent_run', display: undefined }),
    search('a-search', '河谷纪事 作者', { subagentCallId: 'branch-a' }), search('b-search', '山林手记 出版信息', { subagentCallId: 'branch-b' }),
    read('a-read', { subagentCallId: 'branch-a' }), read('b-read', { subagentCallId: 'branch-b' }),
  ])]
  const messages = [msg('one', [search('search', '河谷纪事 作者', stage === 0 ? { ...pending, preparing: true } : {})])]
  if (stage > 0) messages.push(msg('two', [{ type: 'reasoning', text: '先核对出版信息，再读取公开来源。' }, search('reworded', '河谷纪事 官方出版目录', stage === 1 ? pending : {})]))
  if (stage > 1) messages.push(msg('three', [read('read', stage === 2 ? pending : mode === '部分不可用'
    ? { status: 'failed', summary: 'HTTP 403 raw provider error', display: undefined } : {})]))
  if (stage === 3) messages.push(msg('answer', [{ type: 'text', text: '已核对可用来源，下面按实际取得的资料整理结论。' }]))
  if (mode === '第二次查询') messages.push(msg('boundary', [{ type: 'text', text: '开始核对另一项独立问题。' }]), msg('second', [search('second-search', '山林手记 出版信息'), read('second-read')]))
  return messages
}
export function Preview() {
  const [mode, setMode] = useState<Mode>('连续检索')
  const [stage, setStage] = useState(3)
  const [width, setWidth] = useState(540)
  const [scope, setScope] = useState('task-a')
  const [restore, setRestore] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const messages = useMemo(() => {
    const items = fixture(mode, stage)
    return restore ? JSON.parse(JSON.stringify(items)) as AgentUIMessage[] : items
  }, [mode, stage, restore])
  const groups = useMemo(() => projectResearchGroups(messages), [messages])
  const runActive = mode !== '全部不可用' && mode !== '并行分支' && stage < 3
  const live = new Set(messages.flatMap(message => message.parts.flatMap(part => part.type === 'tool-call' ? [part.callId] : [])))
  const buttonClass = 'rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs hover:bg-[var(--surface-muted)]'
  return <main className="studio-workspace min-h-screen p-4 text-[var(--text-primary)]">
    <nav className="mx-auto mb-8 flex max-w-4xl flex-wrap gap-2" aria-label="合成参考资料回归场景">
      {modes.map(item => <button type="button" key={item} aria-pressed={mode === item} className={buttonClass} onClick={() => { setMode(item); setStage(3) }}>{item}</button>)}
      <select aria-label="预览宽度" value={width} onChange={event => setWidth(Number(event.target.value))} className={buttonClass}>
        <option value={280}>280px 窄栏</option><option value={375}>375px 移动端</option><option value={540}>540px 工作区</option><option value={800}>800px 宽栏</option>
      </select>
      <button type="button" className={buttonClass} onClick={() => setRestore(value => value + 1)}>恢复历史负载</button>
      <button type="button" className={buttonClass} onClick={() => setScope(value => value === 'task-a' ? 'task-b' : 'task-a')}>切换任务</button>
      <button type="button" className={buttonClass} onClick={() => setCollapsed(value => !value)}>切换过程折叠</button>
    </nav>
    <div className="mx-auto mb-5 flex max-w-4xl flex-wrap gap-2">{['准备搜索', '改写检索词', '读取页面', '结束'].map((label, index) => <button type="button" key={label} className={buttonClass} aria-pressed={stage === index} onClick={() => setStage(index)}>{label}</button>)}</div>
    <p className="mx-auto mb-6 max-w-4xl text-xs text-[var(--text-secondary)]">合成数据 · {scope} · {mode} · {runActive ? '运行中' : '已结束'} · 历史恢复 {restore}</p>
    <section key={scope} style={{ width, maxWidth: '100%' }} className="mx-auto space-y-3" data-research-fixture="true">
      {messages.map(message => <AgentMessageParts key={message.id} messageId={message.id} parts={message.parts} researchGroups={groups.get(message.id)}
        runActive={runActive} streaming={false} summaryExpanded={!collapsed} animateLive={runActive} liveToolCallIds={live} />)}
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
