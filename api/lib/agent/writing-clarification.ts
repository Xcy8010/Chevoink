import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { TaskSpec } from '../../../shared/contracts/task-spec-contracts.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { DataAccessError } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'
import { readOriginalTaskRequest } from './original-request.js'

type Subject = { userId: string; novelId: string; runId: string }
type Original = Awaited<ReturnType<typeof readOriginalTaskRequest>>
type Writing = NonNullable<TaskSpec['scope']['writing']>
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const clarificationSchema = z.object({ version: z.literal(1), writingScopeClarification: z.literal(true), taskId: z.string(), userId: z.string(), novelId: z.string(),
  sourceRunId: z.string(), questionRunId: z.string(), originHash: digest, manuscriptRevision: z.number().int().nonnegative(),
  callId: z.string().min(1), question: z.string().min(1).max(500), options: z.array(z.object({ label: z.string(), detail: z.string().optional() }).strict()),
  answer: z.string().min(1).max(4000), source: z.enum(['legacy_question', 'durable_question']), requestId: z.string().optional(),
  targetOrderIndex: z.literal(1), contentHash: digest }).strict()
export type WritingClarification = z.infer<typeof clarificationSchema>

/** This capability fills one missing target; it cannot replace a known grant. */
export function eligibleEmptyWritingClarification(spec: TaskSpec, prompt: string | null) {
  return spec.intent === 'write' && spec.scope.reviewProtocol === 1 && spec.scope.localEditProtocol === 1 && spec.scope.writing?.kind === 'needs_input'
    && !spec.scope.writing.targets.length && !spec.scope.chapterIds?.length && !spec.scope.volumeIds?.length
    && !spec.scope.selection && !spec.scope.selectionBoundary && !spec.scope.localEditBoundary && !spec.authorization
    && !['proposal_only', 'conversation_only'].includes(spec.writingPacing ?? '')
    && !/(?:不要|不得|禁止|不许).{0,12}(?:写入|落盘|保存|创建章节)|只(?:讨论|展示|在对话)|read.only|do not.{0,20}(?:save|write|create)/iu
      .test([prompt ?? '', ...spec.hardConstraints.map(item => item.text)].join('\n'))
}

export function explicitFirstChapterAnswer(answer: string) {
  const value = answer.trim()
  const affirmative = value.match(/^(?:(?:就)?(?:作为|按)?(?:第\s*[一1]\s*章|首章)(?:写入|保存|落盘)|(?:写入|保存为)(?:第\s*[一1]\s*章|首章)|(?:write|save)\s+as\s+(?:the\s+)?first chapter)/iu)
  if (!affirmative) return false
  // This deliberately small grammar accepts a target, optional title and stop
  // constraints. Unknown trailing clauses (including questions, retractions,
  // other targets and new permissions) never become affirmative authority.
  const remainder = value.slice(affirmative[0].length)
    .replace(/(?:章名|标题)\s*《[^《》\r\n]{1,100}》/gu, '')
    .replace(/只写(?:这一段|该段|这一小段)|写完即停|完成(?:该段|这一段)?后停止|写完后停止/gu, '')
    .replace(/[（()），,。；;\s]/gu, '')
  return remainder.length === 0
}

const originHash = (original: Original) => runtimeJson({ prompt: original.prompt, spec: original.spec }).hash
function effectiveWriting(writing: Writing): Writing {
  return { ...writing, kind: 'bounded', targets: [{ orderIndex: 1, chapterId: null }] }
}

