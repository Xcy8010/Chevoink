import { afterEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { parseAuthorWritingRequest } from '../../api/lib/agent/author-writing-request.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'
import { projectBoundRevisionTarget, boundRevisionCorrectionResolvesInput } from '../../api/lib/agent/writing-target-correction.js'
import * as originalModule from '../../api/lib/agent/original-request.js'

afterEach(() => vi.restoreAllMocks())
const subject = { userId: 'author', novelId: 'novel', runId: 'source' }

function fixture(prompt = '人物表达太僵硬，全部重新写。') {
  const spec = buildTaskSpec({ ...subject, chapterId: 'chapter', prompt, authorWritingProtocol: 2, reviewProtocol: 1, localEditProtocol: 1 })
  const parsed = parseAuthorWritingRequest(prompt), hash = spec.scope.authorEffects!.requestHash
  const operations = parsed.evidence.operations.filter(operation => operation.accepted && operation.polarity === 'affirmative'
    && (operation.kind === 'revise' || operation.kind === 'write'))
  // A sealed old admission affected by the pre-fix binder. The author and
  // request already identify a chapter; only its derived target was lost.
  spec.scope.writingTargetProtocol = 2
  spec.scope.writingClarificationProtocol = 2
  spec.scope.writing = { version: 1, kind: 'needs_input', targets: [], repairAuthorized: false, titleAndBodyOnly: false }
  spec.scope.writingActions = { version: 1, requestHash: hash, operations: operations.map(operation => ({
    start: operation.span.start, end: operation.span.end, kind: operation.kind as 'write' | 'revise', resolution: 'needs_input', targets: [] })) }
  spec.scope.writingInterpretation = { version: 2, requestHash: hash, scopeHash: '', intent: 'revise', reasons: ['TARGET_UNRESOLVED'],
    revisionDenied: false, creationDenied: false, excludedChapterIds: [], operations: spec.scope.writingActions.operations.map(operation => ({
      start: operation.start, end: operation.end, kind: operation.kind, polarity: 'affirmative' })) }
  spec.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(spec.scope)
  const run = { id: 'source', userId: 'author', novelId: 'novel', sessionId: 'session', chapterId: 'chapter', engine: 'loop', runtimeProtocolVersion: 0,
    taskSpec: spec, incomingChildGrant: null, goalExecution: null, session: { spawnedFromRunId: null, spawnedFromSessionId: null },
    startRequest: withHumanAdmission({ novelId: 'novel', sessionId: 'session', chapterId: 'chapter', prompt, mode: 'build' }) }
  const mocks = { agentRun: { findFirst: vi.fn(async () => run) },
    agentMessage: { findMany: vi.fn(async () => [{ id: 'human', runId: 'source', sessionId: 'session', role: 'user', parts: [{ type: 'text', text: prompt }] }]) },
    chapter: { findFirst: vi.fn(async () => ({ id: 'chapter', orderIndex: 3, title: '候车' })) },
    agentRunEvent: { findFirst: vi.fn(async (args: { where: { type: string } }) => args.where.type === 'tool.call'
      ? { runId: 'source', seq: 20, payload: { toolName: 'ask_user', args: { question: '这次是指把第3章整章重写吗？', options: [{ label: '第3章' }, { label: '第1、2章一起重写' }] } } } : { payload: { toolName: 'story_compiler_prepare' } }) } }
  const tx = mocks as unknown as Prisma.TransactionClient
  const original = { prompt, spec, taskId: spec.id, sourceRunId: 'source', parentRunId: null }
  const source = { chapterId: 'chapter', sessionId: 'session' }
  return { spec, run, mocks, tx, original, source, project: () => projectBoundRevisionTarget(tx, subject, original, spec, source) }
}

it.each(['人物表达太僵硬，全部重新写。', '修改，写入正文', '修改正文'])('corrects the already admitted chapter for %s without changing the root or inventing an answer', async prompt => {
  const f = fixture(prompt), before = JSON.stringify(f.spec)
  const projected = await f.project()
  expect(projected?.writing).toMatchObject({ kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 3 }], repairAuthorized: true })
  expect(projected?.spec.scope.writingActions?.operations.every(operation => operation.resolution === 'bound')).toBe(true)
  expect(projected?.spec.scope.writingInterpretation?.scopeHash).toBe(frozenWritingScopeHash(projected!.spec.scope))
  expect(JSON.stringify(f.spec)).toBe(before)
  expect(projected).not.toHaveProperty('clarification')
})

