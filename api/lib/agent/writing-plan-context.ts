import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { planTargetSchema } from '../../../shared/contracts/novel-plans.js'
import { DataAccessError } from '../prisma.js'
import { novelPlanHash, planKind, planLinkFields, planMetadata, planTarget } from './novel-plan-contract.js'
import { runtimeJson } from './runtime-common.js'

const frozenPlanSchema = z.object({ id: z.string(), title: z.string(), content: z.string(), planHash: z.string() })
export const writingPlanContextSchema = z.object({ version: z.literal(1), outline: frozenPlanSchema, detail: frozenPlanSchema,
  target: planTargetSchema, parentPlanHash: z.string() })
export type WritingPlanContext = z.infer<typeof writingPlanContextSchema>
export function readWritingPlanContext(prepared: unknown): WritingPlanContext | null {
  const metadata = planMetadata(prepared)
  if (metadata.planContext === undefined) return null
  const parsed = writingPlanContextSchema.safeParse(metadata.planContext)
  if (!parsed.success) throw new DataAccessError(409, 'PLAN_CONTEXT_INVALID', '冻结提纲无法核实，未继续写入。')
  return parsed.data
}
export const writingPlanContextHash = (context: WritingPlanContext) => runtimeJson(context).hash
export function renderWritingPlanContext(prepared: unknown) {
  const context = readWritingPlanContext(prepared)
  return context ? `冻结提纲（计划意图，不是前文既成事实；场景与正文落实细纲，不能遗漏或违背父大纲）：\n${JSON.stringify(context)}` : ''
}
export async function prepareWritingPlanContext(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string }, target: { chapter: { id: string } | null; targetOrderIndex: number }, detailPlanId?: string): Promise<WritingPlanContext | null> {
  const plans = await db.agentArtifact.findMany({ where: { artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true },
    run: subject }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const matching = plans.filter(plan => {
    const binding = planTarget(plan.metadata)
    return planKind(plan.metadata) === 'detail' && (target.chapter ? binding?.kind === 'chapter' && binding.chapterId === target.chapter.id
      : binding?.kind === 'future' && binding.targetOrderIndex === target.targetOrderIndex)
  })
  if (!detailPlanId && matching.length > 1) throw new DataAccessError(409, 'PLAN_TARGET_AMBIGUOUS', '该章有多份细纲，请读取后明确 detailPlanId；未猜选。')
  const detail = detailPlanId ? matching.find(plan => plan.id === detailPlanId) : matching[0]
  if (!detail) {
    if (detailPlanId || plans.some(plan => planKind(plan.metadata) === 'outline')) throw new DataAccessError(409, 'DETAIL_PLAN_REQUIRED', '当前作品已有大纲，请先保存、关联并核对本章细纲后再执行。既有章节必须绑定真实 chapterId，不按序号猜选。')
    return null
  }
  const links = planLinkFields(detail, plans), outline = plans.find(plan => plan.id === links.parentPlanId)
  if (links.reviewState !== 'current' || !outline || !links.target || !detail.content.trim() || !outline.content.trim()) {
    throw new DataAccessError(409, 'PLAN_REVIEW_REQUIRED', '本章细纲未关联有效大纲、父版本已变化或内容为空，请先核对大纲和细纲再执行。')
  }
  const freeze = (plan: typeof detail) => ({ id: plan.id, title: plan.title, content: plan.content, planHash: novelPlanHash(plan) })
  return { version: 1, outline: freeze(outline), detail: freeze(detail), parentPlanHash: links.parentPlanHash!, target: links.target }
}

/** Called under the existing novel transaction lock at manuscript effects. */
export async function assertWritingPlanContextCurrent(db: Prisma.TransactionClient, subject: { userId: string; novelId: string }, prepared: unknown) {
  const context = readWritingPlanContext(prepared)
  if (!context) return null // Historical compilations retain their original contract.
  const plans = await db.agentArtifact.findMany({ where: { id: { in: [context.outline.id, context.detail.id] }, artifactType: 'chapterPlan', run: subject } })
  for (const frozen of [context.outline, context.detail]) {
    const current = plans.find(plan => plan.id === frozen.id)
    if (!current || planMetadata(current.metadata).savedAsPlan !== true || novelPlanHash(current) !== frozen.planHash) {
      throw new DataAccessError(409, 'PLAN_CONTEXT_STALE', '本章冻结的大纲或细纲已变化或移除，未继续写入或提交；请读取核对并重新准备。')
    }
  }
  return context
}

/** Future ordinal becomes an identity once, in the chapter-create transaction. */
export async function bindFutureWritingPlan(db: Prisma.TransactionClient, subject: { userId: string; novelId: string },
  compilation: { id: string; preparedContext: unknown; targetOrderIndex: number }, chapter: { id: string; orderIndex: number }) {
  const context = await assertWritingPlanContextCurrent(db, subject, compilation.preparedContext)
  if (!context || context.target.kind === 'chapter') return
  if (context.target.targetOrderIndex !== chapter.orderIndex || compilation.targetOrderIndex !== chapter.orderIndex) {
    throw new DataAccessError(409, 'PLAN_TARGET_INVALID', '新建章与冻结细纲目标不一致，未绑定替代章节。')
  }
  const detail = await db.agentArtifact.findFirstOrThrow({ where: { id: context.detail.id, run: subject } })
  const target = { kind: 'chapter' as const, chapterId: chapter.id }, metadata = { ...planMetadata(detail.metadata), target }
  await db.agentArtifact.update({ where: { id: detail.id }, data: { metadata: runtimeJson(metadata).value } })
  const planContext = { ...context, target, detail: { ...context.detail, planHash: novelPlanHash({ content: detail.content, metadata }) } }
  await db.storyCompilation.update({ where: { id: compilation.id }, data: { chapterId: chapter.id,
    preparedContext: runtimeJson({ ...planMetadata(compilation.preparedContext), planContext }).value } })
}

export async function bindCreatedChapterWritingPlan(db: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; orderIndex: number }) {
  const target = { userId: subject.userId, novelId: subject.novelId, status: 'active' as const,
    OR: [{ chapterId: chapter.id }, { chapterId: null, targetOrderIndex: chapter.orderIndex }] }
  // This optional hook adds no compiler identity requirement to a create with no
  // frozen plan. Inspect every matching candidate so an untyped newer compiler
  // cannot hide a typed one; this presence check grants no binding authority.
  const candidates = await db.storyCompilation.findMany({ where: target, select: { id: true, preparedContext: true } })
  const plannedIds = candidates.filter(item => Object.prototype.hasOwnProperty.call(planMetadata(item.preparedContext), 'planContext')).map(item => item.id)
  if (!plannedIds.length) return
  const { compilationRunScope } = await import('./story-compiler.js')
  const scope = await compilationRunScope(db, subject)
  const compilation = await db.storyCompilation.findFirst({ where: { ...target, ...scope, id: { in: plannedIds } }, orderBy: { createdAt: 'desc' } })
  if (compilation) await bindFutureWritingPlan(db, { userId: subject.userId, novelId: subject.novelId }, compilation, chapter)
}
