import { describe, expect, it } from 'vitest'
import { parseQualityRepairResponse, partitionQualityRepairResponse } from '../../api/lib/agent/quality-repair-response.js'

describe('explicit bounded quality retain proposals', () => {
  it.each(['findingId', 'key'] as const)('keeps mixed patch and retain identities with %s', identity => {
    const response = parseQualityRepairResponse({ patches: [{ [identity]: 'a', replacement: '' }],
      retainedFindings: [{ [identity]: 'b', reason: 'The original negation already supports the fact.' }] }, identity)
    expect(partitionQualityRepairResponse(response, ['a', 'b'])).toEqual({ patches: [{ id: 'a', replacement: '' }],
      retainedFindings: [{ id: 'b', reason: 'The original negation already supports the fact.' }],
      counts: { returned: 2, missing: 0, unknown: 0, duplicate: 0 } })
  })
  it.each(['findingId', 'key'] as const)('accepts all-retain without synthesizing a replacement for %s', identity => {
    const parsed = parseQualityRepairResponse({ patches: [], retainedFindings: [{ [identity]: 'a', reason: 'Keep the supported fact.' }] }, identity)
    expect(parsed.patches).toEqual([])
    expect(partitionQualityRepairResponse(parsed, ['a']).retainedFindings).toHaveLength(1)
  })
  it('does not accept duplicate, conflicting or foreign entries as decisions', () => {
    const parsed = parseQualityRepairResponse({ patches: [{ findingId: 'a', replacement: 'changed' }, { findingId: 'c', replacement: 'one' }, { findingId: 'c', replacement: 'two' }],
      retainedFindings: [{ findingId: 'a', reason: 'conflict' }, { findingId: 'foreign', reason: 'foreign' }] })
    expect(partitionQualityRepairResponse(parsed, ['a', 'b', 'c'])).toEqual({ patches: [], retainedFindings: [],
      counts: { returned: 5, missing: 1, unknown: 1, duplicate: 4 } })
  })
  it.each([
    { patches: [], retainedFindings: [{ findingId: 'a', reason: '   ' }] },
    { patches: [], retainedFindings: [{ findingId: 'a', reason: 'x'.repeat(2_001) }] },
    { patches: [], retainedFindings: [{ findingId: 'a' }] },
    { patches: [], retainedFindings: [] },
    { patches: [{ findingId: 'a', replacement: 'text', reason: 'ambiguous' }] },
  ])('rejects an invalid or ambiguous response %#', response => {
    expect(() => parseQualityRepairResponse(response)).toThrow()
  })
})
