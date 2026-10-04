import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import * as lease from '../../api/lib/agent/runtime-lease.js'
import * as cursor from '../../api/lib/agent/runtime-tool-cursor.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as auxiliary from '../../api/lib/agent/runtime-auxiliary-call.js'
import { executeDurableContinuity } from '../../api/lib/agent/tools/durable-continuity.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('old compiler continuity recovery before paid dispatch', () => {
  it.each(['missing-hash', 'old-protocol', 'committed-receipt'] as const)('%s preserves saved critic work without a new repair HTTP request', async scenario => {
    const oldCritic = { id: 'saved-critic', status: 'succeeded', providerResult: { content: '{"findings":[{"signal":"body","severity":"warning","evidence":"原文风险","suggestion":"局部澄清"}]}',
      usage: { promptTokens: 10, completionTokens: 2 }, chargedMilli: 5 } }
    const beforeCritic = structuredClone(oldCritic)
    const work = { kind: 'check', version: 1, compiler: { id: 'comp', hash: 'a'.repeat(64) },
      chapter: { id: 'c', title: '本章', revision: 1, content: '原文', orderIndex: 1 }, sourceId: null,
      coverage: { version: 1, contentHash: 'b'.repeat(64), charCount: 2, sourceHash: null,
        ...(scenario === 'old-protocol' ? { reviewHash: 'c'.repeat(64), protocolVersion: 1 } : {}) },
      criticInput: '完整正文：原文', criticSystem: 'old critic protocol', repairSystem: 'old repair protocol', repair: true, cached: null, route: null, price: null }
    const inputSnapshot = { input: { work } }, inputHash = runtimeJson(inputSnapshot).hash
    const result = { toolResult: { output: '原操作已完成', summary: '原连续性检查' }, memoryJobId: null }
    const savedReceipt = { result, resultHash: runtimeJson(result).hash }
    const tx = { agentOperation: { findUnique: vi.fn().mockResolvedValue({ inputSnapshot, inputHash }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ status: scenario === 'committed-receipt' ? 'succeeded' : 'prepared',
        effectReceipt: scenario === 'committed-receipt' ? savedReceipt : null }) } } as unknown as RuntimeTx
    vi.spyOn(lease, 'withRunLease').mockImplementation(async (_token, callback) => callback(tx))
    vi.spyOn(cursor, 'prepareToolCursorOperation').mockResolvedValue({ operation: { id: 'parent', inputHash }, pending: { revision: 1, snapshotHash: 'd'.repeat(64) } } as Awaited<ReturnType<typeof cursor.prepareToolCursorOperation>>)
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
    const returned = await executeDurableContinuity(ctx, continuityValidateTool, { compilationId: 'comp' })
    if (scenario === 'committed-receipt') {
      expect(returned).toEqual(result.toolResult)
      expect(failure).not.toHaveBeenCalled()
    } else {
      expect(returned).toMatchObject({ outcome: 'failed', summary: '连续性检查未执行' })
      expect(failure.mock.calls[0][1]).toMatchObject({ operationId: 'parent', inputHash, code: 'CONTINUITY_INPUT_STALE' })
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(oldCritic).toEqual(beforeCritic)
  })
})
