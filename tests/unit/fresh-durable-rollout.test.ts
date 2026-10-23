import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../../api/config/env.js'
import { isFreshDurableAdmissionEnabled } from '../../api/lib/agent/fresh-durable-rollout.js'
const original = env.agentDurableRolloutUserIds
afterEach(() => { env.agentDurableRolloutUserIds = original })
describe('new native admission rollout', () => {
  it('defaults to no new native admissions without changing tool authority', () => {
    env.agentDurableRolloutUserIds = []
    expect(isFreshDurableAdmissionEnabled('owner')).toBe(false)
  })
  it('limits new admissions to the actual configured account', () => {
    env.agentDurableRolloutUserIds = ['owner']
    expect(isFreshDurableAdmissionEnabled('owner')).toBe(true)
    expect(isFreshDurableAdmissionEnabled('another-owner')).toBe(false)
  })
  it('requires an explicit full-rollout setting', () => {
    env.agentDurableRolloutUserIds = ['*']
    expect(isFreshDurableAdmissionEnabled('owner')).toBe(true)
  })
})
