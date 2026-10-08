// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentComposer } from '../../src/features/studio/agent/components/AgentComposer'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { activateComposerDraft } from '../../src/features/studio/agent/composer-drafts'
import type { AgentGoalSnapshot, AgentUIMessage } from '../../shared/contracts/index.js'

const voice = vi.hoisted(() => ({ options: undefined as undefined | { onTranscript: (text: string) => void }, state: 'idle', start: vi.fn(), cancel: vi.fn(), removeModel: vi.fn() }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ info: vi.fn() }) }))
vi.mock('../../src/features/studio/agent/hooks/useVoiceInput', () => ({ useVoiceInput: (options: { onTranscript: (text: string) => void }) => {
  voice.options = options
  return { state: voice.state, disabled: false, modelReady: true, start: voice.start, cancel: voice.cancel, removeModel: voice.removeModel }
} }))
vi.mock('../../src/features/studio/agent/components/AgentVoiceInputBar', () => ({ AgentVoiceInputBar: () => <div>正在本机转写</div> }))

function props(): Parameters<typeof AgentComposer>[0] {
  return { novelId: 'n1', voiceScopeKey: 'u:n1:t1', running: false, onSend: vi.fn(), onStop: vi.fn(), creativeFreedom: 'balanced', onCreativeFreedomChange: vi.fn(), qualityMode: 'premium', modelTier: 'speed', modelOptions: [], onModelTierChange: vi.fn(), customModels: [], customModelId: null, onCustomModelChange: vi.fn(), reasoningSelections: {}, onReasoningEffortChange: vi.fn(), onOpenModelSettings: vi.fn(), referenceOptions: [] }
}

beforeEach(() => {
  voice.state = 'idle'
  vi.clearAllMocks()
  activateComposerDraft('u:n1:t1')
  useAgentStore.setState({ composerDraft: '已有草稿', composerReferences: [], composerAttachments: [], composerUploading: 0, composerSkillIds: [], composerSubagent: null, goalMode: false })
})
afterEach(cleanup)

