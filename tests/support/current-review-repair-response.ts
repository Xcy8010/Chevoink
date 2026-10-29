import { expect } from 'vitest'

type RepairEvidence = { findingId: string; evidence: string; start: number; end: number }

/** Simulate the editor from the actual selected evidence, including deterministic opinions. */
export function currentReviewRepairResponse(original: string, duplicated: string, current: string, findings: RepairEvidence[]) {
  const start = original.length + 2
  const duplicate = findings.filter(finding => finding.start === start && finding.end === duplicated.length
    && finding.evidence === duplicated.slice(start))
  if (current === duplicated) expect(duplicate).toHaveLength(1)
  else {
    expect(current.trim()).toBe(original.trim())
    expect(duplicate).toEqual([])
  }
  return JSON.stringify({ patches: duplicate.map(finding => ({ findingId: finding.findingId, replacement: '' })),
    retainedFindings: findings.filter(finding => !duplicate.some(item => item.findingId === finding.findingId)).map(finding => ({ findingId: finding.findingId,
      reason: 'Retain this additional actual quality opinion for the author; this repair only removes the independently located duplicate action.' })) })
}