it.each(['missing-message', 'different-request-chapter', 'missing-chapter', 'denied', 'read-only', 'local-boundary', 'child', 'excluded'] as const)(
  'keeps %s outside the compatibility correction', async scenario => {
    const f = fixture()
    if (scenario === 'missing-message') f.mocks.agentMessage.findMany.mockResolvedValue([])
    if (scenario === 'different-request-chapter') f.run.startRequest = withHumanAdmission({ ...f.run.startRequest, chapterId: 'other' })
    if (scenario === 'missing-chapter') f.mocks.chapter.findFirst.mockResolvedValue(null as never)
    if (scenario === 'denied') f.spec.scope.writingActions!.operations[0].resolution = 'denied'
    if (scenario === 'read-only') f.spec.scope.authorEffects!.manuscript = false
    if (scenario === 'local-boundary') f.spec.scope.localEditBoundary = { version: 1, kind: 'needs_input', regions: [] }
    if (scenario === 'child') Object.assign(f.original, { parentRunId: 'parent' })
    if (scenario === 'excluded') f.spec.scope.writingInterpretation!.excludedChapterIds = ['chapter']
    f.spec.scope.writingInterpretation!.scopeHash = frozenWritingScopeHash(f.spec.scope)
    expect(await f.project()).toBeNull()
  })

it.each(['修改第2章', '修改上一章'])('never substitutes the editor for an explicit different target: %s', async prompt => {
  const f = fixture(prompt)
  expect(await f.project()).toBeNull()
})

it('releases only the obsolete target question backed by the original failed prepare receipt', async () => {
  const f = fixture(), projected = await f.project()
  vi.spyOn(originalModule, 'originalTaskRunIds').mockResolvedValue(['source'])
  const scope = { ...f.original, spec: projected!.spec, writing: projected!.writing, targetCorrection: projected!.correction }
  expect(await boundRevisionCorrectionResolvesInput(f.tx, subject, scope, { kind: 'writing_scope', callId: 'question' })).toBe(true)
  expect(await boundRevisionCorrectionResolvesInput(f.tx, subject, scope, { kind: 'local_edit_scope', callId: 'question' })).toBe(false)
  f.mocks.agentRunEvent.findFirst.mockResolvedValueOnce({ runId: 'source', seq: 20, payload: { toolName: 'ask_user', args: {
    question: '人物应该离开还是留下？', options: [{ label: '离开' }, { label: '留下' }] } } } as never)
  expect(await boundRevisionCorrectionResolvesInput(f.tx, subject, scope, { kind: 'writing_scope', callId: 'question' })).toBe(false)
  f.mocks.agentRunEvent.findFirst.mockResolvedValueOnce({ runId: 'source', seq: 20, payload: { toolName: 'ask_user', args: {
    question: '是要《让主角牺牲》吗？', options: [{ label: '是' }, { label: '我补充' }] } } } as never)
  expect(await boundRevisionCorrectionResolvesInput(f.tx, subject, scope, { kind: 'writing_scope', callId: 'question' })).toBe(false)
  f.mocks.agentRunEvent.findFirst.mockResolvedValueOnce({ runId: 'source', seq: 20, payload: { toolName: 'ask_user', args: {
    question: '这次是指把第3章整章重写吗？', options: [{ label: '第3章，人物离开' }, { label: '第3章，人物留下' }] } } } as never)
  expect(await boundRevisionCorrectionResolvesInput(f.tx, subject, scope, { kind: 'writing_scope', callId: 'question' })).toBe(false)
  f.mocks.agentRunEvent.findFirst.mockResolvedValue(null as never)
  expect(await boundRevisionCorrectionResolvesInput(f.tx, subject, scope, { kind: 'writing_scope', callId: 'unrelated' })).toBe(false)
})
