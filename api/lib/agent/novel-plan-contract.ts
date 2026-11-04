import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { planTargetSchema, type PlanKind, type PlanTarget, type PlanMetadataPatch, type PlanLinkFields } from '../../../shared/contracts/novel-plans.js'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'

export const PLAN_FAILURE_CODES = ['PLAN_KIND_REQUIRED', 'PLAN_PARENT_INVALID', 'PLAN_PARENT_STALE', 'PLAN_TARGET_INVALID', 'PLAN_REVISION_CONFLICT', 'PLAN_TARGET_AMBIGUOUS', 'PLAN_REVIEW_REQUIRED', 'DETAIL_PLAN_REQUIRED', 'PLAN_CONTEXT_INVALID', 'PLAN_CONTEXT_STALE', 'PLAN_ALIGNMENT_UNVERIFIED'] as const

export type PlanRow = { id: string; title: string; content: string; metadata: unknown }
export const planMetadata = (metadata: unknown): Record<string, unknown> =>
  metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {}
export function planKind(metadata: unknown): PlanKind {
  const kind = planMetadata(metadata).planKind
  return kind === 'outline' || kind === 'detail' ? kind : 'legacy'
}
export function planTarget(metadata: unknown): PlanTarget | null {
  const parsed = planTargetSchema.safeParse(planMetadata(metadata).target)
  return parsed.success ? parsed.data : null
}
export function novelPlanHash(plan: Pick<PlanRow, 'content' | 'metadata'>): string {
  const metadata = planMetadata(plan.metadata)
  return createHash('sha256').update(JSON.stringify({ content: plan.content, planKind: planKind(metadata),
    parentPlanId: typeof metadata.parentPlanId === 'string' ? metadata.parentPlanId : null,
    parentPlanHash: typeof metadata.parentPlanHash === 'string' ? metadata.parentPlanHash : null, target: planTarget(metadata) })).digest('hex')
}
export function planLinkFields(plan: PlanRow, plans: PlanRow[]): PlanLinkFields {
  const metadata = planMetadata(plan.metadata), kind = planKind(metadata)
  const parentPlanId = typeof metadata.parentPlanId === 'string' ? metadata.parentPlanId : null
  const parentPlanHash = typeof metadata.parentPlanHash === 'string' ? metadata.parentPlanHash : null
  const parent = plans.find(item => item.id === parentPlanId && planKind(item.metadata) === 'outline' && planMetadata(item.metadata).savedAsPlan === true)
  return { planKind: kind, planHash: novelPlanHash(plan), parentPlanId, parentPlanHash, target: planTarget(metadata),
    reviewState: kind !== 'detail' || !parentPlanId || !planTarget(metadata) ? 'unlinked' : !parent ? 'missing_parent'
      : parentPlanHash !== novelPlanHash(parent) ? 'stale' : 'current' }
}

/** One title fallback rule is shared by legacy tools and durable admission. */
export async function findPlanByIdentity(db: Prisma.TransactionClient, userId: string, novelId: string,
  args: { title?: string; planKind?: unknown; parentPlanId?: unknown; target?: unknown }) {
  const rows = await db.agentArtifact.findMany({ where: { artifactType: 'chapterPlan', title: args.title?.trim() ?? '',
    metadata: { path: ['savedAsPlan'], equals: true }, run: { userId, novelId } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })
  const kind = args.planKind === 'outline' || args.planKind === 'detail' ? args.planKind : 'legacy'
  const target = planTargetSchema.safeParse(args.target)
  const matches = rows.filter(row => planKind(row.metadata) === kind && (kind !== 'detail'
    || (planMetadata(row.metadata).parentPlanId ?? null) === (args.parentPlanId ?? null)
      && JSON.stringify(planTarget(row.metadata)) === JSON.stringify(target.success ? target.data : null)))
  if (kind !== 'legacy' && matches.length > 1) throw new DataAccessError(409, 'PLAN_TARGET_AMBIGUOUS', '同类型、关联和目标有多份同名计划，请明确 planId，未猜选或覆盖。')
  return matches[0] ?? null
}

export async function applyPlanMetadataPatch(db: Prisma.TransactionClient, userId: string, novelId: string,
  existing: PlanRow | null, patch: PlanMetadataPatch, content: string) {
  const before = existing ? planMetadata(existing.metadata) : {}
  const metadata: Record<string, unknown> = { ...before, savedAsPlan: before.savedAsPlan ?? true }
  const kind = patch.planKind ?? planKind(before)
  if (patch.planKind !== undefined) metadata.planKind = patch.planKind
  if (kind === 'outline') {
    if (patch.parentPlanId || patch.target) throw new DataAccessError(400, 'INVALID_ARGUMENTS', '大纲不能关联父计划或章节目标。')
    metadata.parentPlanId = null; metadata.parentPlanHash = null; metadata.target = null
  } else if (kind === 'detail') {
    if (patch.parentPlanId !== undefined) metadata.parentPlanId = patch.parentPlanId
    if (patch.target !== undefined) metadata.target = patch.target
    if (patch.parentPlanId === null) metadata.parentPlanHash = null
    const parentId = metadata.parentPlanId
    if (existing && parentId === existing.id) throw new DataAccessError(400, 'PLAN_PARENT_INVALID', '细纲不能把自身作为父大纲。')
    if (patch.parentPlanId || patch.expectedParentPlanHash) {
      const parent = typeof parentId === 'string' ? await db.agentArtifact.findFirst({ where: { id: parentId, artifactType: 'chapterPlan',
        run: { userId, novelId }, metadata: { path: ['savedAsPlan'], equals: true } } }) : null
      if (!parent || planKind(parent.metadata) !== 'outline') throw new DataAccessError(409, 'PLAN_PARENT_INVALID', '父大纲不存在、已移除或不属于当前作品。')
      if (!patch.expectedParentPlanHash || patch.expectedParentPlanHash !== novelPlanHash(parent)) throw new DataAccessError(409, 'PLAN_PARENT_STALE', '父大纲版本已变化，请读取核对后明确提交 expectedParentPlanHash。')
      metadata.parentPlanHash = patch.expectedParentPlanHash
    }
    if (patch.target?.kind === 'chapter' && !await db.chapter.findFirst({ where: { id: patch.target.chapterId, authorId: userId, ...activeChapterScope(novelId) }, select: { id: true } })) {
      throw new DataAccessError(404, 'PLAN_TARGET_INVALID', '目标章节不存在、已归档或不属于当前作品；未按序号替换。')
    }
  }
  if (existing && (planKind(existing.metadata) !== 'legacy' || patch.planKind !== undefined) && novelPlanHash(existing) !== novelPlanHash({ content, metadata })) {
    if (patch.expectedPlanHash !== novelPlanHash(existing)) throw new DataAccessError(409, 'PLAN_REVISION_CONFLICT', '计划内容或关联已变化，请读取当前 planHash 后再保存。')
  }
  return metadata
}
