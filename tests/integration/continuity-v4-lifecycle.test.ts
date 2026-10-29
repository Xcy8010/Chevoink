import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { buildContinuityReviewManifest, continuityReviewV4Request, inspectContinuityV4 } from '../../api/lib/agent/continuity-review-v4.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { currentTerminalReview, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readLegacyContinuityAssessment, readReusableLegacyContinuityAssessment, bindLegacyContinuityAssessment, continuityReassessmentRequest, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as credits from '../../api/lib/credits.js'

const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only',
  reasoningEffort: 'high', reasoningEfforts: ['none', 'high'], reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }

describe.runIf(available)('legacy-root continuity9 has one native-priced pair and one manifest for all consumers', () => {
  it.each(['complete', 'unknown-second', 'missing-frame', 'tampered-projection'] as const)('%s preserves the real pair and fee fence', scenario => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running', startRequest: { prompt: '修改第一章，只输出标题和正文' } } })
    const content = 'The packet remains sealed. The guard knows the code.'
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, wordCount: content.length, revision: 4 } })
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'], knowledge: ['The guard knows the code.'] } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Synthetic review' })
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Record', entryState: candidate.exitState, goal: 'Record', obstacle: 'Time', choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const ctx: ToolContext = { ...f, callId: 'new-manifest-pair', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', modelRuntime: runtime, signal: new AbortController().signal, emit: () => {} }
    const firstWire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full-body review.', findingIds: [] })),
      terminalVerdicts: [0, 1].map(claimIndex => ({ claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: claimIndex === 0 ? 'c999' : 'c0' }] })), terminalProofVerdicts: [], terminalDispositions: [] }
    const secondWire = { corrections: [{ table: 'terminalVerdicts', index: 0, value: { claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] } }] }
    const first = JSON.stringify(firstWire), second = JSON.stringify(secondWire)
    // These are immutable pre-refactor response rows. Rebuild them with the
    // original manifest/parser; never ask the current producer for old work.
    const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: [] }, 6, 2)
    const bodies = { previous: null, current: content, terminalEvidence: context }, sourceScope = compilerEvidenceScope(chapter, null)
    const manifest = buildContinuityReviewManifest({ subject: { userId: f.userId, novelId: f.novelId, taskId: f.spec.id,
      targetType: 'story_compilation', targetId: compilation.id, chapterId: chapter.id, revision: chapter.revision }, bodies, candidate, sourceScope,
      sourceHash: null, sourceVersions: { current: context.current, previous: null }, verifiedCoverage: context.factCoverage, draftProposals: null })
    const frozenRecord = { manifest, bodies, candidate, sourceScope }, rendered = continuityReviewV4Request(frozenRecord, '修改第一章，只输出标题和正文', 'Frozen original literary input.')
    const compiler = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const oldCoverage = compilerContinuityCoverage({ chapter, bridge: compiler.bridge, sceneTasks: compiler.sceneTasks, source: null, terminalCandidate: candidate }, 11)
    const originalInput: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, terminalCandidate: candidate, sourceScope,
      parserVersion: 9, reassessmentProtocol: 6, continuityManifest: manifest, bindingHash: runtimeJson(oldCoverage).hash, system: rendered.system, content: rendered.content,
      targetType: 'story_compilation', targetId: compilation.id }
    const firstInspection = inspectContinuityV4(first, frozenRecord), secondInspection = inspectContinuityV4(second, frozenRecord)
    const key = legacyContinuityAssessmentKey(ctx, originalInput), originalFees = []
    for (const action of ['agent3ContinuityCritic', 'agent3ContinuityCriticSecondPass']) {
      const fee = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'fixture', modelTier: 'speed',
        action, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled', creditChargeMilli: 23, reservedCreditMilli: 0,
        billingEvidence: { responseObserved: true }, durationMs: 0 } })
      originalFees.push(fee)
      await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: fee.id,
        idempotencyKey: 'historical-v4:' + fee.id, deltaMilli: -23, dailyDeltaMilli: -23, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } })
    }
    await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: 46 } })
    const metadata = [{ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, input: originalInput, callId: ctx.callId },
      { version: 1, fullReassessmentKey: key, input: originalInput, original: firstInspection.audit, callId: ctx.callId,
        request: continuityReassessmentRequest(originalInput.system, originalInput.content, firstInspection, bodies, false, 6) },
      ...['first', 'reassessment'].flatMap((stage, index) => [
        { version: 1, assessmentRequestOwnerKey: key, stage, callId: ctx.callId, usageIds: [originalFees[index].id] },
        { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage }).hash, input: originalInput, stage, callId: ctx.callId,
          usageIds: [originalFees[index].id], audit: index ? secondInspection.audit : firstInspection.audit,
          response: { content: JSON.stringify(index ? second : first), transportComplete: true, finishReason: 'stop', toolCalls: [] } },
      ])]
    for (const value of metadata) await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Frozen original paid v4 pair', content: '', metadata: runtimeJson(value).value } })
    const oldReport = await readLegacyContinuityAssessment(prisma, ctx, originalInput)
    expect(oldReport).toMatchObject({ billingKnown: true, recoveryReady: true, inspected: { complete: true } })
    const bound = bindLegacyContinuityAssessment(oldReport.inspected, ctx, originalInput)
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ independentCheck: 'complete',
      checkedChapterId: chapter.id, checkedRevision: chapter.revision, findings: [], errorCount: 0, warningCount: 0, terminalCandidate: candidate,
      coverage: oldCoverage,
      continuityCriticResponse: bound.audit }).value } })
    const network = vi.fn(() => { throw Error('Frozen historical pair cannot dispatch') }); vi.stubGlobal('fetch', network)
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const audit = (saved.validation as { continuityCriticResponse: { terminalEvidence: Parameters<typeof currentTerminalReview>[2]; continuityV4: unknown } }).continuityCriticResponse
    expect(saved.validation).toMatchObject({ independentCheck: 'complete', continuityCriticResponse: { parserVersion: 9, responseContract: 4,
      rawResponse: { content: JSON.stringify(first) }, continuityV4: { repair: { response: { content: JSON.stringify(second) } },
        projections: { prose: { valid: true }, currentTerminal: { valid: true }, historicalCoverage: { valid: true }, draftProposals: { valid: true } } } } })
    const binding = await readTerminalDraftBinding(prisma, { ...ctx, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: saved.preparedContext }, chapter, saved.validation, audit.terminalEvidence)
    expect(currentTerminalReview(saved.validation, content, audit.terminalEvidence, binding))
      .toMatchObject({ supported: true, deliveryEligibility: { eligible: true } })
    const artifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
    const reservation = artifacts.find(row => (row.metadata as Record<string, unknown>).continuityAssessmentRequestKey)!
    const frozen = (reservation.metadata as { input: LegacyAssessmentInput }).input
    expect(frozen).toMatchObject({ parserVersion: 9, reassessmentProtocol: 6, continuityManifest: { subject: { userId: f.userId, taskId: f.spec.id, targetId: compilation.id } } })
    const paid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    expect(paid).toHaveLength(2)
    expect(paid.every(row => row.billingStatus === 'settled' && row.usageSource === 'reported' && row.reservedCreditMilli === 0)).toBe(true)
    if (scenario === 'unknown-second') await prisma.aiUsageLog.update({ where: { id: paid.find(row => row.action === 'agent3ContinuityCriticSecondPass')!.id }, data: { usageSource: 'unknown', billingStatus: 'pending_usage' } })
    if (scenario === 'missing-frame') await prisma.agentArtifact.delete({ where: { id: artifacts.find(row => { const meta = row.metadata as Record<string, unknown>; return meta.assessmentKey && meta.stage === 'reassessment' })!.id } })
    if (scenario === 'tampered-projection') {
      const bad = structuredClone(saved.validation) as Record<string, unknown>
      const marker = (bad.continuityCriticResponse as { continuityV4: { projections: { currentTerminal: { valid: boolean } } } }).continuityV4
      marker.projections.currentTerminal.valid = false
      await prisma.storyCompilation.update({ where: { id: saved.id }, data: { validation: runtimeJson(bad).value } })
      expect(currentTerminalReview(bad, content, audit.terminalEvidence, binding)).toBeNull()
    }
    const protectedPaid = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
    if (scenario === 'complete') {
      expect(await prisma.$transaction(tx => readLegacyContinuityAssessment(tx, ctx, frozen))).toMatchObject({ inspected: { complete: true }, recoveryReady: true, billingKnown: true, slotUsed: true })
      const sameWire8 = { ...frozen, parserVersion: 8 as const, reassessmentProtocol: 5 as const }; delete sameWire8.continuityManifest
      expect(await prisma.$transaction(tx => readReusableLegacyContinuityAssessment(tx, { ...ctx, callId: 'new-call' }, sameWire8))).toMatchObject({ complete: true, audit: { parserVersion: 9 } })
      await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      await persistCurrentContinuityReport({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision })
      expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ ready: true, continuity: 'complete', quality: 'complete' })
      expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: compilation.id })).not.toMatchObject({ outcome: 'failed' })
      const nextRunId = randomUUID(), nextPrompt = '写下一章'
      const nextChapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, title: 'Synthetic next', content: 'A later chapter.', orderIndex: 2, orderInVolume: 2, wordCount: 16 } })
      const nextSpec = buildTaskSpec({ runId: nextRunId, novelId: f.novelId, chapterId: nextChapter.id, prompt: nextPrompt, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 })
      await prisma.agentRun.create({ data: { id: nextRunId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, chapterId: nextChapter.id, status: 'running', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0, taskSpec: JSON.parse(JSON.stringify(nextSpec)), startRequest: { prompt: nextPrompt } } })
      const nextSubject = { ...f, runId: nextRunId }
      const inherited = await readCompilerContinuitySource(prisma, nextSubject, nextChapter, chapter.id, 11)
      expect(inherited && 'terminalInheritance' in inherited ? inherited.terminalInheritance?.map(fact => fact.claim).sort() : []).toEqual([])
      expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: compilation.id })).not.toMatchObject({ outcome: 'failed' })
    } else if (scenario !== 'tampered-projection') {
      expect(await prisma.$transaction(tx => readReusableLegacyContinuityAssessment(tx, ctx, frozen))).toBeNull()
      await expect(persistCurrentContinuityReport({ ...f, compilationId: compilation.id })).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    }
    expect(network).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(protectedPaid)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.filter(row => scenario !== 'missing-frame' || (row.metadata as Record<string, unknown>).stage !== 'reassessment' || !(row.metadata as Record<string, unknown>).assessmentKey).map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(artifacts.filter(row => scenario !== 'missing-frame' || (row.metadata as Record<string, unknown>).stage !== 'reassessment' || !(row.metadata as Record<string, unknown>).assessmentKey))
  }, undefined, '修改第一章，只输出标题和正文', { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
