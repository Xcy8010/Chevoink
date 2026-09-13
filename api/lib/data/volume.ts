import type { Chapter, Prisma, Volume as PrismaVolume } from '@prisma/client'
import { createHash } from 'node:crypto'

import type {
  CreateVolumeRequest,
  MergeChaptersRequest,
  MoveChapterRequest,
  MoveVolumeRequest,
  SplitChapterRequest,
  StructureIssue,
  StructureReport,
  UpdateVolumeRequest,
  Volume,
  VolumeListItem,
} from '../../../shared/contracts/index.js'
import { buildStructureOrderRows } from '../../../shared/structure/ordering.js'
import { DataAccessError, prisma } from '../prisma.js'
import { lockNovelActiveScope } from './novel-write-lock.js'
import { CHAPTER_REVISION_CONFLICT_CODE, CHAPTER_REVISION_CONFLICT_MESSAGE } from './chapter-revision.js'
import {
  activeChapterScope,
  activeVolumeWhere,
  assertActiveWriteCount,
  ensureNovelOwner,
  recalculateNovelStats,
  toChapter,
  toVolume,
  toVolumeListItem,
  volumeListItemInclude,
  updateActiveChapter,
  updateActiveVolume,
} from './internal.js'

export const DEFAULT_VOLUME_TITLE = '第一卷'

type StructureTx = Prisma.TransactionClient
type ChapterPlacement = Pick<Chapter, 'id' | 'volumeId' | 'orderInVolume' | 'orderIndex' | 'revision'>

function clampPosition(position: number | undefined, length: number): number {
  if (position === undefined) return length
  return Math.max(0, Math.min(position - 1, length))
}

function assertExpectedRevision(expected: number | undefined, actual: number, entity: '章节' | '卷') {
  if (expected === undefined || expected === actual) return
  if (entity === '章节') {
    throw new DataAccessError(409, CHAPTER_REVISION_CONFLICT_CODE, CHAPTER_REVISION_CONFLICT_MESSAGE)
  }
  throw new DataAccessError(409, 'VOLUME_REVISION_CONFLICT', '卷结构已被其他操作修改，请刷新后重试。')
}

