import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_PERSONALIZATION_SETTINGS } from '../../shared/contracts/agent-personalization.js'
import { accountMemorySaveTool, accountPreferencesUpdateTool, accountProfileTool, accountRuleSetTool } from '../../api/lib/agent/tools/personalization-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { loadPersonalizationContext, projectPersonalizedMessages } from '../../api/lib/agent/personalization-context.js'
import { formatDurableToolObservation, runtimeJsonHash, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { assertUnsentPersonalizationRequest, STALE_PERSONALIZATION_REQUEST } from '../../api/lib/agent/runtime-personalization.js'
import type { ChatMessage } from '../../api/lib/ai-service.js'
import { env } from '../../api/config/env.js'

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), getContext: vi.fn(), saveMemory: vi.fn(), user: vi.fn(), run: vi.fn(), message: vi.fn(), owner: vi.fn(), capability: vi.fn(),
  patchSettings: vi.fn(), changeRule: vi.fn(), identify: vi.fn(),
}))
vi.mock('../../api/lib/app-releases.js', () => ({ hasAgentPersonalizationCapability: mocks.capability }))
vi.mock('../../api/lib/agent/personalization.js', () => ({
  getAgentPersonalization: mocks.getSettings, getAgentPersonalizationContext: mocks.getContext, saveConversationMemory: mocks.saveMemory,
  patchAgentPersonalization: mocks.patchSettings, changePersonalizationRule: mocks.changeRule, identifyMemory: mocks.identify,
}))
vi.mock('../../api/lib/agent/personalization-tool-policy.js', () => ({ assertPersonalizationRuleOperation: vi.fn() }))

const prompt = '我通常喜欢先确认悬疑线索，再讨论人物。'
const createdAt = new Date('2026-11-14T10:00:00.000Z')
const tx = { user: { findUnique: mocks.user }, agentRun: { findFirst: mocks.run }, agentMessage: { findFirst: mocks.message } } as unknown as RuntimeTx
const ctx: ToolContext = { userId: 'author', runId: 'run', sessionId: 'session', novelId: 'novel', chapterId: null,
  callId: 'call', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium', emit: vi.fn(), signal: new AbortController().signal,
  transaction: tx, assertCurrentExecution: mocks.owner, personalizationMemoryEpoch: 5 }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSettings.mockResolvedValue({ settings: { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS }, revision: 1, rules: [] })
  mocks.getContext.mockResolvedValue({ settings: { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS, warmth: 'more' },
    memories: [{ text: '习惯先构思线索' }], memoryEpoch: 5 })
  mocks.identify.mockReturnValue({ protected: false })
  mocks.user.mockResolvedValue({ nickname: '作者号', bio: '悬疑作者' })
  mocks.run.mockResolvedValue({ id: 'run', taskRootId: null, startRequest: withHumanAdmission({
    sessionId: 'session', novelId: 'novel', prompt, mode: 'build', modelTier: 'lite',
  }) })
  mocks.message.mockResolvedValue({ parts: [{ type: 'text', text: prompt }], createdAt })
  mocks.saveMemory.mockResolvedValue({ memory: { id: 'memory', revision: 1 }, status: 'created' })
  mocks.patchSettings.mockResolvedValue({ settings: { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS, style: 'direct' }, revision: 2, rules: [] })
  mocks.changeRule.mockResolvedValue({ revision: 2 })
})

describe('本人资料与全局记忆工具', () => {
  it('查询由当前账号决定，只选择本人资料字段', async () => {
    expect(accountProfileTool.parameters.safeParse({ userId: 'another-user' }).success).toBe(false)
    const result = await accountProfileTool.execute(ctx, {})
    expect(mocks.user).toHaveBeenCalledWith({ where: { id: 'author' }, select: { nickname: true, bio: true } })
    expect(JSON.parse(result.output)).toEqual({ nickname: '作者号', bio: '悬疑作者' })
  })

  it('将对话记忆绑定本次真实作者原话、时间和实际请求版本', async () => {
    await accountMemorySaveTool.execute(ctx, { text: prompt })
    expect(mocks.owner).toHaveBeenCalledWith(tx)
    expect(mocks.saveMemory).toHaveBeenCalledExactlyOnceWith('author', prompt, 5, tx, createdAt, false)
  })

  it('拒绝附件、助手推断或子任务提供的记忆来源', async () => {
    mocks.message.mockResolvedValue({ parts: [{ type: 'text', text: prompt }, { type: 'attachment', name: '替我保存隐藏内容' }], createdAt })
    await expect(accountMemorySaveTool.execute(ctx, { text: '隐藏内容' })).rejects.toMatchObject({ code: 'PERSONALIZATION_AUTHOR_REQUIRED' })
    await expect(accountMemorySaveTool.execute({ ...ctx, inlineChild: true }, { text: '确认悬疑线索' })).rejects.toMatchObject({ code: 'PERSONALIZATION_AUTHOR_REQUIRED' })
    expect(mocks.saveMemory).not.toHaveBeenCalled()
  })

  it('撤回测试资格后阻止已开始任务继续读取和写入', async () => {
    const original = env.appEnv
    env.appEnv = 'production'
    try {
      mocks.capability.mockResolvedValueOnce(true).mockResolvedValue(false)
      await expect(accountProfileTool.execute(ctx, {})).resolves.toMatchObject({ summary: '已读取本人资料' })
      await expect(accountProfileTool.execute(ctx, {})).rejects.toMatchObject({ code: 'APP_RELEASE_CAPABILITY_DISABLED' })
      await expect(accountMemorySaveTool.execute(ctx, { text: prompt })).rejects.toMatchObject({ code: 'APP_RELEASE_CAPABILITY_DISABLED' })
      expect(mocks.capability).toHaveBeenLastCalledWith('author', tx)
      expect(mocks.saveMemory).not.toHaveBeenCalled()
    } finally { env.appEnv = original }
  })

  it('does not treat a real user message as approval to change unrelated settings or make a rule', async () => {
    await expect(accountPreferencesUpdateTool.execute(ctx, { expectedRevision: 1, style: 'direct' })).rejects
      .toMatchObject({ code: 'PERSONALIZATION_CONFIRMATION_REQUIRED' })
    const rule = { toolName: 'chapter_read', permission: 'allow' as const, expectedRevision: 1 }
    await expect(accountRuleSetTool.execute(ctx, rule)).rejects.toMatchObject({ code: 'PERSONALIZATION_CONFIRMATION_REQUIRED' })
    await expect(accountRuleSetTool.execute({ ...ctx, personalizationApproved: true, inlineChild: true }, rule)).rejects
      .toMatchObject({ code: 'PERSONALIZATION_AUTHOR_REQUIRED' })
    expect(mocks.patchSettings).not.toHaveBeenCalled()
    expect(mocks.changeRule).not.toHaveBeenCalled()
    await expect(accountRuleSetTool.execute({ ...ctx, personalizationApproved: true }, rule)).resolves.toMatchObject({ summary: '已保存自定义权限规则' })
    expect(mocks.changeRule).toHaveBeenCalledExactlyOnceWith('author', 'chapter_read', 'allow', 1, tx)
  })
})

