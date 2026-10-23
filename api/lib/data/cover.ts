/**
 * 封面资产域数据访问
 * 由 data-access.ts 按域拆分而来（声明顺序与原文件一致）；
 * 本文件为 api/lib/data-access.ts 桶文件的重导出源，禁止绕过桶文件新增消费者。
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { CoverAsset } from '../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../prisma.js'
import { ensureNovelOwner, ensureUserExists, toCoverAsset } from './internal.js'
import { normalizeCoverImageUrl } from './novel.js'



export type CoverAssetInput = {
  userId: string
  prompt: string
  count: number
  imageUrls: string[]
  modelName: string
  novelId?: string | null
  negativePrompt?: string | null
  width?: number | null
  height?: number | null
}

/** DB-only phase; stable IDs belong to the original admitted operation. The
 * caller commits its ordered asset proof in this same transaction. */
export async function createCoverAssetsInTransaction(tx: Prisma.TransactionClient, input: CoverAssetInput, ids: string[]) {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 4 || ids.length !== input.count || new Set(ids).size !== ids.length) throw new DataAccessError(400, 'IMAGE_COUNT_INVALID', '每批生成张数必须为 1–4 张。')
  if (!await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } })
    || input.novelId && !await tx.novel.findFirst({ where: { id: input.novelId, authorId: input.userId }, select: { id: true } })) throw new DataAccessError(404, 'NOT_FOUND', '作品不存在或无权访问。')
  return Promise.all(input.imageUrls.slice(0, input.count).map((imageUrl, index) => tx.coverAsset.create({ data: {
    id: ids[index], novelId: input.novelId ?? null, ownerUserId: input.userId, sourceType: 'ai_generated', imageUrl,
    prompt: input.prompt, negativePrompt: input.negativePrompt ?? null, modelName: input.modelName, width: input.width ?? null, height: input.height ?? null,
  } })))
}

export async function createCoverAssetsData(input: CoverAssetInput): Promise<CoverAsset[]> {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 4) {
    throw new DataAccessError(400, 'IMAGE_COUNT_INVALID', '每批生成张数必须为 1–4 张。')
  }
  await ensureUserExists(input.userId)
  if (input.novelId) await ensureNovelOwner(input.userId, input.novelId)

  // Persist the original provider result before fallible downloads/storage.
  // imageUrl already supports the raw URL/data fallback; retaining it here
  // allows storage recovery without another paid generation request.
  const created = await prisma.$transaction(
    input.imageUrls.slice(0, input.count).map((imageUrl) =>
      prisma.coverAsset.create({
        data: {
          id: randomUUID(),
          novelId: input.novelId ?? null,
          ownerUserId: input.userId,
          sourceType: 'ai_generated',
          imageUrl,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt ?? null,
          modelName: input.modelName,
          width: input.width ?? null,
          height: input.height ?? null,
        },
      }),
    ),
  )

  return Promise.all(created.map(async asset => {
    const imageUrl = await normalizeCoverImageUrl(asset.imageUrl)
    if (imageUrl === asset.imageUrl) return toCoverAsset(asset)
    try {
      const saved = await prisma.coverAsset.update({ where: { id: asset.id }, data: { imageUrl } })
      return toCoverAsset(saved)
    } catch {
      // The original result remains committed and usable. Do not present an
      // asset-update failure as a generation failure or trigger paid retries.
      console.warn('[cover] Generated asset retained; local URL update deferred')
      return toCoverAsset(asset)
    }
  }))
}

/** Explicit storage-only recovery: never calls a model or creates a new asset. */
export async function recoverCoverAssetStorageData(userId: string, assetId: string): Promise<CoverAsset> {
  const asset = await prisma.coverAsset.findFirst({ where: { id: assetId, ownerUserId: userId } })
  if (!asset) throw new DataAccessError(404, 'COVER_ASSET_NOT_FOUND', '封面不存在或无权访问。')
  const imageUrl = await normalizeCoverImageUrl(asset.imageUrl)
  if (imageUrl === asset.imageUrl) return toCoverAsset(asset)
  // Avoid replacing an asset whose source changed while the download ran.
  await prisma.coverAsset.updateMany({ where: { id: asset.id, ownerUserId: userId, imageUrl: asset.imageUrl }, data: { imageUrl } })
  const current = await prisma.coverAsset.findFirst({ where: { id: assetId, ownerUserId: userId } })
  if (!current) throw new DataAccessError(404, 'COVER_ASSET_NOT_FOUND', '封面已删除。')
  return toCoverAsset(current)
}



export async function createUploadedCoverAssetData(input: {
  userId: string
  novelId: string
  imageUrl: string
  width?: number | null
  height?: number | null
}): Promise<CoverAsset> {
  await ensureNovelOwner(input.userId, input.novelId)

  const created = await prisma.coverAsset.create({
    data: {
      id: randomUUID(),
      novelId: input.novelId,
      ownerUserId: input.userId,
      sourceType: 'upload',
      imageUrl: input.imageUrl,
      prompt: null,
      negativePrompt: null,
      modelName: null,
      width: input.width ?? null,
      height: input.height ?? null,
    },
  })

  return toCoverAsset(created)
}
