import { z } from 'zod'
import { prisma, DataAccessError } from '../../prisma.js'
import { runtimeJson } from '../runtime-common.js'
import { loadSkill } from '../skills/index.js'
import { resolveEnabledRuntimeSkills } from '../skills/service.js'
import type { ToolContext, ToolResult } from './types.js'
import { activeChapterScope } from '../../data/internal.js'
import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'

export const creativeReviewWorkSchema = z.object({ version: z.literal(1), phase: z.enum(['critique', 'revision']),
  chapter: z.object({ id: z.string(), title: z.string(), content: z.string(), revision: z.number().int().positive() }).strict(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), system: z.string(), content: z.string(), temperature: z.number(),
  artifactType: z.enum(['continuityReview', 'rewriteSelection']), title: z.string(), summary: z.string(),
  metadata: z.record(z.string(), z.unknown()), critique: z.object({ id: z.string(), hash: z.string() }).nullable(),
}).strict()
export type CreativeReviewWork = z.infer<typeof creativeReviewWorkSchema>
type Args = { chapterId: string; start?: number; end?: number; skillIds: string[]; creativeFreedom: 'stable' | 'balanced' | 'bold'; critiqueArtifactId?: string; selectedFindings?: string[] }
const critiqueHash = (value: { id: string; artifactType: string; content: string; metadata: unknown }) => runtimeJson({ id: value.id, artifactType: value.artifactType, content: value.content, metadata: value.metadata }).hash

/** Same literary input for legacy and durable tools. This reads owned sources;
 * it never generates a critique, mutates a chapter or acquires provider authority. */
export async function prepareCreativeReview(ctx: ToolContext, args: Args, phase: CreativeReviewWork['phase']): Promise<CreativeReviewWork> {
  const db = ctx.transaction ?? prisma
  if (ctx.transaction) await assertAgentManuscriptCurrent(ctx.transaction, ctx)
  else await prisma.$transaction(tx => assertAgentManuscriptCurrent(tx, ctx))
  const chapter = await db.chapter.findFirst({ where: { id: args.chapterId, ...activeChapterScope(ctx.novelId), authorId: ctx.userId }, select: { id: true, title: true, content: true, revision: true } })
  if (!chapter) throw new DataAccessError(404, 'CREATIVE_SOURCE_NOT_FOUND', '章节不存在或不属于当前作品。')
  const start = args.start ?? 0, end = Math.min(args.end ?? chapter.content.length, chapter.content.length)
  if (start >= end) throw new DataAccessError(422, 'CREATIVE_RANGE_INVALID', '批评或修订范围为空或超出当前正文。')
  const runtime = await resolveEnabledRuntimeSkills(ctx.userId, ctx.novelId, ctx.runId, ctx.transaction)
  const resources = args.skillIds.map(id => loadSkill(id, phase, args.creativeFreedom, runtime)).filter(Boolean).join('\n\n')
  const source = chapter.content.slice(start, end)
  if (phase === 'critique') return creativeReviewWorkSchema.parse({ version: 1, phase, chapter, start, end,
    system: `你是与写作者上下文隔离的小说批评编辑。只依据给定原文指出问题，不续写、不改写、不套固定检查表。每条含编号、短引文、问题和修改方向；把事实硬伤与审美建议分开。\n${resources}`,
    content: `章节：${chapter.title}，revision=${chapter.revision}，范围=[${start},${end})\n原文：\n${source}`, temperature: 0.25,
    artifactType: 'continuityReview', title: `${chapter.title} · 独立批评`, summary: `revision ${chapter.revision} / ${args.skillIds.join(',')}`,
    metadata: { chapterId: chapter.id, revision: chapter.revision, start, end, skillIds: args.skillIds, phase }, critique: null })
  const critique = await db.agentArtifact.findFirst({ where: { id: args.critiqueArtifactId, artifactType: 'continuityReview', run: { userId: ctx.userId, novelId: ctx.novelId } } })
  const metadata = z.object({ chapterId: z.literal(chapter.id), revision: z.literal(chapter.revision), phase: z.literal('critique') }).safeParse(critique?.metadata)
  if (!critique || !metadata.success) throw new DataAccessError(409, 'CREATIVE_CRITIQUE_STALE', '批评产物不存在、不属于当前章节，或正文版本已变化；请核对当前批评，不基于旧文本修订。')
  if (!args.selectedFindings?.length) throw new DataAccessError(422, 'CREATIVE_FINDINGS_REQUIRED', '修订稿必须绑定作者选中的意见。')
  return creativeReviewWorkSchema.parse({ version: 1, phase, chapter, start, end,
    system: `你是与 Draft/Critique 上下文隔离的修订编辑。只落实 selectedFindings，不顺手应用其他建议，不改变未授权事实和情节。只输出可替换原文的修订文本。\n${resources}`,
    content: `作者选中的批评项：\n${args.selectedFindings.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n待修订原文：\n${source}`,
    temperature: args.creativeFreedom === 'stable' ? 0.35 : args.creativeFreedom === 'bold' ? 0.75 : 0.55,
    artifactType: 'rewriteSelection', title: `${chapter.title} · 选择性修订稿`, summary: `${args.selectedFindings.length} 项选中意见`,
    metadata: { chapterId: chapter.id, revision: chapter.revision, start, end, critiqueArtifactId: critique.id, phase }, critique: { id: critique.id, hash: critiqueHash(critique) } })
}

export async function assertCreativeReviewCurrent(ctx: ToolContext, work: CreativeReviewWork) {
  const db = ctx.transaction ?? prisma
  if (ctx.transaction) await assertAgentManuscriptCurrent(ctx.transaction, ctx)
  else await prisma.$transaction(tx => assertAgentManuscriptCurrent(tx, ctx))
  const chapter = await db.chapter.findFirst({ where: { id: work.chapter.id, ...activeChapterScope(ctx.novelId), authorId: ctx.userId }, select: { id: true, title: true, content: true, revision: true } })
  if (!chapter || runtimeJson(chapter).hash !== runtimeJson(work.chapter).hash) throw new DataAccessError(409, 'CREATIVE_SOURCE_STALE', '批评或修订期间正文已变化，保留原模型结果，未将它发布为当前版本产物。')
  if (work.critique) {
    const critique = await db.agentArtifact.findFirst({ where: { id: work.critique.id, run: { userId: ctx.userId, novelId: ctx.novelId } } })
    if (!critique || critiqueHash(critique) !== work.critique.hash) throw new DataAccessError(409, 'CREATIVE_CRITIQUE_STALE', '原批评产物已变化，未替换为另一份批评。')
  }
}

export async function saveCreativeReview(ctx: ToolContext, work: CreativeReviewWork, text: string): Promise<ToolResult> {
  const db = ctx.transaction ?? prisma
  await assertCreativeReviewCurrent(ctx, work)
  ctx.signal.throwIfAborted()
  const artifact = await db.agentArtifact.create({ data: { runId: ctx.runId, artifactType: work.artifactType,
    title: work.title, summary: work.summary, content: text, metadata: runtimeJson(work.metadata).value } })
  return work.phase === 'critique' ? { output: `独立批评已保存为 artifactId=${artifact.id}。\n${text.slice(0, 5000)}`, summary: `独立批评《${work.chapter.title}》` }
    : { output: `选择性修订稿已保存为 artifactId=${artifact.id}，尚未写入章节。\n${text.slice(0, 8000)}`, summary: `生成选择性修订稿《${work.chapter.title}》` }
}
