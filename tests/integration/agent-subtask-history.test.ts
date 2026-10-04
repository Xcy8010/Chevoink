import { randomUUID } from 'node:crypto'
import type { AgentRunStatus } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { getAgentSubtaskLogs, listAgentSubtasks } from '../../api/lib/agent/productivity.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { verifyChildGrant } from '../../api/lib/agent/runtime-child.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })
const epoch = Date.UTC(2026, 9, 4)

async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const userIds = [randomUUID(), randomUUID()]
  await prisma.user.createMany({ data: userIds.map(id => ({ id, nickname: 'subtask-history-isolated', passwordHash: 'test-only' })) })
  try { await work(await setup(userIds)) }
  finally {
    await prisma.agentChildExecutionGrant.deleteMany({ where: { parentRoot: { userId: { in: userIds } } } })
    await prisma.agentRun.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.agentSession.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.novel.deleteMany({ where: { authorId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

async function rootRun(userId: string, novelId: string, sessionId: string, status: AgentRunStatus, rootStatus: string) {
  const runId = randomUUID(), messageId = randomUUID()
  const spec = buildTaskSpec({ runId, novelId, prompt: '只读研究并汇报' })
  const frozen = runtimeJson(JSON.parse(JSON.stringify(spec)))
  const request = runtimeJson([{ type: 'text', text: '只读研究并汇报' }])
  const root = await prisma.agentTaskRoot.create({ data: { id: spec.id, userId, novelId, sessionId, sourceMessageId: messageId,
    inputHash: runtimeJson({ spec: frozen.value, request: request.value }).hash, specSnapshot: frozen.value, requestSnapshot: request.value, status: rootStatus } })
  const run = await prisma.agentRun.create({ data: { id: runId, userId, novelId, sessionId, mode: 'review', action: 'workspaceAgent',
    agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 1, taskRootId: root.id, taskSpec: frozen.value, status } })
  await prisma.agentMessage.create({ data: { id: messageId, runId, sessionId, role: 'user', parts: request.value } })
  return { root, run, spec }
}

async function setup(userIds: string[]) {
  const [userId, foreignUserId] = userIds
  const novel = await prisma.novel.create({ data: { authorId: userId, title: '调用记录', slug: randomUUID(), summary: '' } })
  const otherNovel = await prisma.novel.create({ data: { authorId: userId, title: '其他作品', slug: randomUUID(), summary: '' } })
  const foreignNovel = await prisma.novel.create({ data: { authorId: foreignUserId, title: '其他作者', slug: randomUUID(), summary: '' } })
  const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '父任务' } })
  const otherSession = await prisma.agentSession.create({ data: { userId, novelId: otherNovel.id, title: '其他作品任务' } })
  const foreignSession = await prisma.agentSession.create({ data: { userId: foreignUserId, novelId: foreignNovel.id, title: '其他作者任务' } })
  const definition = await prisma.agentSubtask.create({ data: { userId, novelId: novel.id, parentSessionId: session.id, name: '研究', role: 'research',
    triggerCondition: '需要报告', prompt: '只读研究', tokenBudget: 16000 } })
  const foreignDefinition = await prisma.agentSubtask.create({ data: { userId: foreignUserId, novelId: foreignNovel.id, name: '私有研究', role: 'research',
    triggerCondition: '私有', prompt: '私有提示' } })
  const parent = await rootRun(userId, novel.id, session.id, 'running', 'active')
  return { userId, foreignUserId, novelId: novel.id, otherNovelId: otherNovel.id, foreignNovelId: foreignNovel.id,
    sessionId: session.id, otherSessionId: otherSession.id, foreignSessionId: foreignSession.id, definition, foreignDefinition, parent }
}

type Fixture = Awaited<ReturnType<typeof setup>>

/** Historical rows are seeded directly; no executor or provider is invoked. */
async function canonicalCall(f: Fixture, offset: number, options: { grantStatus?: string; runStatus?: AgentRunStatus; rootStatus?: string;
  childUserId?: string; childNovelId?: string; childSessionId?: string; definitionId?: string; frozenRootId?: string;
  parent?: Fixture['parent']; kind?: 'inline' | 'spawned'; detail?: string } = {}) {
  const parent = options.parent ?? f.parent
  const child = await rootRun(options.childUserId ?? f.userId, options.childNovelId ?? f.novelId, options.childSessionId ?? f.sessionId,
    options.runStatus ?? 'completed', options.rootStatus ?? 'completed')
  await prisma.agentRun.update({ where: { id: child.run.id }, data: { outputSummary: options.detail ?? `报告-${offset}` } })
  const definitionId = options.definitionId ?? f.definition.id
  const args = runtimeJson({ input: { args: { subagentId: definitionId, task: '报告' } } })
  const operation = await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: parent.root.id, operationKey: randomUUID(),
    originRunId: parent.run.id, kind: 'tool', action: 'subagent_run', inputSnapshot: args.value, inputHash: args.hash, status: 'completed' } })
  const frozen = runtimeJson(JSON.parse(JSON.stringify({ version: 1, parentRootId: parent.root.id, parentOperationId: operation.id,
    childIndex: 0, admissionRunId: parent.run.id, admissionEpoch: '1', kind: options.kind ?? 'inline', definitionId, role: 'research', name: '研究',
    prompt: '报告', taskSpec: { ...child.spec, id: options.frozenRootId ?? child.root.id }, configuration: {},
    price: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }, tokenCeiling: 1000, turnCeiling: 3,
    parentConfigurationHash: '0'.repeat(64), parentFrameRevision: 0, parentFrameHash: '0'.repeat(64) })))
  const grant = await prisma.agentChildExecutionGrant.create({ data: { id: randomUUID(), parentRootId: parent.root.id,
    parentOperationId: operation.id, childIndex: 0, admissionRunId: parent.run.id, admissionEpoch: 1n, currentParentRunId: parent.run.id,
    generation: 1n, childRunId: child.run.id, kind: options.kind ?? 'inline', tokenCeiling: 1000, snapshot: frozen.value, snapshotHash: frozen.hash,
    status: options.grantStatus ?? 'completed', createdAt: new Date(epoch + offset * 1000) } })
  verifyChildGrant(grant)
  return { grant, child }
}

