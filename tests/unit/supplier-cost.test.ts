import { describe, expect, it } from 'vitest'
import { publicRates } from '../../api/lib/data/supplier-cost.js'
describe('public CNY estimate rates, verified 2026-09-13', () => {
  it('applies peak and off-peak prices separately', () => {
    expect(publicRates('DeepSeek','deepseek-flash',false)).toEqual([1,.02,4])
    expect(publicRates('DeepSeek','deepseek-flash',true)).toEqual([2,.04,8])
    expect(publicRates('deepseek','deepseek-v4-pro',true)).toEqual([9,.3,27])
  })
  it('does not invent legacy or reseller prices', () => {
    expect(publicRates('deepseek','deepseek-chat',false)).toBeNull()
    expect(publicRates('openai-compatible','deepseek-flash',false)).toBeNull()
  })
  it('uses separate GLM input, cache and output rates', () => {
    expect(publicRates('Zhipu AI','glm-5.3-flash',false)).toEqual([.8,.23,2.8])
    expect(publicRates('Zhipu AI','glm-5.3',false)).toEqual([8,2,28])
  })
})
