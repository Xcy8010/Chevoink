import { describe, expect, it } from 'vitest'
import { findToolRestriction, isLocalToolFailure, toolRestrictionTarget } from '../../api/lib/agent/tool-local-failure.js'
import { readRunOutcome } from '../../api/lib/agent/run-outcome.js'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

describe('local tool restrictions and truthful delivery outcome', () => {
  it('never classifies unknown effects or revoked authority as a local recoverable failure', () => {
    for (const code of ['AI_PROVIDER_TIMEOUT', 'RUNTIME_RECEIPT_INVALID', 'RUNTIME_PARENT_LEASE_LOST', 'RUNTIME_SCOPE_MISMATCH', 'AI_USAGE_UNKNOWN', undefined]) expect(isLocalToolFailure(code)).toBe(false)
    expect(isLocalToolFailure('CONTINUITY_CHECK_LIMIT')).toBe(true)
    expect(isLocalToolFailure('QUALITY_REPORT_INCOMPLETE')).toBe(true)
  })
  it('keeps a restriction on its exact action and normalized target', () => {
    const restriction = { action: 'continuity_validate', target: 'chapter', code: 'CONTINUITY_CHECK_LIMIT', reason: '次数已用完' }
    expect(findToolRestriction([restriction], restriction.action, { chapterId: ' chapter ' })).toBe(restriction)
    expect(findToolRestriction([restriction], restriction.action, { chapterId: 'other' })).toBeUndefined()
    expect(findToolRestriction([restriction], 'chapter_read', { chapterId: 'chapter' })).toBeUndefined()
    expect(toolRestrictionTarget({}, ' chapter ')).toBe('chapter')
  })
  it('restores the limitation through SSE, polling and history without carrying it to a new run', () => {
    const store = useAgentStore.getState
    const outcome = { kind: 'delivered_with_limitations' as const, summary: '正文已交付，尚待复核。' }
    store().resetRun()
    store().resumeRun('limited', 'session')
    store().applyEvent({ runId: 'limited', ts: new Date().toISOString(), seq: 1, type: 'run.finished', status: 'succeeded', outcome,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })
    expect(store()).toMatchObject({ phase: 'succeeded', outcome })
    store().resumeRun('limited', 'session')
    store().syncRemoteRunStatuses({ session: { runId: 'limited', runGoalId: null, status: 'completed', finishedAt: new Date().toISOString(), outcome } })
    expect(store()).toMatchObject({ phase: 'succeeded', outcome })
    store().resetRun()
    store().setRunOutcome(readRunOutcome({ outcome }).outcome ?? null)
    expect(store().outcome).toEqual(outcome)
    store().resumeRun('new', 'session')
    expect(store().outcome).toBeNull()
    store().resetRun()
  })
  it('does not invent delivery outcomes for old or malformed records', () => {
    for (const usage of [null, {}, { outcome: { kind: 'passed', summary: '通过' } }, { outcome: { kind: 'delivered_with_limitations', summary: '' } }]) expect(readRunOutcome(usage)).toEqual({})
  })
})
