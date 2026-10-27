import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readUnsentContinuityAdmission } from '../../api/lib/agent/continuity-reassessment-witness.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as sources from '../../api/lib/agent/compiler-continuity-source.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('positive unsent admission witness before current source authentication', () => {
  it.each(['first-unsent', 'full-unsent', 'no-receipt-paid-pair', 'paid-first', 'unknown', 'retired-unknown-in-interval',
    'duplicate-receipt', 'missing-full-claim', 'paid-second', 'stale-body', 'changed-source'] as const)(
    '%s preserves real PostgreSQL receipts, source identity and accounting without dispatch', scenario => fixture(async f => {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 3, content: 'The guard waits outside the locked door.' } })
      const previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId,
        orderIndex: 0, orderInVolume: 0, title: 'Synthetic previous chapter', content: 'The door remains locked.', revision: 2, wordCount: 5 } })
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: 'Inspect the synthetic current chapter.' })
      const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
      if (!current.bridge) throw Error('Fixture requires the persisted compiler bridge')
      const readSource = sources.readCompilerContinuitySource
      const source = await readSource(prisma, f, chapter, current.bridge.fromChapterId, 9)
      const coverage = compilerContinuityCoverage({ chapter, bridge: current.bridge, sceneTasks: current.sceneTasks, source }, 9)
      const frozen = { chapterId: chapter.id, revision: chapter.revision, parserVersion: 7,
        targetType: 'story_compilation', targetId: compilation.id, bindingHash: runtimeJson(coverage).hash,
        bodies: { current: scenario === 'stale-body' ? 'Different old body.' : chapter.content, previous: source?.content ?? null } }
      const start = new Date(Date.now() - 10000), at = (n: number) => new Date(start.getTime() + n)
      const callId = 'closed-unsent-check', key = 'frozen-unsent-request'
      const seq = (await prisma.agentRunEvent.aggregate({ where: { runId: f.runId }, _max: { seq: true } }))._max.seq ?? 0
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: seq + 1, type: 'tool.call', createdAt: at(0),
        payload: { toolName: 'continuity_validate', callId, args: { compilationId: compilation.id, chapterId: chapter.id } } } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: seq + 2, type: 'tool.result', createdAt: at(5000),
        payload: { toolName: 'continuity_validate', callId, ok: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' } } })
      const artifact = (metadata: object, n: number) => prisma.agentArtifact.create({ data: { runId: f.runId,
        artifactType: 'continuityReview', title: 'Synthetic frozen witness', content: '', metadata: runtimeJson({ callId, ...metadata }).value, createdAt: at(n) } })
      await artifact({ continuityAssessmentRequestKey: key, input: frozen }, 100)
      const full = ['full-unsent', 'missing-full-claim', 'paid-second'].includes(scenario)
      const claim = full && scenario !== 'missing-full-claim' ? await artifact({ fullReassessmentKey: key }, 3000) : null
      if (scenario !== 'no-receipt-paid-pair') {
        const metadata = full ? { fullReassessmentNotDispatchedKey: key, claimId: claim?.id ?? 'missing-claim' } : { firstAssessmentNotDispatchedKey: key }
        await artifact(metadata, 4000)
        if (scenario === 'duplicate-receipt') await artifact(metadata, 4001)
      }
      const paid = ['full-unsent', 'paid-first', 'paid-second', 'no-receipt-paid-pair'].includes(scenario)
      const unknown = scenario === 'unknown' || scenario === 'retired-unknown-in-interval'
      const usageIds: string[] = []
      for (const [index, action] of (paid ? ['agent3ContinuityCritic', ...(['paid-second', 'no-receipt-paid-pair'].includes(scenario) ? ['agent3ContinuityCriticSecondPass'] : [])]
        : unknown ? ['agent3ContinuityCritic'] : []).entries()) {
        const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: chapter.id, agentRunId: f.runId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic-no-network',
          action, usageSource: unknown ? 'unknown' : 'reported', billingStatus: unknown ? 'pending_usage' : 'settled',
          requestTokens: unknown ? null : 10, responseTokens: unknown ? null : 2, reservedCreditMilli: 0, creditChargeMilli: unknown ? 0 : 23,
          durationMs: 1, createdAt: at(1000 + index * 1000) } })
        usageIds.push(usage.id)
        await artifact({ assessmentRequestOwnerKey: key, usageIds: [usage.id] }, 2500 + index)
      }
      if (scenario === 'changed-source') await prisma.chapter.update({ where: { id: previous.id }, data: { content: 'The door is now open.' } })
      const snapshot = () => Promise.all([
        prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }),
        prisma.chapter.findMany({ where: { novelId: f.novelId }, orderBy: { id: 'asc' } }),
        prisma.chapterBridge.findMany({ where: { novelId: f.novelId }, orderBy: { id: 'asc' } }),
        prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } }),
        prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } }),
        prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
        prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } }),
      ])
      const before = await snapshot(), provider = vi.fn(() => { throw Error('Unexpected provider dispatch') })
      vi.stubGlobal('fetch', provider)
      const authenticatesSource = ['first-unsent', 'full-unsent', 'changed-source'].includes(scenario)
      const sourceRead = vi.spyOn(sources, 'readCompilerContinuitySource').mockImplementation(async (...args) => {
        if (!authenticatesSource) throw Error('Rejected unsent witness reached source traversal')
        return readSource(...args)
      })
      const restored = await prisma.$transaction(tx => readUnsentContinuityAdmission(tx, f, {
        runIds: [f.runId], compilationId: compilation.id, admission: { id: 'new-human-admission', at: at(6000) },
        retiredUsageIds: new Set(scenario === 'retired-unknown-in-interval' ? usageIds : []),
      }))
      if (scenario === 'first-unsent' || scenario === 'full-unsent') {
        expect(restored).toMatchObject({ chapter: { id: chapter.id, revision: chapter.revision }, coverage, sourceCallId: callId,
          usageIds, stage: full ? 'reassessment' : 'first' })
        expect(sourceRead).toHaveBeenCalledOnce()
        expect(sourceRead.mock.calls[0][4]).toBe(9)
      } else expect(restored).toBeNull()
      if (!authenticatesSource) expect(sourceRead).not.toHaveBeenCalled()
      if (scenario === 'changed-source') expect(sourceRead.mock.calls.map(call => call[4])).toEqual([9, 7])
      expect(await snapshot()).toEqual(before)
      expect(provider).not.toHaveBeenCalled()
    }))
})
