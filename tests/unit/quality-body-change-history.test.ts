import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { AgentMessagePart } from '../../shared/contracts/index.js'
import { recoverQualityBodyChange, projectLegacyQualityBodyChanges } from '../../api/lib/agent/quality-body-change-history.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture() {
  const before = 'One old sentence. Another old sentence.', after = 'One new sentence. Another new sentence.'
  const part: Extract<AgentMessagePart, { type: 'tool-call' }> = { type: 'tool-call', toolName: 'quality_analyze', callId: 'quality-call', title: 'Quality', args: { chapterId: 'chapter' }, status: 'success',
    display: { kind: 'qualityReport', reportId: 'report', chapterId: 'chapter', chapterRevision: 15, status: 'repaired', repairRound: 1, findings: [] },
    snapshot: { target: 'chapter', targetId: 'chapter', field: 'content', previousValue: before } }
  const report = { id: 'report', runId: 'run', chapterId: 'chapter', chapterRevision: 15, repairRound: 1, chapter: { title: 'Chapter five' },
    deterministicMetrics: { sourceRevision: 14, contentHash: hash(before), repairedContentHash: hash(after) },
    findings: [4, 26].map((startOffset, index) => ({ id: `finding-${index}`, startOffset, endOffset: startOffset + 3, evidenceHash: hash('old'), disposition: 'repaired' })) }
  const artifact = { runId: 'run', metadata: { phase: 'humanity_revision_auto', reportId: 'report', findingIds: ['finding-0', 'finding-1'], sourceRevision: 14, targetRevision: 15 },
    content: JSON.stringify([{ findingId: 'finding-1', replacement: 'new' }, { findingId: 'finding-0', replacement: 'new' }]) }
  return { before, after, part, report, artifact }
}

describe('historical quality body change projection', () => {
  it('recovers exact saved patches without reading current prose or altering the stored message', () => {
    const f = fixture(), original = structuredClone(f.part)
    const result = recoverQualityBodyChange('run', f.part, f.report, [f.artifact])
    expect(result.display).toMatchObject({ kind: 'qualityReport', reportId: 'report', appliedBodyChange: { version: 1, chapterId: 'chapter',
      chapterTitle: 'Chapter five', before: f.before, after: f.after, sourceRevision: 14, targetRevision: 15 } })
    expect(result.status).toBe('success')
    expect(result).not.toHaveProperty('accepted')
    expect(f.part).toEqual(original)
  })
  it.each(['run', 'report-run', 'chapter', 'revision', 'source-revision', 'before-hash', 'after-hash', 'patch-id', 'duplicate-id', 'overlap', 'evidence-hash', 'artifact-run', 'duplicate-artifact', 'missing-artifact', 'failed', 'no-snapshot'] as const)('refuses incomplete or mismatched %s evidence', scenario => {
    const f = fixture()
    let runId = 'run', artifacts = [f.artifact]
    if (scenario === 'run') runId = 'other'
    if (scenario === 'report-run') f.report.runId = 'other'
    if (scenario === 'chapter') f.report.chapterId = 'other'
    if (scenario === 'revision') f.report.chapterRevision++
    if (scenario === 'source-revision') f.artifact.metadata.sourceRevision--
    if (scenario === 'before-hash') f.report.deterministicMetrics.contentHash = hash('other')
    if (scenario === 'after-hash') f.report.deterministicMetrics.repairedContentHash = hash('other')
    if (scenario === 'patch-id') f.artifact.content = JSON.stringify([{ findingId: 'foreign', replacement: 'new' }])
    if (scenario === 'duplicate-id') f.artifact.content = JSON.stringify([{ findingId: 'finding-0', replacement: 'new' }, { findingId: 'finding-0', replacement: 'new' }])
    if (scenario === 'overlap') f.report.findings[1].startOffset = f.report.findings[0].startOffset
    if (scenario === 'evidence-hash') f.report.findings[0].evidenceHash = hash('other')
    if (scenario === 'artifact-run') f.artifact.runId = 'other'
    if (scenario === 'duplicate-artifact') artifacts = [f.artifact, f.artifact]
    if (scenario === 'missing-artifact') artifacts = []
    if (scenario === 'failed') f.part.status = 'failed'
    if (scenario === 'no-snapshot') delete f.part.snapshot
    expect(recoverQualityBodyChange(runId, f.part, f.report, artifacts)).toBe(f.part)
  })
  it('loads only the authorized owner and exact report/run evidence, with no chapter-body query or write', async () => {
    const f = fixture(), reports = vi.fn().mockResolvedValue([f.report]), artifacts = vi.fn().mockResolvedValue([f.artifact])
    const db = { chapterQualityReport: { findMany: reports }, agentArtifact: { findMany: artifacts } } as unknown as Prisma.TransactionClient
    const records = [{ runId: 'run', parts: [f.part] }]
    const result = await projectLegacyQualityBodyChanges('owner', records, db)
    expect(result[0].parts[0].display).toHaveProperty('appliedBodyChange.after', f.after)
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['report'] }, userId: 'owner', runId: { in: ['run'] }, chapter: { authorId: 'owner' } } }))
    expect(artifacts).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['run'] }, run: { userId: 'owner' }, artifactType: 'rewriteSelection' }) }))
    expect(records[0].parts[0].display).not.toHaveProperty('appliedBodyChange')
    await projectLegacyQualityBodyChanges('owner', result, db)
    expect(reports).toHaveBeenCalledOnce()
    expect(artifacts).toHaveBeenCalledOnce()
  })
})
