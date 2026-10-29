import { describe, expect, it } from 'vitest'
import { analyzeDeterministicQuality, prepareQualityFindings } from '../../api/lib/agent/humanity-quality.js'
import { buildQualityEvidenceSources, coerceCriticFindings } from '../../api/lib/agent/quality-evidence.js'
import { selectAutomaticQualityFindings } from '../../api/lib/agent/quality-report-contract.js'
import { currentReviewRepairResponse } from '../support/current-review-repair-response.js'

const originals = [
  'The officer inventories a crate. The crate is sealed.',
  'The packet remains sealed. The table remains dry.',
  'The packet remains sealed.',
  'The packet remains sealed. The packet is open. The table remains dry.',
  'He stops at the control-room doorway, before turning the wheel. The packet remains on the desk.',
  'He stops at the control-room doorway, before turning the wheel. The packet remains on the desk. The current output remains unverified.',
  '他清点口袋，随身只有390元。家里抽屉留着97元。',
  ['The packet remains sealed.', 'The table remains dry.', 'The clerk places his pen beside the ledger.',
    'Rain taps against the shutter.', 'A cart rattles past the courtyard.', 'The guard hangs his coat on a wooden peg.',
    'At noon the station bell sounds twice.', 'The operator checks the lamp before entering.', 'A folded map lies beneath the brass weight.',
    'Footsteps fade along the stone corridor.', 'The observer waits without making a promise.'].join('\n\n'),
]

describe('recovery model responses use the actually selected quality evidence', () => {
  it.each(originals)('removes only the copied final source and preserves every other selected opinion: %s', original => {
    const scope = { userId: 'fixture-owner', novelId: 'fixture-novel', chapterId: 'fixture-chapter', chapterRevision: 2 }
    const last = buildQualityEvidenceSources(scope, original).entries.filter(entry => entry.text.trim()).at(-1)!
    const duplicated = original + '\n\n' + last.text
    const sources = buildQualityEvidenceSources(scope, duplicated)
    const repeated = sources.entries.filter(entry => entry.text.trim()).at(-1)!
    const critic = coerceCriticFindings({ findings: [{ signal: 'explanation_echo', severity: 'warning', sourceId: repeated.id.slice(0, 13),
      explanation: 'This paragraph repeats the saved action without a new event.', suggestion: 'Remove this duplicate paragraph and retain the original action.', confidence: 0.99 }] }, sources)!
    const prepared = prepareQualityFindings(duplicated, analyzeDeterministicQuality(duplicated).findings, critic.findings, true, sources, 3)
    expect(prepared.complete).toBe(true)
    expect(prepared.findings.some(finding => finding.source === 'critic' && finding.explanation === critic.findings[0].explanation)).toBe(true)
    const selected = selectAutomaticQualityFindings(prepared.findings.map((finding, index) => ({ ...finding, findingId: `actual-${index}`,
      startOffset: finding.start, endOffset: finding.end })))
    const response = JSON.parse(currentReviewRepairResponse(original, duplicated, duplicated, selected))
    expect(response.patches).toHaveLength(1)
    const target = selected.find(finding => finding.findingId === response.patches[0].findingId)!
    expect(target).toMatchObject({ start: original.length + 2, end: duplicated.length, evidence: last.text })
    expect(duplicated.slice(0, target.start) + response.patches[0].replacement + duplicated.slice(target.end)).toBe(original + '\n\n')
    expect(response.retainedFindings.map((finding: { findingId: string }) => finding.findingId).sort()).toEqual(
      selected.filter(finding => finding !== target).map(finding => finding.findingId).sort())
    const final = prepareQualityFindings(original, analyzeDeterministicQuality(original).findings, [], true, buildQualityEvidenceSources(scope, original), 3)
    const finalSelected = selectAutomaticQualityFindings(final.findings.map((finding, index) => ({ ...finding, findingId: `final-${index}`,
      startOffset: finding.start, endOffset: finding.end })))
    const unchanged = JSON.parse(currentReviewRepairResponse(original, duplicated, original, finalSelected))
    expect(unchanged.patches).toEqual([])
    expect(unchanged.retainedFindings.map((finding: { findingId: string }) => finding.findingId)).toEqual(finalSelected.map(finding => finding.findingId))
  })
})
