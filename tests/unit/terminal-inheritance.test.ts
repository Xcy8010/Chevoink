import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { terminalEvidenceContext, continuitySemanticRule, hasTerminalEvidenceProtocol } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, inspectTerminalReview, currentTerminalReview, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityReassessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'

const chapter = { id: 'current', title: '当前章', revision: 3, orderIndex: 4, content: '她拆开封条，拿走清单。' }
const predecessor = { id: 'previous', title: '前章', revision: 6, orderIndex: 3, content: '过滤泵仍需检修，必须等零件送到。' }
const candidate = terminalCandidateSchema.parse({ exitState: { openLoops: ['过滤泵检修等零件'] } })
const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable', reason: '已核对，没有相关方向或到达主张。', findingIndexes: [] }))
const inherited = { path: 'exitState.openLoops.0', verdict: 'supported', basis: 'inherited',
  sourceEvidence: [{ segmentId: 'p0', quote: '过滤泵仍需检修，必须等零件送到' }], inheritance: { priorEndState: 'established', currentState: 'unchanged' } }
const raw = (verdict: unknown = inherited, semanticChecks: unknown = checks) => JSON.stringify({ findings: [], terminalVerdicts: [verdict], semanticChecks })
async function context(rows = [predecessor], current = chapter) {
  const db = { chapter: { findFirst: async () => null, findMany: async () => rows } } as unknown as Prisma.TransactionClient
  const source = await readCompilerContinuitySource(db, { userId: 'u', novelId: 'n' }, current, null, 10)
  return { source, proof: terminalEvidenceContext(current, source) }
}

