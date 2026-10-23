import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest } from '../../api/lib/agent/coordinated-writing-input.js'
import { assertWritingServicePolicy, assertWritingReviewWork, readAdmittedWritingServiceStep, readCommittedWritingBodyProgress } from '../../api/lib/agent/runtime-writing-service.js'

const mocks = vi.hoisted(() => ({ admitted: vi.fn(), observation: vi.fn(), original: vi.fn(), state: vi.fn(), policy: vi.fn(), writingTarget: vi.fn() }))
vi.mock('../../api/lib/agent/writing-scope.js', async original => ({ ...await original<object>(), assertWritingTarget: mocks.writingTarget }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(), readAdmittedToolOperation: mocks.admitted }))
vi.mock('../../api/lib/agent/runtime-observed-baseline.js', async original => ({ ...await original<object>(), readObservedBaseline: mocks.observation }))
vi.mock('../../api/lib/agent/original-request.js', async original => ({ ...await original<object>(), readOriginalTaskRequest: mocks.original }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(), readExecutionStateInTransaction: mocks.state }))
vi.mock('../../api/lib/agent/agents.js', () => ({ applySessionToolPolicy: mocks.policy }))
vi.mock('../../api/lib/agent/tools/registry.js', () => ({ getToolByName: (name: string) => ({ name, permission: { build: 'allow' }, readOnly: false }) }))

const lease = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const actions = ['story_compiler_prepare', 'scene_task_build', 'chapter_write']
const tx = { agentOperation: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() },
  agentSession: { findUnique: vi.fn() }, agentExecutionOutbox: { findUnique: vi.fn() }, $queryRaw: vi.fn() }
const transaction = tx as unknown as Prisma.TransactionClient
let parent: Record<string, unknown>, child: { id: string; action: string; inputHash: string; inputSnapshot: ReturnType<typeof runtimeJson>['value']; operationKey: string; parentOperationId: string; kind: string }
let configuration: { mode: 'build'; tools: Array<{ function: { name: string } }>; toolAuthority: Array<{ name: string; permission: 'allow' | 'ask' | 'deny'; alwaysConfirm: boolean }> }
const subject = { operationId: 'body', action: 'chapter_write', novelId: 'novel', callId: 'writer-call' }

beforeEach(() => {
  vi.clearAllMocks()
  const spec = buildTaskSpec({ runId: lease.runId, novelId: 'novel', chapterId: 'chapter', prompt: '完整改写本章' })
  spec.writingPacing = 'explicit_writing'; spec.scope.writingCoordinationProtocol = 1
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 1, chapterId: 'chapter' }], titleAndBodyOnly: false, repairAuthorized: true }
  const writing = { draftComplete: false }, args = { chapterId: 'chapter', content: '实际新正文', writing }
  const original = { novelId: 'novel', callId: 'writer-call', args, expectedRevision: 4,
    writingManifest: coordinatedWritingManifest({ spec, prompt: '完整改写本章' }, subject.action, 'chapter', writing),
    normalization: { sourceRevision: 0, sourceSnapshotHash: 'a'.repeat(64) } }
  parent = { id: 'parent', action: 'chapter_write', inputHash: 'b'.repeat(64), kind: 'tool', status: 'prepared', taskRootId: lease.taskRootId }
  const snapshot = runtimeJson({ kind: 'internal', action: subject.action, parentOperationId: parent.id,
    input: { novelId: 'novel', callId: subject.callId, args, baseline: null, work: {}, serviceAdmission: { version: 1,
      parentOperationId: parent.id, parentInputHash: parent.inputHash, sourceRevision: 0, sourceSnapshotHash: 'a'.repeat(64), step: 'body', chapterId: 'chapter', source: null } } })
  child = { id: subject.operationId, action: subject.action, kind: 'internal', parentOperationId: 'parent', operationKey: 'writing:parent:body', inputHash: snapshot.hash, inputSnapshot: snapshot.value }
  tx.agentOperation.findFirst.mockImplementation(async ({ where }) => where.id === child.id ? child : where.id === parent.id ? parent : null)
  tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ novelId: 'novel', sessionId: 'session', specSnapshot: spec })
  tx.agentSession.findUnique.mockResolvedValue({ userId: lease.userId, novelId: 'novel', sandboxMode: 'workspace', toolPolicy: {} })
  mocks.admitted.mockResolvedValue({ operation: parent, input: original })
  mocks.original.mockResolvedValue({ prompt: '完整改写本章', spec })
  mocks.observation.mockResolvedValue({ kind: 'chapter', id: 'chapter', revision: 4 })
  configuration = { mode: 'build', tools: actions.map(name => ({ function: { name } })),
    toolAuthority: actions.map(name => ({ name, permission: 'allow', alwaysConfirm: false })) }
  mocks.state.mockImplementation(async () => ({ configuration }))
  mocks.policy.mockImplementation(tools => tools)
  mocks.writingTarget.mockResolvedValue({})
})