describe('Agent voice draft integration', () => {
  it('sends the selected helper with the request, preserves on failure and clears on success', async () => {
    useAgentStore.setState({ composerSubagent: { id: 'helper', name: '资料助手', novelId: 'n1' } })
    const input = { ...props(), onSend: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined) }
    render(<AgentComposer {...input} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })))
    expect(input.onSend).toHaveBeenCalledWith('已有草稿', [], 'balanced', 'premium', [], 'helper')
    expect(useAgentStore.getState().composerSubagent?.id).toBe('helper')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })))
    expect(useAgentStore.getState().composerSubagent).toBeNull()
  })
  it('opens goal mode from the plus menu and promotes a leading goal command safely', () => {
    useAgentStore.setState({ composerDraft: '' })
    const onGoalOpen = vi.fn()
    const input = { ...props(), goalCreationEnabled: true, onGoalOpen }
    render(<AgentComposer {...input} />)
    fireEvent.click(screen.getByLabelText('添加内容'))
    fireEvent.click(screen.getByRole('button', { name: '目标' }))
    expect(onGoalOpen).toHaveBeenCalledOnce()

    const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
    editor.textContent = '/goal 完成前三章'
    fireEvent.input(editor)
    expect(useAgentStore.getState().goalMode).toBe(true)
    expect(useAgentStore.getState().composerDraft).toBe('完成前三章')
  })
  it('hides goal creation when the capability is closed and sends /goal as ordinary text', async () => {
    useAgentStore.setState({ composerDraft: '' })
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<AgentComposer {...props()} goalCreationEnabled={false} onSend={onSend} />)
    fireEvent.click(screen.getByLabelText('添加内容'))
    expect(screen.queryByRole('button', { name: '目标' })).toBeNull()

    const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
    editor.textContent = '/goal 写三章'
    fireEvent.input(editor)
    expect(useAgentStore.getState().goalMode).toBe(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })))
    expect(onSend).toHaveBeenCalledWith('/goal 写三章', [], 'balanced', 'premium', [])
  })
  it('restores the helper per task across A→B→A without leaking selection', () => {
    useAgentStore.setState({ composerSubagent: { id: 'helper', name: '资料助手', novelId: 'n1' } })
    const input = props()
    const { rerender } = render(<AgentComposer {...input} />)
    rerender(<AgentComposer {...input} novelId="n2" voiceScopeKey="u:n2:other" />)
    expect(screen.queryByText('本轮子 Agent：资料助手')).toBeNull()
    rerender(<AgentComposer {...input} />)
    expect(screen.getByText('本轮子 Agent：资料助手')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消指定子 Agent' }))
    expect(useAgentStore.getState().composerSubagent).toBeNull()
  })
  it('distinguishes preparation from execution and settles in place', () => {
    const part = { type: 'tool-call' as const, callId: 'preview', toolName: 'chapter_write', title: '写入章节正文', args: null, status: 'running' as const, preparing: true, progressChars: 80 }
    const { container, rerender } = render(<AgentMessageParts parts={[part]} streaming runActive />)
    expect(screen.getByText('写入章节正文')).toBeTruthy()
    expect(screen.getByText('准备调用…')).toBeTruthy()
    expect(container.querySelector('.agent-tool-progress')).toBeNull()
    expect(screen.queryByText('已生成 80 字 · 执行中…')).toBeNull()
    rerender(<AgentMessageParts parts={[{ ...part, preparing: false }]} streaming runActive />)
    expect(screen.getByText('已生成 80 字 · 执行中…')).toBeTruthy()
    expect(container.querySelector('.agent-tool-progress')).toBeTruthy()
    expect(screen.queryByText('已完成')).toBeNull()
    rerender(<AgentMessageParts parts={[{ ...part, preparing: false, status: 'success', summary: '正文已写入' }]} streaming={false} runActive />)
    expect(screen.getAllByText('写入章节正文')).toHaveLength(1)
    expect(container.querySelector('.agent-tool-progress')).toBeNull()
    expect(screen.getByText('已完成')).toBeTruthy()
  })
  it.each(['', '\n', '   \n\u00a0', '\u200B\uFEFF'])('shows the placeholder for semantic blank %j', (draft) => {
    useAgentStore.setState({ composerDraft: draft })
    render(<AgentComposer {...props()} />)
    expect(screen.getByText('告诉我要做什么，我会自主完成…')).toBeTruthy()
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('allows queued sending while running; failed enqueue preserves draft and duplicate clicks do not resubmit', async () => {
    let reject!: (error: Error) => void
    const input = { ...props(), running: true, onSend: vi.fn(() => new Promise<void>((_, fail) => { reject = fail })) }
    render(<AgentComposer {...input} />)
    const button = screen.getByRole('button', { name: '加入待发队列' })
    fireEvent.click(button); fireEvent.click(button)
    expect(input.onSend).toHaveBeenCalledTimes(1)
    await act(async () => reject(new Error('offline')))
    expect(useAgentStore.getState().composerDraft).toBe('已有草稿')
    expect(input.onStop).not.toHaveBeenCalled()
  })
  it('IME Enter never sends a queued requirement', () => {
    const input = { ...props(), running: true }
    render(<AgentComposer {...input} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true })
    expect(input.onSend).not.toHaveBeenCalled()
  })
  it('streaming prose never renders a blinking cursor even before a tool card arrives', () => {
    const { container } = render(<AgentMessageParts parts={[{ type: 'text', text: '参数简化后继续。' }]} streaming runActive />)
    expect(container.querySelector('p')?.textContent).toBe('参数简化后继续。')
    expect(container.querySelector('p span')).toBeNull()
  })
  it('empty resumable composer uses play, deduplicates clicks and switches to stop when running', async () => {
    useAgentStore.setState({ composerDraft: '' })
    let finish!: () => void
    const onContinue = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const input = { ...props(), onContinue }
    const { rerender } = render(<AgentComposer {...input} />)
    const play = screen.getByRole('button', { name: '继续运行' })
    fireEvent.click(play)
    fireEvent.click(play)
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    await act(async () => finish())
    rerender(<AgentComposer {...input} running />)
    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy()
  })
  it('a new draft takes priority over resume and is never discarded', async () => {
    const input = { ...props(), onContinue: vi.fn(async () => {}) }
    render(<AgentComposer {...input} />)
    expect(screen.queryByRole('button', { name: '继续运行' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' })))
    expect(input.onContinue).not.toHaveBeenCalled()
    expect(input.onSend).toHaveBeenCalled()
  })
  it('continues an edited paused goal without resending its objective, clearing the draft state or replacing saved messages', async () => {
    const goal: AgentGoalSnapshot = { id: 'goal', sessionId: 'session', novelId: 'n1', objective: '修订后的目标', revision: 2, pendingRevision: null,
      status: 'paused', phase: 'idle', stateVersion: 7, currentRunId: 'saved-run', reasonCode: 'AUTHOR_PAUSED', tokenLimit: '50000', tokensUsed: '1200',
      tokensReserved: '0', creditsUsedMicros: '3000', activeTimeMs: '120000', activeTimeLimitMs: '3600000', activeSince: null,
      serverTime: '', createdAt: '', updatedAt: '', finishedAt: null }
    const messages: AgentUIMessage[] = [
      { id: 'author', role: 'user', runId: 'saved-run', goalId: 'goal', createdAt: '', parts: [{ type: 'text', text: '原目标' }] },
      { id: 'saved', role: 'assistant', runId: 'saved-run', goalId: 'goal', createdAt: '', parts: [{ type: 'text', text: '已保存第一章' }] },
    ]
    useAgentStore.setState({ composerDraft: '', composerSkillIds: ['selected'], goalMode: false, goal, messages })
    const input = { ...props(), goalActive: true, onContinue: vi.fn().mockResolvedValue(undefined), onGoalSubmit: vi.fn() }
    render(<AgentComposer {...input} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '继续运行' })))
    expect(input.onContinue).toHaveBeenCalledOnce()
    expect(input.onContinue.mock.calls[0]).toEqual([])
    expect(input.onSend).not.toHaveBeenCalled()
    expect(input.onGoalSubmit).not.toHaveBeenCalled()
    expect(useAgentStore.getState()).toMatchObject({ composerDraft: '', composerSkillIds: ['selected'], goalMode: false, goal, messages })
    expect(useAgentStore.getState().messages).toBe(messages)
    expect(screen.getByRole('textbox', { name: 'Agent 提示词' }).textContent).toBe('')
  })
  it('only inserts a transcript into the draft and never sends', () => {
    const input = props()
    render(<AgentComposer {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    act(() => voice.options?.onTranscript('，续写下一章'))
    expect(useAgentStore.getState().composerDraft).toBe('已有草稿，续写下一章')
    expect(input.onSend).not.toHaveBeenCalled()
    expect(screen.queryByText('已转写，请检查后发送')).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Agent 提示词' }), { key: 'z', ctrlKey: true })
    expect(useAgentStore.getState().composerDraft).toBe('已有草稿')
  })
  it('does not overwrite concurrent edits and asks to append', () => {
    render(<AgentComposer {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    act(() => useAgentStore.setState({ composerDraft: '其他操作更新' }))
    act(() => voice.options?.onTranscript('语音'))
    expect(useAgentStore.getState().composerDraft).toBe('其他操作更新')
    fireEvent.click(screen.getByRole('button', { name: '插入到末尾' }))
    expect(useAgentStore.getState().composerDraft).toBe('其他操作更新语音')
  })
  it('ignores a result after changing task windows within the same novel', () => {
    const input = props()
    const { rerender } = render(<AgentComposer {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    rerender(<AgentComposer {...input} voiceScopeKey="u:n1:t2" />)
    act(() => voice.options?.onTranscript('上个窗口的录音'))
    expect(useAgentStore.getState().composerDraft).toBe('')
    rerender(<AgentComposer {...input} />)
    expect(useAgentStore.getState().composerDraft).toBe('已有草稿')
  })
  it('locks editing and Enter sending while voice is active', () => {
    voice.state = 'transcribing'
    const input = props()
    render(<AgentComposer {...input} />)
    const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
    expect(editor.getAttribute('contenteditable')).toBe('false')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(input.onSend).not.toHaveBeenCalled()
    expect(input.onStop).not.toHaveBeenCalled()
  })
  it('retains the draft when starting the Agent fails', async () => {
    const input = props()
    input.onSend = vi.fn().mockRejectedValue(new Error('offline'))
    render(<AgentComposer {...input} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })) })
    expect(useAgentStore.getState().composerDraft).toBe('已有草稿')
  })
})
