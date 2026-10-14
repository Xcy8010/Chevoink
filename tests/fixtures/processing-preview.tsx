import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { AgentStreamEvent } from '../../shared/contracts'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { ProcessingHint } from '../../src/features/studio/agent/components/ProcessingHint'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { useModelStageFeedback, useProcessingHint } from '../../src/features/studio/agent/useProcessingHint'
import '../../src/index.css'
const stages = ['思考流', '生成参数', '正文草稿', '实际执行', '已保存', '真实错误', '暂停', '完成']
function simulate(stage: string) {
  const store = useAgentStore.getState()
  store.resetRun()
  store.resumeRun('preview-run', 'preview-session')
  let seq = 0
  const emit = (event: Record<string, unknown>) => store.applyEvent({ runId: 'preview-run', ts: new Date().toISOString(), seq: ++seq, ...event } as AgentStreamEvent)
  const messageId = 'preview-message'
  emit({ type: 'message.start', messageId, role: 'assistant' })
  emit({ type: 'reasoning.delta', messageId, delta: '先核对上一章的人物动机，再让第二章接住尚未揭开的线索。\n\n' })
  emit({ type: 'reasoning.delta', messageId, delta: '调用 chapter_write，chapterId=cmttleebg03h9wqox9lieracs。\n\n' })
  if (stage === '思考流') return
  emit({ type: 'text.final', messageId, text: '我会承接上一章的线索，继续撰写第二章。', asReasoning: false })
  const callId = 'write-preview'
  emit({ type: 'tool.delta', messageId, callId, toolName: 'chapter_write', title: '撰写本章', argsChars: 168,
    ...(stage === '正文草稿' ? { draft: { kind: 'chapter', toolName: 'chapter_write', content: '雨声盖住了门外的脚步。她重新打开信封，终于看见最后一行字。' } } : {}) })
  if (stage === '生成参数' || stage === '正文草稿') return
  if (stage === '暂停') { emit({ type: 'run.paused', reason: 'user_stop' }); return }
  emit({ type: 'tool.call', messageId, callId, toolName: 'chapter_write', title: '撰写本章', args: {} })
  if (stage === '实际执行') return
  emit({ type: 'tool.result', messageId, callId, toolName: 'chapter_write', ok: stage !== '真实错误',
    summary: stage === '真实错误' ? '正文保存失败，请核对当前章节后继续。' : '第二章正文已保存。', durationMs: 600 })
  if (stage === '完成') emit({ type: 'run.paused', reason: 'needs_input' })
}
export function Preview() {
  const [stage, setStage] = useState('思考流')
  useEffect(() => { simulate(stage) }, [stage])
  const messages = useAgentStore(state => state.messages)
  const runId = useAgentStore(state => state.runId)
  const phase = useAgentStore(state => state.phase)
  const active = phase === 'starting' || phase === 'running'
  const visible = useProcessingHint(messages, runId, phase, false)
  const label = useModelStageFeedback(messages, runId, phase, false)
  return <main className="studio-workspace mx-auto min-h-screen max-w-3xl p-6 text-[var(--text-primary)]">
    <nav className="mb-8 flex flex-wrap gap-3">{stages.map(item => <button key={item} onClick={() => setStage(item)}>{item}</button>)}</nav>
    <p className="mb-6">继续撰写第二章 · 当前阶段：{stage}（离线模拟事件）</p>
    {messages.map(message => <AgentMessageParts key={message.id} parts={message.parts} streaming={active && stage === '思考流'} runActive={active} />)}
    <div className="mt-4"><ProcessingHint visible={visible} label={label} /></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
