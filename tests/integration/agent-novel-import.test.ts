import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Request } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

// HTTP identity itself is covered by novel-import route tests. These tests mint
// the real human-only capability through an explicit fixture identity adapter;
// all approvals, leases, operations, import effects and receipts use actual PG.
vi.mock('../../api/lib/auth-session.js', async original => ({
  ...await original<typeof import('../../api/lib/auth-session.js')>(),
  requireSessionUserId: (req: Request) => String(req.headers['x-fixture-user']),
}))
import { prisma } from '../../api/lib/prisma.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { acquireRunLease, revokeRunLease } from '../../api/lib/agent/runtime-lease.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import { readDurableImportBoundary, assertImportCommitExecution } from '../../api/lib/agent/runtime-import.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { novelImportTool } from '../../api/lib/agent/tools/import-tools.js'
import { verifyNovelImportOrigin } from '../../api/lib/novel-import-origin.js'
import { storeAgentAttachment, resolveManagedAttachmentPath } from '../../api/lib/agent-attachment-storage.js'
import { analyzeNovelImport, attachNovelImportSource, authenticateNovelImportHuman, cancelNovelImport, commitNovelImport,
  confirmNovelImport, getNovelImportPreview, getNovelImportStatus, preflightNovelImport, prepareNovelImport, uploadNovelImportSource } from '../../api/lib/novel-import-service.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
let directory = ''
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'agent-import-fixture-'))
  vi.stubEnv('NOVEL_IMPORT_STORAGE_DIR', directory)
  vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  if (directory) {
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.blob$/.test(name)) throw new Error('unexpected fixture file')
      await unlink(path.join(directory, name))
    }
    await rmdir(directory)
  }
  vi.unstubAllEnvs()
  await prisma.$disconnect()
})

