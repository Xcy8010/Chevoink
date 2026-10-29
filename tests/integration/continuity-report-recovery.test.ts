import { describe, expect, it, vi } from 'vitest'
import { fixture, available } from '../support/agent-durable-runtime-fixture.js'
import { continuityRecoveryFixture } from '../helpers/continuity-recovery-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import { readLegacyContinuityAssessment, legacyContinuityAssessmentKey, continuityReassessmentRequest, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { continuityResponseRepairPlan } from '../../api/lib/agent/continuity-response-repair.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

describe.runIf(available)('frozen continuity sparse-repair history remains read-only in PostgreSQL', () => {
  it.each(['repaired', 'semantic-repaired', 'still-invalid', 'unknown-second', 'missing-second-frame'] as const)(
    'preserves both original paid replies and their exact interpretation without redispatch: %s', scenario => fixture(async f => {
      const shape = continuityRecoveryFixture(), repaired = scenario === 'repaired' || scenario === 'semantic-repaired'
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running' } })
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: shape.content, revision: 4, wordCount: shape.content.length } })
      const context = terminalEvidenceContext(chapter, null, 2, 1,
        { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: shape.context.factCoverage!.obligations }, 6, 2)
      const bodies = { previous: null, current: chapter.content, terminalEvidence: context }
      const bad = { ...structuredClone(scenario === 'semantic-repaired' ? shape.wire : shape.bad), proposalDispositions: undefined }
      if (scenario === 'semantic-repaired') {
        Object.assign(bad.terminalVerdicts[2].sourceEvidence[0], { quote: 'An invented quotation.' })
        Object.assign(bad.terminalDispositions[1], { sourceEvidence: [{ segmentId: 'c0', quote: 'Another invented quotation.' }] })
      }
      const scope = compilerEvidenceScope(chapter, null), firstRaw = JSON.stringify(bad)
      const first = inspectContinuityResponse(firstRaw, bodies, true, 8, shape.candidate, scope, { responseContract: 3 })
      const plan = continuityResponseRepairPlan(first, bodies, 2)!
      expect(plan.bad.map(row => ({ table: row.table, address: row.address }))).toEqual(scenario === 'semantic-repaired'
        ? [{ table: 'terminalVerdicts', address: 2 }, { table: 'terminalDispositions', address: 1 }]
        : [1, 3, 9].map(address => ({ table: 'terminalDispositions', address })))
      const patch = { baseResponseHash: first.audit.contentHash, corrections: plan.bad.map(row => ({
        table: row.table, address: row.address, replacement: (shape.wire[row.table] as Array<Record<string, unknown>>)[row.index],
      })) }
      const secondRaw = repaired ? JSON.stringify(patch) : firstRaw
      const ctx = { ...f, callId: 'original-sparse-report' } as ToolContext
      const input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, system: 'Original frozen full check',
        content: chapter.content, parserVersion: 8, reassessmentProtocol: 5, terminalCandidate: shape.candidate, sourceScope: scope,
        targetType: 'chapter', targetId: chapter.id }
      const key = legacyContinuityAssessmentKey(ctx, input), window = credits.getCreditWindow()
      const account = await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, dailyUsedMilli: 46,
        periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const fees = [], ledger = []
      for (const action of ['agent3ContinuityCritic', 'agent3ContinuityCriticSecondPass']) {
        const row = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
          action, targetType: 'chapter', targetId: chapter.id, providerType: 'text', providerMode: 'custom', modelTier: 'speed', modelName: 'original-fixture',
          multiplierBps: 15000, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled', creditChargeMilli: 23, reservedCreditMilli: 0, durationMs: 0 } })
        fees.push(row)
        ledger.push(await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: row.id,
          idempotencyKey: 'frozen-sparse:' + row.id, deltaMilli: -23, dailyDeltaMilli: -23, modelTier: 'speed', multiplierBps: 15000, requestTokens: 12, responseTokens: 8 } }))
      }
      const second = inspectContinuityResponse(secondRaw, bodies, true, 8, shape.candidate, scope, { responseContract: 3 })
      const metadata = [{ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, input, callId: ctx.callId },
        { version: 1, fullReassessmentKey: key, input, original: first.audit, request: continuityReassessmentRequest(input.system, input.content, first, bodies, false, 5) },
        ...['first', 'reassessment'].flatMap((stage, index) => [
          { version: 1, assessmentRequestOwnerKey: key, stage, usageIds: [fees[index].id] },
          { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage }).hash, input, stage, usageIds: [fees[index].id],
            audit: index ? second.audit : first.audit, response: { content: JSON.stringify(index ? secondRaw : firstRaw), transportComplete: true, finishReason: 'stop', toolCalls: [] } },
        ])]
      const artifacts = []
      for (const value of metadata) artifacts.push(await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview',
        title: 'Original immutable sparse report', metadata: runtimeJson(value).value } }))
      const network = vi.fn(() => { throw Error('Historical inspection cannot dispatch') }); vi.stubGlobal('fetch', network)
      const read = await readLegacyContinuityAssessment(prisma, ctx, input)
      expect(read.inspected.complete).toBe(repaired); expect(read.billingKnown).toBe(true); expect(read.recoveryReady).toBe(true)
      if (repaired) expect(currentTerminalReview({ independentCheck: 'complete', terminalCandidate: shape.candidate, continuityCriticResponse: read.inspected.audit },
        chapter.content, context)).toMatchObject({ supported: false, factCoverage: { complete: false } })
      expect(read.usageIds).toEqual(fees.map(row => row.id))
      if (scenario === 'unknown-second') await prisma.aiUsageLog.update({ where: { id: fees[1].id }, data: { billingStatus: 'pending_usage', usageSource: 'unknown' } })
      if (scenario === 'missing-second-frame') await prisma.agentArtifact.delete({ where: { id: artifacts.at(-1)!.id } })
      const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      const rawRows = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
      if (scenario === 'missing-second-frame') {
        const incomplete = await readLegacyContinuityAssessment(prisma, ctx, input)
        expect(incomplete).toMatchObject({ inspected: { complete: false }, recoveryReady: false })
        expect(currentTerminalReview({ independentCheck: 'unavailable', terminalCandidate: shape.candidate, continuityCriticResponse: incomplete.inspected.audit }, chapter.content, context)?.deliveryEligibility.eligible).not.toBe(true)
      }
      else if (scenario === 'unknown-second') expect(await readLegacyContinuityAssessment(prisma, ctx, input)).toMatchObject({ billingKnown: false, recoveryReady: false })
      else expect(await readLegacyContinuityAssessment(prisma, ctx, input)).toEqual(read)
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
      expect(await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })).toEqual(rawRows)
      expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(account)
      expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: ledger.map(row => row.id) } }, orderBy: { id: 'asc' } }))
        .toEqual([...ledger].sort((a, b) => a.id.localeCompare(b.id)))
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
      expect(network).not.toHaveBeenCalled()
    }, undefined, '修改本章', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }))
})
