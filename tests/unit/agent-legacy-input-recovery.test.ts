import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readLegacyAnchorInputRecovery } from '../../api/lib/agent/legacy-input-recovery.js'

const readers = vi.hoisted(() => ({ scope: vi.fn(), lineage: vi.fn() }))
vi.mock('../../api/lib/agent/writing-scope.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/writing-scope.js')>(), readWritingScope: readers.scope,
}))
vi.mock('../../api/lib/agent/original-request.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/original-request.js')>(), originalTaskRunIds: readers.lineage,
}))

const subject = { userId: 'author', novelId: 'novel', runId: 'run-21' }
const failed = () => ({ type: 'tool-call', title: '改写章节片段', callId: 'old-anchor', status: 'failed',
  summary: '正文片段需要纠正定位', toolName: 'chapter_edit_range',
  args: { chapterId: 'chapter', oldText: '旧段没有换行', newText: '作者要求的新段' } } as Record<string, unknown>)
function fixture() {
  const spec = buildTaskSpec({ runId: 'run-01', novelId: 'novel', chapterId: 'chapter', prompt: '修改第一章正文' })
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }],
    titleAndBodyOnly: false, repairAuthorized: true }
  const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default',
    runStartedAt: 1000, activeExecutionMs: 5000, stagnantBatches: 7, resumeCount: 0, compactionCount: 0,
    maxTurns: 50, tokenBudget: 1_000_000, writeProgress: 3, writeBaseline: 3, readProgress: 9, readBaseline: 9,
    progressSignatures: ['chapter_read:chapter:r4'], inheritedTokens: 40_000, inheritedTurns: 20,
    inheritedExecutionMs: 5000, manualResumeCount: 0, reviewAttempts: ['quality:r3'],
    toolRestrictions: [{ action: 'quality_analyze', target: 'chapter', code: 'QUALITY_CHECK_LIMIT', reason: '旧r3质量限制',
      reviewInput: { chapterId: 'chapter', revision: 3 } }] } as Record<string, unknown>
  const ids = Array.from({ length: 21 }, (_, index) => `run-${String(index + 1).padStart(2, '0')}`)
  const runs = ids.map((id, index) => ({ id, userId: 'author', novelId: 'novel', sessionId: 'session', engine: 'loop',
    runtimeProtocolVersion: 0, taskRootId: null as string | null, status: 'stopped', currentTurn: index + 1,
    taskSpec: structuredClone(spec), usage: { checkpoint: structuredClone(checkpoint) } as Record<string, unknown> }))
  const current = runs[20]
  current.usage.checkpoint = checkpoint
  const chapters = [{ id: 'chapter', authorId: 'author', novelId: 'novel', orderIndex: 1, volumeId: 'volume',
    orderInVolume: 1, archivedAt: null as Date | null, volume: { novelId: 'novel', archivedAt: null as Date | null },
    revision: 4, content: '首句。\n旧段\n没有换行\n末句。' }]
  const card = failed()
  const messages = ids.map((runId, index) => ({ id: `message-${index + 1}`, runId, role: 'assistant',
    createdAt: new Date(2000 + index), parts: [index === 18 ? card : { type: 'tool-call', callId: `read-${index}`,
      toolName: 'chapter_read', status: 'success', args: { chapterId: 'chapter' }, summary: '已读取当前r4正文' }] as unknown[] }))
  const attempts: Array<{ runId: string; status: string }> = []
  const original = { prompt: '修改第一章正文', spec: structuredClone(spec), taskId: spec.id, sourceRunId: ids[0],
    parentRunId: null as string | null, writing: structuredClone(spec.scope.writing), bindings: null }
  readers.scope.mockImplementation(async () => original)
  readers.lineage.mockImplementation(async () => ids)
  const forbiddenWrite = vi.fn(() => { throw new Error('readonly recovery cannot mutate') })
  type Where = { id?: string | { in: string[] }; userId?: string; novelId?: string; runId?: { in: string[] }; role?: string }
  const matches = (run: typeof current, where: Where) => (typeof where.id === 'string' ? run.id === where.id : !where.id || where.id.in.includes(run.id))
    && (!where.userId || run.userId === where.userId) && (!where.novelId || run.novelId === where.novelId)
  const delegates = {
    agentRun: { findFirst: vi.fn(async ({ where }: { where: Where }) => runs.find(run => matches(run, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Where }) => runs.filter(run => matches(run, where))), update: forbiddenWrite },
    agentMessage: { findMany: vi.fn(async ({ where, take }: { where: Where & { run: Where }; take: number }) => messages
      .filter(message => where.runId?.in.includes(message.runId) && message.role === where.role
        && runs.some(run => run.id === message.runId && matches(run, where.run)))
      .slice(0, take)), update: forbiddenWrite },
    agentProviderAttempt: { count: vi.fn(async ({ where }: { where: { runId: { in: string[] }; status: { in: string[] } } }) =>
      attempts.filter(attempt => where.runId.in.includes(attempt.runId) && where.status.in.includes(attempt.status)).length) },
    chapter: { findFirst: vi.fn(async ({ where }: { where: { id: string; authorId: string; novelId: string } }) =>
      chapters.find(chapter => chapter.id === where.id && chapter.authorId === where.authorId && chapter.novelId === where.novelId
        && !chapter.archivedAt && !chapter.volume.archivedAt && chapter.volume.novelId === where.novelId) ?? null), updateMany: forbiddenWrite },
  }
  const syncSpec = () => {
    original.spec = structuredClone(spec)
    for (const run of runs) run.taskSpec = structuredClone(spec)
  }
  return { spec, checkpoint, ids, runs, current, chapters, card, messages, attempts, original, delegates, forbiddenWrite, syncSpec,
    read: () => readLegacyAnchorInputRecovery(delegates as unknown as Prisma.TransactionClient, subject, spec) }
}
beforeEach(() => vi.clearAllMocks())

