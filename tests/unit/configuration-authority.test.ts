import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
vi.mock('../../api/lib/agent/goal-consent.js', () => ({ readGoalConsentSourceRun: async (_tx: unknown, run: unknown) => run }))
const liveControls = vi.hoisted(() => ({ rows: [] as Array<{ prompt: string; row: { sequence: number }; currentEpoch?: boolean; consent: { messageId: string; messageHash: string; consumed: boolean } }> }))
vi.mock('../../api/lib/agent/configuration-journal.js', () => ({ readConfigurationConsents: async (_tx: unknown, _run: unknown, consumed: boolean) => liveControls.rows.filter(item => item.consent.consumed === consumed).map(item => ({ ...item, currentEpoch: item.currentEpoch ?? true })) }))
import { assertConfigurationAuthority } from '../../api/lib/agent/configuration-authority.js'
const ctx: ToolContext = { userId: 'author', novelId: 'novel', runId: 'run', sessionId: 'session', chapterId: null, callId: 'call',
  mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
let prompt = ''
let altered = false
let spawned = false
const tx = { agentRun: { findFirst: async () => ({ id: 'run', userId: 'author', sessionId: 'session', novelId: 'novel', taskRootId: null,
  startRequest: withHumanAdmission({ prompt, mode: 'build', novelId: altered ? 'foreign' : 'novel', sessionId: 'session' }) }) },
  agentSession: { findFirst: async () => ({ spawnedFromSessionId: spawned ? 'other' : null }) },
  agentMessage: { findFirst: async () => ({ id: 'human', parts: [{ type: 'text', text: prompt }] }) },
  agentQueuedRequest: { findMany: async () => [] },
  aiModelConfig: { findFirst: async () => ({ displayName: '模型', modelName: 'provider-model' }) } } as unknown as Prisma.TransactionClient
beforeEach(() => { altered = false; spawned = false; liveControls.rows = [] })
describe('native configuration provenance and exact requested tuple', () => {
  it('accepts a direct human choice without extra confirmation', async () => {
    prompt = '请切换到 ultimate，思考强度高'
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate', reasoningEffort: 'high' } })).resolves.toMatchObject({ sourceMessageId: 'human' })
    prompt = '请切换到 ultimate high'
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate', reasoningEffort: 'high' } })).resolves.toBeDefined()
  })
  it.each(['创作模式切换到严谨创作', '切换到严谨创作'])('accepts an exact mode label as current configuration: %s', async text => {
    prompt = text
    await expect(assertConfigurationAuthority(tx, ctx, { creativeFreedom: 'balanced' })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it.each(['正文写作用 speed。质量检查用 ultimate', '正文写作用 speed，质量检查用 ultimate'])('does not mix task/model clauses: %s', async text => {
    prompt = text
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'ultimate' } })).resolves.toBeDefined()
  })
  it('does not treat an auxiliary choice as a main switch', async () => {
    prompt = '质量检查用 ultimate'
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it('does not mix global scope or effort from another directive', async () => {
    prompt = '全局正文写作用 speed high。质量检查用 ultimate 极高'
    await expect(assertConfigurationAuthority(tx, ctx, { global: true, task: 'quality', model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'ultimate', reasoningEffort: 'high' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it('binds a comma effort modifier only to its own preceding directive', async () => {
    prompt = '正文写作用 speed，思考强度高；质量检查用 ultimate，思考强度极高'
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'speed', reasoningEffort: 'high' } })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'ultimate', reasoningEffort: 'high' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'ultimate', reasoningEffort: 'xhigh' } })).resolves.toBeDefined()
  })
  it('uses the latest applicable authenticated author choice for a fresh call', async () => {
    prompt = '请切换到 ultimate'
    liveControls.rows = [{ prompt: '请切换到 speed', row: { sequence: 1 }, consent: { messageId: 'latest-human', messageHash: 'latest-hash', consumed: true } }]
    await expect(assertConfigurationAuthority(tx, { ...ctx, callId: 'new-call' }, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'speed' } })).resolves.toMatchObject({ sourceMessageId: 'latest-human' })
  })
  it('does not reuse old consumed journal intent after a later choice or revocation', async () => {
    prompt = '请切换到 standard'
    const control = (prompt: string, sequence: number, consumed = true) => ({ prompt, row: { sequence }, consent: { messageId: `control-${sequence}`, messageHash: `hash-${sequence}`, consumed } })
    liveControls.rows = [control('请切换到 ultimate', 1), control('请切换到 speed', 2)]
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    liveControls.rows.push(control('不要再用 speed', 3))
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'speed' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    liveControls.rows = [control('请切换到 ultimate', 1), control('请切换到 speed', 2, false)]
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'speed' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it('keeps different task, setting and scope authority independent', async () => {
    prompt = '正文写作用 ultimate。全局质量检查用 standard high。请切换到 performance'
    liveControls.rows = [{ prompt: '质量检查用 speed。请改为大胆模式', row: { sequence: 1 }, consent: { messageId: 'latest-human', messageHash: 'latest-hash', consumed: true } }]
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'ultimate' } })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { global: true, task: 'quality', model: { modelTier: 'standard', reasoningEffort: 'high' } })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'performance' } })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { creativeFreedom: 'bold' })).resolves.toBeDefined()
  })
  it('does not restore an old effort through a fresh full model selection', async () => {
    prompt = '请切换到 ultimate high'
    liveControls.rows = [{ prompt: '思考强度设为 low', row: { sequence: 1 }, consent: { messageId: 'latest-human', messageHash: 'latest-hash', consumed: true } }]
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate', reasoningEffort: 'high' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { effortOnly: 'low' })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' }, effectiveReasoningEffort: 'high' })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' }, effectiveReasoningEffort: 'low' })).resolves.toBeDefined()
    liveControls.rows.push({ prompt: '请切换到 performance', row: { sequence: 2 }, consent: { messageId: 'new-model', messageHash: 'new-hash', consumed: true } })
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'performance' }, effectiveReasoningEffort: 'high' })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { effortOnly: 'low' })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    liveControls.rows.push({ prompt: '思考强度设为 low', row: { sequence: 3 }, consent: { messageId: 'new-effort', messageHash: 'new-effort-hash', consumed: true } })
    await expect(assertConfigurationAuthority(tx, ctx, { effortOnly: 'low' })).resolves.toMatchObject({ sourceMessageId: 'new-effort' })
  })
  it('retains same-root historical epoch intent only as supersession evidence', async () => {
    prompt = '请切换到 ultimate'
    liveControls.rows = [{ prompt: '请切换到 speed', currentEpoch: false, row: { sequence: 1 }, consent: { messageId: 'old-epoch-human', messageHash: 'hash', consumed: true } }]
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'speed' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    liveControls.rows.push({ prompt: '请切换到 speed', row: { sequence: 2 }, consent: { messageId: 'current-human', messageHash: 'hash-current', consumed: true } })
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'speed' } })).resolves.toMatchObject({ sourceMessageId: 'current-human' })
  })
  it('does not confuse a purpose-specific effort update with a new model choice', async () => {
    prompt = '质量检查用 provider-model high'
    liveControls.rows = [{ prompt: '质量检查思考强度设为 low', row: { sequence: 1 }, consent: { messageId: 'effort-update', messageHash: 'hash', consumed: true } }]
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'custom', customModelId: 'owned' }, effectiveReasoningEffort: 'high' })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'low' } })).resolves.toBeDefined()
  })
  it.each(['正文写作用 speed 和质量检查用 ultimate', '正文写作用 speed and quality use ultimate', '正文写作用 speed 并且质量检查用 ultimate'])('rejects ambiguous compound task/model binding: %s', async text => {
    prompt = text
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it('does not select a later model word from one directive', async () => {
    prompt = '正文写作用 speed ultimate'
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it('keeps explicit Chinese conjunction commands bound to separate purposes', async () => {
    prompt = '正文写作用 speed 和质量检查用 ultimate'
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'speed' } })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'ultimate' } })).resolves.toBeDefined()
    prompt = 'global chapter_writing use speed and quality use ultimate'
    await expect(assertConfigurationAuthority(tx, ctx, { global: true, task: 'chapter_writing', model: { modelTier: 'speed' } })).resolves.toBeDefined()
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'chapter_writing', model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(assertConfigurationAuthority(tx, ctx, { task: 'quality', model: { modelTier: 'ultimate' } })).resolves.toBeDefined()
  })
  it.each(['请分析下面这句英文的语法："use ultimate"', "请分析 'use ultimate'", '假设用 ultimate', '不要用 ultimate'])('denies data: %s', async text => {
    prompt = text
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
  it('denies cross-novel and synthetic child provenance', async () => {
    prompt = '请切换到 ultimate'; altered = true
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    altered = false; spawned = true
    await expect(assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    spawned = false
    await expect(assertConfigurationAuthority(tx, { ...ctx, inlineChild: true }, { model: { modelTier: 'ultimate' } })).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  })
})
