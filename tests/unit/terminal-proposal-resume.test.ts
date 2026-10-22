import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as recovery from '../../api/lib/agent/review-request-recovery.js'
import * as sources from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput, terminalCoverageProofs } from '../../api/lib/agent/terminal-fact-coverage.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts, terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalCandidatePatchSchema } from '../../api/lib/agent/terminal-candidate-patch.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readCompatibleTerminalProposal } from '../../api/lib/agent/terminal-proposal-resume.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

afterEach(() => vi.restoreAllMocks())
function fixture() {
  const subject = { userId: 'owner', novelId: 'novel', runId: 'run' }
  const target = { compilationId: 'compiler', chapterId: 'chapter', revision: 8 }
  const chapter = { id: target.chapterId, revision: 8, orderIndex: 6, content: 'The gauge reads two. The output remains unchanged.' }
  const previous = 'The operator passed the outer door before reaching the control room.'
  const spec: ReturnType<typeof buildTaskSpec> = JSON.parse(JSON.stringify(buildTaskSpec({ runId: subject.runId, novelId: subject.novelId, chapterId: chapter.id, prompt: '修改本章',
    continuityEvidenceProtocol: 1, terminalEvidenceProtocol: 2, terminalQuoteAddressProtocol: 1, terminalCoverageProtocol: 2 })))
  const source = { id: 'previous', revision: 15, content: previous, terminalInheritance: [], preceding: [{ id: 'previous', revision: 15,
    orderIndex: 5, contentHash: createHash('sha256').update(previous).digest('hex'), start: 0, end: previous.length, joinedStart: 0, joinedEnd: previous.length }] }
  const base = terminalCandidateSchema.parse({ exitState: { location: 'Inside the outer door of the control room.',
    knowledge: ['A combined reading.'], emotion: ['A distant suspicion.'] } })
  const context = terminalEvidenceContext(chapter, source as never, 2, 1, terminalCoverageInput(spec, {}, chapter, base, 2, terminalCoverageProofs(source as never, 2)), 5, 2)
  const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic review.', findingIndexes: [] })),
    terminalVerdicts: terminalCandidateFacts(base).map(fact => ({ factId: fact.id, verdict: fact.field === 'location' ? 'supported' : 'unknown',
      sourceEvidence: fact.field === 'location' ? [{ segmentId: 'c0' }, { segmentId: 'p0' }] : [] })), terminalProofVerdicts: [], terminalDispositions: [] })
  const inspected = inspectContinuityResponse(raw, { previous, current: chapter.content, terminalEvidence: context }, true, 8, base)
  expect(inspected.audit.classification).toBe('terminal_invalid')
  const validation = { independentCheck: 'unavailable', terminalCandidate: base, continuityCriticResponse: inspected.audit }
  const args = { compilationId: target.compilationId, terminalPatch: terminalCandidatePatchSchema.parse({ baseCandidateHash: runtimeJson(base).hash,
    removeFactIds: [terminalFactId('knowledge', base.exitState.knowledge[0]), terminalFactId('emotion', base.exitState.emotion[0])],
    addFacts: [{ field: 'knowledge', claim: 'The gauge reads two.' }, { field: 'knowledge', claim: 'The output remains unchanged.' }] }) }
  const run = { runtimeProtocolVersion: 0, taskRootId: null as string | null }
  const oldCall = { runId: subject.runId, type: 'tool.call', payload: { callId: 'original-call', toolName: 'continuity_validate', args } }
  const journal: unknown[] = []
  const db = { agentRun: { findFirst: vi.fn().mockResolvedValue(run) },
    agentRunEvent: { findMany: vi.fn(async ({ where }: { where: { type: unknown } }) => where.type === 'tool.call' ? [oldCall] : journal) },
    storyCompilation: { findFirst: vi.fn().mockResolvedValue({ chapter, bridge: { fromChapterId: source.id, sourceRevision: 15 }, validation, preparedContext: {} }) } }
  vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ spec, taskId: spec.id, sourceRunId: subject.runId, parentRunId: null, prompt: '修改本章' })
  vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue([subject.runId])
  const recovered = vi.spyOn(recovery, 'readReviewRequestRecovery').mockResolvedValue([{ callId: 'original-call', toolName: 'continuity_validate',
    compilationId: target.compilationId, chapterId: chapter.id, revision: chapter.revision, notDispatched: true,
    reconciliation: { status: 'terminal_failed_billing_known', sourceRunId: subject.runId, sourceResultId: 'original-result', sourceReportId: null,
      usageIds: [], currentRevision: chapter.revision, currentContentHash: createHash('sha256').update(chapter.content).digest('hex'), admissionId: 'human-continue' } }])
  vi.spyOn(sources, 'readCompilerContinuitySource').mockResolvedValue(source as never)
  return { subject, target, chapter, spec, source, args, validation, run, oldCall, journal, recovered, tx: db as unknown as Prisma.TransactionClient }
}

it('reuses the exact refused proposal with a stable identity, without a third main-model proposal or data writes', async () => {
  const f = fixture(), before = JSON.stringify(f.args)
  const first = await readCompatibleTerminalProposal(f.tx, f.subject, f.target)
  expect(first).toMatchObject({ args: f.args, callId: expect.stringMatching(/^terminal_resume_/u), claim: expect.stringMatching(/^terminal-compatibility:/u) })
  expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target)).toEqual(first)
  expect(JSON.stringify(f.args)).toBe(before)
})

it.each(['no-admission-proof', 'durable', 'wrong-protocol', 'stale-patch', 'changed-source', 'changed-body', 'damaged-audit'] as const)(
  'does not turn %s into another paid request', async scenario => {
    const f = fixture()
    if (scenario === 'no-admission-proof') f.recovered.mockResolvedValue([])
    if (scenario === 'durable') f.run.taskRootId = 'root'
    if (scenario === 'wrong-protocol') f.spec.scope.terminalEvidenceProtocol = 1
    if (scenario === 'stale-patch') f.args.terminalPatch.baseCandidateHash = 'f'.repeat(64)
    if (scenario === 'changed-source') f.source.revision++
    if (scenario === 'changed-body') f.chapter.revision++
    if (scenario === 'damaged-audit') f.validation.continuityCriticResponse.rawResponse.content = JSON.stringify('corrupt')
    expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target)).toBeNull()
  })

it('rechecks the same persisted call before execution and blocks a result, duplicate or altered journal', async () => {
  const f = fixture(), plan = (await readCompatibleTerminalProposal(f.tx, f.subject, f.target))!
  const call = { type: 'tool.call', runId: f.subject.runId, payload: { callId: plan.callId, toolName: 'continuity_validate', args: plan.args } }
  f.journal.push(call)
  expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target)).toBeNull()
  expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target, plan.callId)).toEqual(plan)
  f.journal.push({ ...call, type: 'tool.result' })
  expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target, plan.callId)).toBeNull()
  f.journal.pop()
  f.journal.push(call)
  expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target, plan.callId)).toBeNull()
  f.journal.pop()
  Object.assign(call.payload.args, { focus: 'A different request' })
  expect(await readCompatibleTerminalProposal(f.tx, f.subject, f.target, plan.callId)).toBeNull()
})
