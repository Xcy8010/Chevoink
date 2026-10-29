import { persistHistoricalContinuityAudit } from '../support/historical-continuity-audit.js'
import { continueCurrentReviewWorkflow } from '../support/current-review-recovery-workflow.js'
import { readLegacyContinuityAssessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { emptyProposalFixture } from '../helpers/empty-proposal-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext, continuitySemanticRule } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { compilerEvidenceScope, continuitySourceAuthorityRule } from '../../api/lib/agent/continuity-source-authority.js'
import { continuityCriticSystem } from '../../api/lib/agent/continuity-history.js'
import { continuityResponseContract, continuityResponseSystem } from '../../api/lib/agent/continuity-response-contract.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { recoverRunElapsedMs } from '../../api/lib/agent/checkpoint.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { allowsChapterOnlyCompletion } from '../../api/lib/agent/writing-scope.js'
import * as credits from '../../api/lib/credits.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'

const recoveryPrompt = '修改第一章，只输出标题和正文'

describe.runIf(available)('Continue reuses a settled empty optional proposal table pair', () => {
  it('applies the two original responses, commits once and preserves raw audits, claims, model, body and fees', () => fixture(async f => {
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const prompt = recoveryPrompt, startedAt = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).createdAt
    expect(allowsChapterOnlyCompletion(prompt)).toBe(true)
    expect(f.spec.scope.writing).toMatchObject({ kind: 'bounded', titleAndBodyOnly: true, targets: [{ chapterId: f.chapterId, orderIndex: 1 }] })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', runtimeProtocolVersion: 0, taskRootId: null, startRequest: { prompt } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 8, content: 'The packet remains sealed.' } })
    const candidate = emptyProposalFixture().candidate
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: prompt })
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Inventory', entryState: candidate.exitState, goal: 'Read', obstacle: 'Time',
      choice: 'Record', cost: 'Time', turn: 'Recorded', exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    const source = await readCompilerContinuitySource(prisma, f, chapter, saved.bridge!.fromChapterId, 11)
    expect(source).toBeNull()
    const context = terminalEvidenceContext(chapter, source, 2, 1, terminalCoverageInput(f.spec, saved.preparedContext, chapter, candidate, 2), 6, 2)
    expect(Object.prototype.hasOwnProperty.call(context, 'proposalChanges')).toBe(false)
    const synthetic = emptyProposalFixture(chapter, context), scope = compilerEvidenceScope(chapter, source)
    const original = inspectContinuityResponse(synthetic.raw, synthetic.bodies, true, 8, candidate, scope, { responseContract: 3 })
    expect(original).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', terminalReviewDiagnostics: [{ path: 'proposalDispositions' }] } })
    const coverage = compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate }, 11)
    await persistHistoricalContinuityAudit({ ...f, compilationId: compilation.id, expectedChapterRevision: chapter.revision, findings: [], independentCheck: 'unavailable',
      terminalCandidate: candidate, coverage, continuityCriticResponse: original.audit })
    await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision,
      mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const callId = 'synthetic-old-empty-proposals', input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies: synthetic.bodies,
      parserVersion: 8, reassessmentProtocol: 5, terminalCandidate: candidate, sourceScope: scope, bindingHash: runtimeJson(coverage).hash,
      system: continuityResponseSystem(`${continuityCriticSystem}\n${continuitySourceAuthorityRule}\n${continuitySemanticRule}`, continuityResponseContract(synthetic.bodies, candidate)),
      content: 'Synthetic original frozen request.', targetType: 'story_compilation', targetId: compilation.id }
    const key = legacyContinuityAssessmentKey({ runId: f.runId, callId }, input), window = credits.getCreditWindow()
    const account = await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, dailyUsedMilli: 46,
      periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const usage = [], ledger = []
    for (const action of ['agent3ContinuityCritic', 'agent3ContinuityCriticSecondPass']) {
      const row = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', modelTier: 'speed',
        multiplierBps: 10000, action, requestTokens: 10, responseTokens: 5, usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0,
        creditChargeMilli: 23, billingEvidence: { responseObserved: true }, durationMs: 0 } })
      usage.push(row)
      ledger.push(await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: row.id,
        idempotencyKey: `synthetic-empty:${row.id}`, deltaMilli: -23, dailyDeltaMilli: -23, modelTier: 'speed', multiplierBps: 10000, requestTokens: 10, responseTokens: 5 } }))
    }
    const response = { content: JSON.stringify(synthetic.raw), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] }
    const metadata = [{ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, input, callId, admissionId: null },
      { version: 1, fullReassessmentKey: key, input, callId, original: original.audit, usageIds: [usage[0].id],
        request: continuityReassessmentRequest(input.system, input.content, original, synthetic.bodies, false, 5) },
      ...['first', 'reassessment'].flatMap((stage, index) => [
        { version: 1, assessmentRequestOwnerKey: key, stage, callId, usageIds: [usage[index].id] },
        { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage }).hash, input, stage, callId, usageIds: [usage[index].id], response, audit: original.audit },
      ])]
    const artifacts = []
    for (const value of metadata) artifacts.push(await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview',
      title: 'Synthetic historical response', content: 'Synthetic historical evidence.', metadata: runtimeJson(value).value } }))
    const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.paused', payload: { reason: 'model_stalled' } } })
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default',
      activeExecutionMs: recoverRunElapsedMs(startedAt.getTime(), pause.createdAt.getTime(), [{ type: 'run.paused', at: pause.createdAt.getTime() }]),
      runStartedAt: startedAt.getTime(), stagnantBatches: 0, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [], reviewAttempts: [], pendingReviews: [],
      inheritedTokens: 10, inheritedTurns: 1, manualResumeCount: 0 }
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', currentTurn: 4, startedAt,
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, checkpoint } } })
    const beforeRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const frozen = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const read = await readLegacyContinuityAssessment(prisma, { ...f, callId } as ToolContext, input)
    expect(read).toMatchObject({ billingKnown: true, providerComplete: true, inspected: { complete: true } })
    expect(read.inspected.audit).toMatchObject({ formatProjection: { kind: 'empty_optional_proposal_table', version: 1 } })
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(frozen)
    const completed = await continueCurrentReviewWorkflow(f, { compilationId: compilation.id, prompt, afterSeq: pause.seq })
    expect(completed.run).toMatchObject({ status: 'completed', taskSpec: beforeRun.taskSpec, modelTier: beforeRun.modelTier,
      customModelId: beforeRun.customModelId, reasoningEffort: beforeRun.reasoningEffort })
    expect(completed.chapter.content.trim()).toBe(chapter.content.trim())
    expect(completed.compilation.preparedContext).not.toHaveProperty('terminalFactProofs')
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: artifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(artifacts))
    expect(await prisma.aiUsageLog.findMany({ where: { id: { in: usage.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(usage))
    expect(await prisma.creditLedgerEntry.findMany({ where: { id: { in: ledger.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(byId(ledger))
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBeGreaterThan(account.dailyUsedMilli)
    for (let i = 0; i < 2; i++) await expect(continueLoopRun(f.userId, f.runId)).rejects.toMatchObject({ code: 'RUN_NOT_PAUSED' })
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).toEqual(completed.run)
    expect(createHash('sha256').update(synthetic.raw).digest('hex')).toBe(original.audit.contentHash)
  }, undefined, recoveryPrompt, { freezeWriting: true, continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
