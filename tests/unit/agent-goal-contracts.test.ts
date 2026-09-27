import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GOAL_OBJECTIVE_MAX_CHARS,
  actOnAgentGoalSchema,
  agentGoalObjectiveSchema,
  agentGoalPresentation,
  createAgentGoalSchema,
  goalIsTerminal,
  updateAgentGoalSchema,
} from '../../shared/contracts/agent-goal.js'

const options = { mode: 'build' as const }

describe('agent goal contracts', () => {
  it('counts Unicode code points for the 12,000 character objective limit', () => {
    const atLimit = '😀'.repeat(GOAL_OBJECTIVE_MAX_CHARS)
    const overLimit = '😀'.repeat(GOAL_OBJECTIVE_MAX_CHARS + 1)

    expect(Array.from(atLimit)).toHaveLength(GOAL_OBJECTIVE_MAX_CHARS)
    expect(agentGoalObjectiveSchema.parse(atLimit)).toBe(atLimit)
    expect(() => agentGoalObjectiveSchema.parse(overLimit)).toThrow('目标不能超过12,000字。')
    expect(agentGoalObjectiveSchema.parse('  完成这一章  ')).toBe('完成这一章')
  })

  it('validates command request shape, versions, and action-only options', () => {
    const requestId = randomUUID()
    const create = createAgentGoalSchema.parse({ requestId, objective: '完成目标', options })
    expect(create).toMatchObject({ requestId, objective: '完成目标', options })
    expect(updateAgentGoalSchema.parse({ requestId, expectedStateVersion: 1, expectedRevision: 1, objective: '修订目标' }))
      .toMatchObject({ expectedStateVersion: 1, expectedRevision: 1 })
    expect(actOnAgentGoalSchema.parse({ requestId, expectedStateVersion: 1, action: 'pause' })).toMatchObject({ action: 'pause' })
    expect(actOnAgentGoalSchema.parse({ requestId, expectedStateVersion: 1, action: 'resume', budgetChange: { tokenLimit: 20 }, model: { modelTier: 'speed' } }))
      .toMatchObject({ action: 'resume', budgetChange: { tokenLimit: 20 } })

    expect(() => createAgentGoalSchema.parse({ requestId, objective: '目标', options, extra: true })).toThrow()
    expect(() => updateAgentGoalSchema.parse({ requestId, expectedStateVersion: 0, expectedRevision: 1, objective: '目标' })).toThrow()
    expect(() => actOnAgentGoalSchema.parse({ requestId, expectedStateVersion: 1, action: 'pause', budgetChange: { tokenLimit: 20 } })).toThrow()
    expect(() => actOnAgentGoalSchema.parse({ requestId, expectedStateVersion: 1, action: 'cancel', model: { modelTier: 'speed' } })).toThrow()
    expect(() => actOnAgentGoalSchema.parse({ requestId: 'not-a-uuid', expectedStateVersion: 1, action: 'pause' })).toThrow()
  })

  it('maps status and phase to the user-visible presentation state', () => {
    expect(agentGoalPresentation({ status: 'active', phase: 'idle' })).toEqual({
      label: '进行中的目标', running: false, canResume: false, canPause: true, visible: true,
    })
    expect(agentGoalPresentation({ status: 'active', phase: 'awaiting_input' }).label).toBe('等待你的回复')
    expect(agentGoalPresentation({ status: 'active', phase: 'awaiting_approval' }).label).toBe('等待确认')
    expect(agentGoalPresentation({ status: 'active', phase: 'awaiting_provider' }).label).toBe('等待服务恢复')
    expect(agentGoalPresentation({ status: 'active', phase: 'reconciling' }).label).toBe('正在核对执行结果')
    expect(agentGoalPresentation({ status: 'active', phase: 'executing' }).running).toBe(true)
    expect(agentGoalPresentation({ status: 'active', phase: 'reviewing' }).running).toBe(true)

    for (const status of ['paused', 'blocked', 'usage_limited', 'budget_limited'] as const) {
      expect(agentGoalPresentation({ status, phase: 'idle' })).toMatchObject({ canResume: true, canPause: false, visible: true })
    }
    expect(agentGoalPresentation({ status: 'updating', phase: 'reconciling' })).toMatchObject({ canResume: false, canPause: true, visible: true })
    expect(agentGoalPresentation({ status: 'completed', phase: 'reviewing' })).toMatchObject({ label: '目标已完成', visible: true })
    expect(agentGoalPresentation({ status: 'cancelled', phase: 'idle' })).toMatchObject({ label: '目标已取消', visible: false })
    expect(goalIsTerminal('completed')).toBe(true)
    expect(goalIsTerminal('cancelled')).toBe(true)
    expect(goalIsTerminal('paused')).toBe(false)
  })
})
