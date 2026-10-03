// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AgentComposer } from '../../src/features/studio/agent/components/AgentComposer'
import { findComposerSlashToken } from '../../src/features/studio/agent/components/composer-slash'
import { useAgentStore, type ComposerReference } from '../../src/features/studio/agent/agentStore'
import { activateComposerDraft } from '../../src/features/studio/agent/composer-drafts'
import type { AgentSkillListItem, AgentSubtaskView } from '../../shared/contracts/index'
import type { AgentGoalSnapshot } from '../../shared/contracts/agent-goal'

const mocks = vi.hoisted(() => ({ fetchSubtasks: vi.fn(), upload: vi.fn(), voiceState: 'idle' }))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ info: vi.fn() }) }))
vi.mock('../../src/features/studio/agent/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: mocks.voiceState, disabled: false, modelReady: true, start: vi.fn(), cancel: vi.fn(), removeModel: vi.fn() }) }))
vi.mock('../../src/features/studio/components/StyleLearningDialog', () => ({ default: () => <div role="dialog" aria-label="样章学习与写作风格" /> }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({ fetchAgentSubtasks: mocks.fetchSubtasks, uploadAgentAttachment: mocks.upload }))

function props(): Parameters<typeof AgentComposer>[0] {
  return { novelId: 'n1', voiceScopeKey: 'slash:n1:a', running: false, onSend: vi.fn(), onStop: vi.fn(), creativeFreedom: 'balanced', onCreativeFreedomChange: vi.fn(), qualityMode: 'premium', modelTier: 'speed', modelOptions: [], onModelTierChange: vi.fn(), customModels: [], customModelId: null, onCustomModelChange: vi.fn(), reasoningSelections: {}, onReasoningEffortChange: vi.fn(), onOpenModelSettings: vi.fn(), referenceOptions: [] }
}
const skill = (id = 'skill'): AgentSkillListItem => ({ id, name: `技能 ${id}`, description: '说明', source: 'user', license: '', status: 'active', defaultVersion: '1', activeVersion: '1', enabled: true, phases: ['draft'], triggerLabels: [], negativeTriggerLabels: [], tokenBudget: 100, priority: 1, lastUsedAt: null, usageCount: 0, versions: [], canEdit: true, latestAudit: null })
const reference: ComposerReference = { id: 'plan:one', kind: 'plan', name: '大纲', text: '引用正文', startLine: 1, endLine: 1, offset: 0 }
const subagent: AgentSubtaskView = { id: 'helper', novelId: 'n1', parentSessionId: null, childSessionId: null, childRunId: null, name: '资料助手', role: 'research', triggerCondition: '查资料', callableBy: 'main_and_subagents', prompt: '', tokenBudget: 100, status: 'idle', enabled: true, runCount: 0, lastRunAt: null, createdAt: '', updatedAt: '' }
const activeGoal: AgentGoalSnapshot = { id: 'g1', sessionId: 's1', novelId: 'n1', objective: '继续写作', revision: 1, pendingRevision: null, status: 'active', phase: 'executing', stateVersion: 4, currentRunId: 'run1', reasonCode: null, tokenLimit: '100', tokensUsed: '1', tokensReserved: '1', creditsUsedMicros: '1', activeTimeMs: '1', activeTimeLimitMs: '100', activeSince: null, serverTime: '', createdAt: '', updatedAt: '', finishedAt: null }

function editor() { return screen.getByRole('textbox', { name: 'Agent 提示词' }) }
function caret(node: Node, offset: number) {
  editor().focus()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}
function typeDraft(text: string, offset = text.length) {
  editor().textContent = text
  caret(editor().firstChild!, offset)
  fireEvent.input(editor())
}
function card() { return screen.getByRole('listbox', { name: '工具' }) }
function choose(label: string) { fireEvent.click(within(card()).getByRole('option', { name: new RegExp(label) })) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.voiceState = 'idle'
  mocks.fetchSubtasks.mockResolvedValue({ items: [subagent, { ...subagent, id: 'off', name: '已关闭助手', enabled: false }] })
  activateComposerDraft('slash:n1:a')
  useAgentStore.setState({ composerDraft: '', composerReferences: [], composerAttachments: [], composerUploading: 0, composerSkillIds: [], composerSubagent: null, goalMode: false, goal: null, runId: null })
})
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })

