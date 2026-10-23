import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

const subject = { userId: 'user', novelId: 'novel', runId: 'run' }
function fixture(native = true) {
  const prompt = '完整修改第一章正文。'
  const generated = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt })
  generated.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  const spec = JSON.parse(JSON.stringify(generated)) as typeof generated
  const original = runtimeJson({ spec, request: { prompt } })
  const root = { id: 'root', specSnapshot: spec, requestSnapshot: { prompt }, inputHash: original.hash }
  const run = { id: 'run', sessionId: 'session', taskRootId: native ? 'root' : null, chapterId: 'chapter', manuscriptRevision: 7,
    writingBindings: null as unknown, taskSpec: spec as unknown, startRequest: { prompt } as unknown }
  // Native readers must not ask Prisma to deserialize these duplicated JSON fields.
  const unused = vi.fn(() => { throw Error('Unused native JSON column requested') })
  const project = (query: { select?: Record<string, boolean> }) => {
    if (!native) return query.select ? Object.fromEntries(Object.keys(query.select).map(key => [key, run[key as keyof typeof run]])) : run
    const stored = { ...run, get taskSpec() { return unused() }, get startRequest() { return unused() }, get usage() { return unused() } }
    return query.select ? Object.fromEntries(Object.keys(query.select).map(key => [key, stored[key as keyof typeof stored]])) : { ...stored }
  }
  const tx = { agentRun: { findFirst: vi.fn(async (query: { select?: Record<string, boolean> }) => project(query)), findFirstOrThrow: vi.fn(async (query: { select?: Record<string, boolean> }) => project(query)) },
    agentChildExecutionGrant: { findUnique: vi.fn(async () => null) }, agentSession: { findFirst: vi.fn(async () => ({ spawnedFromRunId: null })) },
    agentTaskRoot: { findFirst: vi.fn(async () => root) }, agentMessage: { findFirst: vi.fn(async () => ({ parts: [{ type: 'text', text: '历史原始请求' }] })) } }
  return { tx, transaction: tx as unknown as Prisma.TransactionClient, run, root, spec, prompt, unused }
}

describe('native original request and writing-source projections', () => {
  it('reads the same authenticated root without loading the duplicated run JSON', async () => {
    const f = fixture()
    expect(await readOriginalTaskRequest(f.transaction, subject)).toEqual({ prompt: f.prompt, spec: f.spec, taskId: 'root', sourceRunId: 'run', parentRunId: null })
    expect(f.unused).not.toHaveBeenCalled()
    expect(f.tx.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'run', userId: 'user', novelId: 'novel' } }))
  })
  it('retains the root integrity rejection', async () => {
    const f = fixture(); f.root.inputHash = '0'.repeat(64)
    await expect(readOriginalTaskRequest(f.transaction, subject)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('retains the owned-run rejection before any root read', async () => {
    const f = fixture(); f.tx.agentRun.findFirst.mockResolvedValueOnce(null as never)
    await expect(readOriginalTaskRequest(f.transaction, subject)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(f.tx.agentTaskRoot.findFirst).not.toHaveBeenCalled()
  })
  it('retains legacy task identity, prompt and original source-row interpretation', async () => {
    const f = fixture(false)
    expect(await readOriginalTaskRequest(f.transaction, subject)).toEqual({ prompt: f.prompt, spec: f.spec, taskId: f.spec.id, sourceRunId: 'run', parentRunId: null })
    expect(f.tx.agentRun.findFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user', novelId: 'novel', sessionId: 'session',
      taskSpec: { path: ['id'], equals: f.spec.id }, incomingChildGrant: null } }))
  })
  it('retains the legacy admission-message fallback', async () => {
    const f = fixture(false); f.run.startRequest = null; f.run.taskSpec = null
    expect(await readOriginalTaskRequest(f.transaction, subject)).toMatchObject({ prompt: '历史原始请求', taskId: 'run', sourceRunId: 'run' })
  })
  it('reads current writing bindings and manuscript revision from the projected source', async () => {
    const f = fixture()
    expect(await readWritingScope(f.transaction, subject)).toMatchObject({ writing: f.spec.scope.writing, bindings: null })
    expect(f.unused).not.toHaveBeenCalled()
  })
  it('retains rejection of a binding to another original task', async () => {
    const f = fixture(); f.run.writingBindings = { version: 1, taskId: 'other', targets: [{ orderIndex: 1, chapterId: 'chapter' }] }
    await expect(readWritingScope(f.transaction, subject)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
})
