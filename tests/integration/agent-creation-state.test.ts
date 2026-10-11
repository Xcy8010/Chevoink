import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { readAgentCreationState, collectAgentCreationState } from '../../api/lib/agent/creation-state.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('read-only creation-state across execution chains', () => {
  it('projects identical manuscript facts without changing frames, receipts, usage or budgets', async () => fixture(async f => {
    const lease = await claim(f)
    const state = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator',
      creativeFreedom: 'balanced', qualityMode: 'premium', model: { tier: 'speed', provider: 'fixture', modelName: 'fixture',
        customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) }, tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '修改本章' }, { role: 'assistant', content: '正在核对', reasoning: 'DO_NOT_EXPOSE_RAW_REASONING' }], successfulToolSignatures: [] } })
    const capture = async () => ({
      frames: await prisma.agentExecutionFrame.findMany({ where: { taskRootId: f.rootId } }),
      operations: await prisma.agentOperation.findMany({ where: { taskRootId: f.rootId } }),
      budget: await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: f.rootId } }),
      run: await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } }),
      chapter: await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } }),
    })
    const before = await capture(), durable = await readAgentCreationState(f.userId, f.runId)
    expect(await capture()).toEqual(before)
    expect(durable.execution.cursor).toEqual({ kind: 'durable_frame', revision: state.frame.revision, hash: state.frame.snapshotHash })
    expect(durable.targets[0]).toMatchObject({ chapterId: f.chapterId, revision: 1, review: null, unknownReason: 'review_unavailable' })
    expect(JSON.stringify(durable)).not.toContain('DO_NOT_EXPOSE_RAW_REASONING')
    // Change only this fixture's adapter identity; the admitted task and rows
    // remain the same. This is not a production conversion or resume path.
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
    const legacyBefore = await capture(), legacy = await readAgentCreationState(f.userId, f.runId)
    expect(await capture()).toEqual(legacyBefore)
    expect(legacy.targets).toEqual(durable.targets)
    expect(legacy.obligations).toEqual(durable.obligations)
    expect(legacy.effects.legacy).toBe('unknown')
    expect(legacy.delivery.verified).toBe(false)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
  }))
  it('enforces database read-only and rejects a different author before returning any target', async () => fixture(async f => {
    await expect(readAgentCreationState('different-author', f.runId)).rejects.toMatchObject({ code: 'AGENT_RUN_NOT_FOUND' })
    const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      await collectAgentCreationState(tx, f.userId, f.runId)
      await tx.chapter.update({ where: { id: f.chapterId }, data: { content: 'must not write' } })
    }, { isolationLevel: 'RepeatableRead' })).rejects.toThrow()
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
  }))
})
