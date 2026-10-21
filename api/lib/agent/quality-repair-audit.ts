import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DataAccessError, prisma } from '../prisma.js'
import { runtimeJson } from './runtime-common.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const qualityRepairAttemptAuditSchema = z.object({
  version: z.literal(1), kind: z.literal('quality_repair_attempt'),
  runId: z.string().min(1), callId: z.string().min(1), reportId: z.string().min(1), chapterId: z.string().min(1),
  sourceRevision: z.number().int().positive(), contextHash: digest, attempt: z.union([z.literal(1), z.literal(2)]),
  action: z.enum(['agent3HumanityRevision', 'agent3HumanityRevisionRetry']),
  trigger: z.enum(['initial', 'parse_error', 'schema_error', 'missing_patch', 'no_op', 'mixed_unresolved']),
  state: z.enum(['prepared', 'returned', 'request_error']),
  classifications: z.array(z.enum(['parse_error', 'schema_error', 'missing_patch', 'no_op', 'unsafe_patch', 'valid_patch', 'valid_retain',
    'provider_error', 'transport_unknown', 'cancelled', 'unconfirmed_error'])).max(8),
  response: z.object({ contentHash: digest, characterCount: z.number().int().nonnegative() }).strict().optional(),
  counts: z.object({ requested: z.number().int().nonnegative(), returned: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), duplicate: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(), noOp: z.number().int().nonnegative(), unsafe: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative().optional() }).strict().optional(),
  errorCode: z.enum(['AI_PROVIDER_TIMEOUT', 'AI_PROVIDER_TRANSPORT', 'AI_PROVIDER_INCOMPLETE', 'AI_PROVIDER_ERROR',
    'AI_PROVIDER_QUOTA_EXCEEDED', 'AI_PROVIDER_AUTH_ERROR', 'AI_PROVIDER_OUTPUT_LIMIT', 'AI_PROVIDER_EMPTY_RESPONSE',
    'CANCELLED', 'UNCONFIRMED']).optional(),
  requests: z.array(z.object({ usageId: z.string().min(1), status: z.enum(['prepared', 'terminal', 'not_dispatched', 'unknown']),
    billingKnown: z.boolean() }).strict()).max(8),
}).strict()
export type QualityRepairAttemptAudit = z.infer<typeof qualityRepairAttemptAuditSchema>

/** Diagnostic-only artifact, separate from body/report/charge receipts. Never
 * persist model text, prompts, replacements, exception messages or runtimes. */
export async function persistQualityRepairAttemptAudit(subject: { userId: string; novelId: string }, input: QualityRepairAttemptAudit) {
  const audit = qualityRepairAttemptAuditSchema.parse(input)
  const id = `qrepair:${createHash('sha256').update(JSON.stringify([audit.runId, audit.callId, audit.reportId, audit.attempt])).digest('hex').slice(0, 56)}`
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`
    const run = await tx.agentRun.findFirst({ where: { id: audit.runId, userId: subject.userId, novelId: subject.novelId }, select: { id: true } })
    const report = await tx.chapterQualityReport.findFirst({ where: { id: audit.reportId, userId: subject.userId,
      novelId: subject.novelId, chapterId: audit.chapterId }, select: { id: true } })
    if (!run || !report) throw new DataAccessError(409, 'QUALITY_RUN_SCOPE_INVALID', '修订诊断记录与当前任务或报告不一致。')
    const existing = await tx.agentArtifact.findUnique({ where: { id } })
    if (existing) {
      const previous = qualityRepairAttemptAuditSchema.safeParse(existing.metadata)
      if (existing.runId !== audit.runId || existing.artifactType !== 'contextCheckpoint' || existing.content !== '' || !previous.success
        || previous.data.runId !== audit.runId || previous.data.callId !== audit.callId || previous.data.reportId !== audit.reportId
        || previous.data.attempt !== audit.attempt
        || previous.data.chapterId !== audit.chapterId || previous.data.sourceRevision !== audit.sourceRevision
        || previous.data.contextHash !== audit.contextHash || previous.data.action !== audit.action || previous.data.trigger !== audit.trigger) {
        throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原修订诊断身份无法核实，未派发新请求。')
      }
      if (audit.state === 'prepared' || previous.data.state !== 'prepared') {
        if (audit.state !== 'prepared' && runtimeJson(previous.data).hash === runtimeJson(audit).hash) return
        throw new DataAccessError(409, 'QUALITY_REPAIR_RECONCILIATION_REQUIRED', '原修订尝试已有记录，先核对原请求与用量，不重复派发。')
      }
      await tx.agentArtifact.update({ where: { id }, data: { metadata: runtimeJson(audit).value } })
    } else {
      if (audit.state !== 'prepared') throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '缺少原修订尝试记录，未伪造请求回执。')
      await tx.agentArtifact.create({ data: { id, runId: audit.runId, artifactType: 'contextCheckpoint',
        title: '局部质量修订诊断', content: '', metadata: runtimeJson(audit).value } })
    }
  })
}
