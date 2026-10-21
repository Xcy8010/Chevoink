import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { AgentMessagePart } from '../../../shared/contracts/index.js'
import { qualityAppliedBodyChange } from '../../../shared/agent-applied-body-change.js'
import { prisma } from '../prisma.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const metadataSchema = z.object({ phase: z.literal('humanity_revision_auto'), reportId: z.string(), findingIds: z.array(z.string()).min(1),
  sourceRevision: z.number().int().positive(), targetRevision: z.number().int().positive() })
const patchesSchema = z.array(z.object({ findingId: z.string(), replacement: z.string() }).strict()).min(1)
type RepairReport = { id: string; runId: string | null; chapterId: string; chapterRevision: number; repairRound: number; deterministicMetrics: Prisma.JsonValue;
  chapter: { title: string }; findings: Array<{ id: string; startOffset: number; endOffset: number; evidenceHash: string; disposition: string }> }
type RepairArtifact = { runId: string; content: string; metadata: Prisma.JsonValue | null }
type ToolPart = Extract<AgentMessagePart, { type: 'tool-call' }>

/** Reconstruct only a hash-verified saved patch. Never read today's chapter body,
 * infer a delta from word counts, or mutate the original message/repair receipt. */
export function recoverQualityBodyChange(runId: string, part: ToolPart, report: RepairReport, artifacts: RepairArtifact[]): ToolPart {
  const display = part.display, snapshot = part.snapshot
  if (part.toolName !== 'quality_analyze' || part.status !== 'success' || display?.kind !== 'qualityReport' || display.status !== 'repaired'
    || display.appliedBodyChange !== undefined || report.id !== display.reportId || report.runId !== runId || report.chapterId !== display.chapterId
    || report.chapterRevision !== display.chapterRevision || report.repairRound !== display.repairRound
    || snapshot?.target !== 'chapter' || snapshot.targetId !== report.chapterId || snapshot.field !== 'content' || typeof snapshot.previousValue !== 'string') return part
  const metrics = report.deterministicMetrics
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return part
  const matches = artifacts.filter(item => item.runId === runId && metadataSchema.safeParse(item.metadata).data?.reportId === report.id)
  if (matches.length !== 1) return part
  const artifact = matches[0], meta = metadataSchema.parse(artifact.metadata)
  const before = snapshot.previousValue
  if (meta.sourceRevision !== metrics.sourceRevision || meta.targetRevision !== report.chapterRevision || meta.targetRevision !== meta.sourceRevision + 1
    || hash(before) !== metrics.contentHash || typeof metrics.repairedContentHash !== 'string') return part
  let patches: z.infer<typeof patchesSchema>
  try { patches = patchesSchema.parse(JSON.parse(artifact.content)) } catch { return part }
  const ids = patches.map(patch => patch.findingId)
  if (new Set(ids).size !== ids.length || new Set(meta.findingIds).size !== meta.findingIds.length || ids.length !== meta.findingIds.length
    || ids.some(id => !meta.findingIds.includes(id))) return part
  const ranges: Array<{ start: number; end: number; text: string }> = []
  for (const patch of patches) {
    const finding = report.findings.find(item => item.id === patch.findingId)
    if (!finding || finding.disposition !== 'repaired' || !Number.isSafeInteger(finding.startOffset) || !Number.isSafeInteger(finding.endOffset)
      || finding.startOffset < 0 || finding.endOffset <= finding.startOffset || finding.endOffset > before.length
      || hash(before.slice(finding.startOffset, finding.endOffset)) !== finding.evidenceHash) return part
    ranges.push({ start: finding.startOffset, end: finding.endOffset, text: patch.replacement })
  }
  ranges.sort((a, b) => b.start - a.start)
  if (ranges.some((range, index) => index > 0 && ranges[index - 1].start < range.end)) return part
  let after = before
  for (const range of ranges) after = after.slice(0, range.start) + range.text + after.slice(range.end)
  if (after === before || hash(after) !== metrics.repairedContentHash) return part
  const projected = { ...display, appliedBodyChange: { version: 1 as const, chapterId: report.chapterId, chapterTitle: report.chapter.title, before, after,
    sourceRevision: meta.sourceRevision, targetRevision: meta.targetRevision } }
  return qualityAppliedBodyChange(projected) ? { ...part, display: projected } : part
}

export async function projectLegacyQualityBodyChanges<T extends { runId: string; parts: unknown }>(userId: string, records: T[], db: Prisma.TransactionClient = prisma): Promise<T[]> {
  const candidates = records.flatMap(record => Array.isArray(record.parts) ? (record.parts as AgentMessagePart[]).flatMap(part =>
    part.type === 'tool-call' && part.toolName === 'quality_analyze' && part.status === 'success' && part.display?.kind === 'qualityReport'
      && part.display.status === 'repaired' && part.display.appliedBodyChange === undefined && part.snapshot?.target === 'chapter'
      ? [{ runId: record.runId, reportId: part.display.reportId }] : []) : [])
  if (!candidates.length) return records
  const runIds = [...new Set(candidates.map(item => item.runId))], reportIds = [...new Set(candidates.map(item => item.reportId))]
  const reports = await db.chapterQualityReport.findMany({ where: { id: { in: reportIds }, userId, runId: { in: runIds }, chapter: { authorId: userId } },
    select: { id: true, runId: true, chapterId: true, chapterRevision: true, repairRound: true, deterministicMetrics: true, chapter: { select: { title: true } },
      findings: { select: { id: true, startOffset: true, endOffset: true, evidenceHash: true, disposition: true } } } })
  if (!reports.length) return records
  const artifacts = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId }, artifactType: 'rewriteSelection',
    OR: reports.map(report => ({ metadata: { path: ['reportId'], equals: report.id } })) }, select: { runId: true, content: true, metadata: true } })
  return records.map(record => Array.isArray(record.parts) ? { ...record, parts: (record.parts as AgentMessagePart[]).map(part => {
    if (part.type !== 'tool-call' || part.display?.kind !== 'qualityReport') return part
    const reportId = part.display.reportId
    const report = reports.find(item => item.id === reportId)
    return report ? recoverQualityBodyChange(record.runId, part, report, artifacts) : part
  }) } : record)
}
