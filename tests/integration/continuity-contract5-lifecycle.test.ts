import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity, commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'
import { continuityValidateTool, chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { readTerminalDraftBinding } from '../../api/lib/agent/terminal-draft-authority.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { effectiveContinuityAudit, reconstructContinuitySourceProvenance, prepareContinuityMergedRevision } from '../../api/lib/agent/continuity-coordinator.js'
import { chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { handleToolCall } from '../../api/lib/agent/loop.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { buildContinuityInvalidRowRepair, inspectContinuityV4, validateStoredContinuityV4Projection } from '../../api/lib/agent/continuity-review-v4.js'
import { legacyAssessmentInputSchema } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readReviewRequestRecoveryEvidence } from '../../api/lib/agent/review-request-recovery.js'
import { RunEventBus, loadPersistedEvents } from '../../api/lib/agent/events.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

describe.runIf(available)('contract5 actual legacy provider, report CAS and independent bridge gate', () => {
  it.each(['complete', 'normalized-cross-chunk', 'preserved-canonical', 'typed-sparse-repair', 'repaired-background', 'single-background', 'unknown', 'applied-typed-error', 'merged-revision', 'cancel-known-raw', 'wrong-owner', 'body-only-first-terminal', 'body-only-unknown', 'body-only-old-local-refusal'] as const)('%s preserves the original phase and V2 price', scenario => fixture(async f => {
    const bodyOnly = scenario.startsWith('body-only-'), background = scenario === 'repaired-background' || scenario === 'single-background'
    const prompt = background ? '修改第一章' : '修改第一章，只输出标题和正文'
    const completeScenario = background || bodyOnly || scenario === 'complete' || scenario === 'typed-sparse-repair' || scenario === 'normalized-cross-chunk' || scenario === 'preserved-canonical'
    const factual = scenario === 'applied-typed-error' || scenario === 'merged-revision'
    const baseContent = 'The sealed packet remains with the guard.'
    const content = background ? 'x'.repeat(290) + baseContent + ' The clerk waits.' + 'z'.repeat(400)
      : factual ? 'The packet is sealed. The packet is open.' : scenario === 'normalized-cross-chunk' ? `${'x'.repeat(290)}${baseContent}` : baseContent
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running',
      startRequest: { prompt } } })
    await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'run.started', payload: { type: 'run.started', seq: 1 } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, wordCount: content.length, revision: 4 } })
    const canonicalClaim = background ? 'The guard remembers the earlier address.' : 'The pump awaits a replacement seal.'
    let canonicalChapter: typeof chapter | undefined
    if (scenario === 'preserved-canonical' || background) {
      const rootContent = canonicalClaim
      canonicalChapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId,
        orderIndex: 0, orderInVolume: 0, title: 'Synthetic committed predecessor', content: rootContent, revision: 1 } })
      const historicalRun = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        chapterId: canonicalChapter.id, status: 'running', runtimeProtocolVersion: 0, taskRootId: null,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', startRequest: { prompt: '修改本章' } } })
      await prisma.agentMessage.create({ data: { sessionId: f.sessionId, runId: historicalRun.id, role: 'user',
        parts: [{ type: 'text', text: '修改本章' }] } })
      const historical = { userId: f.userId, novelId: f.novelId, runId: historicalRun.id }
      // This parser8 canon uses the legacy scope produced by its original prompt;
      // JSON persistence omits absent optional fields, without changing f.spec.
      const historicalSpec = taskSpecSchema.parse(JSON.parse(JSON.stringify(
        buildTaskSpec({ runId: historicalRun.id, novelId: f.novelId, chapterId: canonicalChapter.id, prompt: '修改本章' }),
      )))
      expect(historicalSpec).toMatchObject({ id: expect.any(String), runId: historicalRun.id, intent: 'revise', goals: ['修改本章'] })
      expect(historicalSpec.scope).toEqual({ novelId: f.novelId, chapterIds: [canonicalChapter.id] })
      await prisma.agentRun.update({ where: { id: historicalRun.id }, data: { taskSpec: runtimeJson(historicalSpec).value } })
      const root = await prepareStoryCompilation({ ...historical, chapterId: canonicalChapter.id, mode: 'balanced', intentSummary: 'Historical manual chapter.' })
      const rootCandidate = terminalCandidateSchema.parse({ exitState: background ? { knowledge: [canonicalClaim] } : { openLoops: [canonicalClaim] } })
      await saveSceneTasks({ ...historical, compilationId: root.compilation.id, tasks: [{ purpose: 'Wait', entryState: rootCandidate.exitState,
        goal: 'Wait', obstacle: 'Parts', choice: 'Wait', cost: 'Time', turn: 'Waiting', exitState: rootCandidate.exitState,
        styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
      const savedRoot = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: root.compilation.id }, include: { bridge: true, sceneTasks: true } })
      const context = terminalEvidenceContext(canonicalChapter, null, 2)
      const inspected = inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
        ({ kind, result: 'clear', reason: 'The full historical chapter establishes this pending fact.', findingIndexes: [] })),
      terminalVerdicts: [{ path: background ? 'exitState.knowledge.0' : 'exitState.openLoops.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: rootContent }] }] }),
      { current: rootContent, previous: null, terminalEvidence: context }, true, 8, rootCandidate)
      expect(inspected.complete).toBe(true)
      await validateStoryContinuity({ ...historical, compilationId: savedRoot.id, findings: [], independentCheck: 'complete',
        terminalCandidate: rootCandidate, continuityCriticResponse: inspected.audit,
        coverage: compilerContinuityCoverage({ chapter: canonicalChapter, bridge: savedRoot.bridge, sceneTasks: savedRoot.sceneTasks, source: null, terminalCandidate: rootCandidate }, 11) })
      await persistHumanityQualityReport({ ...historical, compilationId: savedRoot.id, chapterId: canonicalChapter.id, chapterRevision: 1,
        mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      await commitChapterBridge({ ...historical, compilationId: savedRoot.id, ...rootCandidate,
        chapterSummary: rootContent, hookDecision: '', delayedHookReason: '', openingStructure: 'Wait', endingStructure: 'Wait' })
    }
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: [factual ? 'The packet is sealed.' : 'The sealed packet remains with the guard.'],
      ...(scenario === 'preserved-canonical' ? { openLoops: [canonicalClaim] } : {}), ...(background ? { location: 'The clerk waits.' } : {}) } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: chapter.id, mode: 'balanced', intentSummary: 'Synthetic complete review.' })
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Keep', entryState: candidate.exitState, goal: 'Keep', obstacle: 'Time', choice: 'Keep', cost: 'Time', turn: 'Kept',
      exitState: candidate.exitState, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    const runtime: NonNullable<ToolContext['modelRuntime']> = { tier: 'speed', multiplierBps: 15000, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 128000 }
    const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'contract5-fixture',
      rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue(price)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    const ctx: ToolContext = { ...f, continuityOwnerSeq: 1, callId: 'original-contract5', mode: 'build', creativeFreedom: 'balanced',
      qualityMode: 'balanced', modelRuntime: runtime, signal: new AbortController().signal, emit: () => {} }
    const wire = { findings: [] as unknown[], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reasonCode: 'consistent',
      explanation: 'The whole current body is internally consistent.', findingIds: [] as string[] })), terminalVerdicts: [{ claimIndex: 0,
      verdict: scenario === 'unknown' ? 'unknown' : 'supported', reasonCode: scenario === 'unknown' ? 'insufficient_evidence' : 'consistent',
      explanation: 'Synthetic independent judgment of the whole current claim.', manuscriptEvidence: scenario === 'unknown' ? []
        : scenario === 'normalized-cross-chunk' ? [{ segmentId: 'c1', quote: baseContent }] : [{ segmentId: 'c0' }] }],
      terminalProofVerdicts: scenario === 'preserved-canonical' ? [{ proofIndex: 0, currentState: 'uncertain', reasonCode: 'insufficient_evidence',
        explanation: `The inherited claim “${canonicalClaim}” is not newly established by this packet scene.` }] : [], terminalDispositions: [], issueDispositions: [] }
    const issueExplanation = 'The packet is described as sealed and open at the same time.'
    if (factual) {
      wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'error', reasonCode: 'manuscript_conflict', explanation: issueExplanation,
        suggestion: 'Resolve the incompatible packet states in the original scope.', manuscriptEvidence: [
          { segmentId: 'c0', quote: 'The packet is sealed.' }, { segmentId: 'c0', quote: 'The packet is open.' }] })
      Object.assign(wire.semanticChecks[1], { result: 'conflict', reasonCode: 'manuscript_conflict', explanation: issueExplanation, findingIds: ['f0'] })
    }
    if (scenario === 'typed-sparse-repair') wire.findings.push({ findingId: 'f0', signal: 'object', severity: 'warning',
      reasonCode: 'historical_reference', explanation: 'The text supposedly says “a wholly nonexistent quoted manuscript passage”.',
      suggestion: 'Check the original source.', manuscriptEvidence: [{ segmentId: 'c0', quote: 'a wholly nonexistent quoted manuscript passage' }] })
    if (background) {
      wire.terminalVerdicts[0].claimIndex = 1
      wire.terminalVerdicts[0].manuscriptEvidence = scenario === 'single-background' ? [{ segmentId: 'c1' }] : [{ segmentId: 'c1', quote: baseContent }]
      wire.terminalVerdicts.push({ claimIndex: 0, verdict: 'supported', reasonCode: 'consistent', explanation: 'The current scene establishes this literal location.',
        manuscriptEvidence: [{ segmentId: 'c1', quote: 'The clerk waits.' }] })
      Object.assign(wire, { terminalDispositions: scenario === 'single-background'
        ? [{ obligationIndex: 0, outcome: 'unknown', reasonCode: 'historical_reference', explanation: 'The prior knowledge remains background; the current chapter does not resolve it.', manuscriptEvidence: [] }]
        : [{ obligationIndex: 0, outcome: 'ended', reasonCode: 'completed_obligation',
          explanation: 'A malformed original location.', manuscriptEvidence: [{ segmentId: 'c999' }] }] })
    }
    const raw = JSON.stringify(wire)
    let backgroundSecond = ''
    let requestCount = 0
    const fetchMock = vi.fn(async () => {
      requestCount++
      if (scenario === 'cancel-known-raw') await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused' } })
      if (scenario === 'wrong-owner') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'run.started', payload: { type: 'run.started', seq: 2 } } })
      const revisedWire = { ...wire, findings: [], semanticChecks: wire.semanticChecks.map(row => ({ ...row, result: 'clear', reasonCode: 'consistent', findingIds: [] })),
        issueDispositions: [{ issueIndex: 0, outcome: 'repaired', reasonCode: 'consistent', explanation: 'The current manuscript retains only the sealed state.', manuscriptEvidence: [{ segmentId: 'c0' }] }] }
      if (scenario === 'repaired-background' && requestCount === 2) {
        const rows = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview', metadata: { path: ['stage'], equals: 'first' } } })
        const metadata = rows.map(row => row.metadata as Record<string, unknown>).find(value => value.response && value.input)!
        const input = legacyAssessmentInputSchema.parse(metadata.input)
        const inspected = inspectContinuityV4(raw, { bodies: input.bodies, candidate: input.terminalCandidate!, sourceScope: input.sourceScope!, manifest: input.continuityManifest! })
        const plan = buildContinuityInvalidRowRepair(inspected)!
        expect(plan).not.toBeNull()
        const corrected = { ...wire, terminalDispositions: [{ obligationIndex: 0, outcome: 'replaced', candidateIndex: 0, reasonCode: 'consistent',
          explanation: 'The old knowledge was incorrectly assigned to a current location.', manuscriptEvidence: [{ segmentId: 'c2', quote: 'The clerk waits.' }] }] }
        backgroundSecond = JSON.stringify({ corrections: plan.mask.map(item => ({ ...item, value: (corrected[item.table as keyof typeof corrected] as unknown[])[item.index] })) })
      }
      const responseRaw = scenario === 'repaired-background' && requestCount === 2 ? backgroundSecond : bodyOnly && requestCount === 1 ? JSON.stringify({ findings: [],
        semanticChecks: { action_direction: { result: 'clear', reason: 'Whole saved body checked.', findingIndexes: [] },
          state_progression: { result: 'clear', reason: 'Whole saved body checked.', findingIndexes: [] } },
        terminalVerdicts: [], terminalProofVerdicts: [], terminalDispositions: [] })
        : scenario === 'typed-sparse-repair' && requestCount === 2
        ? JSON.stringify({ corrections: [{ table: 'findings', index: 0, value: { findingId: 'f0', action: 'retract',
          reasonCode: 'insufficient_evidence', explanation: 'The current source does not establish that allegation; the manuscript is unchanged.',
          manuscriptEvidence: [{ segmentId: 'c0' }] } }] })
        : scenario !== 'merged-revision' || requestCount === 1 ? raw : requestCount === 2
        ? JSON.stringify({ patches: [{ oldText: 'The packet is open.', newText: 'The guard keeps the packet sealed.' }], retainedFindings: [] }) : JSON.stringify(revisedWire)
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: responseRaw }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    }); vi.stubGlobal('fetch', fetchMock)
    let bodyFees: Awaited<ReturnType<typeof prisma.aiUsageLog.findMany>> = []
    let bodyArtifacts: Awaited<ReturnType<typeof prisma.agentArtifact.findMany>> = []
    if (bodyOnly) {
      const checked = await continuityValidateTool.execute({ ...ctx, callId: 'automatic-body-check' }, { compilationId: compilation.id })
      expect(checked).toMatchObject({ reviewCompleted: true })
      expect(checked).not.toHaveProperty('failureCode')
      bodyFees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
      bodyArtifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId }, orderBy: { id: 'asc' } })
      const bodySaved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      expect(bodySaved.validation).toMatchObject({ independentCheck: 'complete', continuityCriticResponse: { parserVersion: 8 } })
      expect(bodySaved.validation).not.toHaveProperty('terminalCandidate')
      if (scenario === 'body-only-unknown') {
        await prisma.aiUsageLog.update({ where: { id: bodyFees[0].id }, data: { billingStatus: 'pending_settlement' } })
        const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        await expect(continuityValidateTool.execute(ctx, { compilationId: compilation.id, terminalState: candidate }))
          .rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(before)
        expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
        return
      }
      if (scenario === 'body-only-old-local-refusal') {
        const at = new Date(), oldCallId = 'old-typed-pre-reservation-refusal'
        await prisma.agentRunEvent.createMany({ data: [
          { runId: f.runId, seq: 2, type: 'tool.call', createdAt: at, payload: { callId: oldCallId, toolName: 'continuity_validate',
            args: { compilationId: compilation.id, terminalState: candidate } } },
          { runId: f.runId, seq: 3, type: 'tool.result', createdAt: new Date(at.getTime() + 1), payload: { callId: oldCallId,
            toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' } },
        ] })
        const recovered = await prisma.$transaction(tx => readReviewRequestRecoveryEvidence(tx, f,
          [{ callId: oldCallId, toolName: 'continuity_validate', chapterId: chapter.id, revision: chapter.revision, compilationId: compilation.id }]))
        expect(recovered).toMatchObject([{ callId: oldCallId, notDispatched: true, receipt: { usageIds: [] } }])
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(await prisma.agentArtifact.findMany({ where: { id: { in: bodyArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(bodyArtifacts)
      }
    }
    if (scenario === 'cancel-known-raw' || scenario === 'wrong-owner') {
      await expect(continuityValidateTool.execute(ctx, { compilationId: compilation.id, terminalState: candidate })).rejects.toBeInstanceOf(Error)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      expect(saved.validation).not.toHaveProperty('effectiveReport')
      expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })).toMatchObject({ committedAt: null })
    } else {
      const bus = new RunEventBus(f.runId, scenario === 'body-only-old-local-refusal' ? 3 : 1)
      const result = await handleToolCall({ id: ctx.callId, name: 'continuity_validate', arguments: JSON.stringify({ compilationId: compilation.id, terminalState: candidate }) },
        [continuityValidateTool], ctx, bus, 'contract5-message', f.runId, undefined, () => bus.persist())
      await bus.close()
      expect(result).toMatchObject({ reviewCompleted: true, reviewOutcome: completeScenario ? 'complete' : 'decision_required', part: { status: 'success' } })
      expect(result).not.toHaveProperty('failureCode')
      const reportEvents = (await loadPersistedEvents(f.runId, 1)).filter(event => event.type === 'tool.result' && event.callId === ctx.callId)
      expect(reportEvents).toMatchObject([{ type: 'tool.result', toolName: 'continuity_validate', ok: true }])
      expect(reportEvents[0]).not.toHaveProperty('reviewOutcome')
      expect(result.part).not.toHaveProperty('reviewOutcome')
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      const validation = saved.validation as Record<string, unknown>, audit = validation.continuityCriticResponse as Record<string, unknown>
      expect(validation).toMatchObject({ independentCheck: 'complete', effectiveReport: { version: 1, reportHash: runtimeJson(audit).hash },
        continuityCriticResponse: { parserVersion: 10, responseContract: 5, rawResponse: { content: JSON.stringify(raw) } } })
      const binding = await readTerminalDraftBinding(prisma, { ...ctx, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: saved.preparedContext }, chapter, validation,
        audit.terminalEvidence as Parameters<typeof currentTerminalReview>[2])
      expect(currentTerminalReview(validation, content, audit.terminalEvidence as Parameters<typeof currentTerminalReview>[2], binding)?.deliveryEligibility.eligible).toBe(scenario !== 'unknown')
      await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: chapter.revision, mode: 'balanced',
        criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      if (scenario === 'applied-typed-error') {
        const feesBefore = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const source = await prisma.$transaction(tx => reconstructContinuitySourceProvenance(tx, ctx,
          { compilationId: compilation.id, chapterId: chapter.id, preparedContext: saved.preparedContext }))
        expect(source.establishedIssues).toEqual([expect.objectContaining({ findingId: 'f0', text: issueExplanation,
          reportHash: runtimeJson(audit).hash, origin: expect.objectContaining({ chapterId: chapter.id, revision: 4, bodyHash: runtimeJson({ content }).hash }) })])
        expect(source.establishedIssues[0].text).not.toContain('独立意见')
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(feesBefore)
      } else if (scenario === 'merged-revision') {
        const originals = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const revision = await prepareContinuityMergedRevision(ctx, compilation.id)
        expect(revision?.kind).toBe('tool')
        if (!revision || revision.kind !== 'tool') throw Error('Original phase did not admit the actual correction')
        const applied = await chapterEditRangeTool.execute({ ...ctx, callId: revision.callId, continuityRevision: revision.capability }, revision.args)
        expect(applied).not.toHaveProperty('failureCode')
        const revised = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
        expect(revised).toMatchObject({ revision: 5, content: 'The packet is sealed. The guard keeps the packet sealed.' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        const verified = await continuityValidateTool.execute({ ...ctx, callId: 'original-cycle-reverify' }, { compilationId: compilation.id, terminalState: candidate })
        expect(verified).toMatchObject({ reviewCompleted: true, reviewOutcome: 'complete' })
        expect(verified).not.toHaveProperty('failureCode')
        const verifiedCompilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
        const verifiedAudit = (verifiedCompilation.validation as Record<string, unknown>).continuityCriticResponse as Record<string, unknown>
        expect(verifiedAudit).toMatchObject({ parserVersion: 10, continuityV4: { manifest: { typedLineage: {
          revisionReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/), establishedIssues: [expect.objectContaining({ text: issueExplanation })] } } } })
        expect(await prisma.aiUsageLog.findMany({ where: { id: { in: originals.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(originals)
        await persistHumanityQualityReport({ ...f, compilationId: compilation.id, chapterId: chapter.id, chapterRevision: revised.revision, mode: 'balanced',
          criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
        expect(await chapterBridgeCommitTool.execute({ ...ctx, callId: 'commit-revised' }, { compilationId: compilation.id })).not.toHaveProperty('failureCode')
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(await continuityValidateTool.execute({ ...ctx, callId: 'candidate-only-no-new-grant' }, { compilationId: compilation.id,
          terminalState: terminalCandidateSchema.parse({ exitState: { objects: ['The guard holds a different packet.'] } }) })).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
        expect(fetchMock).toHaveBeenCalledTimes(3)
      } else if (completeScenario) {
        if (background) {
          if (scenario === 'repaired-background') expect(audit).toMatchObject({ continuityV4: { failedRepair: { response: { content: JSON.stringify(backgroundSecond) } }, projectionNormalization: {
            version: 2, serverRejectedReplacements: [{ id: terminalFactId('knowledge', canonicalClaim), code: 'replacement_target_invalid' }] } } })
          else {
            expect(audit).toMatchObject({ continuityV4: { projectionNormalization: { version: 2, mode: 'single_report', mappings: [] } } })
            expect((audit.continuityV4 as Record<string, unknown>)).not.toHaveProperty('repair')
            expect((audit.continuityV4 as Record<string, unknown>)).not.toHaveProperty('failedRepair')
          }
          expect(validateStoredContinuityV4Projection(audit, content, audit.terminalEvidence as Parameters<typeof currentTerminalReview>[2])?.complete).toBe(true)
          const source = await readCompilerContinuitySource(prisma, f, chapter, canonicalChapter!.id, 11)
          expect(source && 'terminalInheritance' in source ? source.terminalInheritance : []).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'knowledge', claim: canonicalClaim })]))
          expect(candidate.exitState.knowledge).not.toContain(canonicalClaim)
        }
        if (scenario === 'normalized-cross-chunk') {
          expect(audit).toMatchObject({ continuityV4: { projectionNormalization: { version: 1, originalParserVersion: 10,
            mappings: [expect.objectContaining({ kind: 'current_evidence_span', originalSegmentId: 'c1' })] } } })
          const source = await prisma.$transaction(tx => reconstructContinuitySourceProvenance(tx, ctx,
            { compilationId: compilation.id, chapterId: chapter.id, preparedContext: saved.preparedContext }))
          expect(source.latestAppliedReport?.reportHash).toBe(runtimeJson(audit).hash)
          expect(fetchMock).toHaveBeenCalledOnce()
        }
        const committed = await chapterBridgeCommitTool.execute({ ...ctx, callId: 'commit-current' }, { compilationId: compilation.id })
        expect(committed).not.toHaveProperty('failureCode')
        expect(committed).not.toMatchObject({ outcome: 'failed' })
        if (background) {
          const beforeFees = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
          const beforeLedger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
          const rawArtifacts = await prisma.agentArtifact.findMany({ where: { runId: f.runId, artifactType: 'continuityReview' }, orderBy: { id: 'asc' } })
          const committedRow = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
          const prepared = committedRow.preparedContext as Record<string, unknown>
          expect(prepared).toMatchObject({ terminalFactCoverage: { facts: expect.arrayContaining([{ id: terminalFactId('knowledge', canonicalClaim), field: 'knowledge', claim: canonicalClaim }]) },
            terminalReviewProof: { scopePreservation: { version: 2, pendingCoverageIds: [terminalFactId('knowledge', canonicalClaim)] } } })
          expect((prepared.terminalFactProofs as Array<{ field: string; claim: string }>).some(fact => fact.field === 'knowledge' && fact.claim === canonicalClaim)).toBe(false)
          expect(await chapterBridgeCommitTool.execute({ ...ctx, callId: 'repeat-background-commit' }, { compilationId: compilation.id })).not.toHaveProperty('failureCode')
          const rebound = await readTerminalDraftBinding(prisma, { ...ctx, compilationId: compilation.id }, { taskId: f.spec.id, preparedContext: committedRow.preparedContext }, chapter,
            committedRow.validation, audit.terminalEvidence as Parameters<typeof currentTerminalReview>[2])
          expect(currentTerminalReview(committedRow.validation, content, audit.terminalEvidence as Parameters<typeof currentTerminalReview>[2], rebound)?.deliveryEligibility)
            .toMatchObject({ eligible: true, preservation: { version: 2 } })
          expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(beforeFees)
          expect(await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(beforeLedger)
          expect(await prisma.agentArtifact.findMany({ where: { id: { in: rawArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(rawArtifacts)
          expect(fetchMock).toHaveBeenCalledTimes(scenario === 'single-background' ? 1 : 2)
        }
        if (scenario === 'preserved-canonical') {
          const committedCompilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
          expect(committedCompilation.preparedContext).toMatchObject({ terminalFactProofs: expect.arrayContaining([
            expect.objectContaining({ claim: canonicalClaim, depth: 2, nodes: [expect.objectContaining({ preservation: {
              version: 1, basis: 'preserved_canonical', sourceProofHash: expect.any(String), sourceNodesHash: expect.any(String),
              auditHash: runtimeJson(audit).hash, policyHash: expect.any(String) } }), expect.objectContaining({ chapterId: canonicalChapter!.id })] })]) })
          const successor = { orderIndex: chapter.orderIndex + 1 }
          const source = await readCompilerContinuitySource(prisma, f, successor, chapter.id, 11)
          expect(source && 'terminalInheritance' in source ? source.terminalInheritance : []).toEqual(expect.arrayContaining([
            expect.objectContaining({ claim: canonicalClaim, depth: 2 })]))
          expect(JSON.parse(JSON.parse((audit.rawResponse as { content: string }).content)).terminalProofVerdicts[0].currentState).toBe('uncertain')
          expect(fetchMock).toHaveBeenCalledOnce()
          await prisma.chapter.update({ where: { id: canonicalChapter!.id }, data: { content: 'The old canonical chapter has changed.' } })
          const stale = await readCompilerContinuitySource(prisma, f, successor, chapter.id, 11)
          expect(stale && 'terminalInheritance' in stale && Array.isArray(stale.terminalInheritance)
            ? stale.terminalInheritance.some(fact => fact.claim === canonicalClaim) : false).toBe(false)
        }
      } else {
        const committed = await chapterBridgeCommitTool.execute({ ...ctx, callId: 'commit-current' }, { compilationId: compilation.id })
        expect(committed).toMatchObject({ outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' })
        expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toEqual(saved.validation)
        expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))).toMatchObject({ continuity: 'complete', terminalReview: { deliveryEligible: false } })
      }
      // Pure and database consumers reject a stale pointer rather than choosing
      // a better old fragment, and this rejection buys no additional request.
      const bad = { ...validation, effectiveReport: { ...(validation.effectiveReport as object), reportHash: 'f'.repeat(64) } }
      expect(effectiveContinuityAudit(bad)).toBeNull()
      expect(currentTerminalReview(bad, content, audit.terminalEvidence as Parameters<typeof currentTerminalReview>[2], binding)).toBeNull()
    }
    if (bodyOnly) {
      expect(await prisma.aiUsageLog.findMany({ where: { id: { in: bodyFees.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(bodyFees)
      expect(await prisma.agentArtifact.findMany({ where: { id: { in: bodyArtifacts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(bodyArtifacts)
      const repeat = await continuityValidateTool.execute({ ...ctx, callId: 'same-completed-terminal' }, { compilationId: compilation.id, terminalState: candidate })
      expect(repeat).toMatchObject({ reviewCompleted: true })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const replacement = await continuityValidateTool.execute({ ...ctx, callId: 'changed-candidate-no-new-slot' }, { compilationId: compilation.id,
        terminalState: terminalCandidateSchema.parse({ exitState: { objects: ['An unrelated new candidate.'] } }) })
      expect(replacement).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    const requestTotal = bodyOnly ? 2 : scenario === 'merged-revision' ? 3 : scenario === 'typed-sparse-repair' || scenario === 'repaired-background' ? 2 : 1
    expect(fetchMock).toHaveBeenCalledTimes(requestTotal)
    const usage = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
    expect(usage).toHaveLength(requestTotal)
    expect(usage[0]).toMatchObject({ multiplierBps: 15000, billingSnapshot: price, usageSource: 'reported', billingStatus: 'settled' })
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(requestTotal)
    if (scenario !== 'merged-revision') expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
  }, undefined, (scenario === 'repaired-background' || scenario === 'single-background') ? '修改第一章' : '修改第一章，只输出标题和正文', { freezeWriting: true, continuityEvidenceProtocol: 1, continuityReportProtocol: 5,
    terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }), 30000)
})