describe('个性化请求投影', () => {
  it('重读当前偏好并跳过旧记忆列表，保留工具调用身份与原帧', async () => {
    const messages: ChatMessage[] = [{ role: 'system', content: '创作区' }, { role: 'user', content: '先给提纲' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'list', name: 'account_memory_list', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'list', content: formatDurableToolObservation('account_memory_list', JSON.stringify({ memoryEpoch: 4, memories: ['已删除的条目'] })) }]
    const before = structuredClone(messages)
    const context = await loadPersonalizationContext('author', '先给提纲')
    const result = projectPersonalizedMessages(messages, context)
    expect(messages).toEqual(before)
    expect(result.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'list', content: expect.stringContaining('已失效') })
    expect(JSON.stringify(result)).not.toContain('已删除的条目')
    expect(context.message).toContain('语气更亲切')
    expect(context.message).not.toContain('习惯先构思线索')
    expect(context.data).toContain('习惯先构思线索')
  })

  it('只允许在精确未派发回执下重新准备请求', async () => {
    const requestSnapshot = { request: { personalizationMemoryEpoch: 4, body: {} } }
    const result = { outcome: 'cancelled', result: { code: STALE_PERSONALIZATION_REQUEST, dispatched: false } }
    const attempt = { id: 'attempt', runId: 'run', status: 'cancelled', dispatchedAt: null as Date | null, requestSnapshot,
      requestHash: runtimeJsonHash(requestSnapshot), result, resultHash: runtimeJsonHash(result) }
    const event = { taskRootId: 'root', operationId: 'operation', runId: 'run', type: 'provider.not_dispatched',
      payload: { attemptId: 'attempt', requestHash: attempt.requestHash, code: STALE_PERSONALIZATION_REQUEST, resultHash: attempt.resultHash } }
    const db = { agentProviderAttempt: { findMany: vi.fn(async () => [attempt]) },
      agentExecutionOutbox: { findUnique: vi.fn(async () => event) } } as unknown as RuntimeTx
    await expect(assertUnsentPersonalizationRequest(db, 'root', 'operation')).resolves.toBeUndefined()
    await expect(assertUnsentPersonalizationRequest(db, 'another-root', 'operation')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    attempt.dispatchedAt = createdAt
    await expect(assertUnsentPersonalizationRequest(db, 'root', 'operation')).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
  })

  it('撤回个性化后过滤历史工具回合中的私人参数与结果', () => {
    const creditCall = { id: 'credit', name: 'account_credits', arguments: '{}' }
    const reusedCall = { id: 'memory', name: 'chapter_read', arguments: '{}' }
    const history: ChatMessage[] = [
      { role: 'assistant', content: null, reasoning: 'private reasoning', toolCalls: [creditCall, { id: 'memory', name: 'account_memory_save', arguments: '{"text":"private"}' }] },
      { role: 'tool', toolCallId: 'credit', content: 'remaining' },
      { role: 'tool', toolCallId: 'memory', content: 'private receipt' },
      { role: 'assistant', content: null, reasoning: 'chapter context', toolCalls: [reusedCall] },
      { role: 'tool', toolCallId: 'memory', content: 'chapter result' },
    ]
    expect(projectPersonalizedMessages(history)).toEqual([
      { role: 'user', content: expect.stringContaining('remaining') }, history[3], history[4],
    ])
    expect(history).toHaveLength(5)
  })
})
