import { describe, expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { durableTaskSpecIdentity } from '../../api/lib/agent/runtime-identity.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'

const spec = JSON.parse(JSON.stringify(buildTaskSpec({ runId: 'original-run', novelId: 'owned-novel', prompt: '分析这本小说' })))
describe('existing frozen durable task identity', () => {
  it('omits execution runId and schema-produced optional undefined values on both fresh and resumed runs', () => {
    const original = durableTaskSpecIdentity(spec)
    expect(original.frozen.value).not.toHaveProperty('runId')
    expect(runtimeJson(original.frozen.value).hash).toBe(original.frozen.hash)
    expect(durableTaskSpecIdentity({ ...spec, runId: 'resumed-run' }).frozen).toEqual(original.frozen)
    expect(durableTaskSpecIdentity(taskSpecSchema.parse(original.frozen.value)).frozen).toEqual(original.frozen)
  })
  it.each(['intent', 'novel', 'goal', 'requirement', 'network', 'task'] as const)('preserves the frozen %s field when comparing identity', field => {
    const changed = structuredClone(spec)
    if (field === 'intent') changed.intent = 'review'
    if (field === 'novel') changed.scope.novelId = 'another-novel'
    if (field === 'goal') changed.goals = ['Changed goal']
    if (field === 'requirement') changed.expectedOutputs[0].description = 'Changed requirement'
    if (field === 'network') changed.networkAccess = 'denied'
    if (field === 'task') changed.id = 'another-task'
    expect(durableTaskSpecIdentity(changed).frozen.hash).not.toBe(durableTaskSpecIdentity(spec).frozen.hash)
  })
})
