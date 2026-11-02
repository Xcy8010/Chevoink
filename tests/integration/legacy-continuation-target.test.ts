import { describe, expect, it } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { readLegacyContinuationTarget } from '../../api/lib/agent/legacy-continuation-target.js'
import { startLegacyRuntimeRun } from '../../api/lib/agent/runtime-identity.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

describe.runIf(available)('legacy Continue identity on isolated PostgreSQL', () => {
  it('atomically preserves wrapper retirement evidence in the original startup and rejects repeated admission', () => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'paused' } })
    const startup: Extract<AgentStreamEvent, { type: 'run.started' }> = { type: 'run.started', runId: f.runId, seq: 1, ts: new Date().toISOString(),
      agent: { type: 'writingOrchestrator', title: '写作', model: 'speed' }, mode: 'build', title: '继续',
      authorContinue: { eventId: 'original-pause', afterSeq: 0, legacyContinuationRetirements: [{
        status: 'legacy_continuation_retired', usageOutcome: 'preserved', sourceRunId: f.runId, sourceTaskId: f.spec.id,
        wrapperRunId: 'closed-wrapper', wrapperTaskId: 'independent-task', manuscriptRevision: 0, terminalEventId: 'wrapper-terminal',
        calls: [{ callId: 'old-call', toolName: 'quality_analyze', resultEventId: 'failed-result', pendingReview: null }], usageIds: ['unknown-usage'],
      }] } }
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', payload: {} } })
    await expect(startLegacyRuntimeRun(f.userId, f.runId, true, undefined, startup)).rejects.toMatchObject({ code: 'RUNTIME_STATE_CONFLICT' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
    startup.seq = 2
    await startLegacyRuntimeRun(f.userId, f.runId, true, undefined, startup)
    expect((await prisma.agentRunEvent.findUniqueOrThrow({ where: { runId_seq: { runId: f.runId, seq: 2 } } })).payload).toEqual(startup)
    await expect(startLegacyRuntimeRun(f.userId, f.runId, true, undefined, { ...startup, seq: 3 })).rejects.toMatchObject({ code: 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED' })
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId } })).toBe(2)
  }))
  it.each(['read-only', 'new-objective', 'body-write', 'author-ended', 'different-target'] as const)(
    '%s preserves the actual task, manuscript and both billing journals', scenario => fixture(async f => {
      const source = await prisma.agentRun.update({ where: { id: f.runId }, data: {
        taskRootId: null, runtimeProtocolVersion: 0, status: 'paused', currentTurn: 18,
        manuscriptRevision: 0, startRequest: { prompt: '修改本章' },
        usage: { totalTokens: 30000, checkpoint: { pendingReviews: [{ chapterId: f.chapterId, revision: 1, callId: 'original-review' }] },
          ...(scenario === 'author-ended' ? { authorEnded: { fulfilled: false } } : {}) },
      } })
      const prompt = scenario === 'new-objective' ? '写第二章' : '继续'
      const spec = buildTaskSpec({ runId: 'later-continue', novelId: f.novelId, chapterId: f.chapterId, prompt, authorWritingProtocol: 2 })
      const wrapper = await prisma.agentRun.create({ data: {
        userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: f.chapterId,
        taskRootId: null, runtimeProtocolVersion: 0, status: 'paused', currentTurn: 1, manuscriptRevision: 0,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
        startRequest: { prompt }, taskSpec: JSON.parse(JSON.stringify(spec)),
        usage: { totalTokens: 1200 }, createdAt: new Date(source.createdAt.getTime() + 1000),
      } })
      if (scenario === 'different-target') {
        const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const other = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId,
          volumeId: chapter.volumeId, title: '另一个目标', content: '另一正文', wordCount: 4, orderIndex: 2, orderInVolume: 2 } })
        await prisma.agentRun.update({ where: { id: wrapper.id }, data: { chapterId: other.id } })
      }
      await prisma.agentMessage.create({ data: { runId: wrapper.id, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      await prisma.agentRunEvent.create({ data: { runId: wrapper.id, seq: 1, type: 'tool.call',
        payload: { toolName: scenario === 'body-write' ? 'chapter_write' : 'quality_analyze', callId: 'later-review' } } })
      await prisma.agentRunEvent.create({ data: { runId: wrapper.id, seq: 2, type: 'tool.result',
        payload: { toolName: scenario === 'body-write' ? 'chapter_write' : 'quality_analyze', callId: 'later-review', ok: false, failureCode: 'AI_PROVIDER_TIMEOUT' } } })
      for (const run of [source, wrapper]) await prisma.aiUsageLog.create({ data: {
        userId: f.userId, novelId: f.novelId, agentRunId: run.id, chapterId: f.chapterId,
        providerType: 'text', providerMode: 'custom', modelName: 'isolated-no-provider', action: 'agent3HumanityCritic',
        requestTokens: null, responseTokens: null, usageSource: 'unknown', billingStatus: 'settled',
        creditChargeMilli: 1234, reservedCreditMilli: 0, durationMs: 10,
      } })
      await prisma.agentRunEvent.create({ data: { runId: wrapper.id, seq: 3, type: 'run.paused', payload: {} } })
      const snapshot = async () => ({
        runs: await prisma.agentRun.findMany({ where: { id: { in: [source.id, wrapper.id] } }, orderBy: { id: 'asc' } }),
        chapters: await prisma.chapter.findMany({ where: { novelId: f.novelId }, orderBy: { id: 'asc' } }),
        usage: await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
      })
      const before = await snapshot()
      const resolved = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`
        return readLegacyContinuationTarget(tx, source)
      })
      expect(resolved?.id ?? null).toBe(scenario === 'read-only' ? source.id : null)
      if (scenario === 'read-only') {
        expect((await prisma.$transaction(tx => readLegacyContinuationTarget(tx, wrapper)))?.id).toBe(source.id)
        expect(resolved?.currentTurn).toBe(18)
      }
      expect(await snapshot()).toEqual(before)
    }),
  )
})
