import { describe, expect, it } from 'vitest'
import { admissionModelOverride } from '../../api/lib/agent/model-assignment-admission.js'
import { startAgentLoopRunSchema } from '../../shared/contracts/schemas.js'
const preferences = { version: 1 as const, globalRevision: 1, novelRevision: 0,
  assignments: { main: { modelTier: 'standard' as const }, chapter_writing: { modelTier: 'ultimate' as const } } }
describe('model admission precedence and compatibility', () => {
  it('preserves old defaults and composer input when no assignment is configured', () => {
    expect(admissionModelOverride({}, undefined, false)).toBeUndefined()
    expect(admissionModelOverride({ modelTier: 'speed' }, undefined, true)).toBeUndefined()
  })
  it('uses chapter assignment only for the verified original writing purpose', () => {
    expect(admissionModelOverride({ modelTier: 'speed' }, preferences, true)?.modelTier).toBe('ultimate')
    expect(admissionModelOverride({ modelTier: 'speed' }, preferences, false)?.modelTier).toBe('standard')
  })
  it('honors actual explicit input including custom identity and effort', () => {
    expect(admissionModelOverride({ modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'high', modelSelectionExplicit: true }, preferences, true))
      .toEqual({ modelTier: 'custom', customModelId: 'owned', reasoningEffort: 'high' })
  })
  it('does not manufacture an absent explicit-selection field into old request hashes', () => {
    const request = startAgentLoopRunSchema.parse({ novelId: 'novel', sessionId: 'session', prompt: '写下一章', mode: 'build' })
    expect(Object.hasOwn(request, 'modelSelectionExplicit')).toBe(false)
  })
})