describe('fresh, bounded terminal inheritance', () => {
  it('uses actual predecessor prose even when the old bridge omitted the unresolved fact', async () => {
    const { proof } = await context()
    const result = inspectTerminalReview(candidate, chapter.content, raw(), true, proof)
    expect(result).toMatchObject({ version: 2, supported: true, verdicts: [{ basis: 'inherited', inheritance: { currentState: 'unchanged' } }] })
    expect(terminalReviewInput(candidate, proof)).toContain('旧桥遗漏')
    expect(terminalReviewInput(candidate, proof)).toContain('不要求本章重述')
  })
  it.each(['changed', 'uncertain'])('keeps unresolved evidence when current reconciliation is %s', async currentState => {
    const { proof } = await context()
    expect(inspectTerminalReview(candidate, chapter.content, raw({ ...inherited, inheritance: { priorEndState: 'established', currentState } }), true, proof)).toBeNull()
    expect(inspectTerminalReview(candidate, chapter.content, raw({ ...inherited, verdict: 'unknown', inheritance: { priorEndState: 'established', currentState } }), true, proof)?.supported).toBe(false)
  })
  it.each(['exitState.location', 'exitState.action', 'exitState.storyTime', 'lastUnfinishedAction'])('does not inherit transient %s from silence', async path => {
    const { proof } = await context()
    const transient = terminalCandidateSchema.parse(path === 'lastUnfinishedAction' ? { exitState: {}, lastUnfinishedAction: '在库门外等候' } : { exitState: { [path.split('.')[1]]: '在库门外等候' } })
    expect(inspectTerminalReview(transient, chapter.content, raw({ ...inherited, path }), true, proof)).toBeNull()
  })
  it('rejects earlier-only and cross-chapter spans without relocating evidence', async () => {
    const earlier = { ...predecessor, id: 'older', orderIndex: 2, content: predecessor.content.padEnd(300, '。') }
    const { proof } = await context([earlier, { ...predecessor, content: '她锁好了窗。'.padEnd(300, '。') }])
    expect(proof.previous?.id).toBe('previous')
    expect(proof.previous?.segments.every(part => part.segmentId !== 'p0')).toBe(true)
    expect(inspectTerminalReview(candidate, chapter.content, raw(), true, proof)).toBeNull()
    const cross = await context([{ ...earlier, content: '短前文' }, predecessor])
    expect(cross.proof.previous?.segments).toEqual([])
    expect(inspectTerminalReview(candidate, chapter.content, raw(), true, cross.proof)).toBeNull()
  })
  it.each(['current source', 'invented quotation', 'invented address', 'absent attestation'])('rejects %s for inherited support', async kind => {
    const { proof } = await context()
    const verdict = structuredClone(inherited)
    if (kind === 'current source') verdict.sourceEvidence[0].segmentId = 'c0'
    if (kind === 'invented quotation') verdict.sourceEvidence[0].quote = '过滤泵已经修好'
    if (kind === 'invented address') verdict.sourceEvidence[0].segmentId = 'p999'
    if (kind === 'absent attestation') delete (verdict as Partial<typeof verdict>).inheritance
    expect(inspectTerminalReview(candidate, chapter.content, raw(verdict), true, proof)).toBeNull()
  })
  it('requires current proof for a changed fact, preserving independent negative and plan judgments', async () => {
    const current = { ...chapter, content: '零件送到，过滤泵已经修好。她准备去码头，还没离开。' }
    const { proof } = await context([predecessor], current)
    const changed = terminalCandidateSchema.parse({ exitState: { objects: ['过滤泵已修好'], location: '码头' } })
    const verdicts = [{ path: 'exitState.objects.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '过滤泵已经修好' }] },
      { path: 'exitState.location', verdict: 'planned', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '准备去码头，还没离开' }] }]
    expect(inspectTerminalReview(changed, current.content, JSON.stringify({ findings: [], terminalVerdicts: verdicts }), true, proof)?.supported).toBe(false)
    expect(inspectTerminalReview(changed, current.content, JSON.stringify({ findings: [], terminalVerdicts: verdicts }), true)).toBeNull()
  })
  it('binds saved proof to current identity and exact predecessor identity, hash, range and adjacency', async () => {
    const { proof, source } = await context()
    const bodies = { previous: source!.content, current: chapter.content, terminalEvidence: proof }
    const inspected = inspectContinuityResponse(raw(), bodies, true, 8, candidate)
    expect(inspected.complete).toBe(true)
    const validation = { independentCheck: 'complete', terminalCandidate: candidate, continuityCriticResponse: inspected.audit }
    expect(currentTerminalReview(validation, chapter.content, proof)?.supported).toBe(true)
    expect(currentTerminalReview(validation, chapter.content)).toBeNull()
    for (const mutated of [await context([{ ...predecessor, id: 'same-prose-new-id' }]), await context([{ ...predecessor, revision: 7 }]),
      await context([{ ...predecessor, content: predecessor.content + '零件仍未到。' }]), await context([predecessor, { ...predecessor, id: 'inserted', orderIndex: 3.5 }]),
      await context([], { ...chapter, id: 'other-current' })]) {
      expect(currentTerminalReview(validation, chapter.content, mutated.proof)).toBeNull()
      const base = { chapter, bridge: {}, sceneTasks: [], source, terminalCandidate: candidate }
      expect(compilerContinuityCoverageMatches(compilerContinuityCoverage(base, 10), compilerContinuityCoverage({ ...base, source: mutated.source }, 10))).toBe(false)
    }
  })
  it('never upgrades an old parser or admission, and keeps new context through full reassessment', async () => {
    const { proof, source } = await context()
    const bodies = { previous: source!.content, current: chapter.content, terminalEvidence: proof }
    expect(hasTerminalEvidenceProtocol({ scope: { continuityEvidenceProtocol: 1 } })).toBe(false)
    expect(hasTerminalEvidenceProtocol({ scope: { terminalEvidenceProtocol: 1 } })).toBe(true)
    expect(inspectContinuityResponse(raw(), bodies, true, 7, candidate).complete).toBe(false)
    const first = inspectContinuityResponse('{"findings":[]}', bodies, true, 8, candidate)
    const response = JSON.stringify({ decisions: [], ...JSON.parse(raw()) })
    const final = applyContinuityReassessment(first, response, bodies)
    expect(final).toMatchObject({ complete: true, audit: { parserVersion: 8, terminalEvidence: proof } })
    expect(currentTerminalReview({ independentCheck: 'complete', terminalCandidate: candidate, continuityCriticResponse: final.audit }, chapter.content, proof)?.supported).toBe(true)
  })
  it.each(['opposite direction', 'toward versus arrival', 'different objects', 'explicit reversal', 'actual arrival'])(
    'requires explicit independent semantic judgment for %s without noun-specific rules', async scenario => {
      const texts: Record<string, string> = { 'opposite direction': '“向左转阀杆。”他把同一根阀杆向右转。', 'toward versus arrival': '车站在五百米外，她朝车站走去。',
        'different objects': '她向左转开水阀，再向右转紧气阀。', 'explicit reversal': '他收回向左转的命令：“改向右。”她照做。', 'actual arrival': '她走完五百米，抵达车站。' }
      const current = { ...chapter, content: texts[scenario] }, { proof } = await context([], current)
      const bodies = { previous: null, current: current.content, terminalEvidence: proof }
      const conflicting = scenario === 'opposite direction'
      const judgment = checks.map(item => ({ ...item, result: conflicting ? 'conflict' : 'clear', reason: '独立合成判定：' + scenario, findingIndexes: conflicting ? [0] : [] }))
      // The parser does not pretend substring matching can perform the critic's
      // semantic work. A declared conflict cannot be laundered as findings=[].
      expect(inspectContinuityResponse(JSON.stringify({ findings: [], semanticChecks: judgment }), bodies, true, 8).complete).toBe(!conflicting)
      if (conflicting) {
        const finding = { signal: 'object', severity: 'error', evidence: '当前正文“向左转阀杆”与当前正文“把同一根阀杆向右转”对同次操作方向相反。',
          suggestion: '核对同次操作方向或明确改令。', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: '向左转阀杆' },
            { source: 'current', segmentId: 'c0', quote: '把同一根阀杆向右转' }] }
        expect(inspectContinuityResponse(JSON.stringify({ findings: [finding], semanticChecks: judgment }), bodies, true, 8).complete).toBe(true)
      }
      expect(inspectContinuityResponse('{"findings":[]}', bodies, true, 8).complete).toBe(false)
      expect(continuitySemanticRule).toContain('同一物体')
      expect(continuitySemanticRule).toContain('明确撤回')
      expect(continuitySemanticRule).toContain('不证明已完成或已到达')
    })
})
