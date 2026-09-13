import type { Prisma } from '@prisma/client'
import { DataAccessError, prisma } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'

type WriteScope = { userId: string; novelId: string; runId: string; transaction?: Prisma.TransactionClient }

/** Run identity, not an editor-provided chapter ID, binds target-less creates to
 * the manuscript the author authorized. Import and restore advance the epoch.
 * Call inside the effect transaction, BEFORE any chapter/volume observation. */
export async function assertAgentManuscriptCurrent(tx: Prisma.TransactionClient, scope: WriteScope): Promise<void> {
  await lockNovelActiveScope(tx, scope.novelId)
  const run = await tx.agentRun.findFirst({
    where: { id: scope.runId, userId: scope.userId, novelId: scope.novelId },
    select: { manuscriptRevision: true, novel: { select: { authorId: true, manuscriptRevision: true } } },
  })
  if (!run || run.novel.authorId !== scope.userId || !Number.isSafeInteger(run.manuscriptRevision)
    || run.manuscriptRevision !== run.novel.manuscriptRevision) {
    throw new DataAccessError(409, 'IMPORT_SCOPE_CHANGED', '作品已导入或恢复，旧任务不能继续写入。请保留历史并在当前稿件新建任务。')
  }
}

export async function withAgentManuscriptWrite<T>(scope: WriteScope, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const apply = async (tx: Prisma.TransactionClient) => {
    await assertAgentManuscriptCurrent(tx, scope)
    return write(tx)
  }
  return scope.transaction ? apply(scope.transaction) : prisma.$transaction(apply)
}
