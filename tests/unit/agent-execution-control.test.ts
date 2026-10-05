import { describe, expect, it } from 'vitest'
import { COMPATIBILITY_TOKEN_LIMIT, executionLimitReached, parseExecutionControl, serializeExecutionControl,
  untilCompletionControl, verifiedUserExecutionControl } from '../../api/lib/agent/execution-control.js'

describe('effective task execution control', () => {
  it.each(['system_default', 'unknown_legacy'] as const)('%s has no cumulative ceilings, including beyond previous token/turn/time caps', origin => {
    const control = untilCompletionControl(origin)
    expect(COMPATIBILITY_TOKEN_LIMIT).toBe(500)
    expect(control.limits).toEqual({ tokens: null, turns: null, activeTimeMs: null })
    expect(executionLimitReached(control, { tokens: 9007199254740993000n, turns: 100000, activeTimeMs: 100000000000n })).toBeNull()
    expect(executionLimitReached(control, {})).toBeNull()
  })
  it('honors exact opt-in consumption boundaries without converting bigint to a rounded number', () => {
    const limits = { tokens: 9007199254740993n, turns: 50, activeTimeMs: 60000n }
    const control = verifiedUserExecutionControl(limits)
    limits.tokens = 1n
    expect(executionLimitReached(control, { tokens: 9007199254740992n, turns: 49, activeTimeMs: 59999n })).toBeNull()
    expect(executionLimitReached(control, { tokens: 9007199254740993n, turns: 49, activeTimeMs: 59999n })).toBe('tokens')
    expect(executionLimitReached(control, { tokens: 0n, turns: 50, activeTimeMs: 59999n })).toBe('turns')
    expect(executionLimitReached(control, { tokens: 0n, turns: 0, activeTimeMs: 60000n })).toBe('active_time')
  })
  it('serializes exact metadata without turning a naked user marker into effective numeric authority', () => {
    const control = verifiedUserExecutionControl({ tokens: 9007199254740993n, turns: null, activeTimeMs: null })
    const metadata = parseExecutionControl(JSON.parse(JSON.stringify(serializeExecutionControl(control))))
    expect(metadata.limits.tokens).toBe('9007199254740993')
    expect(() => parseExecutionControl({ ...metadata, origin: 'unknown_legacy' })).toThrow()
    expect(() => parseExecutionControl({ ...metadata, limits: { ...metadata.limits, tokens: '09007199254740993' } })).toThrow()
  })
  it('treats applicable missing measurements as unknown instead of zero', () => {
    expect(() => executionLimitReached(verifiedUserExecutionControl({ tokens: 500n, turns: null, activeTimeMs: null }), {})).toThrow('Unknown measured tokens')
    expect(() => executionLimitReached(verifiedUserExecutionControl({ tokens: null, turns: null, activeTimeMs: 1n }), {})).toThrow('Unknown measured activeTimeMs')
    expect(() => executionLimitReached(untilCompletionControl(), { tokens: -1n })).toThrow()
    expect(() => verifiedUserExecutionControl({ tokens: 0n, turns: null, activeTimeMs: null })).toThrow()
    expect(() => verifiedUserExecutionControl({ tokens: null, turns: 1.5, activeTimeMs: null })).toThrow()
  })
})
