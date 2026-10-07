import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../data/internal.js'
import { assertWritingTarget, readWritingScope } from './writing-scope.js'
import { runtimeJson } from './runtime-common.js'
import { writingNewVolumeSchema, type WritingNewVolume } from '../../../shared/contracts/writing-volume-contracts.js'

type Subject = { userId: string; novelId: string; runId: string }

/** Counts prompt a review of the arc; they never determine a volume boundary. */
export async function readWritingVolumeContext(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number) {
  const previous = await tx.chapter.findFirst({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId), orderIndex: { lt: targetOrderIndex } },
    orderBy: { orderIndex: 'desc' }, include: { volume: true } })
  if (!previous) return null
  const current = await tx.chapter.findFirst({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId), orderIndex: targetOrderIndex }, include: { volume: true } })
  const volume = current?.volume ?? previous.volume
  const count = await tx.chapter.count({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId), volumeId: volume.id } })
  const plans = await tx.agentArtifact.findMany({ where: { artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true },
    run: { userId: subject.userId, novelId: subject.novelId } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 2,
    select: { id: true, title: true, content: true } })
  const volumeName = volume.title.replace(/^第\s*[0-9零〇一二两三四五六七八九十百千]+\s*卷\s*/u, '').trim()
  const planStatus = !plans.length ? '没有已保存卷计划' : volumeName && plans.some(plan => plan.content.includes(volumeName))
    ? '计划提及当前卷名；仍须核对原卷目标是否完成' : '已保存计划未提及当前卷名，尚无可执行的卷映射；不能机械套用旧卷脊柱'
  return { volumeId: volume.id, volumeTitle: volume.title, summary: volume.summary ?? '', chapterCount: count,
    previousChapter: { id: previous.id, revision: previous.revision, orderIndex: previous.orderIndex, title: previous.title, ending: previous.content.slice(-2400) },
    planStatus, plans: plans.map(plan => ({ ...plan, content: plan.content.slice(0, 3600) })) }
}

export async function assertWritingVolumeBoundary(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number, input: WritingNewVolume) {
  const proposed = writingNewVolumeSchema.parse(input)
  const scope = await assertWritingTarget(tx, subject, { orderIndex: targetOrderIndex })
  const capability = scope.writing?.tailVolume
  const target = scope.writing?.targets.find(item => item.orderIndex === targetOrderIndex)
  if (scope.parentRunId || !capability || capability.targetOrderIndex !== targetOrderIndex || !target || target.chapterId
    || target.volumeId || target.positionInVolume !== undefined || scope.bindings?.targets.some(item => item.orderIndex === targetOrderIndex)) {
    throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原冻结任务没有为此未创建末尾章授权新尾卷；继续原卷，已绑定章不得移动。')
  }
  const previous = await tx.chapter.findFirst({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) }, orderBy: { orderIndex: 'desc' } })
  const evidence = proposed.boundary
  if (!previous || previous.orderIndex + 1 !== targetOrderIndex || previous.id !== capability.previousChapterId
    || previous.revision !== capability.previousRevision || evidence.previousChapterId !== previous.id || evidence.previousRevision !== previous.revision
    || !previous.content.includes(evidence.quote) || evidence.completedObjective === evidence.nextConflict) {
    throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '新卷收束依据不匹配真实末章当前版本或精确原文，请重新审视卷目标；缺证据继续原卷。')
  }
  return proposed
}

/** Only the chapter-create effect calls this, under its novel lock and live fence. */
export async function assertPreparedWritingVolumeDecision(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number, input?: WritingNewVolume) {
  const scope = await readWritingScope(tx, subject)
  const capability = scope.writing?.tailVolume
  if (!capability && !input) return
  const compilation = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: { in: [...new Set([scope.sourceRunId, subject.runId])] }, status: 'active', targetOrderIndex }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const prepared = compilation?.preparedContext as Record<string, unknown> | null
  const decision = prepared?.volumeDecision as { kind?: string; newVolume?: unknown } | undefined
  if (decision?.kind !== (input ? 'new_volume' : 'continue') || input && runtimeJson(decision.newVolume).hash !== runtimeJson(input).hash) {
    throw new DataAccessError(400, 'INVALID_ARGUMENTS', `请先在本任务PREPARE显式保存${input ? 'new_volume及同一份收束证据' : 'continue及未收束理由'}，然后创建本章。当前卷上下文：${JSON.stringify(await readWritingVolumeContext(tx, subject, targetOrderIndex))}`)
  }
  if (capability) {
    const previous = await tx.chapter.findFirst({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) }, orderBy: { orderIndex: 'desc' } })
    const preparedPrevious = prepared?.previousChapter as { id?: string; revision?: number } | undefined
    if (scope.parentRunId || capability.targetOrderIndex !== targetOrderIndex || !previous || previous.orderIndex + 1 !== targetOrderIndex
      || previous.id !== capability.previousChapterId || previous.revision !== capability.previousRevision
      || preparedPrevious?.id !== previous.id || preparedPrevious.revision !== previous.revision) {
      throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '卷处理决定的冻结前章或当前版本不匹配，未创建或移动任何章节。')
    }
  }
}

export async function createWritingTailVolume(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number, input: WritingNewVolume) {
  const proposed = await assertWritingVolumeBoundary(tx, subject, targetOrderIndex, input)
  await assertPreparedWritingVolumeDecision(tx, subject, targetOrderIndex, proposed)
  const last = await tx.volume.findFirst({ where: { novelId: subject.novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'desc' } })
  return tx.volume.create({ data: { novelId: subject.novelId, title: proposed.title, summary: proposed.summary, orderIndex: (last?.orderIndex ?? 0) + 1 } })
}
