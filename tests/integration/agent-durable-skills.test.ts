import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { skillCatalog, SKILL_ROUTER_VERSION, loadSkill } from '../../api/lib/agent/skills/index.js'
import { createNovelSkillDraftWithId, resolveRuntimeSkillContext, syncBuiltinSkillCatalog } from '../../api/lib/agent/skills/service.js'
import { buildCustomSkillArtifacts } from '../../api/lib/agent/skills/custom.js'
import { skillCatalogTool, skillLoadTool, skillRunExplainTool, skillSharedInvitesTool, skillCreateDraftTool, skillTestTool,
  skillEnableTool, skillInstallSharedTool, skillRollbackTool, skillPublishTool } from '../../api/lib/agent/tools/skill-tools.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

type F = Parameters<Parameters<typeof fixture>[0]>[0]
const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) })
const signal = () => new AbortController().signal
const selected = skillCatalog.find(skill => skill.phases.includes('draft'))!
const draft = { name: '林渡短句声口', description: '写林渡面对压力时的短句和回避方式。', intents: ['write' as const], modes: ['build' as const],
  phases: ['draft' as const], triggerPhrases: ['林渡对话'], negativeTriggerPhrases: ['只改错别字'],
  instructions: { draft: '林渡承压时先回避关键名词，用短句回答；不要把短句写成冷漠。' }, tokenBudget: 360, priority: 80 }

async function skillFixture(work: (f: F) => Promise<void>) {
  return fixture(async f => {
    const network = vi.fn(() => { throw Error('Unexpected paid or external request') })
    vi.stubGlobal('fetch', network)
    try {
      await work(f)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      expect(network).not.toHaveBeenCalled()
    } finally {
      await prisma.agentSkillDefinition.deleteMany({ where: { ownerUserId: f.userId } })
      await prisma.agentSkillInstallation.deleteMany({ where: { userId: f.userId } })
    }
  })
}

async function start(f: F, tools: AgentTool[], calls: ReturnType<typeof call>[]) {
  const lease = await claim(f)
  await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
    toolAuthority: tools.map(tool => ({ name: tool.name, permission: tool.permission.build, alwaysConfirm: Boolean(tool.alwaysConfirm), dangerous: Boolean(tool.dangerous) })),
    protectedChapterIds: [], skillRouterVersion: SKILL_ROUTER_VERSION, skillInventoryVersion: 1,
    pinnedSkillVersions: skillCatalog.map(({ id, version }) => ({ id, version })) }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
    phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: 'Only the original synthetic task' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
  return lease
}

function interruptAfterCommittedEffect() {
  return vi.spyOn(reducer, 'reduceExecutionReceipt').mockImplementationOnce(async (_lease, input) => {
    const operation = await prisma.agentOperation.findUniqueOrThrow({ where: { id: input.operationId }, include: { effectReceipt: true } })
    expect(operation.status).toBe('succeeded')
    expect(operation.effectReceipt).not.toBeNull()
    throw Error('Worker ended after the committed skill effect')
  })
}

async function activeSkill(f: F) {
  const { skillId } = await createNovelSkillDraftWithId(f.userId, f.novelId, draft)
  await prisma.agentSkillDefinition.update({ where: { id: skillId }, data: { status: 'active' } })
  await prisma.agentSkillVersion.update({ where: { skillId_version: { skillId, version: '0.1.0' } }, data: { status: 'active' } })
  return skillId
}