describe('internal writing service authority', () => {
  it('accepts only the real writer’s original observed body and checks each actual child action', async () => {
    const assertParent = vi.fn()
    expect((await readAdmittedWritingServiceStep(lease, subject, transaction)).parent.id).toBe('parent')
    await assertWritingServicePolicy(transaction, lease, child, assertParent)
    expect(assertParent).toHaveBeenCalledWith(transaction, lease, parent)
    expect(mocks.policy).toHaveBeenCalledTimes(3)
    expect(mocks.observation).toHaveBeenCalledWith(transaction, lease.taskRootId, 0, { kind: 'chapter', id: 'chapter' })
    expect(mocks.writingTarget).toHaveBeenCalledWith(transaction, { userId: lease.userId, novelId: 'novel', runId: lease.runId }, { chapterId: 'chapter', effect: 'replace' })
  })
  it('requires the original writing scope and server binding before accepting a real read', async () => {
    mocks.writingTarget.mockRejectedValueOnce(Object.assign(Error('Original task permits chapter A, not this chapter B'), { code: 'AUTHOR_CHAPTER_SCOPE' }))
    await expect(readAdmittedWritingServiceStep(lease, subject, transaction)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(mocks.observation).not.toHaveBeenCalled()
    expect(mocks.policy).not.toHaveBeenCalled()
  })
  it.each(['missing-parent', 'stale-observation', 'changed-snapshot', 'changed-step-key', 'wrong-call'] as const)('rejects %s before a service can acquire effect authority', async kind => {
    if (kind === 'missing-parent') parent.id = 'different'
    if (kind === 'stale-observation') mocks.observation.mockResolvedValue({ kind: 'chapter', id: 'chapter', revision: 5 })
    if (kind === 'changed-snapshot') child.inputHash = 'c'.repeat(64)
    if (kind === 'changed-step-key') child.operationKey = 'writing:other:body'
    const assertParent = vi.fn()
    const checked = kind === 'wrong-call' ? { ...subject, callId: 'another-call' } : subject
    await expect(readAdmittedWritingServiceStep(lease, checked, transaction)).rejects.toThrow()
    expect(assertParent).not.toHaveBeenCalled(); expect(mocks.policy).not.toHaveBeenCalled()
  })
  it.each(['missing', 'denied', 'ask', 'always-confirm', 'narrowed-session'] as const)('does not turn a parent writer grant into %s child authorization', async kind => {
    if (kind === 'missing') configuration.toolAuthority = configuration.toolAuthority.filter(item => item.name !== 'scene_task_build')
    if (kind === 'denied') configuration.toolAuthority[1].permission = 'deny'
    if (kind === 'ask') configuration.toolAuthority[1].permission = 'ask'
    if (kind === 'always-confirm') configuration.toolAuthority[1].alwaysConfirm = true
    if (kind === 'narrowed-session') mocks.policy.mockImplementation(tools => tools.map((tool: { permission: object }) => ({ ...tool, permission: { build: 'deny' } })))
    await expect(assertWritingServicePolicy(transaction, lease, child, vi.fn())).rejects.toMatchObject({ code:
      kind === 'ask' || kind === 'always-confirm' ? 'RUNTIME_APPROVAL_REQUIRED' : 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
  })
})

describe('service review business input binding', () => {
  const baseline = { id: 'compilation', hash: 'c'.repeat(64) }
  const candidate = { exitState: { objects: ['弯钳仍在值班员手中'] }, lastUnfinishedAction: '等核查' }
  const expected = { step: 'continuity' as const, baseline, chapterId: 'chapter', revision: 5, content: '真实保存的正文', actualOutcomes: candidate }
  const work = () => ({ kind: 'check', compiler: baseline, chapter: { id: 'chapter', revision: 5, content: expected.content },
    repair: false, terminalCandidate: candidate, sourceBodies: { current: expected.content } })
  it('accepts a read-only review of the exact committed body and writer candidate', () => {
    expect(() => assertWritingReviewWork(work(), expected)).not.toThrow()
  })
  it.each(['compiler', 'chapter', 'revision', 'content', 'candidate', 'source-body', 'repair'] as const)('rejects a self-consistent frozen work envelope with a different %s', field => {
    const changed = work()
    if (field === 'compiler') changed.compiler = { ...baseline, id: 'other-compilation' }
    if (field === 'chapter') changed.chapter.id = 'another-chapter'
    if (field === 'revision') changed.chapter.revision++
    if (field === 'content') changed.chapter.content = '后来读取的新正文'
    if (field === 'candidate') changed.terminalCandidate = { ...candidate, lastUnfinishedAction: '已完成核查' }
    if (field === 'source-body') changed.sourceBodies.current = '另一份正文'
    if (field === 'repair') changed.repair = true
    expect(() => assertWritingReviewWork(changed, expected)).toThrow()
  })
  it('does not grant automatic quality repair through a plain review step', () => {
    expect(() => assertWritingReviewWork({ ...work(), repair: true }, { ...expected, step: 'quality' })).toThrow()
    expect(() => assertWritingReviewWork(work(), { ...expected, step: 'quality' })).not.toThrow()
  })
})

describe('committed body progress behind a blocked review', () => {
  async function evidence() {
    const root = await tx.agentTaskRoot.findUniqueOrThrow(), spec = root.specSnapshot
    const writing = coordinatedWritingInputSchema.parse({ draftComplete: true, actualOutcomes: { exitState: {} }, chapterSummary: '核查未完',
      hookDecision: '', delayedHookReason: '', openingStructure: '动作开场', endingStructure: '等待核查' })
    const args = { chapterId: 'chapter', content: '保存后的正文', writing }, callId = 'writer-call'
    const normalization = { version: 1, rawArguments: JSON.stringify(args), normalizedArgsHash: runtimeJson(args).hash, sourceRevision: 0, sourceSnapshotHash: 'a'.repeat(64) }
    const input = { novelId: 'novel', callId, args, expectedRevision: 4, normalization,
      writingManifest: coordinatedWritingManifest({ spec, prompt: '完整重写本章' }, 'chapter_write', 'chapter', writing) }
    const parentSnapshot = runtimeJson({ kind: 'tool', action: 'chapter_write', parentOperationId: null, input })
    const parent = { id: 'parent', taskRootId: 'root', action: 'chapter_write', inputSnapshot: parentSnapshot.value, inputHash: parentSnapshot.hash }
    const childInput = { novelId: 'novel', callId, args, baseline: null, work: {}, serviceAdmission: { version: 1, parentOperationId: parent.id,
      parentInputHash: parent.inputHash, sourceRevision: 0, sourceSnapshotHash: normalization.sourceSnapshotHash, step: 'body', chapterId: 'chapter', source: null } }
    const childSnapshot = runtimeJson({ kind: 'internal', action: parent.action, parentOperationId: parent.id, input: childInput })
    const display = { kind: 'chapterDiff', chapterId: 'chapter', revision: 5, before: '旧正文', after: args.content }
    const progress = { kind: 'content_revision', targetId: 'chapter', beforeHash: runtimeJson({ content: display.before }).hash, afterHash: runtimeJson({ content: display.after }).hash }
    const result = runtimeJson({ toolResult: { display }, progress })
    const body = { id: 'body', taskRootId: 'root', parentOperationId: parent.id, kind: 'internal', action: parent.action, status: 'succeeded',
      inputSnapshot: childSnapshot.value, inputHash: childSnapshot.hash, effectReceipt: { result: result.value, resultHash: result.hash } }
    const event = { operationId: body.id, taskRootId: 'root', type: 'effect.committed', payload: { operationId: body.id, resultHash: result.hash } }
    const blocked = { writingCompletion: { version: 1, status: 'blocked', steps: [{ step: 'body', operationId: body.id, resultHash: result.hash },
      { step: 'continuity', operationId: 'check', resultHash: 'b'.repeat(64) }] }, progress, toolResult: { outcome: 'failed', display } }
    mocks.original.mockResolvedValue({ spec, prompt: '完整重写本章' })
    tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ ...root, userId: 'user' })
    tx.agentOperation.findUnique.mockResolvedValue(body)
    tx.agentOperation.findUniqueOrThrow.mockResolvedValue({ originRunId: 'run' })
    tx.agentExecutionOutbox.findUnique.mockResolvedValue(event)
    return { parent, body, blocked, event, progress }
  }
  it('retains an authenticated body transition without certifying the failed review', async () => {
    const f = await evidence()
    expect(await readCommittedWritingBodyProgress(transaction, f.parent, f.blocked)).toEqual(f.progress)
    expect(f.blocked.toolResult.outcome).toBe('failed')
  })
  it.each(['missing-body', 'wrong-kind', 'wrong-parent', 'wrong-result', 'missing-event', 'changed-progress', 'changed-display', 'unmarked'] as const)(
    'cannot manufacture progress through %s metadata', async fault => {
      const f = await evidence()
      if (fault === 'missing-body') tx.agentOperation.findUnique.mockResolvedValueOnce(null)
      if (fault === 'wrong-kind') f.body.kind = 'tool'
      if (fault === 'wrong-parent') f.body.parentOperationId = 'another-parent'
      if (fault === 'wrong-result') f.body.effectReceipt.resultHash = 'd'.repeat(64)
      if (fault === 'missing-event') tx.agentExecutionOutbox.findUnique.mockResolvedValueOnce(null)
      if (fault === 'changed-progress') f.blocked.progress = { ...f.progress, afterHash: 'e'.repeat(64) }
      if (fault === 'changed-display') f.blocked.toolResult.display = { ...f.blocked.toolResult.display, after: '未保存的正文' }
      if (fault === 'unmarked') {
        const root = await tx.agentTaskRoot.findUniqueOrThrow()
        delete root.specSnapshot.scope.writingCoordinationProtocol
      }
      await expect(readCommittedWritingBodyProgress(transaction, f.parent, f.blocked)).rejects.toThrow()
    })
})
