import { randomUUID } from 'node:crypto'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { novelDeleteArchiveManifestSchema, novelDeleteArchivePageSchema, novelDeleteArchiveRowSchema,
  type NovelDeleteArchiveRow, type NovelDeletion } from './runtime-novel-delete-contract.js'

/** DB-only accounting retention, in the SAME transaction as the actual purge.
 * Rows contain only the strict accounting contract, never response/body text.
 * The deletion coordinator owns source/approval/lease authority separately. */
export async function writeNovelDeletionArchive(tx: RuntimeTx, identity: { taskRootId: string; operationId: string; inputHash: string; runId: string }, rows: NovelDeleteArchiveRow[]) {
  const parsed = rows.map(row => novelDeleteArchiveRowSchema.parse(row))
  const ids = new Set<string>()
  for (const row of parsed) {
    const key = `${row.kind}:${row.id}`
    if (ids.has(key)) return runtimeError('RUNTIME_RECEIPT_INVALID', '删除账务证据含重复身份。')
    ids.add(key)
  }
  const refs: NovelDeletion['archive']['refs'] = []
  for (let offset = 0; offset < parsed.length; offset += 200) {
    const index = refs.length, page = novelDeleteArchivePageSchema.parse({ version: 1, operationId: identity.operationId, inputHash: identity.inputHash,
      index, rows: parsed.slice(offset, offset + 200) })
    const payload = runtimeJson(page), eventKey = `novel-delete:${identity.operationId}:accounting:${index}`
    const saved = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    if (saved) {
      if (saved.taskRootId !== identity.taskRootId || saved.operationId !== identity.operationId || saved.runId !== identity.runId
        || saved.type !== 'novel.deletion.accounting' || runtimeJson(saved.payload).hash !== payload.hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原删除账务页不能被替换。')
    } else await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: identity.taskRootId, operationId: identity.operationId,
      runId: identity.runId, eventKey, type: 'novel.deletion.accounting', payload: payload.value } })
    refs.push({ index, eventKey, hash: payload.hash, count: page.rows.length })
  }
  // This existing operation/outbox JSON bound is technical, never truncation.
  // A failure rolls the enclosing deletion transaction back with all data intact.
  return novelDeleteArchiveManifestSchema.parse(runtimeJson({ version: 1, refs, count: parsed.length }).value)
}

/** This is NOT a public authority reader. Call only after authenticating the
 * original completed deletion/source/effect/tombstone and the requesting user. */
export async function readNovelDeletionArchive(tx: RuntimeTx, deletion: NovelDeletion) {
  const manifest = novelDeleteArchiveManifestSchema.parse(deletion.archive), rows: NovelDeleteArchiveRow[] = [], identities = new Set<string>()
  for (const [index, ref] of manifest.refs.entries()) {
    if (ref.index !== index || ref.eventKey !== `novel-delete:${deletion.operationId}:accounting:${index}`) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务页顺序无效。')
    const saved = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: ref.eventKey } })
    if (!saved || saved.taskRootId !== deletion.taskRootId || saved.operationId !== deletion.operationId || saved.runId !== deletion.runId
      || saved.type !== 'novel.deletion.accounting' || runtimeJson(saved.payload).hash !== ref.hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务页缺失或已变化。')
    const page = novelDeleteArchivePageSchema.parse(saved.payload)
    if (page.index !== index || page.operationId !== deletion.operationId || page.inputHash !== deletion.inputHash || page.rows.length !== ref.count) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务页与清单不一致。')
    for (const row of page.rows) {
      const key = `${row.kind}:${row.id}`
      if (identities.has(key)) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务身份重复。')
      identities.add(key); rows.push(row)
    }
  }
  if (rows.length !== manifest.count) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务记录不完整。')
  return rows
}