describe.runIf(available)('durable skills with isolated PostgreSQL', () => {
  beforeAll(async () => { await syncBuiltinSkillCatalog() })

  it('recovers the exact loaded version and scoped load receipt across a crash and resume without admitting a later install', () => skillFixture(async f => {
    let lease = await start(f, [skillCatalogTool, skillLoadTool], [call('catalog', 'skill_catalog', {}),
      call('load', 'skill_load', { skillId: selected.id, phase: 'draft' }), call('load-again', 'skill_load', { skillId: selected.id, phase: 'draft' }),
      call('catalog-again', 'skill_catalog', {})])
    const original = await loadExecutionState(f.userId, f.runId)
    const later = await activeSkill(f)
    await prisma.agentSkillInstallation.update({ where: { skillId_userId_scope_scopeId: { skillId: later, userId: f.userId, scope: 'novel', scopeId: f.novelId } }, data: { enabled: true } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { output: expect.not.stringContaining(later) } })
    const interrupted = interruptAfterCommittedEffect()
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended after the committed skill effect')
    interrupted.mockRestore()
    const firstReceipt = await prisma.agentSkillRun.findUniqueOrThrow({ where: { runId: f.runId } })
    expect(firstReceipt).toMatchObject({ selected: [], confidence: 0, reasonCodes: ['explicit_tool_load_without_route'],
      loaded: [{ id: selected.id, name: selected.name, version: selected.version, phase: 'draft', source: 'tool' }] })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    expect(await prisma.agentSkillRun.findUniqueOrThrow({ where: { runId: f.runId } })).toEqual(firstReceipt)
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'skill-resumed-worker')
    await prisma.agentRun.update({ where: { id: resumed.run.id }, data: { status: 'running' } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { output: loadSkill(selected.id, 'draft', 'balanced', skillCatalog) } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { output: expect.not.stringContaining(later) } })
    expect((await loadExecutionState(f.userId, resumed.run.id)).configuration).toEqual(original.configuration)
    expect(await prisma.agentSkillRun.findUniqueOrThrow({ where: { runId: f.runId } })).toEqual(firstReceipt)
    expect((await prisma.agentSkillRun.findUniqueOrThrow({ where: { runId: resumed.run.id } })).loaded).toHaveLength(1)
  }))

  it('receipts the newly created draft identity even when another draft has the same name and never creates it again after interruption', () => skillFixture(async f => {
    const previous = await createNovelSkillDraftWithId(f.userId, f.novelId, { ...draft, source: 'agent' })
    const lease = await start(f, [skillCreateDraftTool], [call('draft', 'skill_create_draft', draft)])
    const interrupted = interruptAfterCommittedEffect()
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended after the committed skill effect')
    interrupted.mockRestore()
    const created = await prisma.agentSkillDefinition.findFirstOrThrow({ where: { ownerUserId: f.userId, id: { not: previous.skillId } } })
    const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'skill_create_draft' }, include: { effectReceipt: true } })
    expect(operation.effectReceipt?.result).toMatchObject({ toolResult: { output: expect.stringContaining(created.id) } })
    expect(JSON.stringify(operation.effectReceipt?.result)).not.toContain(previous.skillId)
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    expect(await prisma.agentSkillDefinition.count({ where: { ownerUserId: f.userId } })).toBe(2)
    expect(await prisma.agentSkillAudit.count({ where: { skillId: created.id } })).toBe(1)
    expect(await prisma.agentSkillInstallation.findFirstOrThrow({ where: { skillId: created.id, userId: f.userId } })).toMatchObject({ enabled: false, lockedVersion: '0.1.0' })
  }))

  it('rolls back skill installation writes on a pre-receipt failure and retries the same original operation', () => skillFixture(async f => {
    const skillId = await activeSkill(f)
    const lease = await start(f, [skillEnableTool], [call('enable', 'skill_enable', { skillId, enabled: true })])
    const originalExecute = skillEnableTool.execute
    const interrupted = vi.spyOn(skillEnableTool, 'execute').mockImplementationOnce(async (ctx, args) => {
      await originalExecute(ctx, args)
      throw Error('Worker ended before the skill receipt')
    })
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended before the skill receipt')
    interrupted.mockRestore()
    expect(await prisma.agentSkillInstallation.findFirstOrThrow({ where: { skillId, userId: f.userId } })).toMatchObject({ enabled: false })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool' })
    expect(await prisma.agentSkillInstallation.findFirstOrThrow({ where: { skillId, userId: f.userId } })).toMatchObject({ enabled: true })
    expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'skill_enable' } })).toBe(1)
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
  }))

  it.each([false, true])('keeps deterministic skill tests and requires exact publication approval (approved=%s)', approved => skillFixture(async f => {
    const { skillId } = await createNovelSkillDraftWithId(f.userId, f.novelId, draft)
    const test = { skillId, version: '0.1.0', intent: 'write', mode: 'build', phase: 'draft' }
    const lease = await start(f, [skillTestTool, skillPublishTool], [call('positive', 'skill_test', { ...test, prompt: '林渡对话', expectMatch: true }),
      call('negative', 'skill_test', { ...test, prompt: '只改错别字', expectMatch: false }), call('publish', 'skill_publish', { skillId, version: '0.1.0' })])
    for (let index = 0; index < 2; index++) expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: '测试技能 · 通过' } })
    const waiting = await executeDurableToolStep(lease, signal())
    if (waiting.kind !== 'waiting_approval') throw Error('Expected exact publication approval')
    expect(await prisma.agentSkillDefinition.findUniqueOrThrow({ where: { id: skillId } })).toMatchObject({ status: 'draft' })
    await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'publish', approved, alwaysAllow: false })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: approved ? { summary: '发布技能 0.1.0' } : { outcome: 'failed' } })
    expect(await prisma.agentSkillEval.count({ where: { skillId, passed: true } })).toBe(2)
    expect(await prisma.agentSkillDefinition.findUniqueOrThrow({ where: { id: skillId } })).toMatchObject({ status: approved ? 'active' : 'draft' })
    expect(await prisma.agentSkillInstallation.findFirstOrThrow({ where: { skillId, userId: f.userId } })).toMatchObject({ enabled: approved })
    expect((await resolveRuntimeSkillContext(f.userId, f.novelId, f.runId)).catalog.some(skill => skill.id === skillId)).toBe(false)
  }))

  it('rolls back only to an existing active version and does not overwrite newer private instructions', () => skillFixture(async f => {
    const skillId = await activeSkill(f), version = buildCustomSkillArtifacts(draft, '0.2.0', 'user')
    await prisma.agentSkillVersion.create({ data: { skillId, version: '0.2.0', status: 'active', manifest: version.manifest,
      instructions: version.instructions, contentHash: version.contentHash } })
    await prisma.agentSkillInstallation.updateMany({ where: { skillId, userId: f.userId }, data: { enabled: true, lockedVersion: '0.2.0' } })
    const lease = await start(f, [skillRollbackTool], [call('rollback', 'skill_rollback', { skillId, version: '0.1.0' }), call('missing', 'skill_rollback', { skillId, version: 'missing' })])
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: '回滚技能到 0.1.0' } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect(await prisma.agentSkillInstallation.findFirstOrThrow({ where: { skillId, userId: f.userId } })).toMatchObject({ enabled: true, lockedVersion: '0.1.0' })
    expect(await prisma.agentSkillVersion.findUniqueOrThrow({ where: { skillId_version: { skillId, version: '0.2.0' } } })).toMatchObject({ contentHash: version.contentHash, instructions: version.instructions })
  }))

  it('explains only owned novel routing while committing its incidental catalog writes with the receipt', () => skillFixture(async f => skillFixture(async foreign => {
    await prisma.agentSkillRun.create({ data: { runId: f.runId, userId: f.userId, novelId: f.novelId, phase: 'draft', routerVersion: SKILL_ROUTER_VERSION,
      candidates: [], selected: [{ id: selected.id, name: selected.name, version: selected.version }], loaded: [], reasonCodes: ['owned-fixture-route'], confidence: 1 } })
    await prisma.agentSkillRun.create({ data: { runId: foreign.runId, userId: foreign.userId, novelId: foreign.novelId, phase: 'draft', routerVersion: SKILL_ROUTER_VERSION,
      candidates: [], selected: [], loaded: [], reasonCodes: ['private-foreign-fixture-route'], confidence: 1 } })
    const lease = await start(f, [skillRunExplainTool], [call('explain', 'skill_run_explain', { runId: f.runId }), call('foreign', 'skill_run_explain', { runId: foreign.runId })])
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining('owned-fixture-route') } })
    const denied = await executeDurableToolStep(lease, signal())
    expect(denied).toMatchObject({ kind: 'tool', result: { summary: '暂无技能路由记录' } })
    expect(JSON.stringify(denied)).not.toContain('private-foreign-fixture-route')
  })))

  it.each([false, true])('lists only scoped invites and requires exact install approval (approved=%s)', approved => skillFixture(async f => {
    await skillFixture(async sender => {
      const skillId = await activeSkill(sender)
      const outsider = await prisma.user.create({ data: { nickname: 'unrelated-share-recipient', passwordHash: 'test-only' } })
      try {
        const invite = async (recipientUserId: string, expired = false) => prisma.skillShareInvite.create({ data: { userId: sender.userId, novelId: sender.novelId,
          recipientUserId, skillId, version: '0.1.0', tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now() + (expired ? -60_000 : 3_600_000)) } })
        const offered = await invite(f.userId), expiredOwn = await invite(f.userId, true), unrelated = await invite(outsider.id, true)
        const lease = await start(f, [skillSharedInvitesTool, skillInstallSharedTool], [call('invites', 'skill_shared_invites', {}), call('install', 'skill_install_shared', { inviteId: offered.id })])
        const listed = await executeDurableToolStep(lease, signal())
        expect(listed).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining(offered.id) } })
        expect(JSON.stringify(listed)).not.toContain(unrelated.id)
        expect(JSON.stringify(listed)).not.toContain(expiredOwn.id)
        expect(await prisma.skillShareInvite.findUniqueOrThrow({ where: { id: expiredOwn.id } })).toMatchObject({ status: 'expired' })
        expect(await prisma.skillShareInvite.findUniqueOrThrow({ where: { id: unrelated.id } })).toMatchObject({ status: 'pending' })
        const waiting = await executeDurableToolStep(lease, signal())
        if (waiting.kind !== 'waiting_approval') throw Error('Expected exact invite installation approval')
        expect(await prisma.agentSkillInstallation.count({ where: { userId: f.userId, skillId } })).toBe(0)
        await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'install', approved, alwaysAllow: false })
        const interrupted = approved ? interruptAfterCommittedEffect() : null
        if (approved) await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended after the committed skill effect')
        else expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        interrupted?.mockRestore()
        if (approved) expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
        expect(await prisma.agentSkillInstallation.count({ where: { userId: f.userId, skillId } })).toBe(approved ? 1 : 0)
        expect(await prisma.skillShareInvite.findUniqueOrThrow({ where: { id: offered.id } })).toMatchObject({ status: approved ? 'accepted' : 'pending' })
        expect((await resolveRuntimeSkillContext(f.userId, f.novelId, f.runId)).catalog.some(skill => skill.id === skillId)).toBe(false)
      } finally { await prisma.user.delete({ where: { id: outsider.id } }) }
    })
  }))
})