describe('composer slash menu', () => {
  it('matches plus entries, wording and capability gating, within a bounded full-width card', () => {
    const input = { ...props(), goalCreationEnabled: true, skills: [skill()] }
    const view = render(<AgentComposer {...input} />)
    typeDraft('/')
    const slashLabels = within(card()).getAllByRole('option').map(item => item.textContent)
    expect(slashLabels.map(label => label?.replace(/PNG.*|PDF.*|查看.*|点选.*|选择后.*|不选时.*/g, ''))).toEqual(['上传图片', '上传文件', '样章学习与写作风格', '目标', '引用作品内容', '指定子 Agent', '技能'])
    expect(card().className).toContain('left-0 right-0')
    expect(card().className).toContain('bottom-full')
    expect(card().className).toContain('60dvh')
    expect(card().className).toContain('[scrollbar-width:none]')
    fireEvent.click(screen.getByLabelText('添加内容'))
    const plus = screen.getByLabelText('添加内容').parentElement!
    expect(within(plus).getAllByRole('button', { hidden: true }).map(item => item.textContent)).toEqual(slashLabels)
    view.rerender(<AgentComposer {...input} goalCreationEnabled={false} skills={[]} />)
    typeDraft('/')
    expect(within(card()).queryByRole('option', { name: '目标' })).toBeNull()
    expect(within(card()).queryByRole('option', { name: /^技能/ })).toBeNull()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it.each(['https://a.test/path', '目录/文件', '/usr/local/bin', '//', '/unknown', '/goal pause', '/目标 暂停'])('leaves ordinary or goal token %s unchanged', text => {
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft(text)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useAgentStore.getState().composerDraft).toBe(text)
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it.each([
    ['说明："请用 /file"', 11],
    ['说明：“请用 /file”', 11],
    ['说明：\'请用 /file\'', 11],
    ['说明：`请用 /file`', 11],
    ['```\n/file\n```', 9],
    ['~~~\n/file\n~~~', 9],
  ] as const)('preserves quoted and code prose %s with the caret inside the command', (text, offset) => {
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft(text, offset)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(useAgentStore.getState().composerDraft).toBe(text)
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('consumes the command without swallowing a following closing delimiter', () => {
    render(<AgentComposer {...props()} />)
    const files = document.querySelector<HTMLInputElement>('input[accept=".pdf,.docx,.txt,.md,.zip,.doc"]')!
    vi.spyOn(files, 'click').mockImplementation(() => {})
    typeDraft('说明 /file）后文', 6)
    choose('上传文件')
    expect(useAgentStore.getState().composerDraft).toBe('说明 ）后文')
  })

  it('filters by Chinese and English aliases and routes keyboard selection without sending', () => {
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft('/上传')
    expect(within(card()).getAllByRole('option')).toHaveLength(2)
    const files = document.querySelector<HTMLInputElement>('input[accept=".pdf,.docx,.txt,.md,.zip,.doc"]')!
    const click = vi.spyOn(files, 'click').mockImplementation(() => {})
    fireEvent.keyDown(editor(), { key: 'ArrowDown' })
    expect(editor().getAttribute('aria-activedescendant')).toContain('-file')
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(editor(), { key: 'Enter', altKey: true })
    expect(input.onSend).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(click).toHaveBeenCalledOnce()
    expect(useAgentStore.getState().composerDraft).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.onSend).not.toHaveBeenCalled()
    typeDraft('/style')
    fireEvent.keyDown(editor(), { key: 'ArrowUp' })
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: '样章学习与写作风格' })).toBeTruthy()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('wraps Up/Down, skips exhausted attachments, and does not consume a disabled click', () => {
    useAgentStore.setState({ composerAttachments: Array.from({ length: 6 }, (_, i) => ({ id: `img${i}`, kind: 'image', name: '图', url: '' })) })
    render(<AgentComposer {...props()} />)
    typeDraft('/')
    const image = within(card()).getByRole('option', { name: /上传图片/ }) as HTMLButtonElement
    expect(image.disabled).toBe(true)
    expect(editor().getAttribute('aria-activedescendant')).toContain('-file')
    fireEvent.click(image)
    expect(useAgentStore.getState().composerDraft).toBe('/')
    fireEvent.keyDown(editor(), { key: 'ArrowUp' })
    expect(editor().getAttribute('aria-activedescendant')).toContain('-subagent')
    fireEvent.keyDown(editor(), { key: 'ArrowDown' })
    expect(editor().getAttribute('aria-activedescendant')).toContain('-file')
  })

  it('never sends Enter when every filtered attachment action is disabled', () => {
    const input = props()
    useAgentStore.setState({ composerAttachments: Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, kind: 'file', name: '文', url: '' })) })
    render(<AgentComposer {...input} />)
    typeDraft('/file')
    expect((within(card()).getByRole('option') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(useAgentStore.getState().composerDraft).toBe('/file')
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('consumes only the token at the caret and preserves surrounding draft, chips and caret identity', () => {
    const input = { ...props(), goalCreationEnabled: true, onGoalOpen: vi.fn() }
    useAgentStore.setState({ composerDraft: '前文 /目 后文', composerReferences: [{ ...reference, offset: 3 }, { ...reference, id: 'plan:two', name: '第二纲', offset: 6 }] })
    render(<AgentComposer {...input} />)
    const originalEditor = editor()
    const texts = Array.from(editor().childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
    caret(texts[1], 2)
    fireEvent.input(editor())
    choose('目标')
    expect(useAgentStore.getState().composerDraft).toBe('前文  后文')
    expect(useAgentStore.getState().composerReferences.map(item => [item.id, item.offset])).toEqual([['plan:one', 3], ['plan:two', 4]])
    expect(editor()).toBe(originalEditor)
    expect(editor().querySelectorAll('[data-composer-reference]')).toHaveLength(2)
    expect(document.activeElement).toBe(editor())
    const selection = window.getSelection()!
    const prefix = selection.getRangeAt(0).cloneRange()
    prefix.setStart(editor(), 0)
    expect(prefix.cloneContents().querySelector('[data-composer-reference]')?.getAttribute('data-composer-reference')).toBe('plan:one')
    expect(input.onGoalOpen).toHaveBeenCalledOnce()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('rejects a token split by an atomic reference and an expanded selection', () => {
    useAgentStore.setState({ composerDraft: '/文件', composerReferences: [{ ...reference, offset: 1 }] })
    render(<AgentComposer {...props()} />)
    const last = editor().lastChild!
    caret(last, 2)
    fireEvent.input(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
    typeDraft('/')
    const range = document.createRange()
    range.selectNodeContents(editor())
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.click(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps goal commands in the existing parser and routes creation through the same callback', () => {
    const input = { ...props(), goalCreationEnabled: true, onGoalOpen: vi.fn() }
    render(<AgentComposer {...input} />)
    typeDraft('/目')
    choose('目标')
    expect(input.onGoalOpen).toHaveBeenCalledOnce()
    expect(useAgentStore.getState().composerDraft).toBe('')
    typeDraft('/goal 完成前三章')
    expect(useAgentStore.getState().goalMode).toBe(true)
    expect(useAgentStore.getState().composerDraft).toBe('完成前三章')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('defers IME filtering until composition ends and preserves composition Enter', () => {
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft('/')
    fireEvent.compositionStart(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
    typeDraft('/文件')
    fireEvent.keyDown(editor(), { key: 'Enter' })
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 229 })
    expect(input.onSend).not.toHaveBeenCalled()
    expect(useAgentStore.getState().composerDraft).toBe('/文件')
    fireEvent.compositionEnd(editor())
    expect(within(card()).getAllByRole('option')).toHaveLength(1)
  })

  it('handles plaintext paste, Shift+Enter newline and Escape without accidental sends', () => {
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft('前文 ')
    fireEvent.paste(editor(), { clipboardData: { items: [], getData: () => '/文件' } })
    expect(card()).toBeTruthy()
    fireEvent.keyDown(editor(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
    typeDraft('/')
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })
    expect(useAgentStore.getState().composerDraft).toBe('/\n')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('reopens a dismissed slash after deleting and retyping it, while unchanged clicks remain dismissed', () => {
    render(<AgentComposer {...props()} />)
    typeDraft('/')
    fireEvent.keyDown(editor(), { key: 'Escape' })
    fireEvent.click(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
    editor().textContent = ''
    caret(editor(), 0)
    fireEvent.input(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
    typeDraft('/')
    expect(card()).toBeTruthy()
    fireEvent.keyDown(editor(), { key: 'Escape' })
    fireEvent.click(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens reference submenu in the same card and uses the existing chip insertion workflow', () => {
    const input = { ...props(), referenceOptions: [reference] }
    render(<AgentComposer {...input} />)
    typeDraft('/引用')
    choose('引用作品内容')
    const submenu = screen.getByRole('region', { name: '工具' })
    expect(submenu.className).toContain('left-0 right-0')
    fireEvent.change(screen.getByPlaceholderText('搜索章节或计划'), { target: { value: '大纲' } })
    fireEvent.click(within(submenu).getByRole('button', { name: '计划大纲' }))
    expect(useAgentStore.getState().composerReferences).toEqual([{ ...reference, offset: 0 }])
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('moves keyboard focus into reference search, reaches results by Tab and restores the consumed-token caret on Escape', async () => {
    const user = userEvent.setup()
    render(<AgentComposer {...props()} referenceOptions={[reference]} />)
    typeDraft('前文 /引用 后文', 6)
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByPlaceholderText('搜索章节或计划'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '计划大纲' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
    expect(document.activeElement).toBe(editor())
    expect(window.getSelection()?.anchorOffset).toBe(3)
    expect(useAgentStore.getState().composerDraft).toBe('前文  后文')
  })

  it('moves keyboard focus to skill choices and keeps selection reachable by Enter', async () => {
    const user = userEvent.setup()
    const input = { ...props(), skills: [skill('one')] }
    render(<AgentComposer {...input} />)
    typeDraft('/技能')
    fireEvent.keyDown(editor(), { key: 'Enter' })
    const child = within(screen.getByRole('region', { name: '工具' })).getByRole('button', { name: /技能 one/ })
    expect(document.activeElement).toBe(child)
    await user.keyboard('{Enter}')
    expect(useAgentStore.getState().composerSkillIds).toEqual(['one'])
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(editor())
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('preserves existing pinned-skill limit and routes manager through the existing callback', () => {
    const input = { ...props(), skills: ['1', '2', '3', '4'].map(id => skill(id)), onOpenSkillManager: vi.fn() }
    render(<AgentComposer {...input} />)
    typeDraft('/技能')
    choose('技能')
    const submenu = screen.getByRole('region', { name: '工具' })
    for (const id of ['1', '2', '3', '4']) fireEvent.click(within(submenu).getByRole('button', { name: new RegExp(`技能 ${id}`) }))
    expect(useAgentStore.getState().composerSkillIds).toHaveLength(3)
    expect(input.onSend).not.toHaveBeenCalled()
    fireEvent.click(within(submenu).getByRole('button', { name: /管理技能/ }))
    expect(input.onOpenSkillManager).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
  })

  it('loads subagents once, filters disabled templates, and pins without immediate execution', async () => {
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft('/agent')
    choose('指定子 Agent')
    await act(async () => {})
    expect(mocks.fetchSubtasks).toHaveBeenCalledExactlyOnceWith('n1')
    const submenu = screen.getByRole('region', { name: '工具' })
    expect(within(submenu).queryByText('已关闭助手')).toBeNull()
    fireEvent.click(within(submenu).getByRole('button', { name: /资料助手/ }))
    expect(useAgentStore.getState().composerSubagent).toEqual({ id: 'helper', name: '资料助手', novelId: 'n1' })
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('moves keyboard focus from the loading card to the first loaded subagent and selects by Enter', async () => {
    const user = userEvent.setup()
    const input = props()
    render(<AgentComposer {...input} />)
    typeDraft('/agent')
    fireEvent.keyDown(editor(), { key: 'Enter' })
    await act(async () => {})
    expect(document.activeElement).toBe(within(screen.getByRole('region', { name: '工具' })).getByRole('button', { name: /资料助手/ }))
    await user.keyboard('{Enter}')
    expect(useAgentStore.getState().composerSubagent?.id).toBe('helper')
    expect(document.activeElement).toBe(editor())
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('keeps focus outside when the user leaves a loading subagent card before the response arrives', async () => {
    const user = userEvent.setup()
    let resolve!: (result: { items: AgentSubtaskView[] }) => void
    mocks.fetchSubtasks.mockReturnValueOnce(new Promise<{ items: AgentSubtaskView[] }>(done => { resolve = done }))
    render(<><button type="button">外部操作</button><AgentComposer {...props()} /></>)
    typeDraft('/agent')
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '工具' }))
    await user.tab({ shift: true })
    const outside = screen.getByRole('button', { name: '外部操作' })
    expect(document.activeElement).toBe(outside)
    await act(async () => resolve({ items: [subagent] }))
    expect(screen.getByRole('button', { name: /资料助手/ })).toBeTruthy()
    expect(document.activeElement).toBe(outside)
    expect(mocks.fetchSubtasks).toHaveBeenCalledOnce()
  })

  it('clears nested state on outside dismissal so the next plus menu starts collapsed', () => {
    render(<AgentComposer {...props()} referenceOptions={[reference]} skills={[skill()]} />)
    typeDraft('/引用')
    choose('引用作品内容')
    fireEvent.change(screen.getByPlaceholderText('搜索章节或计划'), { target: { value: '旧搜索' } })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
    fireEvent.click(screen.getByLabelText('添加内容'))
    expect(screen.queryByPlaceholderText('搜索章节或计划')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /引用作品内容/ }))
    expect((screen.getByPlaceholderText('搜索章节或计划') as HTMLInputElement).value).toBe('')
    fireEvent.pointerDown(screen.getByPlaceholderText('搜索章节或计划'))
    expect(screen.getByPlaceholderText('搜索章节或计划')).toBeTruthy()
  })

  it('dismisses on outside pointer, Escape from submenu search, edit locks and scope A→B→A', () => {
    const input = { ...props(), referenceOptions: [reference] }
    const view = render(<AgentComposer {...input} />)
    typeDraft('/')
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(editor())
    expect(screen.queryByRole('listbox')).toBeNull()
    typeDraft('/引用')
    choose('引用作品内容')
    fireEvent.keyDown(screen.getByPlaceholderText('搜索章节或计划'), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
    typeDraft('/')
    view.rerender(<AgentComposer {...input} disabled />)
    expect(screen.queryByRole('listbox')).toBeNull()
    view.rerender(<AgentComposer {...input} />)
    expect(screen.queryByRole('listbox')).toBeNull()
    typeDraft('/文件')
    view.rerender(<AgentComposer {...input} voiceScopeKey="slash:n1:b" />)
    expect(useAgentStore.getState().composerDraft).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
    view.rerender(<AgentComposer {...input} />)
    expect(useAgentStore.getState().composerDraft).toBe('/文件')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('region', { name: '工具' })).toBeNull()
  })
})

describe('local goal draft mode exit', () => {
  it('exits while goal is running and server busy, preserves the live goal and queues an ordinary draft', async () => {
    const attachment = { id: 'f1', kind: 'file' as const, name: '资料', url: '' }
    useAgentStore.setState({ composerDraft: '普通补充', composerReferences: [reference], composerAttachments: [attachment], goalMode: true, goal: activeGoal, runId: 'run1' })
    const input = { ...props(), running: true, goalActive: true, goalBusy: true, onSend: vi.fn().mockResolvedValue(undefined), onGoalSubmit: vi.fn(), onGoalCommand: vi.fn() }
    render(<AgentComposer {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '取消目标模式' }))
    expect(useAgentStore.getState()).toMatchObject({ goalMode: false, goal: activeGoal, runId: 'run1', composerDraft: '普通补充', composerReferences: [reference], composerAttachments: [attachment] })
    expect(document.querySelector('.agent-composer-goal')).toBeNull()
    expect(screen.queryByRole('button', { name: '取消目标模式' })).toBeNull()
    expect(input.onSend).not.toHaveBeenCalled()
    expect(input.onGoalSubmit).not.toHaveBeenCalled()
    expect(input.onGoalCommand).not.toHaveBeenCalled()
    expect(input.onStop).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '加入待发队列' })))
    expect(input.onSend).toHaveBeenCalledOnce()
    expect(input.onSend.mock.calls[0][0]).toContain('普通补充')
    expect(input.onSend.mock.calls[0][1]).toEqual([attachment])
    expect(useAgentStore.getState().goal).toBe(activeGoal)
    expect(useAgentStore.getState().runId).toBe('run1')
    expect(input.onGoalSubmit).not.toHaveBeenCalled()
  })

  it('restores local goal draft mode A→B→A independently of an active goal', () => {
    useAgentStore.setState({ composerDraft: 'A 草稿', goalMode: true, goal: activeGoal, runId: 'run1' })
    const input = { ...props(), running: true, goalActive: true }
    const view = render(<AgentComposer {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '取消目标模式' }))
    view.rerender(<AgentComposer {...input} voiceScopeKey="slash:n1:b" />)
    act(() => useAgentStore.getState().setGoalMode(true))
    view.rerender(<AgentComposer {...input} />)
    expect(useAgentStore.getState().goalMode).toBe(false)
    expect(useAgentStore.getState().composerDraft).toBe('A 草稿')
    expect(screen.queryByRole('button', { name: '取消目标模式' })).toBeNull()
    view.rerender(<AgentComposer {...input} voiceScopeKey="slash:n1:b" />)
    expect(useAgentStore.getState().goalMode).toBe(true)
    expect(screen.getByRole('button', { name: '取消目标模式' })).toBeTruthy()
    expect(useAgentStore.getState().goal).toBe(activeGoal)
    expect(input.onStop).not.toHaveBeenCalled()
  })
})

it('detects complete caret tokens while reserving exact goal aliases', () => {
  expect(findComposerSlashToken('前 /文件 后', 4)).toEqual({ start: 2, end: 5, query: '文' })
  expect(findComposerSlashToken('/goal', 2)).toBeNull()
  expect(findComposerSlashToken('/目标', 2)).toBeNull()
  expect(findComposerSlashToken('path/file', 9)).toBeNull()
  const longPrefix = '长段落'.repeat(14000)
  const longDraft = `${longPrefix} /file`
  expect(findComposerSlashToken(longDraft, longDraft.length)).toEqual({ start: longPrefix.length + 1, end: longDraft.length, query: 'file' })
  const quotedDraft = `${longPrefix} “引用 /file”`
  expect(findComposerSlashToken(quotedDraft, quotedDraft.length - 1)).toBeNull()
})
