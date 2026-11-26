import { createHash } from 'node:crypto'
import type { AgentArtifact, Prisma } from '@prisma/client'
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

type PlanWriteIdentity = PlanMetadataPatch & { title?: string; planId?: string; mode?: 'replace' | 'append'; expectedContentHash?: string }

export async function findOwnedPlan(db: Prisma.TransactionClient, userId: string, novelId: string, planId: string) {
  return db.agentArtifact.findFirst({ where: { id: planId, artifactType: 'chapterPlan', run: { userId, novelId } } })
}

/** A chapter selector and an exact saved title can recover an incorrect or absent
 * ID. The caller still verifies the selected file's own observed version. */
export async function resolveDetailPlanWrite(db: Prisma.TransactionClient, userId: string, novelId: string, args: PlanWriteIdentity,
  explicit: AgentArtifact | null): Promise<{ id: string | null; plan: AgentArtifact | null } | undefined> {
  const explicitKind = explicit ? planKind(explicit.metadata) : null
  const explicitTarget = explicit && explicitKind === 'detail' ? planTarget(explicit.metadata) : null
  if (args.planKind === 'outline') {
    if (!explicitTarget) return undefined
    throw new DataAccessError(409, 'PLAN_TARGET_CONFLICT', '编号指向已绑定章节的细纲。保存大纲时请使用大纲的编号；已保存细纲保持原样。')
  }
  const title = args.title?.trim()
  const mismatchedTitle = Boolean(explicit && title && title !== explicit.title && (explicitTarget || args.mode === 'append'))
  const mismatchedTarget = Boolean(args.target && explicitTarget && JSON.stringify(args.target) !== JSON.stringify(explicitTarget))
  const wrongDraft = Boolean(args.target && args.planKind === 'detail' && explicit && !explicitTarget
    && (explicitKind !== 'detail' || explicit.title !== title))
  if (mismatchedTarget && args.target && explicitTarget && args.target.kind !== explicitTarget.kind) {
    const chapter = args.target.kind === 'chapter' ? args.target : explicitTarget.kind === 'chapter' ? explicitTarget : null
    const future = args.target.kind === 'future' ? args.target : explicitTarget.kind === 'future' ? explicitTarget : null
    if (chapter && future && await db.chapter.findFirst({ where: { id: chapter.chapterId, orderIndex: future.targetOrderIndex,
      authorId: userId, ...activeChapterScope(novelId) }, select: { id: true } })) return undefined
  }
  if (explicitTarget && args.target && !mismatchedTarget) return undefined
  if (!mismatchedTarget && !mismatchedTitle && !wrongDraft && (explicit || (!args.planId && args.mode !== 'append'))) return undefined
  if (mismatchedTitle && !args.target && args.mode !== 'append') {
    if (explicit && explicit.id === args.planId && (args.expectedPlanHash === novelPlanHash(explicit)
      || args.expectedContentHash === createHash('sha256').update(explicit.content).digest('hex'))) return undefined
    throw new DataAccessError(409, 'PLAN_TARGET_CONFLICT',
      '计划编号与标题指向不同的写入目标。替换时请带明确的章节目标或该文件的核对版本，已保存内容保持原样。')
  }
  if (!args.target && !mismatchedTitle && args.mode !== 'append') return undefined
  if (title) {
    const candidates = await db.agentArtifact.findMany({ where: { title, artifactType: 'chapterPlan',
      metadata: { path: ['savedAsPlan'], equals: true }, run: { userId, novelId } } })
    const matches = candidates.filter(plan => {
      const target = planTarget(plan.metadata)
      return planKind(plan.metadata) === 'detail' && target && (!args.target || JSON.stringify(args.target) === JSON.stringify(target))
        && (args.parentPlanId === undefined || args.parentPlanId === null && args.mode === 'append'
          || (planMetadata(plan.metadata).parentPlanId ?? null) === args.parentPlanId)
    })
    if (matches.length > 1) throw new DataAccessError(409, 'PLAN_TARGET_AMBIGUOUS', '计划标题对应多份细纲。请带准确的目标章号或计划编号，已保存内容保持原样。')
    if (matches.length === 1) return { id: matches[0].id, plan: matches[0] }
  }
  if (args.target && args.planKind === 'detail' && args.mode !== 'append') return { id: null, plan: null }
  if (mismatchedTarget || mismatchedTitle || wrongDraft) throw new DataAccessError(409, 'PLAN_TARGET_CONFLICT',
    '计划编号与这一节的目标不一致。新章请传细纲类型、父大纲和目标章号，回头修改请使用原计划名和编号。已保存内容保持原样。')
  return undefined
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
