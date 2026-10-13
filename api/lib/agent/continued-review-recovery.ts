import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import type { AgentAuthorContinuedReview, AgentMessagePart } from '../../../shared/contracts/index.js'
import { activeChapterScope } from '../data/internal.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import type { PendingReviewCall } from './checkpoint.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { readQualityReviewAdmission } from './quality-review-admission.js'
import { analyzeDeterministicQuality, buildHumanityQualityContext, qualityReviewContextHash, HUMANITY_CRITIC_VERSION } from './humanity-quality.js'
import { buildQualityEvidenceSources } from './quality-evidence.js'
import { buildCriticInput, buildCriticSystem } from './tools/humanity-quality-tools.js'
import { continuityCriticSystem } from './tools/story-compiler-tools.js'
import { continuitySourceInput } from './continuity-review-context.js'
import { COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import { runtimeJson } from './runtime-common.js'
import { isKnownTextRequestBilling } from './text-request-billing.js'

type Subject = { userId: string; novelId: string; runId: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).hash
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const pendingSchema = z.object({ compilationId: z.string().min(1).nullable(), chapterId: z.string().min(1), revision: z.number().int().positive(),
  toolName: z.enum(['quality_analyze', 'continuity_validate']), callId: z.string().min(1) }).strict()
const receiptSchema = z.object({ status: z.literal('author_continued_review'), usageOutcome: z.literal('unknown_preserved'),
  sourceRunId: z.string().min(1), sourceCallId: z.string().min(1), sourceResultId: z.string().min(1), sourceReportId: z.string().min(1).nullable(),
  usageIds: z.array(z.string().min(1)).min(1).max(32), admissionId: z.string().startsWith('author-continue:'), admissionEventId: z.string().min(1),
  taskId: z.string().min(1), currentRevision: z.number().int().positive(), currentContentHash: digest, currentContextHash: digest,
  recoveryKey: z.string().regex(/^author-continued-review:[a-f0-9]{64}$/u) }).strict()
export type ContinuedReviewRecovery = PendingReviewCall & { receipt: AgentAuthorContinuedReview; persisted: boolean }
export type ContinuedReviewDispatchWitness = { callId: string; at: Date; compilationId: string | null; qualityContextHash: string; repairInvariantHash: string; specHash: string }

type QualityBundle = Awaited<ReturnType<typeof buildHumanityQualityContext>>
/** A controlled quality repair changes only body/revision, compiler target and
 * scene write status. Every other actual critic input stays bound. */
function repairInvariant(bundle: QualityBundle, sourceContent: string | null) {
  const bridge = bundle.compilation?.bridge
  const compiler = bundle.compilation ? { id: bundle.compilation.id,
    bridge: bridge ? Object.fromEntries(Object.entries(bridge).filter(([key]) => !['toChapterId', 'targetRevision', 'updatedAt'].includes(key))) : null,
    sceneTasks: bundle.compilation.sceneTasks.map(scene => Object.fromEntries(Object.entries(scene).filter(([key]) => !['chapterId', 'status', 'updatedAt'].includes(key)))) } : null
  return hash({ chapterId: bundle.chapter.id, chapterTitle: bundle.chapter.title, novel: bundle.chapter.novel, compiler,
    charter: bundle.charter, profiles: bundle.profiles, anchors: bundle.anchors, recentChapters: bundle.recentChapters,
    feedback: bundle.feedback, originalRequest: bundle.originalRequest, chapterWritingBackground: bundle.chapterWritingBackground, sourceContent })
}

async function sourceContent(tx: Prisma.TransactionClient, subject: Subject, bundle: QualityBundle) {
  const sourceId = bundle.compilation?.bridge?.fromChapterId
  return sourceId ? (await tx.chapter.findFirst({ where: { id: sourceId, authorId: subject.userId, ...activeChapterScope(subject.novelId) } }))?.content ?? null : null
}

async function reviewContext(tx: Prisma.TransactionClient, subject: Subject, item: PendingReviewCall, manuscriptRevision: number,
  original: Awaited<ReturnType<typeof readOriginalTaskRequest>>, bundle: QualityBundle) {
  const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map(row => row.content))
  const sources = buildQualityEvidenceSources({ ...subject, chapterId: bundle.chapter.id, chapterRevision: bundle.chapter.revision }, bundle.chapter.content)
  const previous = await sourceContent(tx, subject, bundle), qualityContextHash = qualityReviewContextHash(bundle)
  return { previous, qualityContextHash, contextHash: hash({ taskId: original.taskId, spec: original.spec, manuscriptRevision, compilationId: item.compilationId,
    qualityContextHash, system: buildCriticSystem('balanced'), input: buildCriticInput(bundle, deterministic.metrics, sources),
    continuity: { system: continuityCriticSystem, protocol: COMPILER_CONTINUITY_PROTOCOL, originalRequest: bundle.originalRequest,
      bridge: bundle.compilation?.bridge ?? null, sceneTasks: bundle.compilation?.sceneTasks ?? [],
      sources: continuitySourceInput({ previous: previous ?? bundle.recentChapters.map(row => row.content).join('\n'), current: bundle.chapter.content }) }, criticVersion: HUMANITY_CRITIC_VERSION }) }
}