/** Artifacts are server-created answer receipts, scoped to the immutable origin. */
export async function readWritingClarification(tx: Prisma.TransactionClient, subject: Subject, original: Original,
  source: { manuscriptRevision: number }, spec: TaskSpec) {
  if (spec.scope.writingClarificationProtocol !== 1 || !eligibleEmptyWritingClarification(spec, original.prompt) || original.parentRunId) return null
  const artifacts = await tx.agentArtifact.findMany({ where: { runId: original.sourceRunId, artifactType: 'continuityReview',
    metadata: { path: ['writingScopeClarification'], equals: true },
    run: { userId: subject.userId, novelId: subject.novelId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2 })
  if (!artifacts.length) return null
  const parsed = clarificationSchema.safeParse(artifacts[0].metadata)
  if (artifacts.length !== 1 || !parsed.success) throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '章节澄清凭据损坏，未扩展写作范围。')
  const { contentHash, ...payload } = parsed.data
  if (runtimeJson(payload).hash !== contentHash || payload.originHash !== originHash(original) || payload.taskId !== original.taskId
    || payload.userId !== subject.userId || payload.novelId !== subject.novelId || payload.sourceRunId !== original.sourceRunId
    || payload.manuscriptRevision !== source.manuscriptRevision || !explicitFirstChapterAnswer(payload.answer)) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '章节澄清与原任务或稿件版本不一致，未扩展写作范围。')
  }
  return { evidence: parsed.data, writing: effectiveWriting(spec.scope.writing!) }
}

/** Invoke only after an actual authenticated pending-question answer, never a
 * proposed option, generated summary, timeout or fallback/default response. */
export async function recordWritingClarification(tx: Prisma.TransactionClient, subject: Subject,
  answer: { callId: string; question: string; options: Array<{ label: string; detail?: string }>; answer: string;
    source: 'legacy_question' | 'durable_question'; requestId?: string }) {
  const original = await readOriginalTaskRequest(tx, subject), parsed = taskSpecSchema.safeParse(original.spec)
  if (!parsed.success || parsed.data.scope.writingClarificationProtocol !== 1 || original.parentRunId
    || !eligibleEmptyWritingClarification(parsed.data, original.prompt) || !explicitFirstChapterAnswer(answer.answer)) return null
  const { lockWritingRunLineage } = await import('./writing-scope.js')
  await lockWritingRunLineage(tx, subject)
  await (await import('./manuscript-scope.js')).assertAgentManuscriptCurrent(tx, subject)
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['queued', 'running', 'awaiting_approval'] } }, include: { session: true } })
  if (!run || run.session.sandboxMode === 'read_only' || run.session.spawnedFromRunId) {
    throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前执行不可接收章节澄清，未扩展写作范围。')
  }
  const source = await tx.agentRun.findFirstOrThrow({ where: { id: original.sourceRunId, userId: subject.userId, novelId: subject.novelId } })
  const existing = await readWritingClarification(tx, subject, original, source, parsed.data)
  let evidence = existing?.evidence
  if (evidence && (evidence.callId !== answer.callId || evidence.answer !== answer.answer.trim())) return null
  if (!evidence) {
    if (await tx.chapter.count({ where: { authorId: subject.userId, ...activeChapterScope(subject.novelId) } })) return null
    const payload = { version: 1 as const, writingScopeClarification: true as const, taskId: original.taskId, userId: subject.userId, novelId: subject.novelId,
      sourceRunId: original.sourceRunId, questionRunId: subject.runId, originHash: originHash(original), manuscriptRevision: source.manuscriptRevision,
      ...answer, answer: answer.answer.trim(), targetOrderIndex: 1 as const }
    evidence = clarificationSchema.parse({ ...payload, contentHash: runtimeJson(payload).hash })
    await tx.agentArtifact.create({ data: { runId: original.sourceRunId, artifactType: 'continuityReview',
      title: '作者确认第一章目标', content: '仅补全原写作请求缺少的第一章目标；原请求、权限和预算保持原值。', metadata: runtimeJson(evidence).value } })
  }
  return { targetId: `writing-scope:${original.taskId}`, beforeHash: runtimeJson(parsed.data.scope.writing).hash,
    afterHash: runtimeJson(effectiveWriting(parsed.data.scope.writing!)).hash }
}
