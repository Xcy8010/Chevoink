import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { builtInModelTierSchema, creditModelTierSchema, selectableModelTierSchema } from '../../shared/contracts/model-tier.js'
import { agentModelSelectionSchema } from '../../shared/contracts/agent-model-assignments.js'
import { startAgentLoopRunSchema } from '../../shared/contracts/schemas.js'
import { novelImportModelSchema } from '../../shared/contracts/novel-import.js'
import { tokenPriceSchema } from '../../api/lib/billing/token-price.js'
import { configureAgentSchema, configurationResponseSchema } from '../../api/lib/agent/tools/configuration-tools.js'
import { buildAgentIdentityPrompt } from '../../api/lib/agent/context.js'

const tier = 'builtin_0123456789abcdef'
describe('dynamic built-in model identity compatibility', () => {
  it('accepts the new stable identity at selection, tool, HTTP and frozen billing boundaries', () => {
    expect(agentModelSelectionSchema.parse({ modelTier: tier })).toEqual({ modelTier: tier })
    expect(startAgentLoopRunSchema.parse({ novelId: 'n', sessionId: 's', mode: 'build', prompt: '写作', modelTier: tier }).modelTier).toBe(tier)
    expect(novelImportModelSchema.parse({ kind: 'builtin', modelTier: tier })).toMatchObject({ modelTier: tier })
    expect(configureAgentSchema.parse({ model: { modelTier: tier } }).model?.modelTier).toBe(tier)
    expect(configurationResponseSchema.parse({ modelTier: tier, customModelId: null, reasoningEffort: 'high', creativeFreedom: 'stable', modelSelectionExplicit: true }).modelTier).toBe(tier)
    expect(tokenPriceSchema.parse({ version: 'credits-v1-exact', modelTier: tier, multiplierBps: 12345 }).modelTier).toBe(tier)
    expect(JSON.stringify(z.toJSONSchema(configureAgentSchema, { io: 'input' }))).toContain('builtin_')
    expect(buildAgentIdentityPrompt(tier)).not.toContain('undefined')
    expect(buildAgentIdentityPrompt(tier, 'secret-provider-model', '动态名称')).toContain('我是动态名称')
    expect(buildAgentIdentityPrompt(tier, 'secret-provider-model', '动态名称')).not.toContain('secret-provider-model')
  })
  it.each(['builtin_0123456789abcde', 'builtin_0123456789abcdef0', 'builtin_0123456789ABCDEf', 'builtin_', 'other', 'basic', 'custom'])('rejects invalid selectable builtin %s', value => {
    expect(builtInModelTierSchema.safeParse(value).success).toBe(false)
  })
  it('retains all old identities and excludes basic only from user selection', () => {
    for (const legacy of ['lite', 'speed', 'standard', 'performance', 'ultimate', 'basic', 'custom']) expect(creditModelTierSchema.parse(legacy)).toBe(legacy)
    expect(selectableModelTierSchema.safeParse('basic').success).toBe(false)
    expect(agentModelSelectionSchema.safeParse({ modelTier: 'basic' }).success).toBe(false)
    expect(agentModelSelectionSchema.safeParse({ modelTier: tier, customModelId: 'foreign' }).success).toBe(false)
  })
})