export async function readContinuedReviewDispatchWitness(tx: Prisma.TransactionClient, subject: Subject, item: ContinuedReviewRecovery, callId: string) {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: 'running' } })
  if (!run) return null
  const current = await readContinuedReviewRecovery(tx, subject, [])
  if (!current.some(plan => plan.persisted && hash(plan.receipt) === hash(item.receipt))) return null
  const bundle = await buildHumanityQualityContext(subject.userId, subject.novelId, item.chapterId, subject.runId, tx)
  if (bundle.chapter.revision !== item.receipt.currentRevision || sha(bundle.chapter.content) !== item.receipt.currentContentHash) return null
  const original = await readOriginalTaskRequest(tx, subject)
  const context = await reviewContext(tx, subject, item, run.manuscriptRevision, original, bundle)
  if (context.contextHash !== item.receipt.currentContextHash) return null
  return { callId, at: new Date(), compilationId: bundle.compilation?.id ?? null, qualityContextHash: context.qualityContextHash,
    repairInvariantHash: repairInvariant(bundle, context.previous), specHash: hash(original.spec) } satisfies ContinuedReviewDispatchWitness
}

/** Handoff only this call's atomically persisted report/repair to the ordinary
 * loop. It grants no new recovery key, report pass, fee or progress. */
export async function readContinuedReviewRepairHandoff(tx: Prisma.TransactionClient, subject: Subject, item: ContinuedReviewRecovery,
  witness: ContinuedReviewDispatchWitness, part: Extract<AgentMessagePart, { type: 'tool-call' }>) {
  const snapshot = part.snapshot, display = part.display
  if (part.status !== 'success' || part.toolName !== 'quality_analyze' || part.callId !== witness.callId || display?.kind !== 'qualityReport'
    || !snapshot || snapshot.target !== 'chapter' || snapshot.targetId !== item.chapterId || snapshot.field !== 'content'
    || typeof snapshot.previousValue !== 'string' || sha(snapshot.previousValue) !== item.receipt.currentContentHash) return false
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: 'running' } })
  const admission = run ? await readQualityReviewAdmission(tx, run) : null
  if (!run || admission?.id !== item.receipt.admissionId) return false
  const authenticated = await readRecovery(tx, subject, [], true)
  if (!authenticated.some(saved => saved.persisted && hash(saved.receipt) === hash(item.receipt))) return false
  const chapter = await tx.chapter.findFirst({ where: { id: item.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) } })
  const report = await tx.chapterQualityReport.findFirst({ where: { id: display.reportId, userId: subject.userId, novelId: subject.novelId,
    runId: subject.runId, chapterId: item.chapterId, compilationId: witness.compilationId } })
  if (!chapter || chapter.revision !== item.receipt.currentRevision + 1 || chapter.content === snapshot.previousValue || !report
    || report.status !== 'repaired' || report.repairRound !== 1 || report.chapterRevision !== chapter.revision || report.createdAt < witness.at) return false
  const metrics = object(report.deterministicMetrics), diagnostic = object(metrics.criticResponse), afterHash = sha(chapter.content)
  if (metrics.independentCheck !== 'complete' || metrics.contentHash !== item.receipt.currentContentHash
    || metrics.qualityContextHash !== witness.qualityContextHash || metrics.sourceRevision !== item.receipt.currentRevision
    || metrics.repairedContentHash !== afterHash || diagnostic.callId !== witness.callId) return false
  const artifacts = await tx.agentArtifact.findMany({ where: { runId: subject.runId, artifactType: 'rewriteSelection', createdAt: { gte: witness.at } } })
  const matching = artifacts.filter(artifact => {
    const audit = object(artifact.metadata)
    return audit.phase === 'humanity_revision_auto' && audit.reportId === report.id && audit.sourceRevision === item.receipt.currentRevision
      && audit.targetRevision === chapter.revision && Array.isArray(audit.findingIds) && audit.findingIds.length > 0
      && audit.findingIds.every(id => typeof id === 'string') && new Set(audit.findingIds).size === audit.findingIds.length
  })
  if (matching.length !== 1) return false
  const findingIds = object(matching[0].metadata).findingIds as string[]
  const findings = await tx.qualityFinding.findMany({ where: { id: { in: findingIds }, reportId: report.id, userId: subject.userId, novelId: subject.novelId, disposition: 'repaired' } })
  if (findings.length !== findingIds.length) return false
  let replacements: Array<{ findingId: string; replacement: string }>
  try { replacements = z.array(z.object({ findingId: z.string().min(1), replacement: z.string() }).strict()).min(1).max(12).parse(JSON.parse(matching[0].content)) }
  catch { return false }
  const patches = replacements.filter(patch => findingIds.includes(patch.findingId))
    .map(patch => ({ ...patch, finding: findings.find(finding => finding.id === patch.findingId)! }))
    .sort((left, right) => right.finding.startOffset - left.finding.startOffset)
  if (patches.length !== findingIds.length || new Set(patches.map(patch => patch.findingId)).size !== findingIds.length) return false
  let after = snapshot.previousValue
  for (const [index, patch] of patches.entries()) {
    if (patch.finding.startOffset < 0 || patch.finding.endOffset <= patch.finding.startOffset || patch.finding.endOffset > snapshot.previousValue.length
      || sha(snapshot.previousValue.slice(patch.finding.startOffset, patch.finding.endOffset)) !== patch.finding.evidenceHash
      || index > 0 && patches[index - 1].finding.startOffset < patch.finding.endOffset) return false
    after = after.slice(0, patch.finding.startOffset) + patch.replacement + after.slice(patch.finding.endOffset)
  }
  if (after !== chapter.content) return false
  const payments = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, providerType: 'text',
    action: { startsWith: 'agent3Humanity' }, createdAt: { gte: witness.at }, OR: [{ agentRunId: subject.runId }, { chapterId: item.chapterId }] } })
  if (payments.filter(row => row.action === 'agent3HumanityCritic').length !== 1 || payments.some(row => row.agentRunId !== subject.runId
    || row.usageSource !== 'reported' || !isKnownTextRequestBilling(row))) return false
  const bundle = await buildHumanityQualityContext(subject.userId, subject.novelId, item.chapterId, subject.runId, tx)
  const original = await readOriginalTaskRequest(tx, subject)
  if (bundle.chapter.revision !== chapter.revision || bundle.chapter.content !== chapter.content || hash(original.spec) !== witness.specHash
    || repairInvariant(bundle, await sourceContent(tx, subject, bundle)) !== witness.repairInvariantHash) return false
  if ((bundle.compilation?.id ?? null) !== witness.compilationId) return false
  if (bundle.compilation && (bundle.compilation.bridge?.toChapterId !== chapter.id
    || bundle.compilation.bridge.targetRevision !== chapter.revision || bundle.compilation.sceneTasks.some(scene => scene.chapterId !== chapter.id || scene.status !== 'writing'))) return false
  return { chapterId: chapter.id, beforeHash: sha(JSON.stringify({ content: snapshot.previousValue })), afterHash: sha(JSON.stringify({ content: chapter.content })) }
}