async function legacyCall(f: Fixture, offset: number, status = 'succeeded') {
  return prisma.agentSubtaskRun.create({ data: { subtaskId: f.definition.id, parentRunId: f.parent.run.id, userId: f.userId, novelId: f.novelId,
    task: '旧调用', resultSummary: `旧报告-${offset}`, status, createdAt: new Date(epoch + offset * 1000) } })
}

async function persistentCounts(f: Fixture) {
  return Promise.all([
    prisma.agentSubtaskRun.count({ where: { subtaskId: f.definition.id } }),
    prisma.agentChildExecutionGrant.count({ where: { parentRootId: f.parent.root.id } }),
    prisma.agentRunEvent.count({ where: { run: { userId: f.userId } } }),
    prisma.agentExecutionOutbox.count({ where: { taskRoot: { userId: f.userId } } }),
    prisma.creditLedgerEntry.count({ where: { userId: f.userId } }),
  ])
}

describe.runIf(available)('owned legacy and canonical named subtask history', () => {
  it('preserves legacy-only counts, dates, log fields and empty-definition fallback', async () => fixture(async f => {
    expect((await listAgentSubtasks(f.userId, f.novelId)).items[0]).toMatchObject({ runCount: 0, lastRunAt: null })
    expect((await getAgentSubtaskLogs(f.userId, f.definition.id)).entries[0].id).toBe(`${f.definition.id}-created`)
    const old = await legacyCall(f, 1)
    const current = await legacyCall(f, 2, 'running')
    const before = await persistentCounts(f)
    expect((await listAgentSubtasks(f.userId, f.novelId)).items[0]).toMatchObject({ runCount: 2, lastRunAt: current.createdAt.toISOString() })
    expect((await getAgentSubtaskLogs(f.userId, f.definition.id)).entries).toEqual([
      { id: current.id, time: current.createdAt.toISOString(), title: '正在内嵌执行', detail: current.resultSummary, tone: 'neutral' },
      { id: old.id, time: old.createdAt.toISOString(), title: '内嵌调用完成', detail: old.resultSummary, tone: 'success' },
    ])
    expect(await persistentCounts(f)).toEqual(before)
  }))

  it('adds both histories cumulatively, merges deterministic latest20 without writes or duplicate entries', async () => fixture(async f => {
    const expected: { id: string; time: string }[] = []
    for (let index = 0; index < 15; index++) {
      const legacy = await legacyCall(f, index * 2)
      const canonical = await canonicalCall(f, index * 2 + 1)
      expected.push({ id: legacy.id, time: legacy.createdAt.toISOString() }, { id: canonical.grant.id, time: canonical.grant.createdAt.toISOString() })
    }
    const tied = await canonicalCall(f, 29, { detail: '同一时间的另一调用' })
    expected.push({ id: tied.grant.id, time: tied.grant.createdAt.toISOString() })
    expected.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id))
    const before = await persistentCounts(f)
    expect((await listAgentSubtasks(f.userId, f.novelId)).items[0]).toMatchObject({ runCount: 31, lastRunAt: new Date(epoch + 29000).toISOString() })
    const logs = await getAgentSubtaskLogs(f.userId, f.definition.id)
    expect(logs.entries.map(({ id, time }) => ({ id, time }))).toEqual(expected.slice(0, 20))
    expect(new Set(logs.entries.map(entry => entry.id)).size).toBe(20)
    expect(logs.entries.every(entry => entry.tone === 'success')).toBe(true)
    expect((await getAgentSubtaskLogs(f.userId, f.definition.id)).entries).toEqual(logs.entries)
    expect(await persistentCounts(f)).toEqual(before)
  }))

  it('rejects foreign definitions and excludes mismatched author, novel, parent or frozen child root', async () => fixture(async f => {
    const valid = await canonicalCall(f, 1)
    await canonicalCall(f, 2, { definitionId: f.foreignDefinition.id, detail: '外国定义私有资料' })
    await canonicalCall(f, 3, { childUserId: f.foreignUserId, childNovelId: f.foreignNovelId, childSessionId: f.foreignSessionId, detail: '外国作者私有资料' })
    await canonicalCall(f, 4, { childNovelId: f.otherNovelId, childSessionId: f.otherSessionId })
    await canonicalCall(f, 5, { frozenRootId: randomUUID() })
    const foreignParent = await rootRun(f.foreignUserId, f.foreignNovelId, f.foreignSessionId, 'running', 'active')
    await canonicalCall(f, 6, { parent: foreignParent })
    await canonicalCall(f, 7, { kind: 'spawned' })
    await prisma.agentSubtaskRun.create({ data: { subtaskId: f.definition.id, userId: f.foreignUserId, novelId: f.foreignNovelId,
      task: '外国旧调用', status: 'succeeded', createdAt: new Date(epoch + 8000) } })
    expect((await listAgentSubtasks(f.userId, f.novelId)).items[0]).toMatchObject({ runCount: 1, lastRunAt: valid.grant.createdAt.toISOString() })
    expect((await getAgentSubtaskLogs(f.userId, f.definition.id)).entries.map(entry => entry.id)).toEqual([valid.grant.id])
    await expect(getAgentSubtaskLogs(f.foreignUserId, f.definition.id)).rejects.toMatchObject({ code: 'SUBTASK_NOT_FOUND' })
    await expect(getAgentSubtaskLogs(f.userId, f.foreignDefinition.id)).rejects.toMatchObject({ code: 'SUBTASK_NOT_FOUND' })
    await expect(listAgentSubtasks(f.foreignUserId, f.novelId)).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
  }))

  it('reports real paused, unknown, failed, cancelled and running states, requiring all terminal proofs for success', async () => fixture(async f => {
    const completed = await canonicalCall(f, 1)
    const paused = await canonicalCall(f, 2, { grantStatus: 'paused_parent', runStatus: 'paused', rootStatus: 'paused' })
    const unknown = await canonicalCall(f, 3, { grantStatus: 'reconciliation' })
    const failed = await canonicalCall(f, 4, { grantStatus: 'failed', runStatus: 'failed', rootStatus: 'cancelled', detail: '失败原因' })
    const cancelled = await canonicalCall(f, 5, { grantStatus: 'cancelled', runStatus: 'cancelled', rootStatus: 'cancelled' })
    const running = await canonicalCall(f, 6, { grantStatus: 'running', runStatus: 'running', rootStatus: 'active' })
    const noRootCompletion = await canonicalCall(f, 7, { rootStatus: 'active', detail: '长'.repeat(500) })
    const noRunCompletion = await canonicalCall(f, 8, { runStatus: 'paused' })
    const before = await persistentCounts(f)
    const entries = new Map((await getAgentSubtaskLogs(f.userId, f.definition.id)).entries.map(entry => [entry.id, entry]))
    expect(entries.get(completed.grant.id)).toMatchObject({ title: '内嵌调用完成', tone: 'success' })
    expect(entries.get(paused.grant.id)).toMatchObject({ title: '内嵌调用已暂停', tone: 'warning' })
    expect(entries.get(unknown.grant.id)).toMatchObject({ title: '内嵌调用待核对', tone: 'warning' })
    expect(entries.get(failed.grant.id)).toMatchObject({ title: '内嵌调用失败', tone: 'danger', detail: '失败原因' })
    expect(entries.get(cancelled.grant.id)).toMatchObject({ title: '内嵌调用已取消', tone: 'warning' })
    expect(entries.get(running.grant.id)).toMatchObject({ title: '正在内嵌执行', tone: 'neutral' })
    expect(entries.get(noRootCompletion.grant.id)?.tone).toBe('warning')
    expect(entries.get(noRootCompletion.grant.id)?.detail.length).toBeLessThanOrEqual(180)
    expect(entries.get(noRunCompletion.grant.id)?.tone).toBe('warning')
    expect((await listAgentSubtasks(f.userId, f.novelId)).items[0].runCount).toBe(8)
    expect(await persistentCounts(f)).toEqual(before)
  }))
})
