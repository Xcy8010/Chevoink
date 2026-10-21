import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { renderQualityReportFindings } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import type { getQualityReport } from '../../api/lib/agent/humanity-quality.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const quote = 'He did not give the warning.'
function report() {
  return { id: 'report', chapterId: 'chapter', chapterRevision: 4, status: 'needs_repair', repairRound: 0,
    chapter: { revision: 4, content: quote + ' She left.' },
    deterministicMetrics: { independentCheck: 'complete', contentHash: sha(quote + ' She left.') },
    findings: [{ id: 'finding', signal: 'explanation_echo', severity: 'warning', disposition: 'pending', authorFeedback: null,
      startOffset: 0, endOffset: quote.length, evidenceHash: sha(quote), evidenceExcerpt: quote,
      explanation: 'He repeated the warning.', suggestion: 'Remove the warning.' }] } as unknown as Awaited<ReturnType<typeof getQualityReport>>
}
const payload = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1))
describe('model-facing immutable quality judgments', () => {
  it('exposes an incorrect explanation alongside its precise valid quote without changing either', () => {
    const source = report(), before = structuredClone(source)
    const output = payload(renderQualityReportFindings(source))
    expect(output.findings[0]).toMatchObject({ source: 'quality', reportId: 'report', findingId: 'finding', start: 0,
      end: quote.length, evidence: quote, evidenceHash: sha(quote), explanation: 'He repeated the warning.', currentEvidence: true,
      sourceRevision: 4, before: '', after: ' She left.', disposition: 'pending' })
    expect(source).toEqual(before)
  })
  it('labels repaired source offsets honestly and does not borrow current surroundings for old evidence', () => {
    const source = report()
    source.chapterRevision = 5; source.chapter.revision = 5; source.status = 'repaired'
    source.deterministicMetrics = { ...source.deterministicMetrics as object, sourceRevision: 4 }
    const finding = payload(renderQualityReportFindings(source)).findings[0]
    expect(finding).toMatchObject({ sourceRevision: 4, evidence: quote, currentEvidence: false })
    expect(finding).not.toHaveProperty('before')
    expect(finding).not.toHaveProperty('after')
  })
})
