import { expect, it } from 'vitest'
import { modelPublicCopy } from '../../shared/model-public-copy'

it.each(['lite', 'speed', 'standard', 'performance', 'ultimate'])('fills the empty %s catalog with useful writing copy without upstream identity', tier => {
  const copy = modelPublicCopy(tier, { provider: 'PRIVATE_PROVIDER_SENTINEL', modelName: 'PRIVATE_MODEL_ID_SENTINEL', publicDescription: '', publicFeatures: [] })
  expect(copy.publicDescription.length).toBeGreaterThan(15)
  expect(copy.publicFeatures).toHaveLength(3)
  expect(JSON.stringify(copy)).not.toMatch(/PRIVATE_|provider|modelName|根据|透露/)
  expect(Object.keys(copy).sort()).toEqual(['publicDescription', 'publicFeatures'])
})
it('preserves configured public copy and filters blank or nontext features without including private metadata', () => {
  expect(modelPublicCopy('speed', { publicDescription: '  自定义创作介绍  ', publicFeatures: [' 保留特性 ', null, '', 3], apiKey: 'PRIVATE_KEY' })).toEqual({ publicDescription: '自定义创作介绍', publicFeatures: ['保留特性'] })
})
it('does not give text-tier guidance to tools, internal basic or unknown dynamic catalog entries', () => {
  for (const tier of [null, 'basic', 'tool_image', 'builtin_0123456789abcdef', 'toString']) expect(modelPublicCopy(tier, null)).toEqual({ publicDescription: '', publicFeatures: [] })
  expect(modelPublicCopy(null, { publicDescription: '已有工具说明', publicFeatures: ['工具特性'] })).toEqual({ publicDescription: '已有工具说明', publicFeatures: ['工具特性'] })
})
it('does not let an edited form mutate catalog defaults shared by another user', () => {
  const first = modelPublicCopy('speed', {})
  first.publicFeatures.splice(0)
  expect(modelPublicCopy('speed', {}).publicFeatures).toHaveLength(3)
})
