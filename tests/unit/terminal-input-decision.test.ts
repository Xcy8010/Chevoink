import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { bindLegacyContinuityAssessment, readLegacyContinuityAssessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { readTerminalInputDecision, sameTerminalInputSubject, terminalInputDecisionAction, terminalInputDecisionCurrent, terminalInputSemanticKey } from '../../api/lib/agent/terminal-input-decision.js'
import { terminalProcessingEpisodeKey } from '../../api/lib/agent/terminal-processing.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalInputDecisionFixture } from '../helpers/terminal-input-decision-fixture.js'
import { terminalDraftFixture } from '../helpers/terminal-draft-fixture.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { prepareCompilerTerminalProposals } from '../../api/lib/agent/terminal-proposal-context.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

async function fixture(preserveDraft = false) {
  const ctx = { userId: 'owner', novelId: 'novel', runId: 'run', signal: new AbortController().signal }, prompt = '修改第一章，只输出标题和正文'
  const spec = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: 'chapter', prompt, continuityEvidenceProtocol: 1,
    terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 })
  spec.scope.writingTargetProtocol = 1
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: true, repairAuthorized: true }
  const chapter = { id: 'chapter', title: 'Inventory', revision: 4, orderIndex: 1, content: 'The packet remains sealed. The table remains dry.' }
  const bridge = { fromChapterId: null, sourceRevision: null }, scenes = [{ purpose: 'Inventory' }]
  let preparedContext: Record<string, unknown> = {}
  const initial = terminalInputDecisionFixture({ runId: ctx.runId, taskSpec: spec, chapter, compilationId: 'compilation', bridge, scenes, preparedContext })
  const draft = preserveDraft ? terminalDraftFixture('emotion', { chapter, taskId: spec.id, ctx, compilationId: 'compilation', candidate: initial.candidate,
    originBindingHash: runtimeJson(compilerContinuityCoverage({ chapter, bridge, sceneTasks: scenes, source: null, terminalCandidate: terminalDraftFixture('emotion').base }, 11)).hash,
    currentBindingHash: initial.frozen.bindingHash! }) : null
  if (draft) preparedContext = { ...draft.preparedContext }
  const f = draft ? terminalInputDecisionFixture({ runId: ctx.runId, taskSpec: spec, chapter, compilationId: 'compilation', bridge, scenes, preparedContext,
    proposals: draft.nextContext.proposalChanges }) : initial
  const run = { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId, chapterId: chapter.id, taskRootId: null, sessionId: 'session',
    status: 'paused', taskSpec: spec, startRequest: { prompt }, writingBindings: null }
  const rows = [...(draft?.rows.filter(row => row.id.startsWith('origin-')).map(row => row.metadata) ?? []), ...f.metadata]
    .map((metadata, index) => ({ id: `artifact-${index}`, runId: ctx.runId, artifactType: 'continuityReview', metadata, createdAt: new Date(100 + index) }))
  const usage = ['first-usage', 'second-usage'].map((id, index) => ({ id, userId: ctx.userId, novelId: ctx.novelId, agentRunId: ctx.runId,
    chapterId: chapter.id, targetType: 'story_compilation', targetId: 'compilation', action: index ? 'agent3ContinuityCriticSecondPass' : 'agent3ContinuityCritic',
    usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 23 }))
  if (draft) usage.push({ ...usage[0], id: 'usage-origin' })
  const events = [{ id: 'call', seq: 1, type: 'tool.call', createdAt: new Date(99), payload: { callId: f.callId, toolName: 'continuity_validate' } },
    { id: 'result', seq: 2, type: 'tool.result', createdAt: new Date(110), payload: { callId: f.callId, toolName: 'continuity_validate', ok: false, failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED' } }]
  const compilation = { id: 'compilation', userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapter, bridge,
    sceneTasks: scenes, preparedContext, validation: {} as Record<string, unknown> }
  type Args = { where: Record<string, unknown> }
  const artifacts = vi.fn(async ({ where }: Args) => {
    const meta = where.metadata as { path: string[]; equals: unknown } | undefined
    return rows.filter(row => (!where.artifactType || row.artifactType === where.artifactType)
      && (!where.runId || typeof where.runId === 'string' ? !where.runId || row.runId === where.runId : (where.runId as { in: string[] }).in.includes(row.runId))
      && (!meta || (row.metadata as Record<string, unknown>)[meta.path[0]] === meta.equals))
  })
  const owned = (where: Record<string, unknown>) => (!where.userId || where.userId === run.userId) && (!where.novelId || where.novelId === run.novelId)
  const tx = { agentRun: { findFirst: vi.fn(async ({ where }: Args) => owned(where) && where.id === ctx.runId ? run : null),
    findFirstOrThrow: vi.fn(async () => run), findMany: vi.fn(async ({ where }: Args) => where.session ? [] : [run]) },
  agentSession: { findFirst: vi.fn(async () => null) }, agentChildExecutionGrant: { findUnique: vi.fn(async () => null) },
  storyCompilation: { findFirst: vi.fn(async ({ where }: Args) => owned(where) && (!where.id || where.id === compilation.id) ? compilation : null),
    findMany: vi.fn(async () => [compilation]) },
  chapter: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) }, agentProviderAttempt: { count: vi.fn(async () => 0) },
  agentArtifact: { findMany: artifacts, findFirst: vi.fn(async (args: Args) => (await artifacts(args))[0] ?? null) },
  agentRunEvent: { findMany: vi.fn(async () => events) }, aiUsageLog: { findMany: vi.fn(async ({ where }: Args) => {
    const ids = (where.id as { in: string[] } | undefined)?.in
    const prefix = (where.action as { startsWith?: string } | undefined)?.startsWith
    return usage.filter(row => (!ids || ids.includes(row.id)) && (!prefix || row.action.startsWith(prefix))
      && (typeof where.action !== 'string' || row.action === where.action))
  }) } }
  const db = tx as unknown as Prisma.TransactionClient
  const received = await readLegacyContinuityAssessment(db, { ...ctx, callId: f.callId } as ToolContext, f.frozen)
  compilation.validation = { independentCheck: 'unavailable', checkedChapterId: chapter.id, checkedRevision: chapter.revision,
    terminalCandidate: f.candidate, coverage: f.coverage, continuityCriticResponse: bindLegacyContinuityAssessment(received.inspected, { ...ctx, callId: f.callId } as ToolContext, f.frozen).audit }
  return { ...f, draft, ctx, spec, chapter, run, rows, usage, events, compilation, tx, db, received,
    read: () => readTerminalInputDecision(db, ctx, compilation.id) }
}

