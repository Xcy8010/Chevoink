import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'

/** Shared with import/restore. Acquire before observing or changing chapter/volume
 * structure, inside the SAME transaction as the mutation. Row locks cover empty
 * books too, unlike locking the current chapter list. No process-local mutex. */
export async function lockNovelActiveScope(tx: Prisma.TransactionClient, novelId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM novels WHERE id = ${novelId} FOR UPDATE`
  if (rows.length !== 1) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或已被删除。')
}