/** 新作品和历史兼容写入均保证至少有一卷。 */
export async function ensureDefaultVolume(tx: StructureTx, novelId: string): Promise<PrismaVolume> {
  await lockNovelActiveScope(tx, novelId)
  const existing = await tx.volume.findFirst({ where: { novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' } })
  if (existing) return existing
  return tx.volume.create({ data: { novelId, title: DEFAULT_VOLUME_TITLE, orderIndex: 1 } })
}

async function loadLayout(tx: StructureTx, novelId: string) {
  const volumes = await tx.volume.findMany({ where: { novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' } })
  const chapters = await tx.chapter.findMany({
    where: activeChapterScope(novelId),
    orderBy: [{ orderIndex: 'asc' }],
    select: { id: true, volumeId: true, orderInVolume: true, orderIndex: true, revision: true },
  })
  const byVolume = new Map<string, ChapterPlacement[]>()
  for (const volume of volumes) byVolume.set(volume.id, [])
  for (const chapter of chapters) {
    const bucket = byVolume.get(chapter.volumeId)
    if (bucket) bucket.push(chapter)
  }
  for (const bucket of byVolume.values()) {
    bucket.sort((left, right) => left.orderInVolume - right.orderInVolume || left.orderIndex - right.orderIndex)
  }
  return { volumes, byVolume }
}

/**
 * 唯一的章节排序写入口。先写负数临时位释放两个唯一索引，再一次性落定卷内序和全书序。
 * revision 只对实际发生结构变化的章节递增，不把事务内部临时态暴露成用户版本。
 */
async function rewriteChapterLayout(
  tx: StructureTx,
  volumes: Pick<PrismaVolume, 'id'>[],
  byVolume: Map<string, ChapterPlacement[]>,
) {
  const flattened = volumes.flatMap((volume) => byVolume.get(volume.id) ?? [])
  // A newly created chapter already occupies a negative slot. Reordering must
  // use a disjoint range, including BOTH global and per-volume unique indexes.
  const temporaryFloor = flattened.reduce((minimum, chapter) => Math.min(minimum, chapter.orderIndex, chapter.orderInVolume), 0)
  for (let index = 0; index < flattened.length; index += 1) {
    await updateActiveChapter(tx, { id: flattened[index].id, revision: flattened[index].revision },
      { orderIndex: temporaryFloor - index - 1, orderInVolume: temporaryFloor - index - 1 })
  }

  const rows = buildStructureOrderRows(
    volumes.map((volume) => ({ id: volume.id, chapterIds: (byVolume.get(volume.id) ?? []).map((item) => item.id) })),
  )
  const originals = new Map(flattened.map((chapter) => [chapter.id, chapter]))
  for (const row of rows) {
    const chapter = originals.get(row.chapterId)
    if (!chapter) throw new Error(`chapter missing from structure layout: ${row.chapterId}`)
    const changed =
      chapter.volumeId !== row.volumeId || chapter.orderInVolume !== row.orderInVolume || chapter.orderIndex !== row.orderIndex
    await updateActiveChapter(tx, { id: chapter.id, revision: chapter.revision }, {
      volumeId: row.volumeId,
      orderInVolume: row.orderInVolume,
      orderIndex: row.orderIndex,
      revision: changed ? { increment: 1 } : undefined,
    })
  }
}

async function rewriteVolumeOrder(tx: StructureTx, volumes: PrismaVolume[]) {
  const temporaryFloor = volumes.reduce((minimum, volume) => Math.min(minimum, volume.orderIndex), 0)
  for (let index = 0; index < volumes.length; index += 1) {
    await updateActiveVolume(tx, { id: volumes[index].id, revision: volumes[index].revision }, { orderIndex: temporaryFloor - index - 1 })
  }
  for (let index = 0; index < volumes.length; index += 1) {
    const volume = volumes[index]
    const orderIndex = index + 1
    await updateActiveVolume(tx, { id: volume.id, revision: volume.revision }, {
      orderIndex,
      revision: volume.orderIndex === orderIndex ? undefined : { increment: 1 },
    })
  }
}

/** 删除、迁移兼容和结构操作后的统一压缩入口。 */
export async function normalizeNovelStructure(tx: StructureTx, novelId: string) {
  await ensureDefaultVolume(tx, novelId)
  const layout = await loadLayout(tx, novelId)
  await rewriteVolumeOrder(tx, layout.volumes)
  await rewriteChapterLayout(tx, layout.volumes, layout.byVolume)
}

export async function resolveChapterPlacement(
  tx: StructureTx,
  novelId: string,
  requestedVolumeId?: string,
  requestedPosition?: number,
) {
  const fallback = await ensureDefaultVolume(tx, novelId)
  const volume = requestedVolumeId
    ? await tx.volume.findFirst({ where: { id: requestedVolumeId, novelId, ...activeVolumeWhere } })
    : await tx.volume.findFirst({ where: { novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'desc' } })
  if (!volume) {
    throw new DataAccessError(400, 'VOLUME_NOT_FOUND', '目标卷不存在或不属于当前作品。')
  }
  const count = await tx.chapter.count({ where: { ...activeChapterScope(novelId), volumeId: volume.id } })
  return {
    volume: volume ?? fallback,
    position: clampPosition(requestedPosition, count),
    count,
  }
}

/** 在临时位置创建后，把新章插入目标卷并重建两个有序索引。 */
export async function placeCreatedChapter(
  tx: StructureTx,
  novelId: string,
  chapter: ChapterPlacement,
  volumeId: string,
  zeroBasedPosition: number,
) {
  await lockNovelActiveScope(tx, novelId)
  const layout = await loadLayout(tx, novelId)
  const target = layout.byVolume.get(volumeId)
  if (!target) throw new DataAccessError(400, 'VOLUME_NOT_FOUND', '目标卷不存在或不属于当前作品。')
  for (const bucket of layout.byVolume.values()) {
    const index = bucket.findIndex((item) => item.id === chapter.id)
    if (index >= 0) bucket.splice(index, 1)
  }
  target.splice(Math.max(0, Math.min(zeroBasedPosition, target.length)), 0, chapter)
  await rewriteChapterLayout(tx, layout.volumes, layout.byVolume)
}

export async function listVolumesData(userId: string, novelId: string, transaction: Prisma.TransactionClient = prisma): Promise<VolumeListItem[]> {
  await ensureNovelOwner(userId, novelId, transaction)
  const records = await transaction.volume.findMany({
    where: { novelId, ...activeVolumeWhere },
    include: volumeListItemInclude,
    orderBy: { orderIndex: 'asc' },
  })
  return records.map(toVolumeListItem)
}

export async function createVolumeData(userId: string, novelId: string, input: CreateVolumeRequest, transaction?: Prisma.TransactionClient): Promise<Volume> {
  await ensureNovelOwner(userId, novelId, transaction)
  const create = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const volumes = await tx.volume.findMany({ where: { novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' } })
    const created = await tx.volume.create({
      data: {
        novelId,
        title: input.title.trim(),
        summary: input.summary?.trim() || null,
        orderIndex: -(volumes.length + 1),
      },
    })
    volumes.splice(clampPosition(input.position, volumes.length), 0, created)
    await rewriteVolumeOrder(tx, volumes)
    const record = await tx.volume.findFirstOrThrow({ where: { id: created.id, novelId, ...activeVolumeWhere } })
    return toVolume(record)
  }
  return transaction ? create(transaction) : prisma.$transaction(create)
}

export async function updateVolumeData(
  userId: string,
  novelId: string,
  volumeId: string,
  input: UpdateVolumeRequest,
  transaction?: Prisma.TransactionClient,
): Promise<Volume | null> {
  await ensureNovelOwner(userId, novelId, transaction)
  const update = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const existing = await tx.volume.findFirst({ where: { id: volumeId, novelId, ...activeVolumeWhere } })
    if (!existing) return null
    assertExpectedRevision(input.expectedRevision, existing.revision, '卷')
    const title = input.title?.trim() ?? existing.title
    const summary = input.summary === undefined ? existing.summary : input.summary?.trim() || null
    if (title === existing.title && summary === existing.summary) return toVolume(existing)
    await updateActiveVolume(tx, { id: volumeId, novelId, revision: existing.revision },
      { title, summary, revision: { increment: 1 } })
    const updated = await tx.volume.findFirstOrThrow({ where: { id: volumeId, novelId, ...activeVolumeWhere } })
    return toVolume(updated)
  }
  return transaction ? update(transaction) : prisma.$transaction(update)
}

export async function moveVolumeData(
  userId: string,
  novelId: string,
  volumeId: string,
  input: MoveVolumeRequest,
  transaction?: Prisma.TransactionClient,
): Promise<Volume | null> {
  await ensureNovelOwner(userId, novelId, transaction)
  const move = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const volumes = await tx.volume.findMany({ where: { novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' } })
    const currentIndex = volumes.findIndex((item) => item.id === volumeId)
    if (currentIndex < 0) return null
    assertExpectedRevision(input.expectedRevision, volumes[currentIndex].revision, '卷')
    const [moved] = volumes.splice(currentIndex, 1)
    volumes.splice(clampPosition(input.position, volumes.length), 0, moved)
    await rewriteVolumeOrder(tx, volumes)
    const layout = await loadLayout(tx, novelId)
    await rewriteChapterLayout(tx, volumes, layout.byVolume)
    return toVolume(await tx.volume.findFirstOrThrow({ where: { id: volumeId, novelId, ...activeVolumeWhere } }))
  }
  return transaction ? move(transaction) : prisma.$transaction(move)
}

export async function deleteVolumeData(userId: string, novelId: string, volumeId: string, transaction?: Prisma.TransactionClient): Promise<boolean> {
  await ensureNovelOwner(userId, novelId, transaction)
  const remove = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const volumes = await tx.volume.findMany({ where: { novelId, ...activeVolumeWhere }, orderBy: { orderIndex: 'asc' } })
    const target = volumes.find((item) => item.id === volumeId)
    if (!target) return false
    if (volumes.length === 1) throw new DataAccessError(400, 'LAST_VOLUME_REQUIRED', '作品必须至少保留一卷。')
    // Retained chapters still own this FK; an apparently empty active volume
    // cannot be physically deleted while it contains historical records.
    if (await tx.chapter.count({ where: { volumeId } })) {
      throw new DataAccessError(409, 'VOLUME_NOT_EMPTY', '该卷仍有章节，请先移动或删除其中章节。')
    }
    const deleted = await tx.volume.deleteMany({ where: { id: volumeId, novelId, revision: target.revision, ...activeVolumeWhere } })
    assertActiveWriteCount(deleted.count, 'volume')
    const remaining = volumes.filter((item) => item.id !== volumeId)
    await rewriteVolumeOrder(tx, remaining)
    return true
  }
  return transaction ? remove(transaction) : prisma.$transaction(remove)
}

export async function moveChapterData(
  userId: string,
  novelId: string,
  chapterId: string,
  input: MoveChapterRequest,
  transaction?: Prisma.TransactionClient,
) {
  await ensureNovelOwner(userId, novelId, transaction)
  const move = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const chapter = await tx.chapter.findFirst({ where: { id: chapterId, ...activeChapterScope(novelId) } })
    if (!chapter) return null
    assertExpectedRevision(input.expectedRevision, chapter.revision, '章节')
    const layout = await loadLayout(tx, novelId)
    const target = layout.byVolume.get(input.targetVolumeId)
    if (!target) throw new DataAccessError(400, 'VOLUME_NOT_FOUND', '目标卷不存在或不属于当前作品。')
    for (const bucket of layout.byVolume.values()) {
      const index = bucket.findIndex((item) => item.id === chapterId)
      if (index >= 0) bucket.splice(index, 1)
    }
    target.splice(clampPosition(input.position, target.length), 0, chapter)
    await rewriteChapterLayout(tx, layout.volumes, layout.byVolume)
    return toChapter(await tx.chapter.findFirstOrThrow({ where: { id: chapterId, ...activeChapterScope(novelId) } }))
  }
  return transaction ? move(transaction) : prisma.$transaction(move)
}

export async function splitChapterData(
  userId: string,
  novelId: string,
  chapterId: string,
  input: SplitChapterRequest,
  transaction?: Prisma.TransactionClient,
) {
  await ensureNovelOwner(userId, novelId, transaction)
  const split = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const chapter = await tx.chapter.findFirst({ where: { id: chapterId, ...activeChapterScope(novelId) } })
    if (!chapter) return null
    assertExpectedRevision(input.expectedRevision, chapter.revision, '章节')
    if (input.splitOffset <= 0 || input.splitOffset >= chapter.content.length) {
      throw new DataAccessError(400, 'INVALID_SPLIT_OFFSET', '拆分位置必须位于章节正文内部。')
    }
    const firstContent = chapter.content.slice(0, input.splitOffset)
    const secondContent = chapter.content.slice(input.splitOffset)
    await updateActiveChapter(tx, { id: chapter.id, novelId, revision: chapter.revision },
      { content: firstContent, wordCount: firstContent.length, revision: { increment: 1 } })
    const created = await tx.chapter.create({
      data: {
        novelId,
        authorId: userId,
        title: input.newChapterTitle.trim(),
        content: secondContent,
        wordCount: secondContent.length,
        status: chapter.status,
        visibility: chapter.visibility,
        volumeId: chapter.volumeId,
        orderInVolume: -(chapter.orderInVolume + 1),
        orderIndex: -(chapter.orderIndex + 1),
        publishedAt: chapter.publishedAt,
      },
    })
    await placeCreatedChapter(tx, novelId, created, chapter.volumeId, chapter.orderInVolume)
    await recalculateNovelStats(tx, novelId)
    return {
      first: toChapter(await tx.chapter.findFirstOrThrow({ where: { id: chapter.id, ...activeChapterScope(novelId) } })),
      second: toChapter(await tx.chapter.findFirstOrThrow({ where: { id: created.id, ...activeChapterScope(novelId) } })),
    }
  }
  return transaction ? split(transaction) : prisma.$transaction(split)
}

export async function mergeChaptersData(
  userId: string,
  novelId: string,
  targetChapterId: string,
  input: MergeChaptersRequest,
  transaction?: Prisma.TransactionClient,
) {
  await ensureNovelOwner(userId, novelId, transaction)
  if (targetChapterId === input.sourceChapterId) {
    throw new DataAccessError(400, 'INVALID_MERGE_TARGET', '不能把章节与自身合并。')
  }
  const merge = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, novelId)
    const [target, source] = await Promise.all([
      tx.chapter.findFirst({ where: { id: targetChapterId, ...activeChapterScope(novelId) } }),
      tx.chapter.findFirst({ where: { id: input.sourceChapterId, ...activeChapterScope(novelId) } }),
    ])
    if (!target || !source) return null
    assertExpectedRevision(input.expectedTargetRevision, target.revision, '章节')
    assertExpectedRevision(input.expectedSourceRevision, source.revision, '章节')
    const content = `${target.content}${input.separator}${source.content}`
    await updateActiveChapter(tx, { id: target.id, novelId, revision: target.revision },
      { content, wordCount: content.length, revision: { increment: 1 } })
    const deleted = await tx.chapter.deleteMany({ where: { id: source.id, revision: source.revision, ...activeChapterScope(novelId) } })
    assertActiveWriteCount(deleted.count, 'chapter')
    await normalizeNovelStructure(tx, novelId)
    await recalculateNovelStats(tx, novelId)
    return toChapter(await tx.chapter.findFirstOrThrow({ where: { id: target.id, ...activeChapterScope(novelId) } }))
  }
  return transaction ? merge(transaction) : prisma.$transaction(merge)
}

/** Revision vector, not a content read: prevents applying a saved structural
 * decision to a layout changed after the observation. */
export async function getStructureRevisionHash(tx: Prisma.TransactionClient, novelId: string): Promise<string> {
  const volumes = await tx.volume.findMany({ where: { novelId, ...activeVolumeWhere }, orderBy: { id: 'asc' },
    select: { id: true, revision: true, orderIndex: true } })
  const chapters = await tx.chapter.findMany({ where: activeChapterScope(novelId), orderBy: { id: 'asc' },
    select: { id: true, revision: true, volumeId: true, orderIndex: true, orderInVolume: true } })
  return createHash('sha256').update(JSON.stringify({ volumes, chapters })).digest('hex')
}

export async function getStructureReportData(userId: string, novelId: string, transaction: Prisma.TransactionClient = prisma): Promise<StructureReport> {
  return (await getStructureReportObservation(userId, novelId, transaction)).report
}

export async function getStructureReportObservation(userId: string, novelId: string, transaction: Prisma.TransactionClient = prisma) {
  await ensureNovelOwner(userId, novelId, transaction)
  const volumes = await transaction.volume.findMany({
    where: { novelId, ...activeVolumeWhere },
    orderBy: { orderIndex: 'asc' },
    select: { id: true, title: true, orderIndex: true,
      chapters: { where: { archivedAt: null }, orderBy: [{ orderInVolume: 'asc' }, { id: 'asc' }],
        select: { id: true, title: true, novelId: true, volumeId: true, orderIndex: true, orderInVolume: true } } },
  })
  const issues: StructureIssue[] = []
  // Separate FKs allow a chapter's novel and its volume's novel to disagree.
  // Such chapters must not silently disappear from a valid structure report.
  const misplaced = await transaction.chapter.findMany({ where: { novelId, archivedAt: null, volume: { ...activeVolumeWhere, novelId: { not: novelId } } },
    select: { id: true, volumeId: true }, orderBy: { id: 'asc' } })
  for (const chapter of misplaced) issues.push({ code: 'CHAPTER_VOLUME_MISMATCH', message: '章节所在卷不属于当前作品。', entityId: chapter.id })
  let expectedGlobal = 1
  for (let volumeIndex = 0; volumeIndex < volumes.length; volumeIndex += 1) {
    const volume = volumes[volumeIndex]
    if (!volume.title.trim()) issues.push({ code: 'STRUCTURE_TITLE_EMPTY', message: '卷标题不能为空。', entityId: volume.id })
    if (volume.orderIndex !== volumeIndex + 1) {
      issues.push({ code: 'VOLUME_ORDER_GAP', message: `卷序应为 ${volumeIndex + 1}，实际为 ${volume.orderIndex}。`, entityId: volume.id })
    }
    for (let chapterIndex = 0; chapterIndex < volume.chapters.length; chapterIndex += 1) {
      const chapter = volume.chapters[chapterIndex]
      if (!chapter.title.trim()) issues.push({ code: 'STRUCTURE_TITLE_EMPTY', message: '章节标题不能为空。', entityId: chapter.id })
      if (chapter.volumeId !== volume.id || chapter.novelId !== novelId) {
        issues.push({ code: 'CHAPTER_VOLUME_MISMATCH', message: '章节卷归属不一致。', entityId: chapter.id })
      }
      if (chapter.orderInVolume !== chapterIndex + 1) {
        issues.push({ code: 'CHAPTER_ORDER_GAP', message: `卷内章序应为 ${chapterIndex + 1}，实际为 ${chapter.orderInVolume}。`, entityId: chapter.id })
      }
      if (chapter.orderIndex !== expectedGlobal) {
        issues.push({ code: 'GLOBAL_ORDER_GAP', message: `全书章序应为 ${expectedGlobal}，实际为 ${chapter.orderIndex}。`, entityId: chapter.id })
      }
      expectedGlobal += 1
    }
  }
  const chapterCount = expectedGlobal - 1
  const stateHash = createHash('sha256').update(JSON.stringify({ misplaced, volumes: volumes.map(volume => ({ id: volume.id, title: volume.title, orderIndex: volume.orderIndex,
    chapters: volume.chapters.map(chapter => ({ id: chapter.id, title: chapter.title, novelId: chapter.novelId, volumeId: chapter.volumeId, orderIndex: chapter.orderIndex, orderInVolume: chapter.orderInVolume })) })) })).digest('hex')
  return { report: { valid: issues.length === 0, volumeCount: volumes.length, chapterCount, issues }, stateHash }
}
