import { readToolApprovalOutcome } from '../../api/lib/agent/runtime-approval.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { retainedFindingSchema } from '../../api/lib/agent/tools/chapter-arguments.js'
import { projectNativeToolViews, currentNativeToolViews, previousImplicitStrictToolViews, needsNativeToolProjection, verifiedAssistantToolViews, readFrozenModelToolViews, readAssistantToolViews, toolWithNativeView, type NativeToolView } from '../../api/lib/agent/runtime-tool-view.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { toOpenAIParameters } from '../../api/lib/agent/tool-schema.js'
import { readExecutionFrame } from '../../api/lib/agent/runtime-state.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterBridgeCommitTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { getToolByName } from '../../api/lib/agent/tools/registry.js'

vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionFrame: vi.fn() }))
const view = (name: string, parameters: Record<string, unknown>, description = '旧平台说明'): NativeToolView => ({ type: 'function', function: { name, parameters, description } })

describe('current native built-in presentation', () => {
  it.each(['chapter_write', 'chapter_append', 'chapter_edit_range', 'continuity_validate', 'chapter_bridge_commit'])('does not require a new provider source frame for metadata-only %s clarification', async action => {
    const tool = getToolByName(action)!, scope = { novelId: 'n' }
    const { strict: _strict, ...implicit } = (await currentNativeToolViews([view(action, toOpenAIParameters(tool.parameters))], scope))[0].function
    const frozen: NativeToolView[] = [{ type: 'function', function: implicit }]
    const original = runtimeJson(frozen).hash
    const projected = await currentNativeToolViews(frozen, scope)
    expect(projected[0].function.strict).toBe(false)
    expect(runtimeJson(projected).hash).not.toBe(original)
    expect(await needsNativeToolProjection(frozen, scope, action)).toBe(false)
    expect(previousImplicitStrictToolViews(frozen, projected)).toEqual(frozen)
    expect(runtimeJson(frozen).hash).toBe(original)
  })
  it('still requires exact source authentication for real schema or description changes', async () => {
    const parameters = toOpenAIParameters(chapterWriteTool.parameters)
    for (const frozen of [[view('chapter_write', { ...parameters, required: ['content', 'writing'],
      properties: { ...(parameters.properties as object), writing: { type: 'object' } } })], [view('chapter_write', parameters, 'Different original instruction')]]) {
      expect(await needsNativeToolProjection(frozen, { novelId: 'n' }, 'chapter_write')).toBe(true)
      const f = sourceFixture({ tools: frozen })
      f.tx.agentOperation.findFirst.mockResolvedValue(null)
      await expect(verifiedAssistantToolViews(f.tx as unknown as RuntimeTx, 'root', f.frame, frozen, { novelId: 'n' })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    }
  })
  it('removes only platform coordination while preserving frozen identity and custom constraints', () => {
    const frozen = [view('chapter_write', { ...toOpenAIParameters(chapterWriteTool.parameters), required: ['content', 'writing', 'reviewer'],
      properties: { ...(toOpenAIParameters(chapterWriteTool.parameters).properties as object), writing: { type: 'object' }, reviewer: { type: 'string', enum: ['author'] }, content: { type: 'string', minLength: 4, maxLength: 30 } } }),
      view('private_custom', { type: 'object', properties: { writing: { type: 'boolean' } } })]
    const original = runtimeJson(frozen).hash
    const current = projectNativeToolViews(frozen, [chapterWriteTool], { novelId: 'n', writingCoordinationProtocol: 1 })
    expect(runtimeJson(frozen).hash).toBe(original)
    expect(current.map(item => item.function.name)).toEqual(['chapter_write', 'private_custom'])
    expect(current[1]).toEqual({ ...frozen[1], function: { ...frozen[1].function, strict: false } })
    expect(current[1].function.parameters).toBe(frozen[1].function.parameters)
    expect(current[0].function.description).not.toContain('actualOutcomes')
    expect(current[0].function.parameters).not.toHaveProperty('properties.writing')
    expect(current[0].function.parameters.required).toEqual(['content', 'reviewer'])
    const validator = toolWithNativeView(chapterWriteTool, current[0]).parameters
    expect(validator.safeParse({ chapterId: 'c', content: '正文四个字', reviewer: 'author' }).success).toBe(true)
    for (const args of [{ content: '短', reviewer: 'author' }, { content: '正文四个字', reviewer: 'other' }, { content: '正文四个字' }]) expect(validator.safeParse(args).success).toBe(false)
  })
  it('accepts only compilationId after the known old platform summary requirement is retired', () => {
    const frozen = [view('chapter_bridge_commit', { type: 'object', properties: { compilationId: { type: 'string', minLength: 1 },
      chapterSummary: { type: 'string', minLength: 1, maxLength: 2000 }, decisionOnly: { const: true } }, required: ['chapterSummary'] })]
    const next = projectNativeToolViews(frozen, [chapterBridgeCommitTool], { novelId: 'n' })[0]
    expect(next.function.parameters.required).toBeUndefined()
    expect(toolWithNativeView(chapterBridgeCommitTool, next).parameters.safeParse({ compilationId: 'comp' }).success).toBe(true)
    expect(frozen[0].function.parameters.required).toEqual(['chapterSummary'])
  })
  it('projects the exact archived platform retention field without its old forty-item ceiling', () => {
    const field = z.toJSONSchema(z.array(retainedFindingSchema).max(40).optional().describe('不能安全改动的当前意见逐项留置：continuity 的 reportId 使用工具给出的检查绑定，findingId 为从0开始的索引；quality 使用当前报告ID与意见ID。必须写明具体安全原因，留置不表示问题已修复'), { io: 'input' }) as Record<string, unknown>
    delete field.$schema
    const parameters = toOpenAIParameters(chapterBridgeCommitTool.parameters)
    const frozen = [view('chapter_bridge_commit', { ...parameters, properties: { ...(parameters.properties as object), retainedFindings: field } })]
    const original = runtimeJson(frozen).hash
    const next = projectNativeToolViews(frozen, [chapterBridgeCommitTool], { novelId: 'n' })[0]
    const refs = Array.from({ length: 42 }, (_, index) => ({ source: 'continuity', reportId: 'report', findingId: String(index), reason: '当前真实意见逐项保留待审' }))
    expect(toolWithNativeView(chapterBridgeCommitTool, next).parameters.safeParse({ compilationId: 'comp', retainedFindings: refs }).success).toBe(true)
    expect(next.function.parameters).not.toHaveProperty('properties.retainedFindings.maxItems')
    expect(runtimeJson(frozen).hash).toBe(original)
  })
  it('keeps a genuine custom two-item retention constraint in both the model view and call validation', () => {
    const parameters = toOpenAIParameters(chapterBridgeCommitTool.parameters)
    const field = { ...(parameters.properties as Record<string, object>).retainedFindings, maxItems: 2, description: '作者仅允许两项保留意见' }
    const frozen = [view('chapter_bridge_commit', { ...parameters, properties: { ...(parameters.properties as object), retainedFindings: field } })]
    const original = runtimeJson(frozen).hash
    const next = projectNativeToolViews(frozen, [chapterBridgeCommitTool], { novelId: 'n' })[0]
    const refs = Array.from({ length: 3 }, (_, index) => ({ source: 'quality', reportId: 'report', findingId: String(index), reason: '真实具体原因' }))
    const validator = toolWithNativeView(chapterBridgeCommitTool, next).parameters
    expect(validator.safeParse({ compilationId: 'comp', retainedFindings: refs.slice(0, 2) }).success).toBe(true)
    expect(validator.safeParse({ compilationId: 'comp', retainedFindings: refs }).success).toBe(false)
    expect(next.function.parameters).toHaveProperty('properties.retainedFindings.allOf')
    expect(runtimeJson(frozen).hash).toBe(original)
  })
  it('keeps a real additional summary constraint and required field', () => {
    const frozen = [view('chapter_bridge_commit', { type: 'object', properties: { compilationId: { type: 'string' },
      chapterSummary: { type: 'string', minLength: 10, pattern: '^作者' }, decisionOnly: { const: true } }, required: ['chapterSummary'] })]
    const next = projectNativeToolViews(frozen, [chapterBridgeCommitTool], { novelId: 'n' })[0]
    expect(next.function.parameters.required).toContain('chapterSummary')
    expect(toolWithNativeView(chapterBridgeCommitTool, next).parameters.safeParse({ compilationId: 'comp' }).success).toBe(false)
  })
})

function sourceFixture(options: { legacyReasoning?: boolean; siblings?: boolean; tools?: NativeToolView[] } = {}) {
  const tools = options.tools ?? [view('chapter_write', { type: 'object', properties: { content: { type: 'string' } } })]
  const messages = [{ role: 'user', content: '修改本章' }]
  const result = { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call', name: 'chapter_write', arguments: '{"content":"正文"}' }],
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, promptCacheHitTokens: null, promptCacheMissTokens: null } }
  const assistant = { role: 'assistant', content: null, ...(!options.legacyReasoning ? { reasoning: '' } : {}), toolCalls: result.toolCalls }
  const request = { endpoint: 'https://fixture.invalid/v1', body: { tools } }
  const inputSnapshot = { kind: 'provider', action: 'workspaceAgent', parentOperationId: null, input: { request } }
  const requestSnapshot = { provider: 'fixture', model: 'fixture', request }
  const attemptResult = { outcome: 'succeeded', result }
  const attempt = { id: 'attempt', requestSnapshot, requestHash: runtimeJson(requestSnapshot).hash, result: attemptResult, resultHash: runtimeJson(attemptResult).hash }
  const operation = { id: 'provider', status: 'succeeded', operationKey: 'exec:0', inputSnapshot, inputHash: runtimeJson(inputSnapshot).hash }
  const event = { taskRootId: 'root', operationId: 'provider', type: 'provider.result.recorded', payload: { attemptId: 'attempt', status: 'succeeded', resultHash: attempt.resultHash } }
  const frames = [
    { revision: 0, state: { phase: 'idle', messages, nextOperationSequence: 0 } },
    { revision: 1, state: { phase: 'awaiting_operation', pendingOperationId: 'provider', messages, nextOperationSequence: 1 } },
    { revision: 2, state: { phase: 'idle', messages: [...messages, assistant], nextOperationSequence: 1 } },
    { revision: 3, state: { phase: 'idle', messages: [...messages, assistant, { role: 'tool', toolCallId: 'sibling', content: '真实同批观察' }], nextOperationSequence: 2 } },
  ].map(frame => ({ ...frame, snapshotHash: runtimeJson(frame.state).hash }))
  vi.mocked(readExecutionFrame).mockImplementation(async (_tx, _root, revision) => frames[revision] as unknown as Awaited<ReturnType<typeof readExecutionFrame>>)
  const tx = { agentOperation: { findFirst: vi.fn().mockResolvedValue(operation) }, agentProviderAttempt: { findMany: vi.fn().mockResolvedValue([attempt]) }, agentExecutionOutbox: { findUnique: vi.fn().mockResolvedValue(event) } }
  return { tx, operation, attempt, event, frames, tools, frame: frames[options.siblings ? 3 : 2] as unknown as Awaited<ReturnType<typeof readExecutionFrame>> }
}

