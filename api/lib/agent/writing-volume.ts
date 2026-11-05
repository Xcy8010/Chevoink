import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { originalTaskRunIds } from './original-request.js'
import { createVolumeData } from '../data/volume.js'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope, activeVolumeWhere } from '../data/internal.js'
import { assertWritingTarget, readWritingScope } from './writing-scope.js'
import { runtimeJson } from './runtime-common.js'
import { writingNewVolumeSchema, type WritingNewVolume } from '../../../shared/contracts/writing-volume-contracts.js'

type Subject = { userId: string; novelId: string; runId: string }

export function isWritingVolumeTargetOrderIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
}

/** Counts prompt a review of the arc; they never determine a volume boundary. */
export async function readWritingVolumeContext(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number) {
  if (!isWritingVolumeTargetOrderIndex(targetOrderIndex)) {
    throw new DataAccessError(400, 'INVALID_ARGUMENTS', '卷上下文需要有效的目标章节序号。')
  }
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

/** Same-task tail identity is durable even when no compiler was prepared. */
export async function readTailVolumeBinding(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number, scope: Awaited<ReturnType<typeof readWritingScope>>) {
  const runIds = await originalTaskRunIds(tx, subject, scope)
  const compilations = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: { in: runIds }, targetOrderIndex }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  let binding = scope.bindings?.tailVolumes?.find(item => item.targetOrderIndex === targetOrderIndex)
  for (const compilation of compilations) {
    const prepared = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext) ? compilation.preparedContext : {}
    const old = prepared.createdTailVolume
    if (old === undefined) continue
    if (!old || typeof old !== 'object' || Array.isArray(old) || typeof old.id !== 'string' || !old.id
      || typeof old.proposalHash !== 'string' || !/^[a-f0-9]{64}$/u.test(old.proposalHash) || old.targetOrderIndex !== targetOrderIndex) {
      throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原尾卷绑定损坏，未创建替代卷。')
    }
    const historical = { targetOrderIndex, proposalHash: old.proposalHash, volumeId: old.id }
    if (binding && runtimeJson(binding).hash !== runtimeJson(historical).hash) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '同任务尾卷绑定相互冲突。')
    binding = historical
  }
  return { binding, compilations }
}

export async function createWritingTailVolume(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number, input: WritingNewVolume) {
  await lockNovelActiveScope(tx, subject.novelId)
  const proposed = writingNewVolumeSchema.parse(input), proposalHash = runtimeJson(proposed).hash
  const scope = await readWritingScope(tx, subject)
  const { binding, compilations } = await readTailVolumeBinding(tx, subject, targetOrderIndex, scope)
  if (binding && binding.proposalHash !== proposalHash) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '本任务已有不同的新卷创建决定，未再创建卷。')
  const existing = binding ? await tx.volume.findFirst({ where: { id: binding.volumeId, novelId: subject.novelId, ...activeVolumeWhere } }) : null
  if (binding && !existing) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '原新卷已归档或不存在，未创建替代卷。')
  if (!binding) await assertWritingVolumeBoundary(tx, subject, targetOrderIndex, proposed)
  const volume = existing ?? await createVolumeData(subject.userId, subject.novelId, { title: proposed.title, summary: proposed.summary }, tx)
  if (!scope.bindings?.tailVolumes?.some(item => item.targetOrderIndex === targetOrderIndex)) {
    await tx.agentRun.update({ where: { id: scope.sourceRunId }, data: { writingBindings: runtimeJson({ ...scope.bindings,
      version: 1, taskId: scope.taskId, targets: scope.bindings?.targets ?? [],
      tailVolumes: [...(scope.bindings?.tailVolumes ?? []), { targetOrderIndex, proposalHash, volumeId: volume.id }] }).value } })
  }
  // Preserve the old cache for historical readers; it is optional bookkeeping.
  const active = compilations.find(item => item.status === 'active')
  if (active && !binding) {
    const prepared = active.preparedContext && typeof active.preparedContext === 'object' && !Array.isArray(active.preparedContext) ? active.preparedContext : {}
    await tx.storyCompilation.update({ where: { id: active.id }, data: { preparedContext:
      runtimeJson({ ...prepared, createdTailVolume: { id: volume.id, proposalHash, targetOrderIndex } }).value } })
  }
  return volume
}

/** Explicit placement checks a known creation identity, without a PREPARE gate. */
export async function assertExplicitWritingVolumePlacement(tx: Prisma.TransactionClient, subject: Subject, targetOrderIndex: number, volumeId?: string) {
  const scope = await readWritingScope(tx, subject)
  const { binding } = await readTailVolumeBinding(tx, subject, targetOrderIndex, scope)
  if (binding && (binding.volumeId !== volumeId || !await tx.volume.findFirst({ where: { id: binding.volumeId, novelId: subject.novelId, ...activeVolumeWhere } }))) {
    throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '章节位置与本任务已创建的真实尾卷不一致。')
  }
}
