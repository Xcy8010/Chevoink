import { DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS } from '../support/durable-test-lifecycle.js'
import { describe, expect, it, vi } from 'vitest'
import { fixture, claim, available } from '../support/agent-durable-runtime-fixture.js'
import { initializeExecutionState } from '../support/native-tool-test-state.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prisma } from '../../api/lib/prisma.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as credits from '../../api/lib/credits.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { compilerStateHash } from '../../api/lib/agent/runtime-compiler-observation.js'
import { writingServiceOperationKey, prepareWritingServiceStep } from '../../api/lib/agent/runtime-writing-service.js'
import { prepareQualityWork } from '../../api/lib/agent/tools/durable-quality.js'
import { executePreparedCompilerWork } from '../../api/lib/agent/tools/durable-compiler.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { toOpenAIToolPresentation } from '../../api/lib/agent/tool-schema.js'
import { REVIEW_MAX_OUTPUT_TOKENS } from '../../api/lib/agent/review-completion.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

// Simulate a release boundary after an old commit admitted its internal check.
// Model/provider transport is synthetic; journal, billing and recovery use PG.
describe.runIf(available)('existing commit internal work survives the workflow upgrade', () => {
  it.each(['known-response', 'unknown-response'] as const)('%s preserves original operation identities before parent commit', async scenario => fixture(async f => {
    const lease = await claim(f), signal = new AbortController().signal
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '修改本章' })
    const args = { compilationId: compilation.id }, tools = [chapterBridgeCommitTool, qualityAnalyzeTool]
    const model = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high' as const, routeRevision: 'a'.repeat(64) }
    const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator',
      creativeFreedom: 'balanced', qualityMode: 'balanced', model,
      tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, ...toOpenAIToolPresentation(tool, f.spec.scope) } })),
      toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', dangerous: false, alwaysConfirm: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        successfulToolSignatures: [], messages: [{ role: 'user', content: '修改本章并检查质量。' }, { role: 'assistant', content: null,
          toolCalls: [{ id: 'old-commit', name: chapterBridgeCommitTool.name, arguments: JSON.stringify(args) }] }] } })
    const ctx: ToolContext = { ...f, callId: 'old-commit', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal, emit: () => {} }
    const source = initial.frame, baseline = { id: compilation.id, hash: (await withRunLease(lease, tx => compilerStateHash(tx, f.userId, f.novelId, f.rootId, compilation.id)))! }
    const parent = await prepareToolCursorOperation(lease, { expectedRevision: source.revision, expectedHash: source.snapshotHash }, {
      key: 'exec:' + source.state.nextOperationSequence, action: chapterBridgeCommitTool.name, callId: ctx.callId, effectDomain: 'compiler',
      targetId: f.rootId, effectiveArgs: args, normalize: raw => chapterBridgeCommitTool.parameters.parse(raw),
      operationInput: runtimeJson({ callId: ctx.callId, novelId: f.novelId, args, baseline }).value })
    const price = { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 0 }
    const work = await prepareQualityWork(ctx, lease, { operationKey: 'historical-check', observedRevision: source.revision, baseline, args, serviceReadOnly: true,
      frozenReview: { price, route: { tier: 'speed', customModelId: null, reasoningEffort: 'none', provider: 'fixture', model: 'fixture',
        baseUrl: 'https://provider.invalid/v1', maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS } } })
    expect(work.kind).toBe('check')
    if (work.kind !== 'check') throw Error('fixture needs a genuine quality work snapshot')
    const internal = await prepareWritingServiceStep(lease, { novelId: f.novelId, callId: ctx.callId, args, baseline, work,
      serviceAdmission: { version: 1, parentOperationId: parent.operation.id, parentInputHash: parent.operation.inputHash,
        sourceRevision: source.revision, sourceSnapshotHash: source.snapshotHash, step: 'quality', chapterId: f.chapterId, source: null } })
    expect(internal.operationKey).toBe(writingServiceOperationKey(parent.operation.id, 'quality', work.contextHash))
    const frozenInputHash = internal.inputHash
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-not-a-key', reasoningEffort: 'none', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
    const fetcher = vi.fn(async () => {
      if (scenario === 'unknown-response') throw new Error('fixture transport ended after dispatch')
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    if (scenario === 'known-response') {
      const actual = operations.commitOperationEffect
      const interrupted = vi.spyOn(operations, 'commitOperationEffect').mockImplementation((token, id, hash, apply) => actual(token, id, hash, async tx => {
        const result = await apply(tx)
        if (id === internal.id) throw Error('fixture crash before internal receipt')
        return result
      }))
      await expect(executePreparedCompilerWork(ctx, lease, parent.operation.id, chapterBridgeCommitTool)).rejects.toThrow('fixture crash before internal receipt')
      interrupted.mockRestore()
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: internal.id } })).toBe(0)
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { action: { not: 'fixture_model_turn' }, parentOperationId: internal.id }, status: 'succeeded' } })).toBe(1)
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: parent.operation.id } })).toMatchObject({ status: 'prepared' })
      await executePreparedCompilerWork(ctx, lease, parent.operation.id, chapterBridgeCommitTool)
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: internal.id } })).toMatchObject({ status: 'succeeded', inputHash: frozenInputHash })
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: parent.operation.id } })).toMatchObject({ status: 'succeeded' })
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: { in: [internal.id, parent.operation.id] } } })).toBe(2)
    } else {
      for (let index = 0; index < 2; index++) await expect(executePreparedCompilerWork(ctx, lease, parent.operation.id, chapterBridgeCommitTool)).rejects.toBeDefined()
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: { in: [internal.id, parent.operation.id] } } })).toBe(0)
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: parent.operation.id } })).toMatchObject({ status: 'prepared' })
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: internal.id } })).toMatchObject({ status: 'prepared', inputHash: frozenInputHash })
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { action: { not: 'fixture_model_turn' }, parentOperationId: internal.id }, status: { in: ['dispatching', 'unknown'] } } })).toBe(1)
    }
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await prisma.agentOperation.count({ where: { action: { not: 'fixture_model_turn' }, parentOperationId: parent.operation.id, kind: 'internal' } })).toBe(1)
    expect((await loadExecutionState(f.userId, f.runId)).head.configurationHash).toBe(initial.head.configurationHash)
  }, undefined, '修改本章并检查质量。'), DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS)
})
