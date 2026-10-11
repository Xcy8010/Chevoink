import { describe, expect, it } from 'vitest'
import { freezeCreationPreregistration, makeBlindCreationPair, summarizeCreationCohort,
  type CreationObservation, type CreationPreregistration } from '../agent-evals/reliable-creation-metrics.js'

const row: CreationObservation = { taskKey: 'task', cohort: 'candidate', state: 'fulfilled', observationAgeMs: 100,
  firstMeaningfulResponseMs: 10, savedMs: 80, fulfilledMs: 90, attempts: [{ tokens: 100, cashMilli: 10 }] }
const registration: CreationPreregistration = { candidateSha: 'a'.repeat(40), baselineSha: 'b'.repeat(40),
  promptSchemaFingerprint: 'prompt-schema', rubricVersion: 'creation-3.5', holdoutId: 'untouched-holdout',
  primaryDimension: 'overall_preference', minimumMeaningfulDifference: 0.2, nonInferiorityMargin: 0.1,
  confidenceLevel: 0.95, clustering: 'author_and_work', observationAgeMs: 100,
  enrollmentIncludesFailures: true, dualIndependentReviewerSubset: 0.5 }

describe('3.5 complete creation evidence', () => {
  it('includes failed and unfinished attempts in denominator/cost without inventing usage', () => {
    const summary = summarizeCreationCohort([row,
      { ...row, taskKey: 'failed', state: 'failed', fulfilledMs: null, savedMs: null,
        attempts: [{ tokens: 200, cashMilli: 20 }, { tokens: null, cashMilli: null }] },
      { ...row, taskKey: 'unfinished', state: 'unfinished', fulfilledMs: null, savedMs: null, firstMeaningfulResponseMs: null },
      { ...row, taskKey: 'limited', state: 'limited', fulfilledMs: null },
    ])[1]
    expect(summary).toMatchObject({ enrolled: 4, fulfilled: 1, failed: 1, unfinished: 1, limited: 1,
      fullCompletionRate: 0.25, attempts: 5, knownTokens: 500, knownCashMilli: 50,
      unknownTokenAttempts: 1, unknownCostAttempts: 1, totalTokens: null, totalCashMilli: null,
      cashPerEnrolledTask: null, fulfilledLatency: { observed: 1, missingOrCensored: 3, observedP95Ms: 90, allTasksP95Ms: null } })
    expect(summarizeCreationCohort([])[0].fullCompletionRate).toBeNull()
  })
  it('rejects duplicate logical tasks, unknown-as-zero and false completed timing', () => {
    expect(() => summarizeCreationCohort([row, row])).toThrow('Duplicate')
    expect(() => summarizeCreationCohort([{ ...row, fulfilledMs: null }])).toThrow('lacks')
    expect(() => summarizeCreationCohort([{ ...row, state: 'failed' }])).toThrow('Incomplete')
    expect(() => summarizeCreationCohort([{ ...row, attempts: [{ tokens: -1, cashMilli: 0 }] }])).toThrow('Invalid')
    expect(() => summarizeCreationCohort([{ ...row, savedMs: 101 }])).toThrow('age')
  })
  it('binds holdout, exact SHA, rubric and effects before evaluation', () => {
    const frozen = freezeCreationPreregistration(registration)
    expect(frozen).toHaveLength(64)
    expect(freezeCreationPreregistration({ ...registration })).toBe(frozen)
    expect(freezeCreationPreregistration({ ...registration, holdoutId: 'fresh-holdout' })).not.toBe(frozen)
    expect(freezeCreationPreregistration({ ...registration, nonInferiorityMargin: 0.2 })).not.toBe(frozen)
    expect(() => freezeCreationPreregistration({ ...registration, dualIndependentReviewerSubset: 0 })).toThrow()
  })
  it('decomposes waits over the whole enrolled queue without treating missing failures as zero or adding overlapping stages to latency', () => {
    const summary = summarizeCreationCohort([
      { ...row, stageWaitMs: { context: 10, model: 60, checks: 30 } },
      { ...row, taskKey: 'failed', state: 'failed', fulfilledMs: null, stageWaitMs: { context: 20, model: 40, checks: null } },
      { ...row, taskKey: 'unfinished', state: 'unfinished', fulfilledMs: null },
    ])[1]
    expect(summary.stageWaits.context).toEqual({ observedTasks: 2, missingOrUnknownTasks: 1, knownMs: 30, totalMs: null, observedP95Ms: 20 })
    expect(summary.stageWaits.checks).toMatchObject({ observedTasks: 1, missingOrUnknownTasks: 2, totalMs: null })
    expect(summary.fulfilledLatency.allTasksP95Ms).toBeNull()
    expect(() => summarizeCreationCohort([{ ...row, stageWaitMs: { model: -1 } }])).toThrow('Invalid')
  })
  it('blind pair exposes full manuscripts/diffs/retention reasons without origin labels', () => {
    const pair = { taskKey: 'synthetic', authorCluster: 'author', workCluster: 'work', originalRequest: '保留人物意图', priorContext: '前章',
      baseline: { fullManuscript: '原完整稿', revisionDiff: '-旧句\n+原句', retainedReasons: [] },
      candidate: { fullManuscript: '新完整稿', revisionDiff: '-旧句\n+新句', retainedReasons: ['保留对白语气'] } }
    const blind = makeBlindCreationPair(pair, true)
    expect(blind.left.fullManuscript).toBe('新完整稿')
    expect(blind.right.revisionDiff).toBe('-旧句\n+原句')
    expect(blind.left.retainedReasons).toEqual(['保留对白语气'])
    expect(JSON.stringify(blind)).not.toMatch(/baseline|candidate|authorCluster|workCluster/)
    expect(() => makeBlindCreationPair({ ...pair, candidate: { ...pair.candidate, fullManuscript: '' } }, false)).toThrow('Incomplete')
  })
})
