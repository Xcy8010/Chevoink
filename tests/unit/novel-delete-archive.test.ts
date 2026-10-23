import { describe, expect, it, vi } from 'vitest'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { writeNovelDeletionArchive, readNovelDeletionArchive } from '../../api/lib/agent/runtime-novel-delete-archive.js'
import type { NovelDeleteArchiveRow, NovelDeletion } from '../../api/lib/agent/runtime-novel-delete-contract.js'

const identity = { taskRootId: 'root', operationId: 'delete-operation', inputHash: 'a'.repeat(64), runId: 'current-run' }
const row = (index: number): Extract<NovelDeleteArchiveRow, { kind: 'run' }> => ({ kind: 'run', id: `original-run-${index}`, userId: 'owner', novelId: 'novel', sessionId: 'original-session',
  taskRootId: 'original-root', taskKey: 'original-root', taskSpecHash: 'b'.repeat(64), status: 'paused', lastSequence: index })
function fixture() {
  type Record = { id: string; taskRootId: string; operationId: string; runId: string; eventKey: string; type: string; payload: unknown }
  const records = new Map<string, Record>()
  const findUnique = vi.fn(async ({ where }: { where: { eventKey: string } }) => records.get(where.eventKey) ?? null)
  const create = vi.fn(async ({ data }: { data: Record }) => { const saved = structuredClone(data); records.set(data.eventKey, saved); return saved })
  const tx = { agentExecutionOutbox: { findUnique, create } } as unknown as RuntimeTx
  const deletion = (archive: NovelDeletion['archive']): NovelDeletion => ({ version: 1, userId: 'owner', taskRootId: 'root', operationId: 'delete-operation', inputHash: identity.inputHash,
    runId: 'current-run', novelId: 'novel', sessionId: 'session', workHash: 'c'.repeat(64), receiptHash: 'd'.repeat(64), source: { revision: 1, hash: 'e'.repeat(64) },
    terminal: { revision: 2, hash: 'f'.repeat(64) }, archive, chapterCount: 1, runCount: archive.count,
    messageId: 'delete-message', callId: 'delete-call', output: '合成删除回执', summary: '合成', committedAt: '2026-10-23T00:00:00Z',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, durationMs: 0 })
  return { tx, records, create, deletion }
}

describe('deletion archive retains accounting identity without granting deletion or replay authority', () => {
  it('retains every original identity across multiple bounded pages and reuses identical committed pages', async () => {
    const f = fixture(), rows = Array.from({ length: 401 }, (_, index) => row(index))
    const manifest = await writeNovelDeletionArchive(f.tx, identity, rows)
    expect(manifest.refs.map(ref => ref.count)).toEqual([200, 200, 1])
    expect(await readNovelDeletionArchive(f.tx, f.deletion(manifest))).toEqual(rows)
    expect(await writeNovelDeletionArchive(f.tx, identity, rows)).toEqual(manifest)
    expect(f.create).toHaveBeenCalledTimes(3)
  })
  it('does not replace a published original page with different historical facts', async () => {
    const f = fixture()
    await writeNovelDeletionArchive(f.tx, identity, [row(0)])
    await expect(writeNovelDeletionArchive(f.tx, identity, [{ ...row(0), status: 'completed' }])).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
    expect(f.create).toHaveBeenCalledOnce()
  })
  it.each(['missing', 'changed', 'other-root', 'other-operation', 'other-run', 'other-type', 'reordered', 'count'] as const)('rejects %s accounting evidence', async change => {
    const f = fixture(), manifest = await writeNovelDeletionArchive(f.tx, identity, [row(0)])
    const ref = manifest.refs[0], saved = f.records.get(ref.eventKey)!
    if (change === 'missing') f.records.delete(ref.eventKey)
    if (change === 'changed') saved.payload = { unrelated: true }
    if (change === 'other-root') saved.taskRootId = 'other-root'
    if (change === 'other-operation') saved.operationId = 'other-operation'
    if (change === 'other-run') saved.runId = 'other-run'
    if (change === 'other-type') saved.type = 'unrelated'
    if (change === 'reordered') ref.index = 1
    if (change === 'count') manifest.count = 2
    await expect(readNovelDeletionArchive(f.tx, f.deletion(manifest))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('rejects duplicate identities and text payloads before writing an archive page', async () => {
    const f = fixture()
    await expect(writeNovelDeletionArchive(f.tx, identity, [row(0), row(0)])).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    const privateRow = { ...row(0), manuscript: 'must never be archived here' }
    await expect(writeNovelDeletionArchive(f.tx, identity, [privateRow])).rejects.toThrow()
    expect(f.create).not.toHaveBeenCalled()
  })
  it('also detects duplicated identities inside otherwise hash-consistent caller-supplied pages', async () => {
    const f = fixture(), manifest = await writeNovelDeletionArchive(f.tx, identity, [row(0), row(1)])
    const saved = f.records.get(manifest.refs[0].eventKey)!, page = saved.payload as { rows: NovelDeleteArchiveRow[] }
    page.rows[1] = page.rows[0]; manifest.refs[0].hash = runtimeJson(page).hash
    await expect(readNovelDeletionArchive(f.tx, f.deletion(manifest))).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
})
