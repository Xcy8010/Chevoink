import { readCompilerContinuitySource } from './compiler-continuity-source.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema } from '../../../shared/contracts/index.js'
import { activeChapterScope } from '../data/internal.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches, COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { readContinuedContinuityRecovery } from './legacy-continuity-recovery.js'
import { readWritingScope } from './writing-scope.js'
import { originalTaskRunIds } from './original-request.js'
import { runtimeJson } from './runtime-common.js'
import { validatedContinuityCheckRounds } from './story-compiler.js'
import { isKnownRejectedTextRequestAttempt } from './text-request-billing.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
type Subject = { userId: string; novelId: string; runId: string; callId: string }
type Input = { compilationId: string; focus?: string }

/** Returned bytes only. This reader cannot authorize or dispatch a paid retry. */
export async function readOfflineContinuityRecovery(tx: Prisma.TransactionClient, subject: Subject, input: Input) {
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: 'running' } })
  if (!run || run.taskRootId) return null
  const original = await readWritingScope(tx, subject), spec = taskSpecSchema.safeParse(original.spec)
  if (!spec.success || !['write', 'revise'].includes(spec.data.intent) || original.parentRunId || original.writing?.kind !== 'bounded') return null
  const runIds = await originalTaskRunIds(tx, subject, original)
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: runIds }, status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } })) return null
  const compilation = await tx.storyCompilation.findFirst({ where: { id: input.compilationId, userId: subject.userId, novelId: subject.novelId,
    runId: { in: runIds }, status: 'active', chapter: { authorId: subject.userId, ...activeChapterScope(subject.novelId) } },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: { select: { id: true, title: true, revision: true, content: true, orderIndex: true } } } })
  if (!compilation?.chapter || !compilation.bridge || !compilation.chapter.content.trim() || compilation.sceneTasks.length < 1 || compilation.sceneTasks.length > 4) return null
  const chapter = compilation.chapter, validation = object(compilation.validation), audit = object(validation.continuityCriticResponse), rawAudit = object(audit.rawResponse)
  const protocol = object(validation.coverage).protocolVersion
  if (protocol !== 6 && protocol !== 7 && protocol !== 8) return null
  const source = await readCompilerContinuitySource(tx, subject, chapter, compilation.bridge.fromChapterId, protocol)
  if (compilation.bridge.fromChapterId && source?.revision !== compilation.bridge.sourceRevision) return null
  const coverage = compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source, focus: input.focus }, protocol)
  if (validation.independentCheck !== 'unavailable' || validation.checkedChapterId !== chapter.id || validation.checkedRevision !== chapter.revision
    || !compilerContinuityCoverageMatches(validation.coverage, coverage) || validation.reviewFocus !== (input.focus ?? '')
    || validation.continuityFormatRecovery || audit.version !== 1 || audit.parserVersion !== 3 || audit.classification !== 'findings_invalid'
    || rawAudit.version !== 1 || rawAudit.encoding !== 'json-string' || rawAudit.complete !== true || typeof rawAudit.content !== 'string') return null
  let raw: unknown
  try { raw = JSON.parse(rawAudit.content); validatedContinuityCheckRounds(validation) } catch { return null }
  if (typeof raw !== 'string' || !raw.length || raw.length > 262_144 || raw.length !== audit.characterCount
    || createHash('sha256').update(raw).digest('hex') !== audit.contentHash
    || !Number.isSafeInteger(validation.autoRepairRounds) || Number(validation.autoRepairRounds) < 0) return null
  const bodies = { previous: source?.content ?? null, current: chapter.content }
  if (inspectContinuityResponse(raw, bodies, true, 3).audit.classification !== 'findings_invalid') return null
  const inspected = inspectContinuityResponse(raw, bodies, true, 4)
  if (!inspected.structured || inspected.audit.classification !== 'complete' || !inspected.findings.length || !inspected.audit.sourceRelocations?.length) return null
  const currentCalls = await tx.agentRunEvent.findMany({ where: { runId: subject.runId, type: 'tool.call', payload: { path: ['callId'], equals: subject.callId } } })
  const recovered = await readContinuedContinuityRecovery(tx, subject, currentCalls.length ? { callId: subject.callId, compilationId: compilation.id, chapterId: chapter.id } : undefined, 'known_source')
  const admissionKey = recovered.find(([target]) => target === `${compilation.id}:${chapter.id}:${chapter.revision}:continuity_validate:protocol${COMPILER_CONTINUITY_PROTOCOL}`)?.[1]
  if (!admissionKey) return null
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: runIds }, type: { in: ['tool.call', 'tool.result'] } }, orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }] })
  const call = events.filter(event => { const payload = object(event.payload), args = object(payload.args)
    return event.type === 'tool.call' && !(event.runId === subject.runId && payload.callId === subject.callId)
      && payload.toolName === 'continuity_validate' && (args.compilationId === compilation.id || args.chapterId === chapter.id)
  }).at(-1)
  if (!call) return null
  const callPayload = object(call.payload), args = object(callPayload.args)
  if ((args.focus ?? '') !== (input.focus ?? '')) return null
  const result = events.find(event => event.runId === call.runId && event.type === 'tool.result' && object(event.payload).callId === callPayload.callId && event.seq > call.seq)
  if (!result) return null
  // Legacy usage has no agentRunId. Bind the original owned target and exact
  // returned-call time window, as the continued-review reader above does.
  const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    targetType: 'story_compilation', targetId: compilation.id, action: { startsWith: 'agent3Continuity' }, createdAt: { gte: call.createdAt, lte: result.createdAt } }, orderBy: { id: 'asc' } })
  if (paid.filter(row => row.action === 'agent3ContinuityCritic' && !isKnownRejectedTextRequestAttempt(row)).length !== 1 || paid.some(row => !isKnownRejectedTextRequestAttempt(row) && (row.billingStatus !== 'settled' || row.usageSource !== 'reported'
    || row.requestTokens === null || !row.responseTokens || row.reservedCreditMilli !== 0 || object(row.billingEvidence).responseObserved !== true))) return null
  return { findings: inspected.findings, validationHash: runtimeJson(validation).hash, audit: { version: 1, parserVersion: 4,
    originalParserVersion: 3, classification: 'complete', admissionKey, sourceCallId: String(callPayload.callId), sourceRunId: call.runId,
    sourceResultId: result.id, usageIds: paid.map(row => row.id), rawHash: inspected.audit.contentHash, characterCount: inspected.audit.characterCount,
    coverageHash: runtimeJson(coverage).hash, sourceRelocations: inspected.audit.sourceRelocations }, chapter, coverage }
}
