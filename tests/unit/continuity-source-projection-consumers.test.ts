import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { recoverExplicitSourceEvidence, validateStoredExplicitSourceProjection } from '../../api/lib/agent/continuity-explicit-source-projection.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { compilerContinuityCoverage, completeCompilerContinuityAssessment, validCompilerContinuitySourceProjection } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readCurrentCompilerContinuity } from '../../api/lib/agent/chapter-review-guard.js'
import { readHistoricalStandaloneContinuityReport as readStandaloneContinuityReport, readHistoricalStandaloneContinuityContext as buildStandaloneContinuityContext } from '../../api/lib/agent/continuity-history.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

function fixture(version: 7 | 8 = 8) {
  const chapter = { id: 'chapter', revision: 1, orderIndex: 1, title: 'Balance', content: '钱包有一百元。买书花二十元。余额写成七十元。' }
  const finding = { signal: 'object', severity: 'error', evidence: '现金数额与实际支出不符。', suggestion: '按实际支出统一余额。',
    sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '钱包有一百元' }, { source: 'current', segmentId: 'c0', quote: '余额写成七十元' }] }
  const wire = { findings: [finding], terminalVerdicts: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind,
    result: kind === 'state_progression' ? 'conflict' : 'clear', reason: 'Full source review.', findingIndexes: kind === 'state_progression' ? [0] : [] })) }
  const bodies = { current: chapter.content, previous: version === 8 ? null : '', ...(version === 8 ? { terminalEvidence: terminalEvidenceContext(chapter, null, 2, undefined, undefined, 5) } : {}) }
  const strict = inspectContinuityResponse(JSON.stringify(wire), bodies, true, version, undefined, { currentOrderIndex: 1, previous: [] })
  const projected = recoverExplicitSourceEvidence(strict, bodies)!
  expect(projected.complete).toBe(true)
  const bridge = { targetRevision: 1, committedAt: null }, sceneTasks: Array<{ ordinal: number }> = []
  const coverage = compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null }, 11)
  const validation = { independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: 1, coverage,
    findings: projected.findings, errorCount: 1, warningCount: 0, continuityCriticResponse: projected.audit }
  const compilation = { status: 'active', stage: 'check', preparedContext: {}, bridge, sceneTasks, validation }
  return { chapter, projected, compilation }
}

describe('explicit-source report consumers', () => {
  it('reuses the actual parser7 context4 report through the unchanged default cache3 key without dispatch or writes', async () => {
    const f = fixture(7), ctx = { userId: 'owner', novelId: 'novel', runId: 'run', chapterId: f.chapter.id } as ToolContext
    const artifact = { id: 'saved', metadata: { independentCheck: 'complete', chapterId: f.chapter.id,
      findings: f.projected.findings, criticResponse: f.projected.audit } }
    const db = { agentArtifact: { findFirst: vi.fn(async () => artifact) },
      agentRun: { findFirst: vi.fn(async () => ({ taskRootId: null, runtimeProtocolVersion: 0, taskSpec: null, sessionId: 'session' })) },
      chapter: { findFirst: vi.fn(async () => f.chapter), findMany: vi.fn(async () => []) }, storyCharter: { findUnique: vi.fn(async () => null) } }
    const tx = db as unknown as Prisma.TransactionClient
    const current = await buildStandaloneContinuityContext(ctx, f.chapter.id, tx, 4)
    expect((await buildStandaloneContinuityContext(ctx, f.chapter.id, tx, 3)).contextHash).not.toBe(current.contextHash)
    const unchanged = JSON.stringify(artifact), fetcher = vi.fn(async () => { throw new Error('A cached report must not dispatch') })
    vi.stubGlobal('fetch', fetcher)
    try {
      for (let i = 0; i < 2; i++) {
        const cached = await readStandaloneContinuityReport(ctx, current.contextHash, undefined, tx)
        expect(cached).toMatchObject({ artifact, findings: f.projected.findings, criticResponse: f.projected.audit })
        expect(cached?.criticResponse?.rawResponse).toEqual(f.projected.audit.rawResponse)
      }
      expect(fetcher).not.toHaveBeenCalled()
      expect(JSON.stringify(artifact)).toBe(unchanged)
      expect(db.agentArtifact.findFirst).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })

  it('reads an authenticated current body report while retaining the real error', () => {
    const f = fixture()
    expect(validCompilerContinuitySourceProjection(f.compilation.validation, f.chapter.content)).toBe(true)
    expect(completeCompilerContinuityAssessment(f.compilation.validation)).toEqual({ errorCount: 1, warningCount: 0 })
    expect(readCurrentCompilerContinuity(f.compilation, f.chapter, null).assessment).toEqual({ errorCount: 1, warningCount: 0 })
  })

  it.each(['marker', 'raw', 'diagnostic', 'remove-marker', 'remove-finding', 'wrong-body'] as const)('refuses a damaged body report at readiness/cache boundaries: %s', fault => {
    const f = fixture(), validation = f.compilation.validation
    const audit = validation.continuityCriticResponse as unknown as Record<string, unknown>
    const marker = audit.sourceProjection as Record<string, unknown>
    if (fault === 'marker') marker.frozenBodiesHash = 'a'.repeat(64)
    if (fault === 'raw') (audit.rawResponse as { content: string }).content += ' '
    if (fault === 'diagnostic') marker.dispositionDiagnostics = [{ index: 0, code: 'retract_source_proof_invalid' }]
    if (fault === 'remove-marker') delete audit.sourceProjection
    if (fault === 'remove-finding') { validation.findings = []; validation.errorCount = 0 }
    if (fault === 'wrong-body') f.chapter.content += '正文已变化。'
    expect(validCompilerContinuitySourceProjection(validation, f.chapter.content)).toBe(false)
    expect(readCurrentCompilerContinuity(f.compilation, f.chapter, null).assessment).toBeNull()
    if (fault !== 'wrong-body') expect(completeCompilerContinuityAssessment(validation)).toBeNull()
  })

  it.each(['marker', 'raw', 'diagnostic', 'remove-marker'] as const)('does not reuse a corrupted standalone artifact: %s', async fault => {
    const f = fixture(7), audit = f.projected.audit as unknown as Record<string, unknown>, marker = audit.sourceProjection as Record<string, unknown>
    expect(validateStoredExplicitSourceProjection(audit, f.chapter.content)).not.toBeNull()
    if (fault === 'marker') marker.frozenBodiesHash = 'a'.repeat(64)
    if (fault === 'raw') (audit.rawResponse as { content: string }).content += ' '
    if (fault === 'diagnostic') marker.dispositionDiagnostics = [{ index: 0, code: 'retract_source_proof_invalid' }]
    if (fault === 'remove-marker') delete audit.sourceProjection
    const db = { agentArtifact: { findFirst: vi.fn(async () => ({ metadata: { independentCheck: 'complete', chapterId: f.chapter.id,
      findings: f.projected.findings, criticResponse: audit } })) } }
    // No manuscript/provider delegates: an invalid marker must be refused
    // before any actual source retrieval, request or write is attempted.
    expect(await readStandaloneContinuityReport({ userId: 'owner', novelId: 'novel', runId: 'run' } as ToolContext,
      'context', undefined, db as unknown as Prisma.TransactionClient, 4)).toBeNull()
    expect(db.agentArtifact.findFirst).toHaveBeenCalledOnce()
  })
})
