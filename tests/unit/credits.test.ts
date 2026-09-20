import { describe, expect, it } from 'vitest'

import {
  calculateCreditActivityStreaks,
  calculateTokenChargeMilli,
  getCreditActivityModelLabel,
  getCreditWindow,
  parseModelCapabilities,
  resolveCustomReasoningEffort,
} from '../../api/lib/credits.js'

describe('custom model verified capabilities', () => {
  it('adapts unavailable effort labels without rejecting a valid configured model', () => {
    expect(resolveCustomReasoningEffort('max', ['low', 'medium', 'high'])).toBe('high')
    expect(resolveCustomReasoningEffort('medium', ['low', 'high', 'max'])).toBe('low')
    expect(resolveCustomReasoningEffort('high', ['low', 'medium', 'high'])).toBe('high')
    expect(resolveCustomReasoningEffort('max', ['none'])).toBe('none')
  })
  it('carries verified protocol choices and leaves legacy/built-in inference unchanged', () => {
    expect(parseModelCapabilities({ reasoningEfforts: ['none'], defaultReasoningEffort: 'none', reasoningParameterMode: 'omit', outputTokenParameter: 'max_completion_tokens' }))
      .toMatchObject({ reasoningParameterMode: 'omit', outputTokenParameter: 'max_completion_tokens', reasoningEfforts: ['none'] })
    expect(parseModelCapabilities({})).not.toHaveProperty('reasoningParameterMode')
    expect(parseModelCapabilities({ outputTokenParameter: 'arbitrary' })).not.toHaveProperty('outputTokenParameter')
  })
})

describe('Credits token pricing', () => {
  it('charges 1 Credit for 10,000 input tokens', () => {
    expect(calculateTokenChargeMilli(10_000, 0)).toBe(1_000)
  })

  it('charges 1 Credit for 1,000 output tokens', () => {
    expect(calculateTokenChargeMilli(0, 1_000)).toBe(1_000)
  })

  it('bundles input and output pools into one Credit', () => {
    expect(calculateTokenChargeMilli(10_000, 1_000)).toBe(1_000)
  })

  it('applies model multipliers and rounds up to the smallest billable milli-credit', () => {
    expect(calculateTokenChargeMilli(10_000, 0, 11_000)).toBe(1_100)
    expect(calculateTokenChargeMilli(10_000, 0, 18_000)).toBe(1_800)
    expect(calculateTokenChargeMilli(10_000, 0, 48_000)).toBe(4_800)
    expect(calculateTokenChargeMilli(1, 0)).toBe(1)
  })

  it('charges nothing for the free 0x tier', () => {
    expect(calculateTokenChargeMilli(100_000, 10_000, 0)).toBe(0)
  })
})

describe('Credits activity streaks', () => {
  it('calculates current and longest streak from real active dates', () => {
    expect(calculateCreditActivityStreaks(
      ['2026-08-20', '2026-08-21', '2026-09-01', '2026-09-02', '2026-09-03'],
      '2026-09-04',
    )).toEqual({ current: 3, longest: 3 })
  })

  it('resets the current streak after a full inactive day and ignores duplicates', () => {
    expect(calculateCreditActivityStreaks(
      ['2026-08-30', '2026-08-30', '2026-08-31'],
      '2026-09-04',
    )).toEqual({ current: 0, longest: 2 })
  })
})

describe('Credits activity model privacy', () => {
  it('maps provider model IDs to product-facing tier labels', () => {
    expect(getCreditActivityModelLabel('text', 'speed')).toBe('极速')
    expect(getCreditActivityModelLabel('text', 'standard')).toBe('标准')
    expect(getCreditActivityModelLabel('text', 'performance')).toBe('性能')
    expect(getCreditActivityModelLabel('text', 'basic')).toBe('基础')
    expect(getCreditActivityModelLabel('image', null)).toBe('生图')
    expect(getCreditActivityModelLabel('text', null)).toBe('历史模型')
  })
})

describe('模型上下文窗口能力', () => {
  it('从模型 metadata 读取合法窗口，DeepSeek 与 GLM 共用同一能力契约', () => {
    expect(parseModelCapabilities({ contextWindowTokens: 128_000 }, 'deepseek').contextWindowTokens).toBe(128_000)
    expect(parseModelCapabilities({ contextWindowTokens: 200_000 }, 'zhipu').contextWindowTokens).toBe(200_000)
  })

  it('拒绝不可信窗口值并回退服务端默认配置', () => {
    expect(parseModelCapabilities({ contextWindowTokens: 8_000 }, 'zhipu').contextWindowTokens).toBeNull()
    expect(parseModelCapabilities({ contextWindowTokens: 128_000.5 }, 'deepseek').contextWindowTokens).toBeNull()
    expect(parseModelCapabilities({ contextWindowTokens: '128000' }, 'deepseek').contextWindowTokens).toBeNull()
  })
})

describe('Credits UTC+8 reset window', () => {
  it('keeps a request before 15:00 UTC+8 in the previous daily window', () => {
    const window = getCreditWindow(new Date('2026-08-31T06:59:59.000Z'))
    expect(window.startedAt.toISOString()).toBe('2026-08-30T07:00:00.000Z')
    expect(window.endsAt.toISOString()).toBe('2026-08-31T07:00:00.000Z')
  })

  it('starts a new window exactly at 15:00 UTC+8', () => {
    const window = getCreditWindow(new Date('2026-08-31T07:00:00.000Z'))
    expect(window.startedAt.toISOString()).toBe('2026-08-31T07:00:00.000Z')
    expect(window.endsAt.toISOString()).toBe('2026-09-01T07:00:00.000Z')
  })
})
