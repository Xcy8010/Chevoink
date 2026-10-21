import { describe, expect, it } from 'vitest'
import { inspectTerminalReview, resolveTerminalCandidate, terminalCandidateInputSchema, terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import type { TerminalCarriedFact, TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const hash = (value: string) => value.repeat(64)
const proof = (value: string, field = 'openLoops', claim = '过滤泵检修等零件'): TerminalCarriedFact => ({
  proofHash: hash(value), field, claim, segmentId: 't0', depth: 1,
  nodes: [{ compilationId: 'prior-compilation', chapterId: 'prior', revision: 1, orderIndex: 1,
    bodyHash: hash('a'), candidateHash: hash('b'), validationHash: hash('c'), stateHash: hash('d'),
    path: `exitState.${field}.0`, previousChapterId: null }],
  anchors: [{ chapterId: 'prior', revision: 1, contentHash: hash('a'), start: 0, end: 7, quote: '过滤泵仍待检修' }],
})
const first = proof('a'), second = proof('b', 'objects', '钥匙归船长'), unselected = proof('c', 'knowledge', '林舟知道暗号')
const input = (inheritedProofs?: string[]) => terminalCandidateInputSchema.parse({ exitState: {}, ...(inheritedProofs ? { inheritedProofs } : {}) })

describe('explicit inherited terminal proof selection', () => {
  it('canonicalizes only selected exact fields and claims without mutating either input', () => {
    const selected = input([second.proofHash, first.proofHash]), catalog = [first, second, unselected]
    const before = structuredClone({ selected, catalog })
    const result = resolveTerminalCandidate(selected, catalog, 2)
    expect(result).toEqual({ ok: true, candidate: terminalCandidateSchema.parse({ exitState: {
      openLoops: [first.claim], objects: [second.claim],
    } }) })
    expect({ selected, catalog }).toEqual(before)
    if (result.ok) expect(result.candidate).not.toHaveProperty('inheritedProofs')
    expect(terminalCandidateSchema.safeParse(selected).success).toBe(false)
  })

  it.each([undefined, []])('does not merge the catalog without an explicit selection: %s', selected => {
    expect(resolveTerminalCandidate(input(selected), [first, second], 2)).toEqual({ ok: true, candidate: terminalCandidateSchema.parse({ exitState: {} }) })
  })

  it('keeps selection order and transient tN renumbering out of canonical facts', () => {
    const another = proof('d', 'openLoops', '南门守卫仍待替班')
    const normal = resolveTerminalCandidate(input([first.proofHash, another.proofHash]), [first, another], 2)
    const reordered = resolveTerminalCandidate(input([another.proofHash, first.proofHash]),
      [{ ...another, segmentId: 't0' }, { ...first, segmentId: 't9' }], 2)
    expect(reordered).toEqual(normal)
  })

  it('deduplicates only an exact fact and preserves typed conflicting and differently filed claims', () => {
    const selected = terminalCandidateInputSchema.parse({ exitState: {
      openLoops: [first.claim, '过滤泵已完成检修'], objects: [first.claim],
    }, inheritedProofs: [first.proofHash] })
    const result = resolveTerminalCandidate(selected, [first], 2)
    expect(result).toEqual({ ok: true, candidate: terminalCandidateSchema.parse({ exitState: selected.exitState }) })
  })

  it.each(['unknown', 'duplicate', 'ambiguous', 'old-protocol', 'missing-protocol', 'depth', 'field'] as const)(
    'rejects %s selection without rewriting the candidate', scenario => {
      const selected = input(scenario === 'unknown' ? [hash('e')] : scenario === 'duplicate' ? [first.proofHash, first.proofHash] : [first.proofHash])
      const catalog = scenario === 'ambiguous' ? [first, first]
        : [{ ...first, ...(scenario === 'depth' ? { depth: 16 } : {}), ...(scenario === 'field' ? { field: 'location' } : {}) }]
      const before = structuredClone({ selected, catalog })
      const result = resolveTerminalCandidate(selected, catalog, scenario === 'old-protocol' ? 1 : scenario === 'missing-protocol' ? undefined : 2)
      expect(result).toMatchObject({ ok: false, reason: expect.any(String) })
      expect({ selected, catalog }).toEqual(before)
    })

  it('rejects malformed hashes at the tool schema and excess canonical field capacity without truncation', () => {
    expect(terminalCandidateInputSchema.safeParse({ exitState: {}, inheritedProofs: ['t0'] }).success).toBe(false)
    const selected = terminalCandidateInputSchema.parse({ exitState: { openLoops: Array.from({ length: 30 }, (_, index) => `待办${index}`) }, inheritedProofs: [first.proofHash] })
    expect(resolveTerminalCandidate(selected, [first], 2)).toMatchObject({ ok: false })
    expect(selected.exitState.openLoops).toHaveLength(30)
  })

  it('does not turn selected identity into an unchanged-state semantic attestation', () => {
    const result = resolveTerminalCandidate(input([first.proofHash]), [first], 2)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const content = '林舟取走清单。'
    const context: TerminalEvidenceContext = { protocol: 2,
      current: { id: 'current', revision: 1, orderIndex: 2, contentHash: runtimeJson({ content }).hash },
      previous: { id: 'prior', revision: 1, orderIndex: 1, contentHash: hash('a'), start: 0, end: 7,
        joinedStart: 0, joinedEnd: 7, segments: [], carried: [first] } }
    const verdict = { path: 'exitState.openLoops.0', verdict: 'supported', basis: 'inherited',
      sourceEvidence: [{ segmentId: 't0', quote: '过滤泵仍待检修' }] }
    expect(inspectTerminalReview(result.candidate, content, JSON.stringify({ findings: [], terminalVerdicts: [verdict] }), true, context)).toBeNull()
    expect(inspectTerminalReview(result.candidate, content, JSON.stringify({ findings: [], terminalVerdicts: [{ ...verdict, verdict: 'unknown' }] }), true, context)?.supported).toBe(false)
    expect(inspectTerminalReview(result.candidate, content, JSON.stringify({ findings: [], terminalVerdicts: [{ ...verdict,
      inheritance: { priorEndState: 'established', currentState: 'unchanged' } }] }), true, context)?.supported).toBe(true)
  })
})
