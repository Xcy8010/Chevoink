import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import * as lease from '../../api/lib/agent/runtime-lease.js'
import * as cursor from '../../api/lib/agent/runtime-tool-cursor.js'
import * as reviewWork from '../../api/lib/agent/runtime-writing-service.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as runtimeState from '../../api/lib/agent/runtime-state.js'
import * as continuityReview from '../../api/lib/agent/continuity-review.js'
import * as auxiliary from '../../api/lib/agent/runtime-auxiliary-call.js'
import { executeDurableContinuity } from '../../api/lib/agent/tools/durable-continuity.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('old compiler continuity recovery before paid dispatch', () => {
  it.each(['missing-hash', 'old-protocol', 'previous-protocol', 'protocol-five', 'protocol-five-unknown', 'committed-receipt'] as const)('%s preserves saved critic work without a new repair HTTP request', async scenario => {
    const oldCritic = { id: 'saved-critic', status: scenario === 'protocol-five-unknown' ? 'unknown' : 'succeeded', providerResult: { content: '{"findings":[{"signal":"body","severity":"warning","evidence":"原文风险","suggestion":"局部澄清"}]}',
      usage: { promptTokens: 10, completionTokens: 2 }, chargedMilli: 5 } }
    const beforeCritic = structuredClone(oldCritic)
    const work = { kind: 'check', version: 1, compiler: { id: 'comp', hash: 'a'.repeat(64) },
      chapter: { id: 'c', title: '本章', revision: 1, content: '原文', orderIndex: 1 }, sourceId: null,
      coverage: { version: 1, contentHash: 'b'.repeat(64), charCount: 2, sourceHash: null,
        ...(['old-protocol', 'previous-protocol', 'protocol-five', 'protocol-five-unknown'].includes(scenario) ? { reviewHash: 'c'.repeat(64), protocolVersion: scenario.startsWith('protocol-five') ? 5 : scenario === 'previous-protocol' ? 2 : 1 } : {}) },
      criticInput: '完整正文：原文', criticSystem: 'old critic protocol', repairSystem: 'old repair protocol', repair: true, cached: null, route: null, price: null }
    const admittedInput = { novelId: 'n', callId: 'old-check', args: { compilationId: 'comp' }, work,
      normalization: { version: 1, rawArguments: '{"compilationId":"comp"}', normalizedArgsHash: runtimeJson({ compilationId: 'comp' }).hash,
        sourceRevision: 0, sourceSnapshotHash: 'e'.repeat(64) } }
    const inputSnapshot = { input: admittedInput }, inputHash = runtimeJson(inputSnapshot).hash
    const result = { toolResult: { output: '原操作已完成', summary: '原连续性检查' }, memoryJobId: null }
    const savedReceipt = { result, resultHash: runtimeJson(result).hash }
    const tx = { agentEffectReceipt: { findUnique: vi.fn().mockResolvedValue(scenario === 'committed-receipt' ? savedReceipt : null) }, agentOperation: { findUnique: vi.fn().mockResolvedValue({ id: 'parent', inputSnapshot, inputHash }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ status: scenario === 'committed-receipt' ? 'succeeded' : 'prepared',
        effectReceipt: scenario === 'committed-receipt' ? savedReceipt : null }) } } as unknown as RuntimeTx
    vi.spyOn(lease, 'withRunLease').mockImplementation(async (_token, callback) => callback(tx))
    const prepare = vi.spyOn(cursor, 'prepareToolCursorOperation').mockResolvedValue({ operation: { id: 'parent', inputHash }, pending: { revision: 1, snapshotHash: 'd'.repeat(64) } } as Awaited<ReturnType<typeof cursor.prepareToolCursorOperation>>)
    // This test owns frozen-work recovery; actual tool/service provenance has
    // its separate negative matrix. Keep the same admitted input at that seam.
    const admission = vi.spyOn(reviewWork, 'readAdmittedReviewWork').mockResolvedValue({ operation: { id: 'parent', inputHash },
      input: admittedInput } as Awaited<ReturnType<typeof reviewWork.readAdmittedReviewWork>>)
    vi.spyOn(runtimeState, 'readExecutionFrame').mockResolvedValue({ revision: 1, snapshotHash: 'd'.repeat(64) } as Awaited<ReturnType<typeof runtimeState.readExecutionFrame>>)
    vi.spyOn(continuityReview, 'buildContinuitySnapshot').mockResolvedValue({ chapter: work.chapter, runIds: ['r'] } as Awaited<ReturnType<typeof continuityReview.buildContinuitySnapshot>>)
    vi.spyOn(continuityReview, 'readContinuityRequestBilling').mockResolvedValue({ known: scenario !== 'protocol-five-unknown', hasRequest: true,
      usageIds: ['original-usage'], nativeReceiptIds: ['original-attempt'] })
    vi.spyOn(operations, 'commitOperationEffect').mockResolvedValue(savedReceipt as Awaited<ReturnType<typeof operations.commitOperationEffect>>)
    const failure = vi.spyOn(operations, 'recordToolFailure').mockImplementation(async (_token, args) => ({ result: {
      outcome: 'failed', effectApplied: false, code: args.code, toolResult: { output: args.output, summary: args.summary },
    } } as Awaited<ReturnType<typeof operations.recordToolFailure>>))
    vi.spyOn(reducer, 'reduceExecutionReceipt').mockResolvedValue({} as Awaited<ReturnType<typeof reducer.reduceExecutionReceipt>>)
    const call = vi.spyOn(auxiliary, 'callDurableAuxiliary').mockResolvedValue(oldCritic.providerResult as unknown as Awaited<ReturnType<typeof auxiliary.callDurableAuxiliary>>)
    const resolve = vi.spyOn(auxiliary, 'resolveDurableAuxiliaryRuntime')
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected new paid request'))
    vi.stubGlobal('fetch', fetch)
    const ctx = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', chapterId: 'c', callId: 'old-check', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
      signal: new AbortController().signal, emit: () => {}, durableCompiler: { operationKey: 'exec:0', baseline: work.compiler,
        lease: { userId: 'u', runId: 'r', taskRootId: 'root' }, cursor: { expectedRevision: 0, expectedHash: 'e'.repeat(64) } } } as ToolContext
    const pending = executeDurableContinuity(ctx, continuityValidateTool, { compilationId: 'comp' })
    if (scenario === 'protocol-five-unknown') {
      await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(failure).not.toHaveBeenCalled()
    } else if (scenario === 'committed-receipt') {
      expect(await pending).toEqual(result.toolResult)
      expect(failure).not.toHaveBeenCalled()
    } else {
      expect(await pending).toMatchObject({ outcome: 'failed', summary: '原连续性报告未完成' })
      expect(failure.mock.calls[0][1]).toMatchObject({ operationId: 'parent', inputHash, code: 'CONTINUITY_REPORT_INCOMPLETE' })
    }
    expect(admission).toHaveBeenCalledWith(ctx.durableCompiler!.lease,
      { operationId: 'parent', action: 'continuity_validate', novelId: 'n', callId: 'old-check' })
    expect(prepare).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(oldCritic).toEqual(beforeCritic)
  })
})