describe('assistant tool view source', () => {
  it.each(['previous', 'current', 'frozen', 'strict-changed', 'explicit-true-removed', 'explicit-false-removed', 'constraint', 'description', 'required', 'order'] as const)('authenticates the actual provider journal for %s views without changing old snapshots', async scenario => {
    const parameters = toOpenAIParameters(chapterWriteTool.parameters)
    const frozen = [view('chapter_write', { ...parameters, required: ['content', 'writing'],
      properties: { ...(parameters.properties as object), writing: { type: 'object' } } }),
      { ...view('private_true', { type: 'object', properties: { optional: { type: 'string' } } }),
        function: { ...view('private_true', { type: 'object', properties: { optional: { type: 'string' } } }).function, strict: true } },
      { ...view('private_false', { type: 'object' }), function: { ...view('private_false', { type: 'object' }).function, strict: false } }]
    const scope = { novelId: 'n' }, original = structuredClone(frozen)
    const current = await currentNativeToolViews(frozen, scope)
    const source = structuredClone(scenario === 'frozen' ? frozen : current)
    if (scenario !== 'current' && scenario !== 'frozen') delete source[0].function.strict
    if (scenario === 'strict-changed') source[0].function.strict = true
    if (scenario === 'explicit-true-removed') delete source[1].function.strict
    if (scenario === 'explicit-false-removed') delete source[2].function.strict
    if (scenario === 'constraint') source[0].function.parameters.properties = { content: { type: 'string', minLength: 999 } }
    if (scenario === 'description') source[0].function.description += ' changed'
    if (scenario === 'required') source[0].function.parameters.required = []
    if (scenario === 'order') source.reverse()
    const f = sourceFixture({ tools: source }), journal = structuredClone(f.attempt.requestSnapshot)
    // sourceFixture authenticates operation/request/result/outbox hashes and
    // the real assistant boundary, not merely a schema helper return value.
    const result = verifiedAssistantToolViews(f.tx as unknown as RuntimeTx, 'root', f.frame, frozen, scope)
    if (['previous', 'current', 'frozen'].includes(scenario)) await expect(result).resolves.toEqual(source)
    else await expect(result).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(frozen).toEqual(original)
    expect(f.attempt.requestSnapshot).toEqual(journal)
    expect(f.attempt.requestHash).toBe(runtimeJson(journal).hash)
  })
  it.each([undefined, false, true])('reads frozen strict=%s exactly and defaults only a new request view', strict => {
    const original = view('private_custom', { type: 'object', properties: { optional: { type: 'string' } } })
    if (strict !== undefined) original.function.strict = strict
    const snapshot = { input: { request: { body: { tools: [original] } } } }
    const hash = runtimeJson(snapshot).hash
    const frozen = readFrozenModelToolViews(snapshot)
    expect(frozen).toEqual([original])
    const current = projectNativeToolViews(frozen, [], { novelId: 'n' })
    expect(current[0].function.strict).toBe(strict ?? false)
    expect(current[0].function.parameters).toEqual(original.function.parameters)
    expect(runtimeJson(snapshot).hash).toBe(hash)
    expect(readFrozenModelToolViews(snapshot)).toEqual([original])
  })
  it.each([{ siblings: false }, { siblings: true }, { legacyReasoning: true }])('reads the exact source request across sibling results and empty-reasoning history %o', async options => {
    const f = sourceFixture(options)
    expect(await readAssistantToolViews(f.tx as unknown as RuntimeTx, 'root', f.frame)).toEqual(f.tools)
    expect(f.tx.agentOperation.findFirst).toHaveBeenCalledWith({ where: { id: 'provider', taskRootId: 'root', kind: 'provider', parentOperationId: null } })
  })
  it.each(['request-hash', 'request-owner', 'result-hash', 'result-content', 'event-owner', 'source-key', 'duplicate-result', 'unrelated-latest', 'missing-model-boundary'] as const)('rejects %s without taking a different request as authority', async scenario => {
    const f = sourceFixture()
    if (scenario === 'request-hash') f.attempt.requestHash = '0'.repeat(64)
    if (scenario === 'request-owner') { f.attempt.requestSnapshot.request.endpoint = 'https://other.invalid'; f.attempt.requestHash = runtimeJson(f.attempt.requestSnapshot).hash }
    if (scenario === 'result-hash') f.attempt.resultHash = '0'.repeat(64)
    if (scenario === 'result-content') { f.attempt.result.result.content = '冒充新调用'; f.attempt.resultHash = runtimeJson(f.attempt.result).hash; f.event.payload.resultHash = f.attempt.resultHash }
    if (scenario === 'event-owner') f.event.taskRootId = 'other-root'
    if (scenario === 'source-key') f.operation.operationKey = 'exec:99'
    if (scenario === 'duplicate-result') f.tx.agentProviderAttempt.findMany.mockResolvedValue([f.attempt, f.attempt])
    if (scenario === 'unrelated-latest') f.tx.agentOperation.findFirst.mockResolvedValue(null)
    if (scenario === 'missing-model-boundary') f.frames[1].state.phase = 'idle'
    await expect(readAssistantToolViews(f.tx as unknown as RuntimeTx, 'root', f.frame)).rejects.toThrow()
  })
})


