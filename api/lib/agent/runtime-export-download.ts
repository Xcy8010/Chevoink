import { z } from 'zod'
import { runtimeError, runtimeJson, runtimeTransaction, databaseNow } from './runtime-common.js'
import { readToolOperationSource } from './runtime-tool-cursor.js'
import { exportPublicationSchema, exportWorkSchema, readExportSource, EXPORT_TTL_MS } from './runtime-export-contract.js'
import { readExportFile, storeExportFile } from '../export-private-storage.js'
import { renderNovelExportZip } from '../export-service.js'

/** The original random short-lived token remains the anonymous credential.
 * A private file alone grants nothing: event, parent, effect and owner must
 * agree before any manuscript bytes are loaded. No live run lease is needed. */
export async function getDurableExport(exportId: string, userId?: string) {
  try { return await readDurableExport(exportId, userId) }
  catch (error) {
    if (error instanceof z.ZodError) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出发布回执格式无效。')
    throw error
  }
}

async function readDurableExport(exportId: string, userId?: string) {
  if (!z.string().uuid().safeParse(exportId).success) return null
  const admitted = await runtimeTransaction(async tx => {
    const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `export:${exportId}` } })
    if (!event || event.type !== 'export.published' || !event.operationId) return null
    const publication = exportPublicationSchema.parse(event.payload)
    const now = await databaseNow(tx)
    if (userId !== undefined && publication.userId !== userId || Date.parse(publication.expiresAt) <= now.getTime()) return null
    const root = await tx.agentTaskRoot.findUnique({ where: { id: event.taskRootId } })
    const parent = await tx.agentOperation.findUnique({ where: { id: event.operationId }, include: { effectReceipt: true } })
    if (!root || !parent || parent.kind !== 'tool' || parent.action !== 'novel_export' || parent.status !== 'succeeded' || !parent.effectReceipt
      || parent.taskRootId !== root.id || root.userId !== publication.userId || publication.exportId !== exportId
      || publication.taskRootId !== root.id || publication.parentOperationId !== parent.id || publication.parentInputHash !== parent.inputHash
      || Date.parse(publication.expiresAt) - Date.parse(publication.publishedAt) !== EXPORT_TTL_MS
      || Date.parse(publication.publishedAt) > now.getTime()) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出发布身份或有效期不一致。')
    const receipt = parent.effectReceipt
    const result = z.object({ publication: exportPublicationSchema }).parse(receipt.result)
    const committed = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${parent.id}` } })
    if (runtimeJson(receipt.result).hash !== receipt.resultHash || runtimeJson(result.publication).hash !== runtimeJson(publication).hash
      || !committed || committed.type !== 'effect.committed' || committed.operationId !== parent.id || committed.taskRootId !== root.id
      || runtimeJson(committed.payload).hash !== runtimeJson({ operationId: parent.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出缺少一致的交付回执。')
    const source = await readToolOperationSource(tx, parent), work = exportWorkSchema.parse(source.input.work)
    if (source.input.novelId !== root.novelId || work.novelId !== root.novelId || work.identity.userId !== root.userId || work.identity.taskRootId !== root.id
      || work.identity.operationKey !== parent.operationKey || work.identity.sourceHash !== source.source.snapshotHash
      || work.identity.argsHash !== source.input.normalization.normalizedArgsHash || work.exportId !== exportId
      || work.fileName !== publication.fileName || work.summary !== publication.summary
      || (source.input.args.includeInfo === false) !== (work.advice.kind === 'omitted')) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出快照与下载凭证不一致。')
    if (!await tx.novel.findFirst({ where: { id: root.novelId, authorId: root.userId } })) return null
    return { publication, work }
  })
  if (!admitted) return null
  const { work, publication } = admitted
  // Absence may reconstruct the exact original ZIP. Corruption never becomes a
  // cache miss and cannot silently reread today's manuscript or call a model.
  let zip = await readExportFile(work.identity, 'zip')
  if (!zip) {
    const source = await readExportSource(work)
    zip = await storeExportFile(work.identity, 'zip', renderNovelExportZip(source.snapshot, publication.advice).buffer)
  }
  if (runtimeJson(zip.pointer).hash !== runtimeJson(publication.zip).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原导出文件与发布回执不一致。')
  if (Date.parse(publication.expiresAt) <= Date.now()) return null
  return { buffer: zip.body, fileName: publication.fileName }
}
