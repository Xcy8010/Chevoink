import { describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { readVerifiedNovelDeletion } from '../../api/lib/agent/runtime-novel-delete-read.js'
import { writeNovelDeletionArchive } from '../../api/lib/agent/runtime-novel-delete-archive.js'
import type { NovelDeleteWork, NovelDeletion } from '../../api/lib/agent/runtime-novel-delete-contract.js'
import { readDeletedNovelEvents } from '../../api/lib/agent/runtime-novel-delete-events.js'

type Event = { id: string; taskRootId: string; operationId: string | null; runId: string; eventKey: string; type: string; payload: unknown }
async function fixture() {
  const root = { id: 'root', userId: 'owner', novelId: 'novel', sessionId: 'session', status: 'completed', specSnapshot: { original: true }, requestSnapshot: ['synthetic original'] }
  const inputHash = runtimeJson({ spec: root.specSnapshot, request: root.requestSnapshot }).hash
  const configuration = { version: 1, mode: 'build', agentType: 'novelist', creativeFreedom: 'stable', qualityMode: 'balanced',
    model: { tier: 'speed', provider: 'openai', modelName: 'synthetic', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: [{ type: 'function', function: { name: 'novel_delete', description: 'synthetic', parameters: { type: 'object' } } }],
    toolAuthority: [{ name: 'novel_delete', permission: 'ask', alwaysConfirm: true, dangerous: true }], protectedChapterIds: [], pinnedSkillVersions: [] }
  const args = { confirmTitle: '合成作品' }, rawArguments = JSON.stringify(args), events = new Map<string, Event>()
  const base = { version: 1, turn: 1, nextOperationSequence: 1, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
    messages: [{ role: 'assistant', content: null, toolCalls: [{ id: 'call', name: 'novel_delete', arguments: rawArguments }] }], successfulToolSignatures: [] }
  const frames = [base, { ...base, phase: 'awaiting_operation', pendingOperationId: 'operation', nextOperationSequence: 2 },
    { ...base, phase: 'completed', nextOperationSequence: 2, messages: [...base.messages,
      { role: 'tool', toolCallId: 'call', content: '合成已删除' }, { role: 'assistant', content: '合成已删除' }] }].map((snapshot, revision, all) => ({ taskRootId: root.id, revision, snapshot,
      snapshotHash: runtimeJson(snapshot).hash, previousHash: revision ? runtimeJson(all[revision - 1]).hash : null }))
  const head = { taskRootId: root.id, revision: 2, configuration, configurationHash: runtimeJson({ configuration, inputHash }).hash }
  const add = (eventKey: string, type: string, payload: unknown, id = eventKey) => {
    const event: Event = { id, taskRootId: root.id, runId: 'run', operationId: null, eventKey, type, payload }
    events.set(eventKey, event); return event
  }
  frames.forEach(frame => add(`state:root:${frame.revision}`, 'execution.state.saved',
    { revision: frame.revision, snapshotHash: frame.snapshotHash, previousHash: frame.previousHash }))
  const request = add(`approval:root:${runtimeJson({ sourceHash: frames[0].snapshotHash, callId: 'call' }).hash}`, 'approval.requested',
    { version: 1, callId: 'call', toolName: 'novel_delete', sourceRevision: 0, sourceHash: frames[0].snapshotHash,
      rawArguments, args, argsHash: runtimeJson(args).hash, expiresAt: '2026-10-23T00:00:00Z' }, 'request')
  const decision = add('approval-decision:request', 'approval.resolved',
    { version: 1, requestId: request.id, requestHash: runtimeJson(request.payload).hash, approved: true, userId: 'owner' }, 'decision')
  const work: NovelDeleteWork = { version: 1, userId: 'owner', taskRootId: root.id, originRunId: 'run', sessionId: 'session', novelId: 'novel',
    title: args.confirmTitle, displayTitle: null, confirmTitle: args.confirmTitle,
    approval: { requestId: request.id, requestHash: runtimeJson(request.payload).hash, decisionId: decision.id, decisionHash: runtimeJson(decision.payload).hash } }
  const envelope = { kind: 'tool', action: 'novel_delete', input: { novelId: 'novel', callId: 'call', args, work,
    normalization: { version: 1, rawArguments, normalizedArgsHash: runtimeJson(args).hash, sourceRevision: 0, sourceSnapshotHash: frames[0].snapshotHash } } }
  const operation = { id: 'operation', taskRootId: root.id, kind: 'tool', action: 'novel_delete', status: 'succeeded', originRunId: 'run',
    operationKey: 'exec:1', inputSnapshot: envelope, inputHash: runtimeJson(envelope).hash, effectReceipt: { runId: 'run', result: {} as unknown, resultHash: '' } }
  let liveNovel = false, liveRun = false
  const findEvent = vi.fn(async ({ where }: { where: { eventKey?: string; id?: string } }) =>
    where.eventKey ? events.get(where.eventKey) ?? null : [...events.values()].find(event => event.id === where.id) ?? null)
  const create = vi.fn(async ({ data }: { data: Event }) => { events.set(data.eventKey, structuredClone(data)); return data })
  const tx = { agentExecutionOutbox: { findUnique: findEvent, create },
    agentTaskRoot: { findUnique: vi.fn(async () => ({ ...root, inputHash })), findUniqueOrThrow: vi.fn(async () => ({ ...root, inputHash })) },
    agentOperation: { findUnique: vi.fn(async () => operation) },
    agentExecutionFrame: { findUnique: vi.fn(async ({ where }: { where: { taskRootId_revision: { revision: number } } }) => frames[where.taskRootId_revision.revision] ?? null),
      findFirst: vi.fn(async () => ({ revision: frames.at(-1)!.revision })) },
    agentExecutionState: { findUnique: vi.fn(async () => head) },
    novel: { findUnique: vi.fn(async () => liveNovel ? { id: 'novel' } : null) }, agentRun: { findUnique: vi.fn(async () => liveRun ? { id: 'run' } : null) } } as unknown as RuntimeTx
  const archive = await writeNovelDeletionArchive(tx, { taskRootId: root.id, operationId: operation.id, inputHash: operation.inputHash, runId: 'run' },
    [{ kind: 'run', id: 'run', userId: 'owner', novelId: 'novel', sessionId: 'session', taskRootId: root.id, taskKey: root.id,
      taskSpecHash: runtimeJson(root.specSnapshot).hash, status: 'running', lastSequence: 17 }])
  const deleted = { version: 1, userId: 'owner', taskRootId: root.id, runId: 'run', novelId: 'novel', workHash: runtimeJson(work).hash,
    source: { revision: 1, hash: frames[1].snapshotHash }, archive, chapterCount: 1, runCount: 1,
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 }, durationMs: 12 }
  operation.effectReceipt.result = { toolResult: { output: '合成已删除', summary: '合成删除' }, deleted }
  operation.effectReceipt.resultHash = runtimeJson(operation.effectReceipt.result).hash
  const deletion: NovelDeletion = { ...deleted, version: 1, operationId: operation.id, inputHash: operation.inputHash, sessionId: 'session',
    receiptHash: operation.effectReceipt.resultHash, terminal: { revision: 2, hash: frames[2].snapshotHash },
    messageId: 'message', callId: 'call', output: '合成已删除', summary: '合成删除', committedAt: '2026-10-23T00:00:01Z' }
  const committed = add('novel-delete:operation', 'novel.deletion.committed', deletion); committed.operationId = operation.id
  const effect = add('effect:operation', 'effect.committed', { operationId: operation.id, resultHash: operation.effectReceipt.resultHash }); effect.operationId = operation.id
  const index = add('novel-deleted-run:run', 'novel.deletion.run', { version: 1, userId: 'owner', runId: 'run', operationId: operation.id,
    inputHash: operation.inputHash, deletionHash: runtimeJson(deletion).hash }); index.operationId = operation.id
  create.mockClear()
  findEvent.mockClear()
  return { tx, root, head, frames, events, operation, request, decision, deletion, create, findEvent,
    makeLive: (kind: 'novel' | 'run') => { if (kind === 'novel') liveNovel = true; else liveRun = true } }
}

describe('historical deletion authentication is read-only and needs the original complete proof', () => {
  it('authenticates the original persisted approval after its display deadline without creating a timeout or lease', async () => {
    const f = await fixture(), result = await readVerifiedNovelDeletion(f.tx, 'owner', 'run')
    expect(result?.deletion).toEqual(f.deletion)
    expect(result?.run.lastSequence).toBe(17)
    expect(f.create).not.toHaveBeenCalled()
  })
  it('does not infer success from absent novel/run or expose another owner', async () => {
    const f = await fixture()
    expect(await readVerifiedNovelDeletion(f.tx, 'other', 'run')).toBeNull()
    expect(f.findEvent).toHaveBeenCalledOnce()
    f.events.delete('novel-deleted-run:run')
    expect(await readVerifiedNovelDeletion(f.tx, 'owner', 'run')).toBeNull()
    expect(f.create).not.toHaveBeenCalled()
  })
  it('replays only the same frozen terminal facts above the original sequence and rejects an ahead cursor', async () => {
    const f = await fixture(), events = await readDeletedNovelEvents(f.tx, 'owner', 'run', 0, 200)
    expect(events?.map(event => event.seq)).toEqual([18, 19, 20, 21])
    expect(events?.at(-1)).toMatchObject({ type: 'run.finished', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 }, deletedNovelId: 'novel' })
    expect(await readDeletedNovelEvents(f.tx, 'owner', 'run', 19, 200)).toEqual(events?.slice(2))
    expect(await readDeletedNovelEvents(f.tx, 'owner', 'run', 21, 200)).toEqual([])
    await expect(readDeletedNovelEvents(f.tx, 'owner', 'run', 22, 200)).rejects.toMatchObject({ code: 'RUNTIME_EVENT_CURSOR_AHEAD' })
    expect(f.create).not.toHaveBeenCalled()
  })
  it('does not certify a completed frame that omitted the actual deletion result even if its frame hashes agree', async () => {
    const f = await fixture(), terminal = f.frames[2]
    terminal.snapshot.messages.splice(-2)
    terminal.snapshotHash = runtimeJson(terminal.snapshot).hash
    f.events.get('state:root:2')!.payload = { revision: 2, snapshotHash: terminal.snapshotHash, previousHash: terminal.previousHash }
    f.deletion.terminal.hash = terminal.snapshotHash
    const index = f.events.get('novel-deleted-run:run')!.payload as { deletionHash: string }
    index.deletionHash = runtimeJson(f.deletion).hash
    await expect(readVerifiedNovelDeletion(f.tx, 'owner', 'run')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    expect(f.create).not.toHaveBeenCalled()
  })
  it.each(['novel', 'run'] as const)('does not authenticate a receipt while its %s still exists', async kind => {
    const f = await fixture(); f.makeLive(kind)
    await expect(readVerifiedNovelDeletion(f.tx, 'owner', 'run')).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
  })
  it.each(['index', 'root', 'operation', 'effect', 'receipt', 'request', 'decision', 'source', 'pending', 'terminal', 'archive', 'configuration'] as const)(
    'rejects missing or altered %s proof without manufacturing replacement history', async kind => {
      const f = await fixture()
      if (kind === 'index') f.events.get('novel-deleted-run:run')!.runId = 'other'
      if (kind === 'root') f.root.status = 'active'
      if (kind === 'operation') f.operation.status = 'prepared'
      if (kind === 'effect') f.events.delete('effect:operation')
      if (kind === 'receipt') f.operation.effectReceipt.resultHash = 'a'.repeat(64)
      if (kind === 'request') f.events.delete(f.request.eventKey)
      if (kind === 'decision') f.events.delete(f.decision.eventKey)
      if (kind === 'source') f.frames[0].snapshotHash = 'a'.repeat(64)
      if (kind === 'pending') f.frames[1].snapshotHash = 'a'.repeat(64)
      if (kind === 'terminal') f.frames[2].snapshotHash = 'a'.repeat(64)
      if (kind === 'archive') f.events.delete(f.deletion.archive.refs[0].eventKey)
      if (kind === 'configuration') f.head.configurationHash = 'a'.repeat(64)
      await expect(readVerifiedNovelDeletion(f.tx, 'owner', 'run')).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(f.create).not.toHaveBeenCalled()
    })
})
