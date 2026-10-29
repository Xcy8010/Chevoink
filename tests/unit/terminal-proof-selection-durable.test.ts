import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import * as lease from '../../api/lib/agent/runtime-lease.js'
import * as cursor from '../../api/lib/agent/runtime-tool-cursor.js'
import * as reviewWork from '../../api/lib/agent/runtime-writing-service.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as observation from '../../api/lib/agent/runtime-compiler-observation.js'
import * as runtimeState from '../../api/lib/agent/runtime-state.js'
import * as continuityReview from '../../api/lib/agent/continuity-review.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { currentNativeToolViews } from '../../api/lib/agent/runtime-tool-view.js'
import { toOpenAIToolPresentation } from '../../api/lib/agent/tool-schema.js'
import * as auxiliary from '../../api/lib/agent/runtime-auxiliary-call.js'
import * as originalRequest from '../../api/lib/agent/original-request.js'
import * as continuitySource from '../../api/lib/agent/compiler-continuity-source.js'
import { executeDurableContinuity } from '../../api/lib/agent/tools/durable-continuity.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const nativeRegistry = vi.hoisted(() => ({ getToolByName: vi.fn() }))
vi.mock('../../api/lib/agent/tools/registry.js', () => ({ getToolByName: nativeRegistry.getToolByName }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('historical durable terminal proof selection remains read-only', () => {
  it.each(['known', 'unknown', 'recovered'] as const)('preserves canonical facts and the original %s physical outcome without restarting the retired producer', async scenario => {
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
    const admittedInput = { novelId: 'n', callId: 'check', args: { compilationId: 'comp' }, baseline, work: frozen,
      normalization: { version: 1, rawArguments: '{"compilationId":"comp"}', normalizedArgsHash: runtimeJson({ compilationId: 'comp' }).hash,
        sourceRevision: 0, sourceSnapshotHash: 'f'.repeat(64) } }
    const savedInput = { input: admittedInput }
    const original = structuredClone(savedInput), physical = { raw: '{"findings":[]}', price: { rateCardId: 'original-frozen-price', multiplierBps: 11000 },
      status: scenario === 'unknown' ? 'unknown' : 'settled' }
    const originalPhysical = structuredClone(physical)
    const result = { toolResult: { output: 'synthetic cached result', summary: 'synthetic cached result' }, memoryJobId: null }
    const savedReceipt = { result, resultHash: runtimeJson(result).hash }
    const tx = { agentEffectReceipt: { findUnique: vi.fn().mockResolvedValue(scenario === 'recovered' ? savedReceipt : null) }, agentOperation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'operation', inputSnapshot: savedInput, inputHash: runtimeJson(savedInput).hash }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ status: 'prepared', effectReceipt: null }),
    }, storyCompilation: { findFirst: vi.fn().mockResolvedValue(compilation) } } as unknown as RuntimeTx
    vi.spyOn(lease, 'withRunLease').mockImplementation(async (_token, callback) => callback(tx))
    vi.spyOn(originalRequest, 'readOriginalTaskRequest').mockResolvedValue({ prompt: '完成合成章节', spec: { scope: { terminalEvidenceProtocol: 2, continuityEvidenceProtocol: 1 } }, taskId: 'task', sourceRunId: 'r', parentRunId: null } as never)
    vi.spyOn(observation, 'compilerStateHash').mockResolvedValue(baseline.hash)
    const readSource = vi.spyOn(continuitySource, 'readCompilerContinuitySource').mockResolvedValue(source as never)
    const prepare = vi.spyOn(cursor, 'prepareToolCursorOperation').mockResolvedValue({ operation: { id: 'operation', inputHash: 'd'.repeat(64) },
      pending: { revision: 1, snapshotHash: 'e'.repeat(64) } } as Awaited<ReturnType<typeof cursor.prepareToolCursorOperation>>)
    const admission = vi.spyOn(reviewWork, 'readAdmittedReviewWork').mockResolvedValue({ operation: { id: 'operation', inputHash: runtimeJson(savedInput).hash },
      input: admittedInput } as Awaited<ReturnType<typeof reviewWork.readAdmittedReviewWork>>)
    vi.spyOn(runtimeState, 'readExecutionFrame').mockResolvedValue({ revision: 1, snapshotHash: 'e'.repeat(64) } as Awaited<ReturnType<typeof runtimeState.readExecutionFrame>>)
    vi.spyOn(continuityReview, 'buildContinuitySnapshot').mockResolvedValue({ chapter, runIds: ['r'] } as Awaited<ReturnType<typeof continuityReview.buildContinuitySnapshot>>)
    vi.spyOn(continuityReview, 'readContinuityRequestBilling').mockResolvedValue({ known: scenario !== 'unknown', hasRequest: true,
      usageIds: ['original-usage'], nativeReceiptIds: ['original-attempt'] })
    const failure = vi.spyOn(operations, 'recordToolFailure').mockImplementation(async (_token, args) => ({ result: {
      outcome: 'failed', effectApplied: false, code: args.code, toolResult: { output: args.output, summary: args.summary },
    } } as Awaited<ReturnType<typeof operations.recordToolFailure>>))
    vi.spyOn(operations, 'commitOperationEffect').mockResolvedValue(savedReceipt as never)
    vi.spyOn(reducer, 'reduceExecutionReceipt').mockResolvedValue({} as Awaited<ReturnType<typeof reducer.reduceExecutionReceipt>>)
    const call = vi.spyOn(auxiliary, 'callDurableAuxiliary')
    const resolve = vi.spyOn(auxiliary, 'resolveDurableAuxiliaryRuntime')
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected paid request'))
    vi.stubGlobal('fetch', fetch)
    const ctx = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', chapterId: chapter.id, callId: 'check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
      signal: new AbortController().signal, emit: () => {}, durableCompiler: { operationKey: 'exec:0', baseline,
        lease: { userId: 'u', runId: 'r', taskRootId: 'root' }, cursor: { expectedRevision: 0, expectedHash: 'f'.repeat(64) } } } as ToolContext
    const args = { compilationId: 'comp', terminalState: { ...terminalCandidateSchema.parse({ exitState: {} }), inheritedProofs: [scenario === 'unknown' ? 'f'.repeat(64) : proofHash] } }
    const pending = executeDurableContinuity(ctx, continuityValidateTool, args)
    if (scenario === 'unknown') {
      await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(failure).not.toHaveBeenCalled()
    } else if (scenario === 'recovered') {
      expect(await pending).toEqual(result.toolResult)
      expect(failure).not.toHaveBeenCalled()
    } else {
      expect(await pending).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE' })
      expect(failure.mock.calls[0][1]).toMatchObject({ operationId: 'operation', inputHash: runtimeJson(savedInput).hash, code: 'CONTINUITY_REPORT_INCOMPLETE' })
    }
    expect(admission).toHaveBeenCalledWith(ctx.durableCompiler!.lease,
      { operationId: 'operation', action: 'continuity_validate', novelId: 'n', callId: 'check' })
    expect(prepare).not.toHaveBeenCalled()
    expect(readSource).not.toHaveBeenCalled()
    expect(savedInput).toEqual(original)
    expect(physical).toEqual(originalPhysical)
    expect(frozen.terminalCandidate).toEqual(canonical)
    expect(frozen.terminalCandidate).not.toHaveProperty('inheritedProofs')
    expect(call).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

// Exercise the actual current rejection path rather than recreating a terminal
// proof producer for a new unadmitted request.
describe('fresh retired terminal arguments', () => {
  it.each(['known', 'unknown', 'recovered'] as const)('refuses %s proof claims through the published current view without provider authority', async claim => {
    const token = { userId: 'u', novelId: 'n', runId: 'r', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'current', prompt: '检查本章' })
    nativeRegistry.getToolByName.mockImplementation(name => name === continuityValidateTool.name ? continuityValidateTool : undefined)
    const views = await currentNativeToolViews([{ type: 'function', function: { name: continuityValidateTool.name, ...toOpenAIToolPresentation(continuityValidateTool, spec.scope) } }], spec.scope)
    const raw = JSON.stringify({ compilationId: 'comp', terminalState: { inheritedProofs: [claim] } })
    const frame = { revision: 0, snapshotHash: 'a'.repeat(64), state: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
      phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'assistant', content: null,
        toolCalls: [{ id: 'fresh', name: 'continuity_validate', arguments: raw }] }] } }
    const tx = {} as RuntimeTx
    vi.spyOn(lease, 'withRunLease').mockImplementation(async (_lease, work) => work(tx))
    vi.spyOn(runtimeState, 'readExecutionStateInTransaction').mockResolvedValue({ frame, originalSpec: spec, configuration: { tools: views,
      toolAuthority: [{ name: 'continuity_validate', permission: 'allow', alwaysConfirm: false }] } } as Awaited<ReturnType<typeof runtimeState.readExecutionStateInTransaction>>)
    const prepare = vi.spyOn(operations, 'prepareOperationInTransaction').mockResolvedValue({ id: 'rejection', inputHash: 'b'.repeat(64) } as never)
    vi.spyOn(runtimeState, 'saveExecutionStateInTransaction').mockResolvedValue({ revision: 1, snapshotHash: 'c'.repeat(64) } as never)
    const failed = vi.spyOn(operations, 'recordToolFailureInTransaction').mockResolvedValue({ operationId: 'rejection', result: {
      outcome: 'failed', effectApplied: false, code: 'TOOL_CONTRACT_RETIRED', toolResult: { output: 'Original evidence retained', summary: 'Retired arguments refused' } } } as never)
    const fetcher = vi.fn(() => { throw Error('A refused proof claim cannot call a provider') }); vi.stubGlobal('fetch', fetcher)
    const result = await cursor.rejectToolCursorCall(token, { expectedRevision: 0, expectedHash: frame.snapshotHash }, 'fresh', continuityValidateTool)
    expect(prepare.mock.calls[0][2].input).toMatchObject({ callId: 'fresh', rejection: { rawArguments: raw, code: 'TOOL_CONTRACT_RETIRED' } })
    expect(failed).toHaveBeenCalledWith(tx, token, expect.objectContaining({ code: 'TOOL_CONTRACT_RETIRED' }))
    expect(result.receipt.result).toMatchObject({ outcome: 'failed', effectApplied: false, code: 'TOOL_CONTRACT_RETIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
