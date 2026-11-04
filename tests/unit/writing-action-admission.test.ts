import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import * as original from '../../api/lib/agent/original-request.js'
import { freezeWritingScope, frozenWritingRevisionAuthority, requiresCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { clarifyWritingProjection, projectWritingClarification } from '../../api/lib/agent/writing-clarification.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'
import { isWritingContinuationRequest } from '../../api/lib/agent/completion-guard.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { getToolsForMode } from '../../api/lib/agent/tools/registry.js'
import { taskSpecSchema, type TaskSpec } from '../../shared/contracts/task-spec-contracts.js'

afterEach(() => vi.restoreAllMocks())
const subject = { userId: 'author', novelId: 'novel', runId: 'current' }
const chapters = [1, 2].map(orderIndex => ({ id: `chapter-${orderIndex}`, orderIndex, orderInVolume: orderIndex,
  volumeId: 'volume', revision: 1, volume: { orderIndex: 1 }, content: '窗边还留着灯。\n门开了。\n走廊无人。' }))
function makeRun(id: string, prompt: string, time: number, chapterId: string | null = null) {
  return { id, userId: 'author', novelId: 'novel', sessionId: 'session', chapterId, createdAt: new Date(time),
    engine: 'loop', runtimeProtocolVersion: 0, taskRootId: null as string | null, taskSpec: null as TaskSpec | null,
    incomingChildGrant: null as unknown, goalExecution: null, writingBindings: null as unknown,
    session: { spawnedFromRunId: null, spawnedFromSessionId: null, sandboxMode: 'workspace' },
    startRequest: withHumanAdmission({ novelId: 'novel', sessionId: 'session', mode: 'build', prompt }) }
}
async function fixture(prompt: string, previousPrompt = '写第1、2章', editorId: string | null = 'chapter-1') {
  const previous = makeRun('previous', previousPrompt, 10), current = makeRun('current', prompt, 20, editorId), runs = [previous, current]
  const messages = runs.map(run => ({ id: `${run.id}-message`, runId: run.id, sessionId: run.sessionId, role: 'user',
    parts: [{ type: 'text', text: run.startRequest.prompt }] }))
  const terminals = new Set<string>(), terminalAttempts = new Map<string, string>(), reports: Array<{ id: string; chapterId: string; chapterRevision: number }> = []
  const mocks = {
    $queryRaw: vi.fn(async () => [{ id: 'novel' }]),
    agentGoalExecution: { findUnique: vi.fn(async () => null) },
    agentRun: {
      findFirst: vi.fn(async (input: { where: { id: string } }) => runs.find(run => run.id === input.where.id) ?? null),
      findFirstOrThrow: vi.fn(async (input: { where: { id: string } }) => runs.find(run => run.id === input.where.id)!),
      findMany: vi.fn(async (input: { where: { id: { not: string }; createdAt: { lte: Date } } }) => runs
        .filter(run => run.id !== input.where.id.not && run.createdAt <= input.where.createdAt.lte)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(run => ({ id: run.id }))),
    },
    agentMessage: { findMany: vi.fn(async (input: { where: { runId: string } }) => messages.filter(message => message.runId === input.where.runId)) },
    chapter: { findMany: vi.fn(async (input: { where: { id?: { in: string[] } } }) => chapters.filter(chapter => !input.where.id || input.where.id.in.includes(chapter.id))) },
    volume: { findFirst: vi.fn(async () => ({ id: 'volume', orderIndex: 1 })) },
    storyCompilation: { findFirst: vi.fn(async (input: { where: { chapterId: string; runId: { in: string[] } } }) =>
      terminals.has(input.where.chapterId) || input.where.runId.in.includes(terminalAttempts.get(input.where.chapterId) ?? '') ? { id: 'terminal' } : null) },
    chapterQualityReport: { findMany: vi.fn(async () => reports) },
  }
  const tx = mocks as unknown as Prisma.TransactionClient
  vi.spyOn(original, 'readOriginalTaskRequest').mockImplementation(async (_tx, target) => {
    const run = runs.find(run => run.id === target.runId)!
    return { prompt: run.startRequest.prompt, spec: run.taskSpec, sourceRunId: run.id, taskId: run.taskSpec?.id ?? run.id, parentRunId: null }
  })
  vi.spyOn(original, 'originalTaskRunIds').mockImplementation(async (_tx, _subject, source) => {
    const run = runs.find(run => run.id === source.sourceRunId)!
    return run.taskRootId ? runs.filter(item => item.taskRootId === run.taskRootId).map(item => item.id) : [run.id]
  })
  async function freeze(run = current) {
    const fresh = buildTaskSpec({ ...subject, runId: run.id, chapterId: run.chapterId ?? undefined, prompt: run.startRequest.prompt,
      authorWritingProtocol: 2, reviewProtocol: 1, localEditProtocol: 1 })
    const spec = fresh.scope.authorEffects?.manuscript ? await freezeWritingScope(tx, { ...subject, runId: run.id }, fresh, run.startRequest.prompt, 2) : fresh
    run.taskSpec = JSON.parse(JSON.stringify(spec)) as TaskSpec
    return taskSpecSchema.parse(spec)
  }
  await freeze(previous)
  return { tx, mocks, previous, current, runs, messages, terminals, terminalAttempts, reports, freeze }
}

describe('fresh human actions and their own chapter objects', () => {
  it.each(['修改', '重新写', '重写', '授权，继续写'])('retains a current mutation and resolves only its recent owned object: %s', async prompt => {
    const f = await fixture(prompt, '写第2章')
    const spec = await f.freeze()
    expect(spec.scope.authorEffects?.manuscript).toBe(true)
    expect(spec.scope.writing?.targets).toEqual([{ orderIndex: 2, chapterId: 'chapter-2' }])
    expect(spec.scope.writingActions?.operations).toEqual([expect.objectContaining({ resolution: 'bound',
      source: expect.objectContaining({ runId: 'previous', messageId: 'previous-message' }) })])
    expect(spec.scope.writing?.targets).not.toContainEqual(expect.objectContaining({ chapterId: 'chapter-1' }))
  })
  it('keeps explicit revision of two chapters and next-chapter creation as separate grants and completion targets', async () => {
    const f = await fixture('修改第1、2章，再写下一章')
    const spec = await f.freeze()
    expect(spec.scope.writing).toMatchObject({ kind: 'bounded', repairAuthorized: false,
      targets: [{ orderIndex: 1, chapterId: 'chapter-1' }, { orderIndex: 2, chapterId: 'chapter-2' }, { orderIndex: 3, chapterId: null }] })
    expect(spec.scope.writingActions?.operations.map(operation => [operation.kind, operation.targets.map(target => target.orderIndex)]))
      .toEqual([['revise', [1, 2]], ['write', [3]]])
    expect(original.originalRepairAuthority({ prompt: f.current.startRequest.prompt, spec }, 'chapter-1')).toBe(true)
    expect(original.originalRepairAuthority({ prompt: f.current.startRequest.prompt, spec }, 'chapter-2')).toBe(true)
    expect(original.originalRepairAuthority({ prompt: f.current.startRequest.prompt, spec }, 'chapter-3')).toBe(false)
    expect(original.originalRepairAuthority({ prompt: f.current.startRequest.prompt, spec })).toBe(false)
    expect(frozenWritingRevisionAuthority(spec, 'outside')).toBe(false)
    expect(requiresCompletedWritingPresentation(spec)).toBe(true)
    expect(renderTaskSpec(spec)).toContain('不能只交付最后的新章')
  })
  it('preserves an elided revision group alongside an explicit new chapter', async () => {
    const f = await fixture('修改，写下一章')
    const spec = await f.freeze()
    expect(spec.scope.writingActions?.operations.map(operation => [operation.kind, operation.targets.map(target => target.orderIndex)]))
      .toEqual([['revise', [1, 2]], ['write', [3]]])
  })
  it('does not inherit the historical revision group when the current request only writes next', async () => {
    const f = await fixture('写下一章', '修改第1、2章')
    const spec = await f.freeze()
    expect(spec.scope.writing?.targets).toEqual([{ orderIndex: 3, chapterId: null }])
    expect(original.originalRepairAuthority({ prompt: f.current.startRequest.prompt, spec }, 'chapter-1')).toBe(false)
  })
  it('keeps a local revision fence on its own old chapter while freezing the separate next target', async () => {
    const f = await fixture('修改第1章首段，写下一章')
    const spec = await f.freeze()
    expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: 'chapter-1' }] })
    expect(spec.scope.writing?.targets.map(target => target.orderIndex)).toEqual([1, 3])
    expect(frozenWritingRevisionAuthority(spec, 'new-target', true)).toBe(true)
  })
  it.each(['不要修改', '只读检查第2章', '引用：“修改，写下一章”', '如何重新写？'])(
    'never revives historical mutation authority from denial, read-only or data: %s', async prompt => {
      const f = await fixture(prompt)
      const spec = await f.freeze()
      expect(spec.scope.authorEffects?.manuscript).toBe(false)
      expect(spec.scope.writingActions).toBeUndefined()
    })
  it.each(['不想修改', '尚未修改', '我想知道你会不会修改', '这算不算修改', '我喜欢写', '请不要重新写', '修改？'])(
    'requires an affirmative command speech act before resolving an elided object: %s', async prompt => {
      const f = await fixture(prompt, '写第2章')
      const spec = await f.freeze()
      expect(spec.scope.authorEffects?.manuscript).toBe(false)
      expect(spec.scope.writing).toBeUndefined()
    })
  it('resolves a discourse demonstrative separately from an explicitly current editor chapter', async () => {
    const f = await fixture('那一章重新写', '写第2章', 'chapter-1')
    expect((await f.freeze()).scope.writing?.targets).toEqual([{ orderIndex: 2, chapterId: 'chapter-2' }])
    f.current.startRequest = withHumanAdmission({ novelId: 'novel', sessionId: 'session', mode: 'build', prompt: '修改当前章节' })
    f.messages[1].parts = [{ type: 'text', text: '修改当前章节' }]
    expect((await f.freeze()).scope.writing?.targets).toEqual([{ orderIndex: 1, chapterId: 'chapter-1' }])
  })
  it('retains a prior local object instead of upgrading a short new revision to the whole chapter', async () => {
    const f = await fixture('再修改', '只修改第2章首段')
    const local = f.previous.taskSpec!.scope.localEditBoundary
    expect(local?.kind).toBe('bounded')
    const spec = await f.freeze()
    expect(spec.scope.localEditBoundary).toEqual(local)
    expect(spec.scope.writingActions?.operations[0].boundary).toEqual(local)
  })
  it.each(['不要写下一章', '不要新建'])('applies %s to known actions even while another action still needs a target', async denial => {
    const f = await fixture(`修改。写下一章。${denial}`, '你好')
    const spec = await f.freeze()
    expect(spec.scope.writing?.targets).toEqual([])
    expect(spec.scope.writingActions?.operations.find(operation => operation.kind === 'write')?.resolution).toBe('denied')
    expect(clarifyWritingProjection(spec, f.current.startRequest.prompt, '第2章', chapters)).toBeNull()
  })
  it('keeps the total projection valid when one known revision is denied and a separate new slot remains', async () => {
    const f = await fixture('修改第1章。不要修改第1章。写下一章')
    const spec = await f.freeze()
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [{ orderIndex: 3, chapterId: null }] })
    expect(spec.scope.writingActions?.operations[0].resolution).toBe('denied')
  })
  it('keeps an unresolved real modification on the question path after an unbound discussion', async () => {
    const f = await fixture('修改', '网站只有传闻吧，哪里来的下载链接？')
    const spec = await f.freeze()
    expect(spec.scope.authorEffects?.manuscript).toBe(true)
    expect(spec.scope.writing?.kind).toBe('needs_input')
    expect(spec.scope.writingClarificationProtocol).toBe(2)
    expect(restrictToolsToTask(getToolsForMode('build'), spec).some(tool => tool.name === 'ask_user')).toBe(true)
    expect(renderTaskSpec(spec)).toContain('通过 ask_user')
    expect(renderTaskSpec(spec)).not.toContain('本轮没有章节正文写入义务')
  })
  it('classifies pure writing resume separately from a new target, new revision or new permission', () => {
    expect(isWritingContinuationRequest('继续写')).toBe(true)
    expect(isWritingContinuationRequest('请接着创作')).toBe(true)
    expect(isWritingContinuationRequest('授权，继续写')).toBe(true)
    expect(isWritingContinuationRequest('继续修改')).toBe(true)
    for (const prompt of ['写下一章', '继续写下一章', '修改，继续写', '不要继续写', '继续写？']) {
      expect(isWritingContinuationRequest(prompt)).toBe(false)
    }
  })
  it.each(['source-message', 'current-message', 'source-hash', 'source-novel', 'child-source', 'intervening-topic'])(
    'asks instead of guessing the editor chapter when provenance fails: %s', async failure => {
      const f = await fixture('修改', '写第2章')
      if (failure === 'source-message') f.messages[0].parts = [{ type: 'text', text: '助手合成摘要' }]
      if (failure === 'current-message') f.messages[1].parts = [{ type: 'text', text: '不同的作者输入' }]
      if (failure === 'source-hash') f.previous.taskSpec!.scope.authorEffects!.requestHash = 'f'.repeat(64)
      if (failure === 'source-novel') f.previous.novelId = 'other-novel'
      if (failure === 'child-source') f.previous.incomingChildGrant = { id: 'child' }
      if (failure === 'intervening-topic') {
        const unrelated = makeRun('unrelated', '你好，聊聊别的', 15)
        unrelated.taskSpec = buildTaskSpec({ novelId: 'novel', prompt: unrelated.startRequest.prompt, authorWritingProtocol: 2 })
        f.runs.push(unrelated)
        f.messages.push({ id: 'unrelated-message', runId: unrelated.id, sessionId: 'session', role: 'user', parts: [{ type: 'text', text: unrelated.startRequest.prompt }] })
      }
      const spec = await f.freeze()
      expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
      expect(spec.ambiguity).toBe('must_ask')
      expect(spec.scope.writingClarificationProtocol).toBe(2)
    })
  it('restores unfinished targets and does not turn completed work into a fresh next chapter', async () => {
    const f = await fixture('继续写')
    f.terminals.add('chapter-1')
    expect((await f.freeze()).scope.writing?.targets).toEqual([{ orderIndex: 2, chapterId: 'chapter-2' }])
    f.terminals.add('chapter-2')
    const completed = await f.freeze()
    expect(completed.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
  })
  it('uses a human-named pending next object without treating that old noun as current authority', async () => {
    const f = await fixture('授权，继续写', '下一章')
    expect((await f.freeze()).scope.writing?.targets).toEqual([{ orderIndex: 3, chapterId: null }])
  })
  it('finds completion in the original task lineage even when a resumed attempt has no user message', async () => {
    const f = await fixture('继续写', '写第2章')
    f.previous.taskRootId = 'logical-root'
    const attempt = makeRun('resumed-attempt', '写第2章', 15)
    attempt.taskRootId = 'logical-root'
    attempt.taskSpec = { ...f.previous.taskSpec!, runId: attempt.id }
    f.runs.push(attempt)
    f.terminalAttempts.set('chapter-2', attempt.id)
    const spec = await f.freeze()
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
    expect(f.mocks.storyCompilation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      runId: { in: ['previous', 'resumed-attempt'] }, chapterId: 'chapter-2',
    }) }))
  })
  it('uses actual current-version review objects when the author now authorizes all of them', async () => {
    const f = await fixture('授权所有，全部修改', '检查一下')
    f.reports.push({ id: 'report-1', chapterId: 'chapter-1', chapterRevision: 1 }, { id: 'report-2', chapterId: 'chapter-2', chapterRevision: 1 })
    const spec = await f.freeze()
    expect(spec.scope.writing?.targets.map(target => target.chapterId)).toEqual(['chapter-1', 'chapter-2'])
    expect(spec.scope.writingActions?.operations[0].source?.resultIds).toEqual(['report-1', 'report-2'])
    f.reports.forEach(report => { report.chapterRevision = 0 })
    expect((await f.freeze()).scope.writing?.kind).toBe('needs_input')
  })
  it('clarifies only a missing action and preserves the known new chapter grant', async () => {
    const f = await fixture('修改，写下一章', '你好')
    const spec = await f.freeze(), known = spec.scope.writingActions!.operations[1]
    const projection = clarifyWritingProjection(spec, f.current.startRequest.prompt, '第2章', chapters)
    expect(projection?.writingActions?.operations[0]).toMatchObject({ kind: 'revise', targets: [{ chapterId: 'chapter-2' }] })
    expect(projection?.writingActions?.operations[1]).toEqual(known)
    expect(projection?.writing.targets.map(target => target.orderIndex)).toEqual([2, 3])
    expect(clarifyWritingProjection(spec, f.current.startRequest.prompt, '第2章，再写第4章', chapters)).toBeNull()
  })
  it('hashes the additive projection while leaving historical contract bytes and hashes unchanged on recovery', async () => {
    const f = await fixture('修改第2章')
    const spec = await f.freeze(), changed = structuredClone(spec)
    changed.scope.writingActions!.operations[0].targets[0].chapterId = 'chapter-1'
    expect(frozenWritingScopeHash(changed.scope)).not.toBe(spec.scope.writingInterpretation!.scopeHash)
    const old = structuredClone(spec)
    delete old.scope.writingActions
    old.scope.writingInterpretation!.scopeHash = frozenWritingScopeHash(old.scope)
    const bytes = JSON.stringify(old)
    expect(JSON.stringify(await freezeWritingScope(f.tx, subject, old, '写下一章', 2))).toBe(bytes)
    expect(taskSpecSchema.parse(old).scope.writingActions).toBeUndefined()
    expect(() => projectWritingClarification(spec, { version: 2, projection: { writing: spec.scope.writing } } as never)).toThrow()
  })
})