export function continuedReviewAttemptKey(receipt: AgentAuthorContinuedReview, name: PendingReviewCall['toolName']) {
  return `${receipt.recoveryKey}:${name}`
}
export function continuedReviewCallId(attemptKey: string) { return `continued_review_${sha(attemptKey).slice(0, 40)}` }
const inScope = (spec: unknown, novelId: string, chapter: { id: string; orderIndex: number }) => {
  const scope = object(object(spec).scope), writing = object(scope.writing)
  return scope.novelId === novelId && (writing.kind === 'unbounded' || writing.kind === 'bounded' && Array.isArray(writing.targets) && writing.targets.some(item => {
    const target = object(item)
    return target.orderIndex === chapter.orderIndex && (target.chapterId == null || target.chapterId === chapter.id)
  }) || writing.kind === undefined && Array.isArray(scope.chapterIds) && scope.chapterIds.includes(chapter.id))
}

/** Only reads an existing author run.started and its exact prior failed call.
 * The active loop alone journals retirement through its event bus. Neither this
 * reader nor that audit certifies a report, settles old fees or resets budgets. */
async function readRecovery(tx: Prisma.TransactionClient, subject: Subject, pending: readonly PendingReviewCall[], historical: boolean,
  historicalAdmission?: { id: string; at: Date }) {
  const recovered: ContinuedReviewRecovery[] = []
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.taskRootId || run.runtimeProtocolVersion !== 0 || ['completed', 'cancelled'].includes(run.status)
    || object(run.usage).authorEnded !== undefined) return recovered
  const admission = historicalAdmission ?? await readQualityReviewAdmission(tx, run)
  if (!admission?.id.startsWith('author-continue:')) return recovered
  const novel = await tx.novel.findFirst({ where: { id: subject.novelId, authorId: subject.userId }, select: { manuscriptRevision: true } })
  const latest = await tx.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId: run.sessionId }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  if (!novel || !Number.isSafeInteger(run.manuscriptRevision) || run.manuscriptRevision !== novel.manuscriptRevision || latest?.id !== run.id
    || await tx.agentGoalExecution.findUnique({ where: { runId: run.id } })) return recovered
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  if (!ids.includes(subject.runId) || !original.prompt?.trim() || original.parentRunId !== null) return recovered
  const history = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['run.started', 'run.paused', 'run.finished', 'tool.call', 'tool.result', 'review.reconciled'] } },
    orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }], take: 2001 })
  if (history.length >= 2001) return recovered
  const starts = history.filter(event => event.runId === subject.runId && event.type === 'run.started'
    && `author-continue:${object(object(event.payload).authorContinue).eventId}` === admission.id
    && event.seq === Number(object(object(event.payload).authorContinue).afterSeq) + 1)
  const start = starts[0]
  if (!start || start.createdAt.getTime() !== admission.at.getTime()) return recovered
  const terminalId = object(object(start.payload).authorContinue).eventId
  const terminal = history.find(event => event.id === terminalId && event.runId === subject.runId && ['run.paused', 'run.finished'].includes(event.type)
    && event.seq <= Number(object(object(start.payload).authorContinue).afterSeq))
  if (!terminal || history.some(event => event.runId === subject.runId && ['run.paused', 'run.finished'].includes(event.type)
    && event.seq > terminal.seq && event.seq < start.seq)) return recovered
  const candidates = [...pending]
  for (const event of history) {
    if (event.runId !== subject.runId || event.type !== 'review.reconciled') continue
    const payload = object(event.payload), receipt = receiptSchema.safeParse(payload.receipt)
    if (!receipt.success || receipt.data.admissionId !== admission.id || receipt.data.admissionEventId !== start.id) continue
    const call = history.find(row => row.type === 'tool.call' && row.runId === receipt.data.sourceRunId && object(row.payload).callId === payload.callId)
    const item = pendingSchema.safeParse({ compilationId: payload.compilationId, chapterId: payload.chapterId, revision: payload.revision,
      toolName: object(call?.payload).toolName, callId: payload.callId })
    if (item.success && !candidates.some(saved => saved.callId === item.data.callId)) candidates.push(item.data)
  }
  for (const item of candidates) {
    const calls = history.filter(event => event.type === 'tool.call' && object(event.payload).callId === item.callId)
    const results = history.filter(event => event.type === 'tool.result' && object(event.payload).callId === item.callId)
    if (calls.length !== 1 || results.length !== 1) continue
    const call = calls[0], result = results[0], args = object(object(call.payload).args), returned = object(result.payload)
    if (call.runId !== subject.runId || result.runId !== call.runId || result.seq <= call.seq || result.createdAt < call.createdAt
      || result.createdAt >= start.createdAt || result.seq >= start.seq || returned.ok !== false
      || !String(returned.failureCode).startsWith('AI_PROVIDER_') || object(call.payload).toolName !== item.toolName || returned.toolName !== item.toolName
      || args.chapterId !== undefined && args.chapterId !== item.chapterId || args.compilationId !== undefined && args.compilationId !== item.compilationId
      || args.chapterId !== item.chapterId && (!item.compilationId || args.compilationId !== item.compilationId)) continue
    // An overlapping sensitive operation cannot borrow another call's interval.
    if (history.some(other => {
      if (other.type !== 'tool.call' || other.id === call.id || !['quality_analyze', 'continuity_validate', 'chapter_write', 'chapter_edit_range', 'chapter_append'].includes(String(object(other.payload).toolName))
        || other.createdAt > result.createdAt) return false
      const ends = history.filter(end => end.type === 'tool.result' && end.runId === other.runId && object(end.payload).callId === object(other.payload).callId && end.seq > other.seq)
      return other.createdAt >= call.createdAt || ends.length !== 1 || ends[0].createdAt >= call.createdAt
    })) continue
    const chapter = await tx.chapter.findFirst({ where: { id: item.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) } })
    if (!chapter || chapter.revision < item.revision || !inScope(original.spec, subject.novelId, chapter)) continue
    if (item.compilationId && !await tx.storyCompilation.findFirst({ where: { id: item.compilationId, userId: subject.userId, novelId: subject.novelId,
      runId: { in: ids }, chapterId: item.chapterId, status: 'active' } })) continue
    const family = item.toolName === 'quality_analyze' ? 'agent3Humanity' : 'agent3Continuity'
    const primaryAction = `${family}Critic`
    const actions = new Set([primaryAction, `${primaryAction}OutputRecovery`, `${primaryAction}EmptyRecovery`,
      ...(item.toolName === 'quality_analyze' ? ['agent3HumanityFormatRecovery'] : [])])
    const payments = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, providerType: 'text', action: { startsWith: family },
      createdAt: { gte: call.createdAt, lte: result.createdAt }, OR: [{ agentRunId: call.runId }, { chapterId: item.chapterId },
        { targetId: { in: [item.chapterId, ...(item.compilationId ? [item.compilationId] : [])] } }] }, orderBy: { id: 'asc' } })
    if (payments.filter(row => row.action === primaryAction).length !== 1 || !payments.some(row => row.usageSource === 'unknown')
      || payments.some(row => !actions.has(row.action) || row.agentRunId !== null && row.agentRunId !== call.runId
      || row.chapterId !== null && row.chapterId !== item.chapterId || row.durationMs < 0 || row.createdAt.getTime() + row.durationMs > result.createdAt.getTime())) continue
    const reports = item.toolName === 'quality_analyze' ? await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
      runId: call.runId, chapterId: item.chapterId, chapterRevision: item.revision, status: 'failed', createdAt: { gte: call.createdAt, lte: result.createdAt } } }) : []
    const sourceReports = reports.filter(report => object(object(report.deterministicMetrics).criticResponse).callId === item.callId)
    if (sourceReports.length > 1) continue
    const audits = history.filter(event => event.runId === subject.runId && event.type === 'review.reconciled'
      && object(event.payload).callId === item.callId && object(object(event.payload).receipt).status === 'author_continued_review'
      && object(object(event.payload).receipt).admissionId === admission.id)
    if (audits.length > 1) continue
    const prior = audits.length ? receiptSchema.safeParse(object(audits[0].payload).receipt) : null
    if (audits.length && (!prior?.success || audits[0].seq <= start.seq || audits[0].createdAt < start.createdAt
      || object(audits[0].payload).chapterId !== item.chapterId || object(audits[0].payload).revision !== item.revision
      || object(audits[0].payload).compilationId !== item.compilationId)) continue
    if (historical) {
      if (!prior?.success) continue
      const { status: _status, usageOutcome: _usageOutcome, recoveryKey, ...binding } = prior.data
      if (binding.sourceRunId !== call.runId || binding.sourceCallId !== item.callId || binding.sourceResultId !== result.id
        || binding.sourceReportId !== (sourceReports[0]?.id ?? null) || binding.taskId !== original.taskId || binding.admissionId !== admission.id
        || binding.admissionEventId !== start.id || binding.currentRevision < item.revision
        || hash(binding.usageIds) !== hash(payments.map(row => row.id)) || recoveryKey !== `author-continued-review:${hash(binding)}`) continue
      // Later legitimate revisions cannot revoke an already journaled old-slot
      // retirement. Its author/call/usage chain remains exact and immutable.
      recovered.push({ ...item, receipt: prior.data, persisted: true })
      continue
    }
    const bundle = await buildHumanityQualityContext(subject.userId, subject.novelId, item.chapterId, subject.runId, tx)
    if (bundle.chapter.id !== chapter.id || bundle.chapter.revision !== chapter.revision || bundle.chapter.content !== chapter.content
      || item.compilationId && bundle.compilation?.id !== item.compilationId) continue
    const context = await reviewContext(tx, subject, item, run.manuscriptRevision, original, bundle)
    const binding = { sourceRunId: call.runId, sourceCallId: item.callId, sourceResultId: result.id, sourceReportId: sourceReports[0]?.id ?? null,
      usageIds: payments.map(row => row.id), admissionId: admission.id, admissionEventId: start.id, taskId: original.taskId,
      currentRevision: chapter.revision, currentContentHash: sha(chapter.content), currentContextHash: context.contextHash }
    const receipt: AgentAuthorContinuedReview = { status: 'author_continued_review', usageOutcome: 'unknown_preserved', ...binding,
      recoveryKey: `author-continued-review:${hash(binding)}` }
    if (audits.length) {
      if (!prior?.success || hash(prior.data) !== hash(receipt)) continue
    }
    recovered.push({ ...item, receipt, persisted: audits.length === 1 })
  }
  return recovered
}

