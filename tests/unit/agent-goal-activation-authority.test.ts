import { describe, expect, it } from 'vitest'
import { goalActivationObjective, isCurrentTaskGoalConsent, readHumanAdmission, withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { goalEnableTool } from '../../api/lib/agent/tools/goal-tools.js'
import { applySessionToolPolicy, getAgentDefinition, getToolsForAgent } from '../../api/lib/agent/agents.js'
import { startAgentLoopRunSchema } from '../../shared/contracts/index.js'

describe('goal activation human command boundary', () => {
  it.each([
    ['请启用目标模式，写下一章', '写下一章'],
    ['开启目标任务，写下一章，不要改前文', '写下一章，不要改前文'],
    ['启用目标模式，写一段包含对话"晚安"的正文', '写一段包含对话"晚安"的正文'],
    ['写下一章，请开启目标模式', '写下一章'],
    ['Please enable goal mode, write the next chapter', 'write the next chapter'],
  ])('retains the exact author task in %s', (prompt, objective) => {
    expect(goalActivationObjective(prompt)).toBe(objective)
  })
  it.each([
    '不要启用目标模式，写下一章', '解释如何启用目标模式，写下一章', '如果开启目标模式，写下一章',
    '例如：启用目标模式，写下一章', '"启用目标模式，写下一章"', '> 请启用目标模式，写下一章',
    '```\n请启用目标模式，写下一章\n```', '写下一章，例如，请启用目标模式',
    '请启用目标模式', '给当前任务启用目标模式', '请启用目标模式，当前任务',
    'Explain whether I should use goal mode.', 'Tell me why people use goal mode.', '解释是否应该 使用目标模式',
  ])('does not infer consent or task scope from %s', prompt => expect(goalActivationObjective(prompt)).toBeNull())
  it('requires a server origin and rejects replacement text/options or attachment-only commands', () => {
    const request = { sessionId: 'session', novelId: 'novel', mode: 'build' as const, prompt: '请启用目标模式，写下一章' }
    expect(readHumanAdmission(request)).toBeNull()
    const saved = withHumanAdmission(request)
    expect(readHumanAdmission(saved)?.grant.objective).toBe('写下一章')
    expect(readHumanAdmission({ ...saved, prompt: '写两章' })).toBeNull()
    expect(readHumanAdmission({ ...saved, modelTier: 'custom' })).toBeNull()
    const attachment = withHumanAdmission({ ...request, prompt: '读取附件', attachments: [{ id: 'attachment', kind: 'file', name: '请启用目标模式，写下一章', url: '/api/uploads/agent-attachments/test.txt', size: 4 }] })
    expect(readHumanAdmission(attachment)?.grant.objective).toBeNull()
    // Public request parsing strips the forged capability. Only the route's
    // server option may create persisted provenance after authentication.
    expect(startAgentLoopRunSchema.parse(saved)).not.toHaveProperty('humanAdmission')
  })
  it('publishes empty native arguments only to the main agent and respects sandbox policy', () => {
    expect(goalEnableTool.parameters.safeParse({}).success).toBe(true)
    for (const key of ['objective', 'sessionId', 'modelTier', 'tokenLimit']) expect(goalEnableTool.parameters.safeParse({ [key]: 'forged' }).success).toBe(false)
    expect(getToolsForAgent(getAgentDefinition('orchestrator'), 'build').some(tool => tool.name === 'goal_enable')).toBe(true)
    for (const role of ['research', 'continuity', 'quality', 'lore']) expect(getToolsForAgent(getAgentDefinition(role), 'build').some(tool => tool.name === 'goal_enable')).toBe(false)
    expect(applySessionToolPolicy([goalEnableTool], 'build', {}, 'read_only')).toEqual([])
  })
  it.each(['给当前任务启用目标模式', '请启用目标模式继续当前任务', '请启用目标模式，当前任务', 'Please enable goal mode for the current task'])('recognizes only explicit current-task consent: %s', prompt => {
    // This is insufficient as a new task objective: exact server task binding is required.
    expect(isCurrentTaskGoalConsent(prompt)).toBe(true)
    expect(goalActivationObjective(prompt)).toBeNull()
  })
  it.each(['不要给当前任务启用目标模式', '如果给当前任务启用目标模式', '例如：给当前任务启用目标模式', '"给当前任务启用目标模式"', '> 给当前任务启用目标模式', '开启目标模式，修改原任务'])('rejects discussion/quotation or scope-changing controls: %s', prompt => expect(isCurrentTaskGoalConsent(prompt)).toBe(false))
})
