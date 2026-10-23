import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { DataAccessError, prisma } from '../../api/lib/prisma.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readReviewRequestRecoveryEvidence, readReviewRequestRecovery } from '../../api/lib/agent/review-request-recovery.js'
import { listAgentSessionHistoryData } from '../../api/lib/agent/run-service.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { prepareTerminalProposalInput } from '../../api/lib/agent/terminal-proposal-context.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import * as proposals from '../../api/lib/agent/terminal-proposal-context.js'
import * as credits from '../../api/lib/credits.js'

describe.runIf(available)('closed local candidate refusal is not an unknown provider request', () => {
  it('the real tool records a local stale delta without dispatch, charging or changing the manuscript', () => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: 'Review the saved chapter.' })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({
      terminalCandidate: terminalCandidateSchema.parse({ exitState: { objects: ['A sealed packet'] } }),
    }).value } })
    const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
    const network = vi.fn(() => { throw Error('Local refusal must not dispatch') })
    vi.stubGlobal('fetch', network)
    const result = await continuityValidateTool.execute({ ...f, callId: 'local-live', mode: 'build',
      creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }, {
      compilationId: compilation.id, terminalPatch: { baseCandidateHash: 'f'.repeat(64), removeFactIds: [], addFacts: [] },
    })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_INPUT_STALE', summary: '章末候选更新未应用',
      reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: chapter.revision,
        contentHash: createHash('sha256').update(chapter.content).digest('hex'), usageIds: [] } })
    expect(network).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(before)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
  }))
  it.each([false, true])('real proposal preflight with existing reservation=%s preserves dispatch uncertainty', reserved => fixture(async f => {
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
    const { compilation } = await prepareStoryCompilation({ ...f, chapterId: f.chapterId, mode: 'balanced', intentSummary: 'Review the saved chapter.' })
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['A sealed packet'] } })
    const unknown = terminalCandidateSchema.parse({ exitState: {} }).exitState
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: 'Check the packet', entryState: unknown,
      goal: 'Inspect it', obstacle: 'A seal', choice: 'Read the label', cost: 'Time', turn: 'Find the label', exitState: unknown,
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ terminalCandidate: candidate }).value } })
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const callId = 'producer-preflight'
    const reservation = reserved ? await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview',
      title: 'Synthetic original reservation', content: '', metadata: { version: 1, callId, continuityAssessmentRequestKey: 'a'.repeat(64) } } }) : null
    const prepare = vi.spyOn(proposals, 'prepareCompilerTerminalProposals').mockImplementation(() => {
      throw new DataAccessError(409, 'TERMINAL_STATE_REVIEW_REQUIRED', 'Synthetic local proposal refusal')
    })
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
    const network = vi.fn(() => { throw Error('Local preflight must not dispatch') })
    vi.stubGlobal('fetch', network)
    const operation = continuityValidateTool.execute({ ...f, callId, mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced',
      modelSelection: { tier: 'speed', customModelId: null, reasoningEffort: 'high', provider: 'fixture', modelName: 'fixture', routeRevision: 'a'.repeat(64) },
      signal: new AbortController().signal, emit: () => {} }, { compilationId: compilation.id, terminalState: candidate })
    if (reserved) await expect(operation).rejects.toMatchObject({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' })
    else expect(await operation).toMatchObject({ outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED',
      reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: chapter.revision,
        contentHash: createHash('sha256').update(chapter.content).digest('hex'), usageIds: [] } })
    expect(prepare).toHaveBeenCalledOnce()
    expect(network).not.toHaveBeenCalled()
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(chapter)
    // A local refusal still retains the monotonic check audit; it is not a free reset.
    expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }))
      .toMatchObject({ validation: { terminalCandidate: candidate, checkRounds: 1 } })
    if (reservation) expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: reservation.id } })).toEqual(reservation)
  }, undefined, '修改本章', { freezeWriting: true, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }))

  it.each(['known', 'typed', 'candidate-replacement', 'reservation', 'owner', 'response', 'snapshot', 'payment', 'earlier-unknown', 'overlap',
    'duplicate', 'plain-state', 'valid-patch', 'newer-candidate', 'newer-body', 'wrong-code', 'durable'] as const)(
    '%s preserves the original evidence and does not create paid retry authority', scenario => fixture(async f => {
      const network = vi.fn(() => { throw Error('This reconciliation must remain offline') })
      vi.stubGlobal('fetch', network)
      try {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: scenario === 'durable' ? f.rootId : null, runtimeProtocolVersion: scenario === 'durable' ? 1 : 0 } })
        const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '检查本章' })
        const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const base = terminalCandidateSchema.parse({ exitState: scenario === 'candidate-replacement'
          ? { knowledge: ['Combined reading'], emotion: ['Unverified suspicion'] } : { objects: ['A sealed packet'] } })
        const start = Date.now() + 1000, at = (ms: number) => new Date(start + ms)
        const patch = scenario === 'candidate-replacement' ? { baseCandidateHash: runtimeJson(base).hash,
          removeFactIds: [terminalFactId('knowledge', base.exitState.knowledge[0]), terminalFactId('emotion', base.exitState.emotion[0])],
          addFacts: [{ field: 'knowledge', claim: 'First reading' }, { field: 'knowledge', claim: 'Second reading' }] }
          : { baseCandidateHash: scenario === 'valid-patch' ? runtimeJson(base).hash : 'f'.repeat(64), removeFactIds: [], addFacts: [] }
        await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({
          terminalCandidate: base, checkedAt: at(scenario === 'newer-candidate' ? 200 : -100).toISOString(), checkedRevision: chapter.revision,
          ...(scenario === 'candidate-replacement' ? { independentCheck: 'unavailable', continuityCriticResponse: { classification: 'terminal_invalid',
            terminalCandidate: base, terminalContentHash: runtimeJson({ content: chapter.content }).hash } } : {}),
        }).value } })
        if (scenario === 'newer-body') await prisma.chapter.update({ where: { id: chapter.id }, data: { content: chapter.content, updatedAt: at(200) } })
        const call = { callId: 'local-delta', toolName: 'continuity_validate', args: { compilationId: compilation.id,
          ...(scenario === 'plain-state' ? { terminalState: base } : { terminalPatch: patch }) } }
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: call, createdAt: at(0) } })
        if (scenario === 'duplicate') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', payload: call, createdAt: at(1) } })
        if (scenario === 'overlap') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call',
          payload: { toolName: 'quality_analyze', callId: 'other-review' }, createdAt: at(50) } })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.result', createdAt: at(400), payload: {
          callId: call.callId, toolName: call.toolName, ok: false, failureCode: scenario === 'wrong-code' ? 'AI_PROVIDER_TRANSPORT' : scenario === 'candidate-replacement' ? 'TERMINAL_STATE_REVIEW_REQUIRED' : 'CONTINUITY_INPUT_STALE',
          ...(scenario === 'typed' || scenario === 'candidate-replacement' ? { reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: chapter.revision,
            contentHash: createHash('sha256').update(chapter.content).digest('hex'), usageIds: [] } } : {}),
        } } })
        const stop = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.paused', createdAt: at(401), payload: {} } })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'run.started', createdAt: at(500),
          payload: { authorContinue: { eventId: stop.id, afterSeq: 4 } } } })
        if (['reservation', 'owner', 'response', 'snapshot'].includes(scenario)) await prisma.agentArtifact.create({ data: {
          runId: f.runId, artifactType: 'continuityReview', title: 'Internal request proof', content: '',
          metadata: scenario === 'snapshot' ? { version: 1, kind: 'terminalCandidatePatch', identity: { callId: call.callId } }
            : { version: 1, callId: call.callId, [scenario === 'reservation' ? 'continuityAssessmentRequestKey' : scenario === 'owner' ? 'assessmentRequestOwnerKey' : 'assessmentResponseKey']: 'owned' },
        } })
        if (['payment', 'earlier-unknown'].includes(scenario)) await prisma.aiUsageLog.create({ data: {
          userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: chapter.id, targetType: 'story_compilation', targetId: compilation.id,
          providerType: 'text', providerMode: 'custom', modelName: 'synthetic', action: 'agent3ContinuityCritic',
          usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null,
          reservedCreditMilli: 16000, durationMs: 10, createdAt: at(scenario === 'payment' ? 100 : -200),
        } })
        const pending = [{ callId: call.callId, toolName: 'continuity_validate' as const, compilationId: compilation.id, chapterId: chapter.id, revision: chapter.revision }]
        const history = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
        const usages = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
        const body = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
        const evidence = await prisma.$transaction(tx => readReviewRequestRecoveryEvidence(tx, f, pending))
        const recovered = await prisma.$transaction(tx => readReviewRequestRecovery(tx, f, pending))
        const permitted = scenario === 'known' || scenario === 'typed' || scenario === 'candidate-replacement'
        expect(evidence).toHaveLength(permitted ? 1 : 0)
        expect(recovered).toHaveLength(permitted ? 1 : 0)
        if (permitted) expect(await prisma.$transaction(tx => readReviewRequestRecoveryEvidence(tx, f)))
          .toMatchObject([{ notDispatched: true, callId: call.callId }])
        if (permitted) expect(recovered[0]).toMatchObject({ notDispatched: true, callId: call.callId, reconciliation: { usageIds: [], sourceReportId: null } })
        expect(await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })).toEqual(history)
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })).toEqual(usages)
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toEqual(body)
        expect(network).not.toHaveBeenCalled()
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))

  it.each((['bare', 'explicit', 'initial-explicit'] as const).flatMap(kind =>
    (['known', 'reservation', 'unknown-usage', 'changed-body', 'corrupt-audit', 'duplicate-call', 'extra-field'] as const).map(scenario => [kind, scenario] as const)))(
    '%s resumed proposal preflight %s is reconciled only with complete owned evidence', (kind, scenario) => fixture(async f => {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
      const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: 'The gauge reads two.', wordCount: 20 } })
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: 'Review the saved chapter.' })
      const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId: f.spec.id, chapterId: chapter.id, obligations: [] }, 5, 2)
      const base = terminalCandidateSchema.parse({ exitState: { knowledge: ['A combined reading.', 'A different unsupported event.'] } })
      const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The gauge reads two.'] } })
      const response = (selected: typeof base) => JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
        ({ kind, result: 'clear', reason: 'Checked the synthetic body.', findingIndexes: [] })),
      terminalVerdicts: terminalCandidateFacts(selected).map(fact => ({ path: fact.path, verdict: 'unknown', sourceEvidence: [] })),
      terminalProofVerdicts: [], terminalDispositions: [] })
      const prior = inspectContinuityResponse(response(base), { previous: null, current: chapter.content, terminalEvidence: context }, true, 8, base)
      expect(prior.complete).toBe(true)
      const staged = prepareTerminalProposalInput({ spec: f.spec, preparedContext: {}, validation: {
        independentCheck: 'complete', terminalCandidate: base, continuityCriticResponse: prior.audit }, content: chapter.content, previousContent: null,
      candidate, originalContext: context, nextContext: context })!
      const evidence = { ...context, proposalChanges: staged.changes }
      const invalid = inspectContinuityResponse(response(candidate), { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
      expect(invalid.complete).toBe(false)
      const firstInvalid = inspectContinuityResponse(JSON.stringify({ ...JSON.parse(response(base)), proposalDispositions: 'invalid' }),
        { previous: null, current: chapter.content, terminalEvidence: context }, true, 8, base)
      const firstFailure = kind === 'initial-explicit'
      const start = Date.now() + 1000, at = (ms: number) => new Date(start + ms), callId = 'resumed-review'
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: {
        preparedContext: runtimeJson(firstFailure ? {} : { terminalProposalReview: staged.state }).value,
        validation: runtimeJson({ independentCheck: 'unavailable', checkedChapterId: chapter.id, checkedRevision: chapter.revision,
          checkedAt: at(-100).toISOString(), checkedContent: chapter.content, terminalCandidate: firstFailure ? base : candidate, continuityCriticResponse: { ...(firstFailure ? firstInvalid.audit : invalid.audit),
            ...(scenario === 'corrupt-audit' ? { contentHash: 'f'.repeat(64) } : {}),
            assessmentRequest: { version: 1, key: 'a'.repeat(64), inputHash: 'b'.repeat(64) } } }).value,
      } })
      const refusedChapter = kind !== 'bare' ? await prisma.chapter.update({ where: { id: chapter.id },
        data: { revision: { increment: 1 }, content: chapter.content + ' The room is cold.', updatedAt: at(-50) } }) : chapter
      const args = { compilationId: compilation.id, ...(kind !== 'bare' ? { terminalState: candidate } : {}),
        ...(scenario === 'extra-field' ? { focus: 'different request' } : {}) }
      await prisma.agentRunEvent.createMany({ data: [
        { runId: f.runId, seq: 1, type: 'tool.call', createdAt: at(0), payload: { callId, toolName: 'continuity_validate', args } },
        { runId: f.runId, seq: 2, type: 'tool.result', createdAt: at(400), payload: { callId, toolName: 'continuity_validate', ok: false, failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' } },
      ] })
      if (scenario === 'duplicate-call') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.call',
        createdAt: at(1), payload: { callId, toolName: 'continuity_validate', args } } })
      if (scenario === 'reservation') await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview',
        title: 'Synthetic original reservation', content: '', metadata: { callId, continuityAssessmentRequestKey: 'a'.repeat(64) } } })
      if (scenario === 'unknown-usage') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId,
        chapterId: chapter.id, targetType: 'story_compilation', targetId: compilation.id, action: 'agent3ContinuityCritic', providerType: 'text',
        providerMode: 'custom', modelName: 'synthetic', usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 16000,
        durationMs: 10, createdAt: at(-200) } })
      // Model the edit AFTER this synthetic call, rather than wall-clock now before its future timestamp.
      if (scenario === 'changed-body') await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: { increment: 1 }, updatedAt: at(500) } })
      const pending = [{ callId, toolName: 'continuity_validate' as const, compilationId: compilation.id, chapterId: chapter.id, revision: refusedChapter.revision }]
      const withPending = await prisma.$transaction(tx => readReviewRequestRecoveryEvidence(tx, f, pending))
      const discovered = await prisma.$transaction(tx => readReviewRequestRecoveryEvidence(tx, f))
      expect(withPending).toHaveLength(scenario === 'known' ? 1 : 0)
      expect(discovered).toHaveLength(scenario === 'known' ? 1 : 0)
      if (scenario === 'known') expect(discovered[0]).toMatchObject({ callId, notDispatched: true, revision: refusedChapter.revision, receipt: { usageIds: [], currentRevision: refusedChapter.revision } })
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toMatchObject({ validation: { independentCheck: 'unavailable', checkedRevision: chapter.revision } })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).toMatchObject({ content: refusedChapter.content })
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(scenario === 'unknown-usage' ? 1 : 0)
    }, undefined, '修改本章', { freezeWriting: true, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 }))

  it('history keeps actual reports and preserves all private audit rows', () => fixture(async f => {
    const records = await Promise.all([
      prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Actual continuity report', content: 'A real report.', metadata: { findings: [] } } }),
      prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Request audit', content: '', metadata: { version: 1, continuityAssessmentRequestKey: 'private', input: { raw: 'private full request' } } } }),
      prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'continuityReview', title: 'Candidate snapshot', content: '', metadata: { version: 1, kind: 'terminalCandidatePatch', candidate: { private: 'state' } } } }),
    ])
    const response = await listAgentSessionHistoryData(f.userId, f.sessionId)
    expect(response.items.flatMap(item => item.artifacts).map(item => item.id)).toEqual([records[0].id])
    expect(JSON.stringify(response)).not.toContain('private full request')
    expect(await prisma.agentArtifact.findMany({ where: { id: { in: records.map(row => row.id) } }, orderBy: { id: 'asc' } }))
      .toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)))
  }))
})