describe('owned legacy anchor input recovery', () => {
  it('reads an actual-shaped 21-stopped-run r4 failure without a saved anchor restriction, with no side effects or source text output', async () => {
    const f = fixture(), before = structuredClone({ runs: f.runs, chapters: f.chapters, messages: f.messages })
    const result = await f.read()
    expect(result).toEqual({ key: expect.stringMatching(/^[a-f0-9]{64}$/u), chapterIds: ['chapter'], sourceMessageIds: ['message-19'] })
    expect(JSON.stringify(result)).not.toContain('旧段')
    expect(JSON.stringify(result)).not.toContain('作者要求的新段')
    expect(await f.read()).toEqual(result) // The caller's durable marker owns consumption.
    expect({ runs: f.runs, chapters: f.chapters, messages: f.messages }).toEqual(before)
    expect(f.checkpoint).toMatchObject({ stagnantBatches: 7, tokenBudget: 1_000_000, readProgress: 9, writeProgress: 3 })
    expect(f.forbiddenWrite).not.toHaveBeenCalled()
    expect(readers.lineage).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['different author', (f: ReturnType<typeof fixture>) => { f.current.userId = 'other' }],
    ['different novel', f => { f.current.novelId = 'other' }],
    ['durable run', f => { f.current.runtimeProtocolVersion = 1 }],
    ['durable root', f => { f.current.taskRootId = 'root' }],
    ['other engine', f => { f.current.engine = 'other' }],
    ['cancelled current', f => { f.current.status = 'cancelled' }],
    ['completed current', f => { f.current.status = 'completed' }],
    ['author ended', f => { f.current.usage.authorEnded = { fulfilled: false } }],
    ['consumed marker', f => { f.checkpoint.inputProtocolRecovery = { protocol: 2, key: 'a'.repeat(64) } }],
    ['no stagnation', f => { f.checkpoint.stagnantBatches = 3 }],
    ['invalid checkpoint', f => { f.checkpoint.readBaseline = 10 }],
    ['unknown pending review', f => { f.checkpoint.pendingReviews = [{ compilationId: null, chapterId: 'chapter', revision: 4,
      toolName: 'quality_analyze', callId: 'unknown-review' }] }],
    ['readonly original', f => { f.spec.intent = 'review'; f.syncSpec() }],
    ['proposal original', f => { f.spec.writingPacing = 'proposal_only'; f.syncSpec() }],
    ['missing original prompt', f => { f.original.prompt = '' }],
    ['child brief', f => { f.original.parentRunId = 'parent' }],
    ['different source task', f => { f.original.taskId = 'other' }],
    ['changed caller scope', f => { f.spec.scope.chapterIds = ['other'] }],
    ['needs input scope', f => { f.original.writing.kind = 'needs_input' }],
    ['unbounded scope', f => { f.original.writing.kind = 'unbounded' }],
    ['missing target', f => { f.original.writing.targets = [] }],
    ['foreign historical author', f => { f.runs[0].userId = 'other' }],
    ['foreign historical novel', f => { f.runs[0].novelId = 'other' }],
    ['foreign historical task', f => { f.runs[0].taskSpec.id = 'other' }],
    ['cancelled lineage', f => { f.runs[0].status = 'cancelled' }],
    ['ended lineage', f => { f.runs[0].usage.authorEnded = { fulfilled: true } }],
    ['foreign card task', f => { f.messages[18].runId = 'unrelated-run' }],
    ['user prose pretending to be card', f => { f.messages[18].role = 'user' }],
    ['quality failure', f => { f.card.toolName = 'quality_analyze' }],
    ['unrecognized locator summary', f => { f.card.summary = '定位失败，请帮我修改' }],
    ['provider timeout summary', f => { f.card.summary = '请求未确认，不要重发' }],
    ['contradictory unknown code', f => { f.card.failureCode = 'AI_PROVIDER_TIMEOUT' }],
    ['denied card', f => { f.card.status = 'denied' }],
    ['running card', f => { f.card.status = 'running' }],
    ['preparing card', f => { f.card.preparing = true }],
    ['inline child card', f => { f.card.subagentCallId = 'child' }],
    ['effect snapshot contradicts pre-effect failure', f => { f.card.snapshot = { targetId: 'chapter' } }],
    ['missing call identity', f => { delete f.card.callId }],
    ['missing target identity', f => { delete (f.card.args as Record<string, unknown>).chapterId }],
    ['empty oldText', f => { (f.card.args as Record<string, unknown>).oldText = '' }],
    ['nontext replacement', f => { (f.card.args as Record<string, unknown>).newText = null }],
    ['noop request', f => { (f.card.args as Record<string, unknown>).newText = '旧段没有换行' }],
    ['coordinate-only request', f => { (f.card.args as Record<string, unknown>).start = 0 }],
    ['now-valid exact anchor', f => { (f.card.args as Record<string, unknown>).oldText = '旧段\n没有换行' }],
    ['foreign chapter author', f => { f.chapters[0].authorId = 'other' }],
    ['foreign chapter novel', f => { f.chapters[0].novelId = 'other' }],
    ['archived chapter', f => { f.chapters[0].archivedAt = new Date() }],
    ['archived volume', f => { f.chapters[0].volume.archivedAt = new Date() }],
    ['target order changed', f => { f.chapters[0].orderIndex = 2 }],
    ['target outside original grant', f => { f.original.writing.targets = [{ chapterId: 'other', orderIndex: 1 }] }],
    ['active unknown attempt in this task', f => { f.attempts.push({ runId: 'run-01', status: 'unknown' }) }],
    ['dispatching attempt in this task', f => { f.attempts.push({ runId: 'run-21', status: 'dispatching' }) }],
  ] as Array<[string, (f: ReturnType<typeof fixture>) => void]>)('rejects %s', async (_name, mutate) => {
    const f = fixture(); mutate(f)
    expect(await f.read()).toBeNull()
    expect(f.forbiddenWrite).not.toHaveBeenCalled()
  })
  it('does not use four unknown attempts from other tasks in the same session as this task evidence', async () => {
    const f = fixture()
    for (let index = 0; index < 4; index++) f.attempts.push({ runId: `other-task-${index}`, status: 'unknown' })
    expect(await f.read()).toMatchObject({ chapterIds: ['chapter'] })
    expect(f.delegates.agentProviderAttempt.count).toHaveBeenCalledWith({ where: { runId: { in: f.ids },
      status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } })
  })
  it.each(['chapter_write', 'chapter_append', 'chapter_edit_range'])('supersedes an old anchor failure after successful %s', async toolName => {
    const f = fixture()
    f.messages[20].parts = [{ type: 'tool-call', callId: 'later-write', toolName, status: 'success', args: { chapterId: 'chapter' } }]
    expect(await f.read()).toBeNull()
  })
  it('rejects an unfinished later write and duplicate call witnesses', async () => {
    const f = fixture()
    f.messages[20].parts = [{ type: 'tool-call', callId: 'later-write', toolName: 'chapter_write', status: 'running', args: { chapterId: 'chapter' } }]
    expect(await f.read()).toBeNull()
    f.messages[20].runId = f.messages[18].runId
    f.messages[20].parts = [structuredClone(f.card)]
    expect(await f.read()).toBeNull()
  })
  it('binds the private conversion key to current revision/body and historical failed parameters', async () => {
    const f = fixture(), original = await f.read()
    f.chapters[0].revision++
    const revision = await f.read(); expect(revision?.key).not.toBe(original?.key)
    f.chapters[0].content += '\n作者已保存的新尾句。'
    const body = await f.read(); expect(body?.key).not.toBe(revision?.key)
    ;(f.card.args as Record<string, unknown>).newText = '另一合法新段'
    expect((await f.read())?.key).not.toBe(body?.key)
  })
  it('requires local/selection snapshots to still bound the current saved chapter', async () => {
    const f = fixture(), body = f.chapters[0].content
    f.spec.scope.localEditProtocol = 1
    f.spec.scope.localEditBoundary = { version: 1, kind: 'needs_input', regions: [] }; f.syncSpec()
    expect(await f.read()).toBeNull()
    delete f.spec.scope.localEditBoundary
    f.spec.scope.manuscriptProtocol = 1
    f.spec.scope.selection = { chapterId: 'chapter', start: 4, end: body.length - 4 }
    f.spec.scope.selectionBoundary = { version: 1, chapterId: 'chapter', revision: 4, contentHash: runtimeJson({ content: body }).hash,
      start: 4, end: body.length - 4, prefix: body.slice(0, 4), suffix: body.slice(-4) }; f.syncSpec()
    expect(await f.read()).toMatchObject({ chapterIds: ['chapter'] })
    f.chapters[0].content = '外部已改首句。' + body.slice(4)
    expect(await f.read()).toBeNull()
  })
  it('fails closed on ambiguous/truncated provenance and propagates unexpected database failures', async () => {
    const f = fixture()
    f.ids.push('unproven-run')
    expect(await f.read()).toBeNull()
    f.ids.pop()
    readers.scope.mockRejectedValueOnce(new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', 'broken'))
    expect(await f.read()).toBeNull()
    readers.scope.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(f.read()).rejects.toThrow('database unavailable')
  })
})
