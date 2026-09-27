import type { Prisma } from '@prisma/client'
import { recoverCoverAssetStorageData } from '../../data-access.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { prepareAttachmentCover } from './attachment-cover.js'
import type { ToolContext, ToolResult } from './types.js'
import { currentGoalExecution } from '../goal-context.js'
import { assertGoalFence } from '../goal-fence.js'

export type CoverSelection = { id: string; imageUrl: string; upload?: { width: number; height: number } }

/** Idempotent storage preparation outside the publication transaction. No generation. */
export async function prepareCoverSelection(ctx: ToolContext, args: { attachmentUrl?: string; coverAssetId?: string }): Promise<CoverSelection> {
  ctx.signal.throwIfAborted()
  if (args.attachmentUrl) {
    const { width, height, ...cover } = await prepareAttachmentCover(ctx, args.attachmentUrl)
    return { ...cover, upload: { width, height } }
  }
  const asset = await prisma.coverAsset.findFirst({ where: { id: args.coverAssetId, ownerUserId: ctx.userId,
    OR: [{ novelId: ctx.novelId }, { novelId: null }] }, select: { id: true } })
  if (!asset) throw new DataAccessError(404, 'COVER_ASSET_NOT_FOUND', '封面候选不存在或不属于当前作品。使用当前任务的图片 attachmentUrl，或先读取当前作品的候选再应用，不要猜测 ID 或重新付费生成。')
  const recovered = await recoverCoverAssetStorageData(ctx.userId, asset.id)
  ctx.signal.throwIfAborted()
  return { id: asset.id, imageUrl: recovered.imageUrl }
}

/** Also used inside the durable effect transaction, behind its lease/approval fence. */
export async function applyCoverSelection(ctx: ToolContext, cover: CoverSelection, tx: Prisma.TransactionClient): Promise<ToolResult> {
  ctx.signal.throwIfAborted()
  const goal = currentGoalExecution()
  if (goal) await assertGoalFence(tx, goal)
  const novel = await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { title: true, coverAssetId: true } })
  if (!novel) throw new DataAccessError(404, 'NOVEL_NOT_FOUND', '作品不存在或无权修改。')
  if (cover.upload) await tx.coverAsset.upsert({ where: { id: cover.id },
    create: { id: cover.id, imageUrl: cover.imageUrl, ...cover.upload, novelId: ctx.novelId, ownerUserId: ctx.userId, sourceType: 'upload' }, update: {} })
  const asset = await tx.coverAsset.findFirst({ where: { id: cover.id, ownerUserId: ctx.userId,
    OR: [{ novelId: ctx.novelId }, { novelId: null }] }, select: { id: true, imageUrl: true } })
  if (!asset) throw new DataAccessError(409, 'COVER_ASSET_NOT_FOUND', '候选归属已变化，未修改封面，请重新选择当前作品的图片。')
  ctx.signal.throwIfAborted()
  await tx.coverAsset.update({ where: { id: asset.id }, data: { novelId: ctx.novelId } })
  await tx.novel.update({ where: { id: ctx.novelId }, data: { coverAssetId: asset.id } })
  if (goal) await tx.agentGoalEvidence.upsert({ where: { goalId_revision_criterionId: {
    goalId: goal.goalId, revision: goal.revision, criterionId: 'cover-applied',
  } }, create: { goalId: goal.goalId, revision: goal.revision, criterionId: 'cover-applied',
    kind: 'cover-application', description: '当前目标已应用作品封面。', targetId: asset.id, status: 'verified',
    receipt: { runId: ctx.runId, novelId: ctx.novelId, coverAssetId: asset.id }, verifiedAt: new Date(),
  }, update: { targetId: asset.id, status: 'verified', receipt: { runId: ctx.runId, novelId: ctx.novelId, coverAssetId: asset.id }, verifiedAt: new Date() } })
  return { output: `已把${cover.upload ? '上传图片' : '候选图'}设为《${novel.title}》的封面。`, summary: '已应用作品封面',
    display: { kind: 'coverImages', images: [{ id: asset.id, url: asset.imageUrl }] },
    snapshot: { target: 'novel', targetId: ctx.novelId, field: 'coverAssetId', previousValue: novel.coverAssetId } }
}
