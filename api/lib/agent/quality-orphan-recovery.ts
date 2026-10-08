import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { buildHumanityQualityContext, qualityReviewContextHash } from './humanity-quality.js'
import { runtimeJson } from './runtime-common.js'
import { hasReturnedQualityCorrection } from './quality-evidence.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const links = (metrics: unknown) => {
  const value = object(metrics)
  return [value.formatRecovery, ...(Array.isArray(value.formatRecoveryHistory) ? value.formatRecoveryHistory : [])].map(object)
}

/** Deleting a conversation removes run/events, but retains paid usage and
 * manuscript reports. Close only an exact, settled report-to-report claim;
 * never restore the deleted run or infer task authority from its identifier. */
export async function readOrphanQualityRecoveryProofs(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, ids: string[], taskId: string,
  chapterId: string, revision: number) {
  const proofs = new Map<string, { sourceReportId: string; key: string; claimRunId: string; evidenceHash: string }>()
  const bundle = await buildHumanityQualityContext(subject.userId, subject.novelId, chapterId, subject.runId, tx)
  if (bundle.chapter.revision !== revision || !bundle.compilation) return proofs
  const compilation = await tx.storyCompilation.findFirst({ where: { id: bundle.compilation.id,
    userId: subject.userId, novelId: subject.novelId, runId: { in: ids } } })
  if (!compilation) return proofs
  const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId, chapterRevision: revision, compilationId: compilation.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 501 })
  if (reports.length > 500 || !reports.some(report => report.runId === null)) return proofs
  const trusted = new Set(reports.filter(report => report.runId && ids.includes(report.runId)).map(report => report.id))
  const contextHash = qualityReviewContextHash(bundle), contentHash = hash(bundle.chapter.content)
  const matches = (sourceId: string, claim: Record<string, unknown>, link: Record<string, unknown>) =>
    ['failed', 'completed'].includes(String(link.state)) && link.reportId === sourceId
    && ['taskId', 'chapterId', 'chapterRevision', 'compilationId', 'contextHash', 'key', 'evidenceHash', 'admissionId']
      .every(key => claim[key] === link[key])
  for (const source of reports) {
    if (!trusted.has(source.id)) continue
    const sourceMetrics = object(source.deterministicMetrics), claim = object(sourceMetrics.formatRecovery)
    if (claim.state !== 'claimed' || claim.taskId !== taskId || claim.chapterId !== chapterId || claim.chapterRevision !== revision
      || claim.compilationId !== compilation.id || claim.contextHash !== contextHash || sourceMetrics.contentHash !== contentHash
      || typeof claim.claimRunId !== 'string' || typeof claim.key !== 'string' || typeof claim.evidenceHash !== 'string') continue
    const owner = await tx.agentRun.findUnique({ where: { id: claim.claimRunId }, select: { id: true } })
    if (owner && !ids.includes(owner.id)) continue
    const finals = reports.filter(report => report.id !== source.id && links(report.deterministicMetrics).some(link => matches(source.id, claim, link)))
    if (finals.length !== 1 || finals[0].runId !== null) continue
    const final = finals[0], metrics = object(final.deterministicMetrics), audit = object(metrics.criticResponse)
    const terminal = links(metrics).find(link => matches(source.id, claim, link))!
    const start = typeof claim.claimedAt === 'string' ? new Date(claim.claimedAt) : source.updatedAt
    if (!Number.isFinite(start.getTime()) || start < source.createdAt || start > final.createdAt
      || (terminal.state === 'failed') !== (final.status === 'failed') || metrics.contentHash !== contentHash
      || metrics.qualityContextHash !== contextHash || audit.version !== 1 || typeof audit.contentHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(audit.contentHash) || !Number.isSafeInteger(audit.characterCount) || Number(audit.characterCount) <= 0) continue
    const raw = object(audit.rawResponse)
    if (raw.complete === true) {
      try {
        const text = raw.encoding === 'json-string' && typeof raw.content === 'string' ? JSON.parse(raw.content) : null
        if (typeof text !== 'string' || text.length !== audit.characterCount || hash(text) !== audit.contentHash) continue
      } catch { continue }
    }
    const interval = { gte: start, lte: final.createdAt }
    const [paid, competingReports, operations] = await Promise.all([
      tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, targetType: 'chapter', targetId: chapterId,
        action: { startsWith: 'agent3Humanity' }, createdAt: interval } }),
      tx.chapterQualityReport.count({ where: { userId: subject.userId, novelId: subject.novelId, chapterId,
        createdAt: interval, id: { notIn: [source.id, final.id] } } }),
      tx.agentOperation.count({ where: { originRunId: { in: ids }, kind: 'provider', action: { startsWith: 'quality_' }, createdAt: interval } }),
    ])
    const recoveries = paid.filter(usage => usage.action === 'agent3HumanityFormatRecovery')
    const corrections = paid.filter(usage => usage.action === 'agent3HumanityEvidenceCorrection')
    if (competingReports || operations || recoveries.length !== 1 || corrections.length > 1
      || paid.length !== recoveries.length + corrections.length
      || corrections.length && (audit.classification !== 'source_invalid' || !hasReturnedQualityCorrection(audit) || corrections[0].createdAt < recoveries[0].createdAt)
      || paid.some(usage => usage.usageSource !== 'reported' || usage.billingStatus !== 'settled'
        || usage.requestTokens === null || usage.responseTokens === null || usage.responseTokens <= 0
        || object(usage.billingEvidence).responseObserved !== true)) continue
    trusted.add(final.id)
    proofs.set(final.id, { sourceReportId: source.id, key: claim.key, claimRunId: claim.claimRunId,
      evidenceHash: runtimeJson({ sourceReportId: source.id, finalReportId: final.id, claim, terminal,
        usageIds: paid.map(usage => usage.id).sort(), start: start.toISOString(), end: final.createdAt.toISOString(), responseHash: audit.contentHash }).hash })
  }
  return proofs
}