describe('known invalid terminal input candidate decision', () => {
  it('reconstructs the real pending-draft report/save contract before permitting a genuinely changed candidate', async () => {
    const f = await fixture(true), draft = f.draft!
    const beforePending = JSON.stringify(f.compilation.preparedContext)
    expect(await f.read()).not.toBeNull()
    const context = terminalEvidenceContext(f.chapter, null, 2, 1, terminalCoverageInput(f.spec, {}, f.chapter, f.candidate, 2), 6, 2)
    const first = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: {}, validation: { independentCheck: 'complete',
      terminalCandidate: draft.base, continuityCriticResponse: draft.bound.audit }, chapter: f.chapter, source: null, candidate: f.candidate, nextContext: context })
    expect(first!.state).toEqual(draft.preparedContext.terminalProposalReview)
    const candidate = structuredClone(f.candidate); candidate.exitState.objects.push('The table remains dry.')
    const next = prepareCompilerTerminalProposals({ spec: f.spec, preparedContext: f.compilation.preparedContext, validation: f.compilation.validation,
      chapter: f.chapter, source: null, candidate, nextContext: context })
    expect(next!.state.pending).toEqual(first!.state.pending)
    expect(next!.changes!.candidateHash).toBe(runtimeJson(candidate).hash)
    expect(JSON.stringify(f.compilation.preparedContext)).toBe(beforePending)
    expect(sameTerminalInputSubject(f.frozen, { ...f.frozen, terminalCandidate: candidate })).toBe(false)
  })

  it('limits the handoff to one exact candidate decision or one first-phase exact target read', () => {
    const plan = { compilationId: 'compilation', chapterId: 'chapter' }
    const decision = { name: 'continuity_validate', args: { compilationId: plan.compilationId, terminalPatch: {} } }
    const read = { name: 'chapter_read', args: { chapterId: plan.chapterId } }
    const bridge = { name: 'chapter_bridge_get', args: { compilationId: plan.compilationId } }
    expect(terminalInputDecisionAction(plan, [decision], false, false)).toBe('decision')
    expect(terminalInputDecisionAction(plan, [decision], true, true)).toBe('decision')
    expect(terminalInputDecisionAction(plan, [read], false, false)).toBe('read')
    expect(terminalInputDecisionAction(plan, [bridge], false, false)).toBe('read')
    expect(terminalInputDecisionAction(plan, [{ name: 'ask_user', args: { question: 'Clarify the current candidate.' } }], true, true)).toBe('ask')
    for (const calls of [[], [decision, decision], [read, bridge], [{ ...decision, args: { ...decision.args, compilationId: 'other' } }],
      [{ ...decision, args: { ...decision.args, chapterId: 'other' } }], [{ ...decision, args: { compilationId: plan.compilationId } }],
      [{ ...read, args: { chapterId: 'other' } }], [{ ...bridge, args: { compilationId: 'other' } }],
      [{ name: 'chapter_write', args: { chapterId: plan.chapterId } }], [{ name: 'continuity_validate', args: null }]]) {
      expect(terminalInputDecisionAction(plan, calls, false, false)).toBeNull()
    }
    for (const call of [read, bridge]) {
      expect(terminalInputDecisionAction(plan, [call], true, false)).toBeNull()
      expect(terminalInputDecisionAction(plan, [call], false, true)).toBeNull()
    }
  })

  it('authenticates the returned pair without treating the standalone second verdicts as final support', async () => {
    const f = await fixture(), before = JSON.stringify({ rows: f.rows, usage: f.usage, validation: f.compilation.validation })
    expect(f.first.audit.classification).toBe('source_invalid'); expect(f.second.complete).toBe(true)
    expect(f.received).toMatchObject({ billingKnown: true, providerComplete: true, recoveryReady: true, inspected: { complete: false, audit: { classification: 'source_invalid' } } })
    const plan = await f.read()
    expect(plan).toMatchObject({ taskId: f.spec.id, chapterId: f.chapter.id, revision: 4, compilationId: 'compilation' })
    expect(plan!.key).toMatch(/^[a-f0-9]{64}$/u); expect(plan!.readKey).not.toBe(plan!.key)
    expect(plan!.guidance).toContain('readOnlyCoverage'); expect(plan!.guidance).toContain('inheritedProofs')
    expect(plan!.guidance).toContain('baseCandidateHash'); expect(plan!.guidance).toContain('another absent quotation')
    expect((await f.read())!.key).toBe(plan!.key)
    const episode = terminalProcessingEpisodeKey({ ...f.ctx, taskId: f.spec.id, chapterId: f.chapter.id,
      contentHash: plan!.contentHash, sourceHash: plan!.sourceHash, contractHash: runtimeJson(JSON.parse(JSON.stringify(f.spec))).hash })
    expect(plan!.nativeClaims).toEqual([0, 1].map(index => `terminal-processing:${episode}:${index}`))
    expect(JSON.stringify({ rows: f.rows, usage: f.usage, validation: f.compilation.validation })).toBe(before)
  })

  it('does not buy a different subject by changing prompt, focus binding, ordering or call identity', async () => {
    const f = await fixture(), next = structuredClone(f.frozen)
    next.content += ' Different focus.'; next.system += ' Different rendering.'; next.bindingHash = 'e'.repeat(64)
    expect(sameTerminalInputSubject(f.frozen, next)).toBe(true)
    next.terminalCandidate!.exitState.objects.push('The table remains dry.')
    expect(sameTerminalInputSubject(f.frozen, next)).toBe(false)
    const reordered = structuredClone(next); reordered.terminalCandidate!.exitState.objects.reverse()
    expect(sameTerminalInputSubject(next, reordered)).toBe(true)
    expect(terminalInputSemanticKey({ ...next, parserVersion: 7 })).toBeNull()
    expect(sameTerminalInputSubject(f.frozen, { ...f.frozen, bodies: { ...f.frozen.bodies, current: `${f.chapter.content} Changed.` } })).toBe(false)
  })

  it('rechecks the authenticated report after a main turn, independently of the persistent semantic slot', async () => {
    const f = await fixture(); f.run.status = 'running'
    const plan = (await f.read())!
    expect(terminalInputDecisionCurrent(plan, await f.read(), new Set())).toBe(true)
    for (const current of [null, { ...plan, runStatus: 'paused' }, { ...plan, proofHash: 'f'.repeat(64) }, { ...plan, key: 'e'.repeat(64) }]) {
      expect(terminalInputDecisionCurrent(plan, current, new Set())).toBe(false)
    }
    expect(terminalInputDecisionCurrent(plan, plan, new Set(plan.nativeClaims))).toBe(false)
  })

  it.each(['agent3ContinuityEvidenceCorrection', 'agent3ContinuityCritic'])(
    'blocks legacy target-owned unknown %s even without an agentRunId or provider-attempt row', async action => {
      const f = await fixture()
      f.usage.push({ ...f.usage[0], id: 'legacy-unknown', agentRunId: null as unknown as string, action,
        usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 23 })
      await expect(f.read()).resolves.toBeNull()
      expect(f.tx.aiUsageLog.findMany.mock.calls.some(([args]) => (args.where.action as { startsWith?: string })?.startsWith === 'agent3Continuity')).toBe(true)
    })

  it.each(['owner', 'task', 'chapter', 'revision', 'body', 'source', 'candidate', 'binding', 'audit', 'raw', 'missing', 'second-request',
    'second-unknown', 'fees', 'provider', 'unfinished-tool', 'event-time', 'duplicate-frame'] as const)('fails closed after %s drift', async scenario => {
    const f = await fixture()
    if (scenario === 'owner') f.ctx.userId = 'another-owner'
    if (scenario === 'task') f.spec.id = 'another-task'
    if (scenario === 'chapter') f.chapter.id = 'another-chapter'
    if (scenario === 'revision') f.chapter.revision++
    if (scenario === 'body') f.chapter.content += ' Changed.'
    if (scenario === 'source') f.compilation.bridge.fromChapterId = 'missing-source' as never
    if (scenario === 'candidate') (f.compilation.validation.terminalCandidate as typeof f.candidate).exitState.objects.push('Another draft.')
    if (scenario === 'binding') (f.compilation.validation.coverage as { reviewHash: string }).reviewHash = 'f'.repeat(64)
    if (scenario === 'audit') (f.compilation.validation.continuityCriticResponse as { contentHash: string }).contentHash = 'f'.repeat(64)
    const second = f.rows.find(row => (row.metadata as Record<string, unknown>).stage === 'reassessment' && 'response' in row.metadata)!
    if (scenario === 'raw') (second.metadata as { response: { content: string } }).response.content = 'not-json'
    if (scenario === 'missing') f.rows.splice(f.rows.indexOf(second), 1)
    if (scenario === 'second-request') (f.rows.find(row => 'fullReassessmentKey' in row.metadata)!.metadata as { request: { content: string } }).request.content += ' Changed.'
    if (scenario === 'second-unknown') (second.metadata as { response: { transportComplete: boolean } }).response.transportComplete = false
    if (scenario === 'fees') f.usage[1].billingStatus = 'pending_usage'
    if (scenario === 'provider') f.tx.agentProviderAttempt.count.mockResolvedValue(1)
    if (scenario === 'unfinished-tool') f.events.pop()
    if (scenario === 'event-time') f.events[1].createdAt = new Date(1)
    if (scenario === 'duplicate-frame') f.rows.push({ ...second, id: 'duplicate-frame' })
    await expect(f.read().catch(error => { expect(error).toMatchObject({ code: expect.stringMatching(/^(RUNTIME_|TERMINAL_)/u) }); return null })).resolves.toBeNull()
  })

  it('cancels before reading or minting any control identity', async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort()
    await expect(readTerminalInputDecision(f.db, { ...f.ctx, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
