import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import * as lease from '../../api/lib/agent/runtime-lease.js'
import * as cursor from '../../api/lib/agent/runtime-tool-cursor.js'
import * as reviewWork from '../../api/lib/agent/runtime-writing-service.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as observation from '../../api/lib/agent/runtime-compiler-observation.js'
import * as auxiliary from '../../api/lib/agent/runtime-auxiliary-call.js'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as continuitySource from '../../api/lib/agent/compiler-continuity-source.js'
import { executeDurableContinuity } from '../../api/lib/agent/tools/durable-continuity.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('durable explicit terminal proof selection', () => {
  it.each(['known', 'unknown', 'recovered'] as const)('freezes canonical facts and immutable selection identity for %s input without a provider request', async scenario => {
    const chapter = { id: 'current', title: 'Synthetic', revision: 1, orderIndex: 2, content: '林舟取走清单。' }
    const proofHash = 'a'.repeat(64), canonical = terminalCandidateSchema.parse({ exitState: { openLoops: ['过滤泵检修等零件'] } })
    const source = { id: '', revision: 0, content: '过滤泵仍待检修。', scope: 'current_and_previous_3_bounded', targetOrderIndex: 2,
      preceding: [{ id: 'prior', revision: 1, orderIndex: 1, contentHash: 'b'.repeat(64), start: 0, end: 8, joinedStart: 0, joinedEnd: 8 }], bridgeSource: null,
      terminalInheritance: [{ proofHash, field: 'openLoops', claim: canonical.exitState.openLoops[0], segmentId: 't9', depth: 1,
        anchors: [{ chapterId: 'prior', revision: 1, contentHash: 'b'.repeat(64), start: 0, end: 7, quote: '过滤泵仍待检修' }],
        nodes: [{ compilationId: 'prior-compilation', chapterId: 'prior', revision: 1, orderIndex: 1,
          bodyHash: 'b'.repeat(64), candidateHash: 'b'.repeat(64), validationHash: 'b'.repeat(64), stateHash: 'b'.repeat(64),
          path: 'exitState.openLoops.0', previousChapterId: null }] }] }
    const compilation = { id: 'comp', chapter, bridge: { fromChapterId: null }, sceneTasks: [{ ordinal: 1 }], preparedContext: {}, validation: {} }
    const coverage = compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source, terminalCandidate: canonical }, 11)
    compilation.validation = { independentCheck: 'complete', checkedRevision: 1, findings: [], coverage }
    const baseline = { id: 'comp', hash: 'c'.repeat(64) }
    const frozen = { kind: 'check', version: 14, compiler: baseline, chapter, terminalCandidate: canonical, sourceId: null, coverage,
      sourceScope: { currentOrderIndex: 2, previous: [] }, sourceBodies: { previous: source.content, current: chapter.content },
      criticInput: 'frozen canonical facts', criticSystem: 'frozen critic', repairSystem: 'frozen repair', repair: false, cached: [], route: null, price: null }
    const savedInput = { input: { work: frozen } }
    const tx = { agentOperation: {
      findUnique: vi.fn().mockResolvedValue(scenario === 'recovered' ? { inputSnapshot: savedInput, inputHash: runtimeJson(savedInput).hash } : null),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'prepared', effectReceipt: null }),
    }, storyCompilation: { findFirst: vi.fn().mockResolvedValue(compilation) } } as unknown as RuntimeTx
    vi.spyOn(lease, 'withRunLease').mockImplementation(async (_token, callback) => callback(tx))
    vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ prompt: '完成合成章节', spec: { scope: { terminalEvidenceProtocol: 2, continuityEvidenceProtocol: 1 } }, taskId: 'task', sourceRunId: 'r', parentRunId: null } as never)
    vi.spyOn(observation, 'compilerStateHash').mockResolvedValue(baseline.hash)
    const readSource = vi.spyOn(continuitySource, 'readCompilerContinuitySource').mockResolvedValue(source as never)
    const prepare = vi.spyOn(cursor, 'prepareToolCursorOperation').mockResolvedValue({ operation: { id: 'operation', inputHash: 'd'.repeat(64) },
      pending: { revision: 1, snapshotHash: 'e'.repeat(64) } } as Awaited<ReturnType<typeof cursor.prepareToolCursorOperation>>)
    vi.spyOn(reviewWork, 'readAdmittedReviewWork').mockImplementation(async () => ({ operation: { id: 'operation', inputHash: 'd'.repeat(64) },
      input: prepare.mock.calls[0][2].operationInput } as Awaited<ReturnType<typeof reviewWork.readAdmittedReviewWork>>))
    const failure = vi.spyOn(operations, 'recordToolFailure').mockImplementation(async (_token, args) => ({ result: {
      outcome: 'failed', effectApplied: false, code: args.code, toolResult: { output: args.output, summary: args.summary },
    } } as Awaited<ReturnType<typeof operations.recordToolFailure>>))
    vi.spyOn(operations, 'commitOperationEffect').mockResolvedValue({ result: { toolResult: { output: 'synthetic cached result', summary: 'synthetic cached result' }, memoryJobId: null } } as never)
    vi.spyOn(reducer, 'reduceExecutionReceipt').mockResolvedValue({} as Awaited<ReturnType<typeof reducer.reduceExecutionReceipt>>)
    const call = vi.spyOn(auxiliary, 'callDurableAuxiliary')
    const resolve = vi.spyOn(auxiliary, 'resolveDurableAuxiliaryRuntime')
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected paid request'))
    vi.stubGlobal('fetch', fetch)
    const ctx = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', chapterId: chapter.id, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
      signal: new AbortController().signal, emit: () => {}, durableCompiler: { operationKey: 'exec:0', baseline,
        lease: { userId: 'u', runId: 'r', taskRootId: 'root' }, cursor: { expectedRevision: 0, expectedHash: 'f'.repeat(64) } } } as ToolContext
    const args = { compilationId: 'comp', terminalState: { ...terminalCandidateSchema.parse({ exitState: {} }), inheritedProofs: [scenario === 'unknown' ? 'f'.repeat(64) : proofHash] } }
    const result = await executeDurableContinuity(ctx, continuityValidateTool, args)
    const prepared = prepare.mock.calls[0][2].operationInput as { args: typeof args; work: typeof frozen }
    expect(prepared.args.terminalState.inheritedProofs).toEqual(args.terminalState.inheritedProofs)
    if (scenario === 'unknown') {
      expect(result).toMatchObject({ outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' })
      expect(failure.mock.calls[0][1]).toMatchObject({ code: 'TERMINAL_STATE_REVIEW_REQUIRED' })
    } else {
      expect(prepared.work.terminalCandidate).toEqual(canonical)
      expect(prepared.work.terminalCandidate).not.toHaveProperty('inheritedProofs')
      expect(prepared.work.coverage.terminalHash).toBe(runtimeJson(canonical).hash)
      expect(failure).not.toHaveBeenCalled()
    }
    if (scenario === 'recovered') {
      expect(readSource).not.toHaveBeenCalled()
      expect(prepared.work).toEqual(frozen)
    } else expect(readSource).toHaveBeenCalledOnce()
    expect(call).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