async function fixture(work: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture()
  try { await work(f) } finally {
    const sources = await prisma.novelImportSource.findMany({ where: { job: { userId: f.userId } }, select: { storageKey: true } })
    const manifests = await prisma.novelImportManifest.findMany({ where: { job: { userId: f.userId } }, select: { storageKey: true } })
    const artifacts = await prisma.novelImportArtifact.findMany({ where: { job: { userId: f.userId } }, select: { storageKey: true } })
    await prisma.agentRun.deleteMany({ where: { userId: f.userId } })
    await prisma.agentSession.deleteMany({ where: { userId: f.userId } })
    await prisma.chapter.deleteMany({ where: { authorId: f.userId } })
    await prisma.novel.deleteMany({ where: { authorId: f.userId } })
    await prisma.user.delete({ where: { id: f.userId } })
    await prisma.novelImportGarbage.deleteMany({ where: { storageKey: { in: [...sources, ...manifests, ...artifacts].map(row => row.storageKey) } } })
    await unlink(resolveManagedAttachmentPath(f.attachment.url)!)
  }
}
async function createFixture() {
  const user = await prisma.user.create({ data: { nickname: 'agent-import-fixture', passwordHash: 'fixture-only' } })
  const novel = await prisma.novel.create({ data: { authorId: user.id, title: '导入测试', summary: '', slug: randomUUID() } })
  const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '测试', toolPolicy: { destructive: 'allow' } } })
  const bytes = Buffer.from('第一章 起点\n这是拥有授权的完整测试原文。')
  const attachment = await storeAgentAttachment({ userId: user.id, kind: 'file', name: '原稿.txt', dataUrl: `data:text/plain;base64,${bytes.toString('base64')}` })
  const scope = { userId: user.id, novelId: novel.id }
  const human = authenticateNovelImportHuman({ params: { novelId: novel.id }, headers: { 'x-fixture-user': user.id } } as unknown as Request)
  const admit = async (args: Record<string, unknown>, permission: 'allow' | 'ask' = 'allow') => {
    const runId = randomUUID(), callId = 'import-call', messageId = randomUUID()
    const spec = buildTaskSpec({ runId, novelId: novel.id, chapterId: null, prompt: '把本次上传的原稿导入当前作品' })
    await prisma.agentRun.create({ data: { id: runId, ...scope, sessionId: session.id, status: 'queued', mode: 'act',
      action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
    await prisma.agentMessage.create({ data: { id: messageId, runId, sessionId: session.id, role: 'user',
      parts: [{ type: 'text', text: '导入原稿' }, { type: 'attachment', kind: 'file', name: attachment.name, url: attachment.url }] } })
    const root = await initializeDurableTask({ userId: user.id, runId, sourceMessageId: messageId })
    const lease = await acquireRunLease({ userId: user.id, runId, ownerId: 'import-fixture', claimId: randomUUID(), ttlMs: 120000 })
    const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: novelImportTool.name, description: novelImportTool.description, parameters: z.toJSONSchema(novelImportTool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: 'novel_import', permission, alwaysConfirm: false, dangerous: true }], protectedChapterIds: [], pinnedSkillVersions: [] },
      snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
        messages: [{ role: 'user', content: '导入原稿' }, { role: 'assistant', content: null, toolCalls: [{ id: callId, name: 'novel_import', arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
    return { runId, callId, rootId: root.id, lease, initial }
  }
  const ready = async (intentId: string, runId?: string) => {
    const job = await prepareNovelImport(scope, intentId)
    if (runId) await attachNovelImportSource(human, job.jobId, { runId, url: attachment.url })
    else await uploadNovelImportSource(scope, job.jobId, '原稿.txt', (async function* () { yield bytes })())
    // The isolated DB may run the core import suite concurrently; retry only
    // its explicit busy admission, never steal/clear another job's parser lease.
    let parseError: unknown
    await vi.waitFor(async () => {
      try { await analyzeNovelImport(scope, job.jobId) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'IMPORT_WRITE_BUSY') expect.fail('waiting for the shared parser admission')
        parseError = error
      }
    }, { timeout: 20000, interval: 100 })
    if (parseError) throw parseError
    await vi.waitFor(async () => expect((await getNovelImportStatus(scope, job.jobId)).status).toBe('ready'), { timeout: 15000 })
    // Public ready must already be confirmable, not await a later finally cleanup.
    // Keep this outside waitFor so a live lease fails instead of being retried.
    expect(await prisma.novelImportJob.findFirstOrThrow({ where: { id: job.jobId, ...scope },
      select: { status: true, leaseOwner: true, leaseUntil: true } })).toEqual({ status: 'ready', leaseOwner: null, leaseUntil: null })
    const preview = await getNovelImportPreview(scope, job.jobId)
    return { job, preview }
  }
  return { ...scope, scope, sessionId: session.id, attachment, human, admit, ready }
}

describe.skipIf(!available)('Agent import durable workflow on isolated PG', () => {
  it('persists one prepare intent and waiting event, verifies origin, replays UI without granting approval', async () => fixture(async f => {
    const run = await f.admit({ action: 'prepare', attachmentUrl: f.attachment.url })
    const first = await executeDurableToolStep(run.lease, new AbortController().signal)
    expect(first.kind).toBe('waiting_import')
    expect(await executeDurableToolStep(run.lease, new AbortController().signal)).toEqual(first)
    expect(await prisma.novelImportIntent.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.novelImportJob.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.novelImportApproval.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(0)
    await expect(verifyNovelImportOrigin(prisma, f, run)).resolves.toEqual({ agentRunId: run.runId, agentToolCallId: run.callId })
    await expect(verifyNovelImportOrigin(prisma, f, { ...run, callId: 'fabricated' })).rejects.toMatchObject({ code: 'IMPORT_ATTACHMENT_SCOPE' })
    const events = await publishDurableEvents(f.userId, run.runId)
    const waiting = events.find(event => event.type === 'tool.call' && event.importWaiting)
    expect(waiting).toMatchObject({ type: 'tool.call', autoApproved: false, importWaiting: { url: expect.stringContaining('importCallId=import-call') } })
    expect(await publishDurableEvents(f.userId, run.runId)).toEqual([])
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: run.rootId } } })).toBe(0)
  }))
  it('shared human approval and actual commit wake prepare, retain one receipt and stop the old queue', async () => fixture(async f => {
    const run = await f.admit({ action: 'prepare', attachmentUrl: f.attachment.url })
    await executeDurableToolStep(run.lease, new AbortController().signal)
    const intent = await preflightNovelImport(f.scope, run)
    const { job, preview } = await f.ready(intent.intentId, run.runId)
    const approval = await confirmNovelImport(f.human, job.jobId, { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: intent.targetHash })
    await commitNovelImport(f.scope, job.jobId, { approvalId: approval.approvalId, idempotencyKey: randomUUID() })
    const completed = await executeDurableToolStep(run.lease, new AbortController().signal)
    expect(completed).toMatchObject({ kind: 'tool', result: { summary: '导入已提交，待核对新稿' } })
    expect(await readDurableImportBoundary(run.lease)).toMatchObject({ kind: 'needs_attention', importBoundary: true })
    expect(await prisma.novelImportCommit.count({ where: { jobId: job.jobId } })).toBe(1)
    expect(await prisma.chapter.findMany({ where: { novelId: f.novelId }, select: { status: true, visibility: true } })).toEqual([{ status: 'draft', visibility: 'private' }])
  }))
  it('commit with generic allow waits for real approval, then consumes only the exact manifest grant', async () => fixture(async f => {
    const intent = await preflightNovelImport(f.scope)
    const { job, preview } = await f.ready(intent.intentId)
    const run = await f.admit({ action: 'commit', jobId: job.jobId })
    expect((await executeDurableToolStep(run.lease, new AbortController().signal)).kind).toBe('waiting_import')
    expect(await prisma.novelImportCommit.count({ where: { jobId: job.jobId } })).toBe(0)
    // The persisted, exact commit origin permits this human confirmation while
    // the run is waiting. No stop/status hack or model approval is needed.
    const approval = await confirmNovelImport(f.human, job.jobId, { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: intent.targetHash })
    expect(await executeDurableToolStep(run.lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { summary: '导入已提交，待核对新稿' } })
    const receipt = await prisma.novelImportCommit.findUniqueOrThrow({ where: { jobId: job.jobId } })
    expect(receipt.approvalId).toBe(approval.approvalId)
    expect(receipt.idempotencyKey).toBe(`agent-import:${job.jobId}:${approval.approvalId}`)
    expect((await prisma.novelImportApproval.findUniqueOrThrow({ where: { id: approval.approvalId } })).consumedAt).not.toBeNull()
  }))
  it('a cancelled job produces a stable failed result and cannot silently continue old write tools', async () => fixture(async f => {
    const run = await f.admit({ action: 'prepare', attachmentUrl: f.attachment.url })
    await executeDurableToolStep(run.lease, new AbortController().signal)
    const intent = await preflightNovelImport(f.scope, run)
    const job = await prepareNovelImport(f.scope, intent.intentId)
    await cancelNovelImport(f.scope, job.jobId)
    expect(await executeDurableToolStep(run.lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect(await readDurableImportBoundary(run.lease)).toMatchObject({ kind: 'needs_attention' })
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(0)
  }))
  it('revoked lease is rejected inside the actual core commit admission transaction', async () => fixture(async f => {
    const intent = await preflightNovelImport(f.scope)
    const { job } = await f.ready(intent.intentId)
    const run = await f.admit({ action: 'commit', jobId: job.jobId })
    await executeDurableToolStep(run.lease, new AbortController().signal)
    const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: run.rootId, action: 'novel_import' } })
    await revokeRunLease(f.userId, run.runId)
    const ctx = { ...f, ...run, chapterId: null, mode: 'build' as const, creativeFreedom: 'stable' as const, qualityMode: 'premium' as const,
      signal: new AbortController().signal, emit: vi.fn(), durableImport: { lease: run.lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: run.initial.frame.snapshotHash } } }
    await expect(prisma.$transaction(tx => assertImportCommitExecution(tx, ctx, operation.id, operation.inputHash))).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    expect(await prisma.novelImportCommit.count({ where: { jobId: job.jobId } })).toBe(0)
  }))
  it('recovers a successful core commit after the Agent receipt write is interrupted without importing twice', async () => fixture(async f => {
    const intent = await preflightNovelImport(f.scope)
    const { job, preview } = await f.ready(intent.intentId)
    await confirmNovelImport(f.human, job.jobId, { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: intent.targetHash })
    const run = await f.admit({ action: 'commit', jobId: job.jobId })
    const interrupted = vi.spyOn(operations, 'commitOperationEffect').mockRejectedValueOnce(new Error('fixture: response lost after core commit'))
    await expect(executeDurableToolStep(run.lease, new AbortController().signal)).rejects.toThrow('response lost')
    interrupted.mockRestore()
    expect(await prisma.novelImportCommit.count({ where: { jobId: job.jobId } })).toBe(1)
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: run.rootId, action: 'novel_import' } } })).toBe(0)
    expect(await executeDurableToolStep(run.lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { summary: '导入已提交，待核对新稿' } })
    expect(await prisma.novelImportCommit.count({ where: { jobId: job.jobId } })).toBe(1)
    expect(await prisma.novelImportBackup.count({ where: { jobId: job.jobId } })).toBe(1)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
  }))
  it('expired preparation cannot treat silence as approval or continue the old queue', async () => fixture(async f => {
    const run = await f.admit({ action: 'prepare', attachmentUrl: f.attachment.url })
    const waiting = await executeDurableToolStep(run.lease, new AbortController().signal)
    if (waiting.kind !== 'waiting_import') throw new Error('expected waiting')
    const event = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: waiting.requestId } })
    await prisma.agentExecutionOutbox.update({ where: { id: event.id }, data: { payload: { ...(event.payload as object), expiresAt: new Date(Date.now() - 60000).toISOString() } } })
    expect(await executeDurableToolStep(run.lease, new AbortController().signal)).toMatchObject({ kind: 'tool', result: { outcome: 'failed', summary: '导入等待已过期' } })
    expect(await prisma.novelImportApproval.count({ where: { userId: f.userId } })).toBe(0)
    expect(await readDurableImportBoundary(run.lease)).toMatchObject({ kind: 'needs_attention' })
  }))
  it('rejects a human grant when the target changes before actual commit', async () => fixture(async f => {
    const intent = await preflightNovelImport(f.scope)
    const { job, preview } = await f.ready(intent.intentId)
    const approval = await confirmNovelImport(f.human, job.jobId, { manifestRevision: preview.manifestRevision, manifestHash: preview.manifestHash, targetHash: intent.targetHash })
    const run = await f.admit({ action: 'commit', jobId: job.jobId })
    await prisma.novel.update({ where: { id: f.novelId }, data: { summary: '作者在批准后修改了目标' } })
    const result = await executeDurableToolStep(run.lease, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'tool', result: { outcome: 'failed', output: expect.stringContaining('IMPORT_TARGET_CHANGED') } })
    expect(await prisma.novelImportCommit.count({ where: { jobId: job.jobId } })).toBe(0)
    expect((await prisma.novelImportApproval.findUniqueOrThrow({ where: { id: approval.approvalId } })).consumedAt).toBeNull()
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(0)
  }))
})