export async function readContinuedReviewRecovery(tx: Prisma.TransactionClient, subject: Subject, pending: readonly PendingReviewCall[]) {
  return readRecovery(tx, subject, pending, false)
}

/** An execution exemption for exact audited old calls; this never changes a
 * billing row or lets a post-admission unknown borrow the author's action. */
export async function readAuthorContinuedReviewUsageIds(tx: Prisma.TransactionClient, subject: Subject) {
  const audits = await tx.agentRunEvent.findMany({ where: { runId: subject.runId, type: 'review.reconciled' }, orderBy: { seq: 'asc' }, take: 2001 })
  const ids = new Set<string>()
  if (audits.length >= 2001) return ids
  const admissions = new Map<string, { id: string; at: Date }>()
  for (const audit of audits) {
    const receipt = receiptSchema.safeParse(object(audit.payload).receipt)
    if (!receipt.success) continue
    const start = await tx.agentRunEvent.findFirst({ where: { id: receipt.data.admissionEventId, runId: subject.runId, type: 'run.started' } })
    if (start) admissions.set(receipt.data.admissionEventId, { id: receipt.data.admissionId, at: start.createdAt })
  }
  for (const admission of admissions.values()) for (const item of await readRecovery(tx, subject, [], true, admission)) {
    for (const id of item.receipt.usageIds) ids.add(id)
  }
  return ids
}