describe('actual native approval payload binding', () => {
  it.each(['same-raw', 'changed-custom-raw', 'changed-business-raw'] as const)('keeps a normalized built-in approval bound to the complete %s arguments', async scenario => {
    const raw = JSON.stringify({ chapterId: 'c', content: '当前正文', reviewer: 'author' })
    const args = { chapterId: 'c', content: '当前正文' }
    const request = { id: 'request', taskRootId: 'root', type: 'approval.requested', payload: { version: 1, callId: 'call', toolName: 'chapter_write', sourceRevision: 2,
      sourceHash: 'source', rawArguments: raw, args, argsHash: runtimeJson(args).hash, expiresAt: '2030-01-01T00:00:00.000Z' } }
    const decision = { taskRootId: 'root', type: 'approval.resolved', payload: { version: 1, requestId: 'request', requestHash: runtimeJson(request.payload).hash, approved: true, userId: 'user' } }
    const tx = { agentExecutionOutbox: { findUnique: vi.fn(async ({ where }: { where: { eventKey: string } }) => where.eventKey === 'approval-decision:request' ? decision : request) } }
    const supplied = scenario === 'same-raw' ? raw : JSON.stringify({ chapterId: 'c', content: scenario === 'changed-business-raw' ? '另一版正文' : '当前正文', reviewer: scenario === 'changed-custom-raw' ? 'other' : 'author' })
    const result = readToolApprovalOutcome(tx as unknown as RuntimeTx, { taskRootId: 'root', runId: 'run', userId: 'user' } as RunLeaseToken, 'source', 'call', 'chapter_write', supplied)
    if (scenario === 'same-raw') await expect(result).resolves.toMatchObject({ status: 'approved', requestData: { rawArguments: raw, args } })
    else await expect(result).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(request.payload.rawArguments).toBe(raw)
  })
})
