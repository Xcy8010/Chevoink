import type { Prisma } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as scope from '../../api/lib/agent/writing-scope.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import { explicitFirstChapterAnswer, eligibleEmptyWritingClarification, recordWritingClarification } from '../../api/lib/agent/writing-clarification.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { observeSemanticTransition, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'
import { shortSceneRequest, firstChapterAnswer, placementQuestion } from '../support/writing-clarification-fixture.js'

afterEach(() => vi.restoreAllMocks())
function fixture() {
  const subject = { userId: 'u', novelId: 'n', runId: 'r' }
  let spec = buildTaskSpec({ ...subject, prompt: shortSceneRequest, mode: 'build', reviewProtocol: 1, localEditProtocol: 1 })
  spec = { ...spec, scope: { ...spec.scope, writingClarificationProtocol: 1,
    writing: { version: 1, kind: 'needs_input', targets: [], titleAndBodyOnly: false, repairAuthorized: false } } }
  spec = JSON.parse(JSON.stringify(spec)) as typeof spec
  const admission = { prompt: shortSceneRequest, spec, taskId: spec.id, sourceRunId: 'r', parentRunId: null }
  vi.spyOn(original, 'readOriginalTaskRequest').mockImplementation(async () => structuredClone(admission))
  vi.spyOn(scope, 'lockWritingRunLineage').mockResolvedValue(undefined)
  vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
  const artifacts: Array<{ metadata: unknown }> = []
  const run = { id: 'r', manuscriptRevision: 0, writingBindings: null, session: { sandboxMode: 'workspace', spawnedFromRunId: null } }
  const create = vi.fn(async ({ data }: { data: { metadata: unknown } }) => { artifacts.push(data); return data })
  const count = vi.fn(async () => 0)
  const tx = { $queryRaw: vi.fn(async () => [{ id: 'n' }]), agentGoalExecution: { findUnique: vi.fn(async () => null) },
    agentRun: { findFirst: vi.fn(async () => run), findFirstOrThrow: vi.fn(async () => run) },
    chapter: { count, findMany: vi.fn(async () => []) },
    agentArtifact: { findMany: vi.fn(async () => artifacts), create } } as unknown as Prisma.TransactionClient
  return { subject, spec, admission, artifacts, create, tx, run, count,
    answer: { callId: 'q', ...placementQuestion, answer: firstChapterAnswer, source: 'legacy_question' as const } }
}

describe('authenticated first-chapter scope clarification', () => {
  it.each(['请分析如何写一个短场景，不要写入章节。', '先给我短场景的写作建议。', 'How do I write a short scene?'])(
    'does not turn an informational scene question into a write grant: %s', prompt => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).writingPacing).not.toBe('explicit_writing')
    })
  it('freezes a fresh empty short-scene request with a single-question path before compiler attempts', async () => {
    const f = fixture()
    expect(scope.requestedWritingRange(shortSceneRequest)).toBeNull()
    const fresh = { ...f.spec, scope: { ...f.spec.scope, writing: undefined, writingClarificationProtocol: undefined } }
    const frozen = await scope.freezeWritingScope(f.tx, f.subject, fresh, shortSceneRequest)
    expect(frozen.intent).toBe('write')
    expect(frozen.writingPacing).toBe('explicit_writing')
    expect(frozen.scope.writing?.kind).toBe('needs_input')
    expect(frozen.scope.writingClarificationProtocol).toBe(1)
    expect(renderTaskSpec(frozen)).toContain('先用 ask_user 一次询问该落点')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('keeps fresh protocol2 scene creation eligible for an authenticated first-chapter answer', async () => {
    const f = fixture()
    const fresh = buildTaskSpec({ ...f.subject, prompt: shortSceneRequest, authorWritingProtocol: 2,
      reviewProtocol: 1, localEditProtocol: 1 })
    const frozen = await scope.freezeWritingScope(f.tx, f.subject, fresh, shortSceneRequest, 2)
    expect(frozen).toMatchObject({ intent: 'write', scope: { writingTargetProtocol: 2, writingClarificationProtocol: 1,
      writing: { kind: 'needs_input', targets: [] }, writingInterpretation: { intent: 'write' } } })
    expect(frozen.scope.localEditBoundary).toBeUndefined()
    expect(f.create).not.toHaveBeenCalled()
    // The production admission is persisted as JSON before its answer receipt.
    f.admission.spec = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    expect(await recordWritingClarification(f.tx, f.subject, f.answer)).toBeTruthy()
    expect((await scope.readWritingScope(f.tx, f.subject)).writing).toMatchObject({ kind: 'bounded', targets: [{ orderIndex: 1, chapterId: null }] })
    expect(f.admission.spec).toEqual(frozen)
  })
  it('keeps an explicit first-chapter grant when a separate clause forbids continuation', async () => {
    const f = fixture(), prompt = '写第一章，不继续下一章。'
    f.admission.prompt = prompt
    const fresh = buildTaskSpec({ ...f.subject, prompt, reviewProtocol: 1, localEditProtocol: 1 })
    const frozen = await scope.freezeWritingScope(f.tx, f.subject, fresh, prompt)
    expect(frozen.scope.writing).toMatchObject({ kind: 'bounded', targets: [{ orderIndex: 1, chapterId: null }] })
    expect(frozen.scope.writingClarificationProtocol).toBeUndefined()
  })
  it('binds one real affirmative answer without modifying the frozen contract and credits the transition once', async () => {
    const f = fixture(), before = runtimeJson(f.admission).hash
    const transition = await recordWritingClarification(f.tx, f.subject, f.answer)
    expect(transition).toBeTruthy()
    expect(f.create).toHaveBeenCalledOnce()
    const effective = await scope.readWritingScope(f.tx, f.subject)
    expect(effective.writing).toEqual({ ...f.spec.scope.writing, kind: 'bounded', targets: [{ orderIndex: 1, chapterId: null }] })
    expect(runtimeJson(f.admission).hash).toBe(before)
    expect(effective.spec).toEqual(f.spec)
    expect(effective.prompt).toBe(shortSceneRequest)
    expect(await scope.effectiveWritingTaskSpec(f.tx, f.subject, f.spec)).toMatchObject({ id: f.spec.id,
      scope: { writing: { kind: 'bounded', targets: [{ orderIndex: 1, chapterId: null }] } }, hardConstraints: f.spec.hardConstraints })
    expect(await recordWritingClarification(f.tx, f.subject, f.answer)).toEqual(transition)
    expect(f.create).toHaveBeenCalledOnce()
    const seen = new Set<string>()
    expect(observeSemanticTransition(seen, transition!.targetId, transition!.beforeHash, transition!.afterHash)).toBe(true)
    expect(observeSemanticTransition(seen, transition!.targetId, transition!.beforeHash, transition!.afterHash)).toBe(false)
    const milestone = { version: 1 as const, ...f.subject, targetOrderIndex: 1, phase: 'prepare' as const }
    expect(observeWritingWorkflowMilestone(seen, 'story_compiler_prepare', milestone,
      { ...f.subject, taskSpec: await scope.effectiveWritingTaskSpec(f.tx, f.subject, f.spec) })).toBe(true)
    Object.assign(f.run, { writingBindings: { version: 1, taskId: f.spec.id, targets: [{ orderIndex: 1, chapterId: 'new-first' }] } })
    expect(await scope.readNewDraftWritingAuthority(f.tx, f.subject, { id: 'new-first', orderIndex: 1 })).toEqual({ taskId: f.spec.id })
    await expect(scope.assertWritingTarget(f.tx, f.subject, { orderIndex: 2 })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  })
  it.each(['第一章不要写，先讨论设定', '第一章暂不确定', '第一章，写入；但别保存', '第一章写入，但取消这个决定',
    '第一章写入是否合适？', '第一章写入会不会破坏结构？', '第一章写入吗？', '第一章写入好不好', '第一章写入大概可以',
    '第一章写入能否合适', '第一章写入可否', '第一章写入还有什么问题',
    '第一章写入，后面第十二章也生成', '第一章写入，继续下一章', '第一章写入，自动续写全书', '第一章应该可以吧', '按推荐方案', ''])(
    'does not mint authority or progress from negative, ambiguous or nonaffirmative answer: %s', async answer => {
      const f = fixture()
      expect(explicitFirstChapterAnswer(answer)).toBe(false)
      expect(await recordWritingClarification(f.tx, f.subject, { ...f.answer, answer })).toBeNull()
      expect(f.create).not.toHaveBeenCalled()
      await expect(scope.assertWritingTarget(f.tx, f.subject, { orderIndex: 1 })).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    })
  it.each(['legacy', 'bounded', 'selection', 'review', 'denied', 'parent', 'readonly', 'nonempty', 'cancelled'] as const)(
    'cannot expand a %s boundary', async scenario => {
      const f = fixture()
      if (scenario === 'legacy') delete f.spec.scope.writingClarificationProtocol
      if (scenario === 'bounded') f.spec.scope.writing = { ...f.spec.scope.writing!, kind: 'bounded', targets: [{ orderIndex: 2, chapterId: null }] }
      if (scenario === 'selection') f.spec.scope.selection = { chapterId: 'c', start: 0, end: 4 }
      if (scenario === 'review') f.spec.intent = 'review'
      if (scenario === 'denied') f.admission.prompt += '不要保存或写入章节。'
      if (scenario === 'parent') Object.assign(f.admission, { parentRunId: 'parent' })
      if (scenario === 'readonly') f.run.session.sandboxMode = 'read_only'
      if (scenario === 'nonempty') f.count.mockResolvedValue(1)
      if (scenario === 'cancelled') vi.mocked(manuscript.assertAgentManuscriptCurrent).mockRejectedValue(new Error('cancelled epoch'))
      const work = recordWritingClarification(f.tx, f.subject, f.answer)
      if (scenario === 'readonly' || scenario === 'cancelled') await expect(work).rejects.toBeDefined()
      else expect(await work).toBeNull()
      expect(f.create).not.toHaveBeenCalled()
    })
  it('requires the receipt to remain bound to user/task/call and the admission manuscript revision', async () => {
    const f = fixture()
    await recordWritingClarification(f.tx, f.subject, f.answer)
    expect(await recordWritingClarification(f.tx, f.subject, { ...f.answer, callId: 'another' })).toBeNull()
    const artifact = f.artifacts[0].metadata as Record<string, unknown>
    artifact.userId = 'foreign'
    await expect(scope.readWritingScope(f.tx, f.subject)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.create).toHaveBeenCalledOnce()
  })
  it('does not treat a proposed option as an author instruction', async () => {
    const f = fixture()
    expect(eligibleEmptyWritingClarification(f.spec, f.admission.prompt)).toBe(true)
    expect(await recordWritingClarification(f.tx, f.subject, { ...f.answer, answer: '先讨论，暂不写入' })).toBeNull()
    expect(f.create).not.toHaveBeenCalled()
    expect(explicitFirstChapterAnswer(firstChapterAnswer)).toBe(true)
  })
})
