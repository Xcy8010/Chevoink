import { describe, expect, it } from 'vitest'
import { assertFreshGoalOptions } from '../../api/lib/agent/fresh-goal-source.js'
import type { StartAgentLoopRunRequest } from '../../shared/contracts/index.js'

const options = { mode: 'build' as const, chapterId: 'chapter-a', qualityMode: 'balanced' as const, creativeFreedom: 'balanced' as const,
  pinnedSkillIds: ['skill-a'], selection: { text: '原文', start: 0, end: 2 }, modelTier: 'speed' as const }
const input: StartAgentLoopRunRequest = { ...options, sessionId: 'session-a', novelId: 'novel-a', prompt: '修改选区。' }
describe('goal original options survive fresh native admission', () => {
  it('accepts exact original options and only the existing model-assignment normalization', () => {
    expect(() => assertFreshGoalOptions(input, options, true)).not.toThrow()
    expect(() => assertFreshGoalOptions({ ...input, modelTier: 'custom', customModelId: 'fixture-model' }, options)).not.toThrow()
    expect(() => assertFreshGoalOptions({ ...input, modelTier: 'custom', customModelId: 'fixture-model' }, options, true)).toThrow()
  })
  it.each(['selection', 'qualityMode', 'creativeFreedom', 'pinnedSkillIds', 'chapterId'] as const)('refuses a missing original %s', field => {
    const altered = { ...input }; delete altered[field]
    expect(() => assertFreshGoalOptions(altered, options)).toThrow()
  })
})
