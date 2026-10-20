import { readCompilerContinuitySource } from './compiler-continuity-source.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { readContinuedContinuityRecovery } from './legacy-continuity-recovery.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches, COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { activeChapterScope } from '../data/internal.js'
import { isKnownTextRequestBilling } from './text-request-billing.js'
import { runtimeJson } from './runtime-common.js'
import type { ToolContext } from './tools/types.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A real author admission and authoritative original result/usage establish
 * reuse. Reading a saved raw string alone never buys another provider request. */
export async function readContinuedContinuityEvidence(tx: Prisma.TransactionClient, ctx: ToolContext, input: { compilationId: string; focus?: string }) {
  const originalTask = await readOriginalTaskRequest(tx, ctx)
  const runIds = await originalTaskRunIds(tx, ctx, originalTask)
  const compilation = await tx.storyCompilation.findFirst({ where: { id: input.compilationId, userId: ctx.userId, novelId: ctx.novelId,
    runId: { in: runIds }, status: 'active', chapter: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId) } },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: { select: { id: true, title: true, revision: true, content: true, orderIndex: true } } } })
  if (!compilation?.chapter || !compilation.bridge) return null
  const chapter = compilation.chapter
  const validation = object(compilation.validation), audit = object(validation.continuityCriticResponse), rawAudit = object(audit.rawResponse)
  const protocol = object(validation.coverage).protocolVersion
  if (protocol !== 6 && protocol !== 7 && protocol !== 8) return null
  const source = await readCompilerContinuitySource(tx, ctx, chapter, compilation.bridge.fromChapterId, protocol)
  if (compilation.bridge.fromChapterId && source?.revision !== compilation.bridge.sourceRevision) return null
  const coverage = compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source, focus: input.focus }, protocol)
  if (validation.independentCheck !== 'unavailable' || validation.checkedChapterId !== chapter.id || validation.checkedRevision !== chapter.revision
    || !compilerContinuityCoverageMatches(validation.coverage, coverage) || validation.reviewFocus !== (input.focus ?? '')
    || ![3, 4, 5].includes(Number(audit.parserVersion)) || rawAudit.complete !== true || rawAudit.encoding !== 'json-string'
    || typeof rawAudit.content !== 'string' || validation.continuityFormatRecovery) return null
  let raw: unknown
  try { raw = JSON.parse(rawAudit.content) } catch { return null }
  if (typeof raw !== 'string' || raw.length !== audit.characterCount || createHash('sha256').update(raw).digest('hex') !== audit.contentHash) return null
  const bodies = { previous: source?.content ?? null, current: chapter.content }
  const inspected = inspectContinuityResponse(raw, bodies, true, 5)
  if (!inspected.structured || !inspected.candidateFindings.length || !['source_invalid', 'complete'].includes(inspected.audit.classification)) return null
  const currentCalls = await tx.agentRunEvent.findMany({ where: { runId: ctx.runId, type: 'tool.call', payload: { path: ['callId'], equals: ctx.callId } } })
  const recovered = await readContinuedContinuityRecovery(tx, ctx, currentCalls.length ? { callId: ctx.callId, compilationId: compilation.id, chapterId: chapter.id } : undefined)
  const admissionKey = recovered.find(([target]) => target === `${compilation.id}:${chapter.id}:${chapter.revision}:continuity_validate:protocol${COMPILER_CONTINUITY_PROTOCOL}`)?.[1]
  if (!admissionKey) return null
  const checkedAt = new Date(String(validation.checkedAt))
  if (!Number.isFinite(checkedAt.getTime())) return null
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] } } })
  const pairs = events.flatMap(call => {
    const payload = object(call.payload), args = object(payload.args)
    if (call.type !== 'tool.call' || payload.toolName !== 'continuity_validate' || call.createdAt > checkedAt
      || args.compilationId !== compilation.id || (args.focus ?? '') !== (input.focus ?? '')) return []
    const results = events.filter(result => result.runId === call.runId && result.type === 'tool.result' && result.seq > call.seq
      && object(result.payload).callId === payload.callId && result.createdAt >= checkedAt && object(result.payload).ok === false
      && ['CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_EVIDENCE_UNLOCATED'].includes(String(object(result.payload).failureCode)))
    return results.length === 1 ? [{ call, result: results[0] }] : []
  })
  if (pairs.length !== 1) return null
  const { call, result } = pairs[0]
  const paid = await tx.aiUsageLog.findMany({ where: { userId: ctx.userId, novelId: ctx.novelId, targetType: 'story_compilation', targetId: compilation.id,
    action: { startsWith: 'agent3ContinuityCritic' }, createdAt: { gte: call.createdAt, lte: result.createdAt } } })
  if (paid.filter(row => row.action === 'agent3ContinuityCritic').length !== 1 || paid.some(row => row.usageSource !== 'reported'
    || !isKnownTextRequestBilling(row) || object(row.billingEvidence).responseObserved !== true)) return null
  return { inspected, originalAudit: structuredClone(audit), bodies, chapter, coverage, usageIds: paid.map(row => row.id), validationHash: runtimeJson(validation).hash, admissionKey }
}
