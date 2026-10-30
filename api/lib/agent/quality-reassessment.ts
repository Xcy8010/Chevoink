import type { qualityReviewCycleContext } from './review-cycle.js'

type PriorCycle = NonNullable<ReturnType<typeof qualityReviewCycleContext>>
type Span = { start: number; end: number }

/** Project verified successful edits into current coordinates. An edited anchor
 * is unknown, never resolved; deletion points retain their surrounding context. */
export function qualityReassessmentContext(prior: PriorCycle, content: string) {
  let changed: Span[] = []
  let anchors = prior.baseline.findings.map(finding => finding.anchor && { ...finding.anchor })
  for (const step of prior.transitions) {
    const ranges = [...step.ranges].sort((a, b) => a.start - b.start)
    const map = (point: number, edge: 'start' | 'end') => {
      let delta = 0
      for (const range of ranges) {
        if (point < range.start) break
        if (point > range.end || point === range.end && range.start !== range.end) {
          delta += range.newLength - (range.end - range.start)
          continue
        }
        return range.start + delta + (edge === 'end' ? range.newLength : 0)
      }
      return point + delta
    }
    changed = changed.map(span => ({ start: map(span.start, 'start'), end: map(span.end, 'end') }))
    anchors = anchors.map(anchor => {
      if (!anchor || ranges.some(range => range.start < anchor.end && range.end > anchor.start
        || range.start === range.end && range.start > anchor.start && range.start < anchor.end)) return null
      const delta = ranges.filter(range => range.end <= anchor.start).reduce((sum, range) => sum + range.newLength - (range.end - range.start), 0)
      return { ...anchor, start: anchor.start + delta, end: anchor.end + delta }
    })
    let delta = 0
    for (const range of ranges) {
      changed.push({ start: range.start + delta, end: range.start + delta + range.newLength })
      delta += range.newLength - (range.end - range.start)
    }
  }
  const merged: Span[] = []
  for (const span of changed.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end)
    else merged.push({ ...span })
  }
  return {
    baselineRevision: prior.baseline.body.revision, currentRevision: prior.current.revision,
    changedRegions: merged.map(span => ({ ...span, text: content.slice(span.start, span.end),
      before: content.slice(Math.max(0, span.start - 200), span.start), after: content.slice(span.end, span.end + 200) })),
    baselineLocations: prior.baseline.findings.map((finding, index) => {
      const anchor = anchors[index]
      const currentAnchor = anchor && content.slice(anchor.start, anchor.end) === anchor.text ? anchor : null
      return { source: finding.source, reportId: finding.reportId, findingId: finding.findingId,
        location: currentAnchor ? 'unchanged' : 'edited_or_unlocated', currentAnchor }
    }),
  }
}
