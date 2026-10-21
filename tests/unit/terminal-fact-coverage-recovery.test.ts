import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readUnsentContinuityAdmission } from '../../api/lib/agent/continuity-reassessment-witness.js'
import { advanceTerminalCoverage, terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { inspectTerminalReview, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import * as sources from '../../api/lib/agent/compiler-continuity-source.js'
import * as original from '../../api/lib/agent/original-request.js'
import type { TerminalCarriedFact } from '../../api/lib/agent/terminal-evidence-context.js'
import { applyTerminalCandidatePatch, terminalCandidatePatchSchema } from '../../api/lib/agent/terminal-candidate-patch.js'
import { resolveTerminalCandidate } from '../../api/lib/agent/terminal-state-review.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'

afterEach(() => vi.restoreAllMocks())
describe('undispatched recovery with persisted terminal facts', () => {
  it.each(['top-level', 'nested', 'unknown-proof', 'duplicate-proof', 'changed-candidate', 'changed-frozen-candidate', 'other-owner','patch','patch-capacity','patch-second-unsent','patch-unknown-paid'] as const)(
    'authenticates explicit proof selection before dispatch without a provider call or write: %s', async scenario => {
      const spec = { id: 'original-task', scope: { terminalCoverageProtocol: 1, terminalQuoteAddressProtocol: 1, terminalEvidenceProtocol: 2 } }
      const subject = { userId: 'author', novelId: 'novel', runId: 'continued' }
      const chapter = { id: 'chapter', revision: 3, orderIndex: 4, title: 'Synthetic chapter', content: 'The crate is sealed.' }
      const claim = 'The pump still awaits a replacement seal.', hash = 'a'.repeat(64)
      const proof: TerminalCarriedFact = { proofHash: hash, segmentId: 't4', field: 'openLoops', claim, depth: 1,
        anchors: [{ chapterId: 'previous', revision: 2, contentHash: 'b'.repeat(64), start: 0, end: claim.length, quote: claim }],
        nodes: [{ compilationId: 'prior', chapterId: 'previous', revision: 2, orderIndex: 3, bodyHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64),
          validationHash: 'd'.repeat(64), stateHash: 'e'.repeat(64), path: 'exitState.openLoops.0', previousChapterId: null }] }
      const source = { revision: 2, content: claim, terminalInheritance: [proof], preceding: [{ id: 'previous', revision: 2, orderIndex: 3,
        contentHash: 'b'.repeat(64), start: 0, end: claim.length, joinedStart: 0, joinedEnd: claim.length }] } as unknown as Awaited<ReturnType<typeof sources.readCompilerContinuitySource>>
      const isPatch = scenario.startsWith('patch')
      const savedCandidate = terminalCandidateSchema.parse({ exitState: { objects: [chapter.content],...(scenario==='patch-capacity'?{openLoops:Array.from({length:30},(_,i)=>`Pending obligation ${i}`)}:{}) } })
      const patch = terminalCandidatePatchSchema.parse({baseCandidateHash:runtimeJson(savedCandidate).hash,removeFactIds:scenario==='patch-capacity'?[terminalFactId('openLoops',savedCandidate.exitState.openLoops[0])]:[],addFacts:[{field:'knowledge',claim:'The inventory is recorded.'}]})
      const patched = applyTerminalCandidatePatch(savedCandidate,patch)
      const selectionResult = resolveTerminalCandidate({...patched,inheritedProofs:[hash]},[proof],2)
      if (!selectionResult.ok) throw Error('Invalid synthetic patch')
      const candidate = isPatch ? selectionResult.candidate : terminalCandidateSchema.parse({ exitState: { objects: [chapter.content], openLoops: [claim] } })
      const bridge = { fromChapterId: 'previous', sourceRevision: 2 }, sceneTasks = [{ ordinal: 1 }]
      const compilation = { id: 'compilation', runId: 'original', chapter, bridge, sceneTasks, preparedContext: {}, validation: { terminalCandidate: savedCandidate } }
      const terminalEvidence = terminalEvidenceContext(chapter, source, 2, 1, terminalCoverageInput(spec, {}, chapter, candidate, 2), 3)
      const coverage = compilerContinuityCoverage({ chapter, bridge, sceneTasks, source, terminalCandidate: candidate }, 11)
      const selection = scenario === 'unknown-proof' ? ['f'.repeat(64)] : scenario === 'duplicate-proof' ? [hash, hash] : [hash]
      const args: Record<string, unknown> = { compilationId: compilation.id, ...(scenario === 'nested'
        ? { terminalState: { ...savedCandidate, inheritedProofs: selection } } : { inheritedProofs: selection }) }
      if (isPatch) args.terminalPatch = patch
      if (scenario === 'changed-candidate') args.terminalState = terminalCandidateSchema.parse({ exitState: { objects: ['The crate is open.'] } })
      const call = { id: 'call-event', runId: 'original', seq: 1, createdAt: new Date(100), payload: { callId: 'call', toolName: 'continuity_validate', args } }
      const result = { seq: 2, createdAt: new Date(300), payload: { callId: 'call', toolName: 'continuity_validate', ok: false } }
      const key = 'frozen-proof-only-request'
      const frozen = { chapterId: chapter.id, revision: chapter.revision, parserVersion: 8, terminalCandidate: scenario === 'changed-frozen-candidate' ? savedCandidate : candidate,
        bodies: { previous: claim, current: chapter.content, terminalEvidence }, bindingHash: runtimeJson(coverage).hash, targetType: 'story_compilation', targetId: compilation.id }
      const second = scenario==='patch-second-unsent'
      const reservations = [{id:'reservation', createdAt: new Date(120), metadata: { continuityAssessmentRequestKey: key, input: frozen } },
        {id:'not-dispatched', createdAt: new Date(200), metadata: second ? {fullReassessmentNotDispatchedKey:key,claimId:'claim'} : { firstAssessmentNotDispatchedKey: key } },
        ...(second?[{id:'claim',createdAt:new Date(190),metadata:{fullReassessmentKey:key}}, {id:'payment-link',createdAt:new Date(180),metadata:{assessmentRequestOwnerKey:key,usageIds:['payment']}}]:[])]
      const snapshot = {version:1,kind:'terminalCandidatePatch',identity:{...subject,runId:'original',callId:'call',taskId:spec.id,compilationId:compilation.id,chapterId:chapter.id,revision:chapter.revision,bodyHash:runtimeJson({content:chapter.content}).hash,sourceHash:runtimeJson({source}).hash},request:{patch,inheritedProofs:[hash]},base:savedCandidate,candidate}
      const write = vi.fn(() => { throw Error('Unexpected write') }), fetcher = vi.fn(() => { throw Error('Unexpected request') })
      vi.stubGlobal('fetch', fetcher)
      const findFirst = vi.fn().mockImplementation(({ where }) => Promise.resolve(where.userId === subject.userId && where.novelId === subject.novelId ? compilation : null))
      const db = { storyCompilation: { findFirst, update: write },
        agentRunEvent: { findMany: vi.fn().mockImplementation(({ where }) => Promise.resolve(where.type === 'tool.call' ? [call] : [result])), create: write },
        agentArtifact: { findMany: vi.fn().mockResolvedValue(reservations),findUnique:vi.fn().mockResolvedValue(isPatch?{runId:'original',metadata:snapshot}:null), create: write }, aiUsageLog: { findMany: vi.fn().mockResolvedValue(scenario==='patch-unknown-paid'?[{id:'unknown',billingStatus:'pending_usage',usageSource:'unknown'}]:second?[{id:'payment',agentRunId:'original',createdAt:new Date(160),action:'agent3ContinuityCritic',billingStatus:'settled',usageSource:'reported',requestTokens:10,responseTokens:0,requestCompletedAt:new Date(170),reservedCreditMilli:0}]:[]), create: write } }
      vi.spyOn(sources, 'readCompilerContinuitySource').mockResolvedValue(source)
      vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ spec, prompt: 'Synthetic original request', taskId: spec.id, sourceRunId: 'original', parentRunId: null })
      const before = JSON.stringify({ compilation, reservations, call })
      const restored = await readUnsentContinuityAdmission(db as unknown as Prisma.TransactionClient, scenario === 'other-owner' ? { ...subject, userId: 'other' } : subject, {
        runIds: ['original', 'continued'], compilationId: compilation.id, admission: { id: 'new-human-admission', at: new Date(400) }, retiredUsageIds: new Set(),
      })
      if (scenario === 'top-level' || scenario === 'nested' || isPatch&&scenario!=='patch-unknown-paid') expect(restored).toMatchObject({ chapter, coverage, sourceCallId: 'call', usageIds: second?['payment']:[] })
      else expect(restored).toBeNull()
      expect(JSON.stringify({ compilation, reservations, call })).toBe(before)
      expect(fetcher).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })
  it.each(['omitted', 'explicit-empty', 'context-drift', 'unknown-paid'] as const)(
    'reconstructs the exact frozen producer candidate without buying or replaying work: %s', async scenario => {
      const spec = { id: 'original-task', scope: { terminalCoverageProtocol: 1, terminalQuoteAddressProtocol: 1, terminalEvidenceProtocol: 2 } }
      const subject = { userId: 'author', novelId: 'novel', runId: 'continued' }
      const chapter = { id: 'chapter', revision: 3, orderIndex: 4, title: '合成章', content: '林舟右掌有伤，门还关着。' }
      const supported = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌有伤'] } })
      const evidence = terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(spec, {}, chapter, supported))
      const review = inspectTerminalReview(supported, chapter.content, JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.body.0', verdict: 'supported',
        basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '右掌有伤' }] }] }), true, evidence)!
      const preparedContext = { terminalFactCoverage: advanceTerminalCoverage(spec, {}, chapter, review) }
      const empty = terminalCandidateSchema.parse({ exitState: {} })
      const bridge = { fromChapterId: null, sourceRevision: null }, sceneTasks = [{ ordinal: 1 }]
      const compilation = { id: 'compilation', runId: 'original', chapter, bridge, sceneTasks, preparedContext, validation: null }
      const terminalEvidence = terminalEvidenceContext(chapter, null, 2, 1, terminalCoverageInput(spec, preparedContext, chapter, empty))
      const coverage = compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null, terminalCandidate: empty }, 11)
      const call = { id: 'call-event', runId: 'original', seq: 1, createdAt: new Date(100), payload: { callId: 'call', toolName: 'continuity_validate',
        args: { compilationId: compilation.id, ...(scenario === 'explicit-empty' ? { terminalState: empty } : {}) } } }
      const result = { seq: 2, createdAt: new Date(300), payload: { callId: 'call', toolName: 'continuity_validate', ok: false } }
      const key = 'frozen-not-dispatched-request'
      const frozen = { chapterId: chapter.id, revision: chapter.revision, parserVersion: 8, terminalCandidate: empty,
        bodies: { previous: null, current: chapter.content, terminalEvidence }, bindingHash: runtimeJson(coverage).hash,
        targetType: 'story_compilation', targetId: compilation.id }
      const reservations = [{ createdAt: new Date(120), metadata: { continuityAssessmentRequestKey: key, input: frozen } },
        { createdAt: new Date(200), metadata: { firstAssessmentNotDispatchedKey: key } }]
      const db = { storyCompilation: { findFirst: vi.fn().mockResolvedValue(compilation) },
        agentRunEvent: { findMany: vi.fn().mockImplementation(({ where }) => Promise.resolve(where.type === 'tool.call' ? [call] : [result])) },
        agentArtifact: { findMany: vi.fn().mockResolvedValue(reservations) },
        aiUsageLog: { findMany: vi.fn().mockResolvedValue(scenario === 'unknown-paid' ? [{ id: 'unknown', billingStatus: 'pending', usageSource: 'unknown' }] : []) } }
      vi.spyOn(sources, 'readCompilerContinuitySource').mockResolvedValue(null)
      vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ spec, prompt: '合成原请求', taskId: spec.id, sourceRunId: 'original', parentRunId: null })
      if (scenario === 'context-drift') frozen.bodies.terminalEvidence = { ...terminalEvidence, factCoverage: { ...terminalEvidence.factCoverage!, obligations: [] } }
      const restored = await readUnsentContinuityAdmission(db as unknown as Prisma.TransactionClient, subject, {
        runIds: ['original', 'continued'], compilationId: compilation.id, admission: { id: 'new-human-admission', at: new Date(400) }, retiredUsageIds: new Set(),
      })
      if (scenario === 'context-drift' || scenario === 'unknown-paid') expect(restored).toBeNull()
      else expect(restored).toMatchObject({ chapter, coverage, sourceCallId: 'call', usageIds: [] })
    })
})
