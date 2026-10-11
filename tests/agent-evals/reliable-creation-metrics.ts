import { createHash } from 'node:crypto'

/** One enrollment per logical author task, not one row per successful retry. */
export type CreationObservation = {
  taskKey: string
  cohort: 'baseline' | 'candidate'
  state: 'fulfilled' | 'limited' | 'failed' | 'unfinished'
  observationAgeMs: number
  firstMeaningfulResponseMs: number | null
  savedMs: number | null
  fulfilledMs: number | null
  attempts: Array<{ tokens: number | null; cashMilli: number | null }>
}

function percentile(values: number[]): number | null {
  if (!values.length) return null
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
}

/** Unknown usage stays unknown. Censored observations are counted explicitly;
 * this report does not turn the observation window into an execution limit. */
export function summarizeCreationCohort(rows: CreationObservation[]) {
  const keys = new Set<string>()
  for (const row of rows) {
    const key = `${row.cohort}:${row.taskKey}`
    if (keys.has(key)) throw new Error('Duplicate logical task enrollment')
    keys.add(key)
    for (const value of [row.observationAgeMs, row.firstMeaningfulResponseMs, row.savedMs, row.fulfilledMs,
      ...row.attempts.flatMap(attempt => [attempt.tokens, attempt.cashMilli])]) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid observation')
    }
    if (row.state === 'fulfilled' && (row.savedMs === null || row.fulfilledMs === null)) throw new Error('Fulfilled task lacks actual saved/completed times')
    if (row.state !== 'fulfilled' && row.fulfilledMs !== null) throw new Error('Incomplete task cannot have fulfilled time')
    if ([row.firstMeaningfulResponseMs, row.savedMs, row.fulfilledMs].some(value => value !== null && value > row.observationAgeMs)) throw new Error('Event exceeds observation age')
  }
  return (['baseline', 'candidate'] as const).map(cohort => {
    const tasks = rows.filter(row => row.cohort === cohort)
    const attempts = tasks.flatMap(row => row.attempts)
    const knownTokens = attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0)
    const knownCashMilli = attempts.reduce((sum, attempt) => sum + (attempt.cashMilli ?? 0), 0)
    const unknownTokenAttempts = attempts.filter(attempt => attempt.tokens === null).length
    const unknownCostAttempts = attempts.filter(attempt => attempt.cashMilli === null).length
    const fulfilled = tasks.filter(row => row.state === 'fulfilled').length
    const latency = (select: (row: CreationObservation) => number | null) => {
      const observed = tasks.flatMap(row => select(row) === null ? [] : [select(row)!])
      return { observed: observed.length, missingOrCensored: tasks.length - observed.length,
        observedP95Ms: percentile(observed), allTasksP95Ms: observed.length === tasks.length ? percentile(observed) : null }
    }
    return { cohort, enrolled: tasks.length, fulfilled,
      limited: tasks.filter(row => row.state === 'limited').length,
      failed: tasks.filter(row => row.state === 'failed').length,
      unfinished: tasks.filter(row => row.state === 'unfinished').length,
      fullCompletionRate: tasks.length ? fulfilled / tasks.length : null,
      attempts: attempts.length, knownTokens, unknownTokenAttempts,
      totalTokens: unknownTokenAttempts ? null : knownTokens,
      knownCashMilli, unknownCostAttempts, totalCashMilli: unknownCostAttempts ? null : knownCashMilli,
      cashPerEnrolledTask: tasks.length && !unknownCostAttempts ? knownCashMilli / tasks.length : null,
      firstResponse: latency(row => row.firstMeaningfulResponseMs), saved: latency(row => row.savedMs),
      fulfilledLatency: latency(row => row.fulfilledMs) }
  })
}

export const CREATION_QUALITY_DIMENSIONS = ['facts_and_characters', 'author_intent', 'style', 'point_of_view',
  'pacing', 'dialogue', 'chapter_transition', 'overall_preference'] as const

export type CreationPreregistration = {
  candidateSha: string
  baselineSha: string
  promptSchemaFingerprint: string
  rubricVersion: string
  holdoutId: string
  primaryDimension: typeof CREATION_QUALITY_DIMENSIONS[number]
  minimumMeaningfulDifference: number
  nonInferiorityMargin: number
  confidenceLevel: number
  clustering: 'author_and_work'
  observationAgeMs: number
  enrollmentIncludesFailures: true
  dualIndependentReviewerSubset: number
}

/** Validate before opening a holdout. Caller persists this exact fingerprint.
 * No certificate is issued by a parser or a synthetic rating. */
export function freezeCreationPreregistration(value: CreationPreregistration): string {
  if (!/^[a-f0-9]{40}$/.test(value.candidateSha) || !/^[a-f0-9]{40}$/.test(value.baselineSha)
    || !value.promptSchemaFingerprint || !value.rubricVersion || !value.holdoutId
    || !CREATION_QUALITY_DIMENSIONS.includes(value.primaryDimension)
    || [value.minimumMeaningfulDifference, value.nonInferiorityMargin, value.confidenceLevel,
      value.observationAgeMs, value.dualIndependentReviewerSubset].some(number => !Number.isFinite(number))
    || value.minimumMeaningfulDifference <= 0 || value.nonInferiorityMargin <= 0
    || value.confidenceLevel <= 0 || value.confidenceLevel >= 1 || value.observationAgeMs <= 0
    || value.clustering !== 'author_and_work' || value.enrollmentIncludesFailures !== true
    || value.dualIndependentReviewerSubset <= 0 || value.dualIndependentReviewerSubset > 1) throw new Error('Incomplete literary preregistration')
  const canonical = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

type ManuscriptCandidate = { fullManuscript: string; revisionDiff: string; retainedReasons: string[] }
export type CreationPair = {
  taskKey: string; authorCluster: string; workCluster: string; originalRequest: string
  priorContext: string; baseline: ManuscriptCandidate; candidate: ManuscriptCandidate
}

/** The caller supplies a randomized side. Both complete manuscripts and diffs
 * are mandatory; report JSON alone is never a literary evaluation artifact. */
export function makeBlindCreationPair(pair: CreationPair, swap: boolean) {
  if (!pair.taskKey || !pair.authorCluster || !pair.workCluster || !pair.originalRequest
    || !pair.baseline.fullManuscript.trim() || !pair.candidate.fullManuscript.trim()
    || typeof pair.baseline.revisionDiff !== 'string' || typeof pair.candidate.revisionDiff !== 'string') throw new Error('Incomplete manuscript pair')
  const content = (value: ManuscriptCandidate) => ({ fullManuscript: value.fullManuscript,
    revisionDiff: value.revisionDiff, retainedReasons: [...value.retainedReasons] })
  return { taskKey: pair.taskKey, originalRequest: pair.originalRequest, priorContext: pair.priorContext,
    dimensions: CREATION_QUALITY_DIMENSIONS,
    left: content(swap ? pair.candidate : pair.baseline), right: content(swap ? pair.baseline : pair.candidate) }
}
