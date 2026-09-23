import { describe, expect, it } from 'vitest'

import { buildProviderReasoningPayload, extractCacheTokens, resolveTextOutputTokenParameter } from '../../api/lib/ai-service.js'

describe('供应商 usage 缓存命中双格式解析', () => {
  it('DeepSeek 顶层 hit/miss 字段优先，原样透传', () => {
    expect(
      extractCacheTokens({
        prompt_tokens: 1500,
        prompt_cache_hit_tokens: 1000,
        prompt_cache_miss_tokens: 500,
      }),
    ).toEqual({ hit: 1000, miss: 500 })
  })

  it('OpenAI 兼容网关用 prompt_tokens_details.cached_tokens，miss 取 prompt_tokens - hit', () => {
    expect(
      extractCacheTokens({
        prompt_tokens: 2000,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    ).toEqual({ hit: 800, miss: 1200 })
  })

  it('两种格式均未返回时用 null/null 区分“不可观测”与“零命中”', () => {
    expect(extractCacheTokens({ prompt_tokens: 1500 })).toEqual({ hit: null, miss: null })
    expect(extractCacheTokens({})).toEqual({ hit: null, miss: null })
  })

  it('显式零命中仍是有效观测，并从 prompt_tokens 推导全部未命中', () => {
    expect(extractCacheTokens({ prompt_tokens: 1500, prompt_cache_hit_tokens: 0 })).toEqual({ hit: 0, miss: 1500 })
    expect(extractCacheTokens({ prompt_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 } })).toEqual({ hit: 0, miss: 1500 })
  })

  it('DeepSeek 显式返回 0 hit 与正 miss 时原样记录', () => {
    expect(extractCacheTokens({ prompt_tokens: 1500, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1500 })).toEqual({ hit: 0, miss: 1500 })
  })

  it('DeepSeek 缺 miss 字段但 hit > 0 时用 prompt_tokens 推断', () => {
    expect(
      extractCacheTokens({
        prompt_tokens: 1500,
        prompt_cache_hit_tokens: 1000,
      }),
    ).toEqual({ hit: 1000, miss: 500 })
  })

  it('非数值类型的命中字段按缺失处理', () => {
    expect(
      extractCacheTokens({
        prompt_tokens: 1500,
        prompt_cache_hit_tokens: '1000' as unknown as number,
        prompt_tokens_details: { cached_tokens: '800' },
      }),
    ).toEqual({ hit: null, miss: null })
  })

  it('异常超限字段被钳制，避免污染后台命中率', () => {
    expect(extractCacheTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 150 } })).toEqual({ hit: 100, miss: 0 })
    expect(extractCacheTokens({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 80 })).toEqual({ hit: 80, miss: 20 })
  })
})

describe('供应商推理参数适配', () => {
  it('GLM 4.5 使用 thinking，但不发送仅 GLM 5.2+ 支持的 reasoning_effort', () => {
    expect(buildProviderReasoningPayload({ provider: 'zhipu', model: 'glm-4.5', reasoningEffort: 'high' })).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  it('GLM 4.5 以前不发送尚未支持的 thinking/reasoning_effort', () => {
    expect(buildProviderReasoningPayload({ provider: 'zhipu', model: 'glm-4.1v-thinking-flash', reasoningEffort: 'high' })).toEqual({})
  })

  it('GLM 5.2 同时发送 thinking 与 reasoning_effort', () => {
    expect(buildProviderReasoningPayload({ provider: 'bigmodel', model: 'glm-5.2', reasoningEffort: 'max' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('即使供应商名称是自定义，也能通过 GLM 模型名识别并关闭思考', () => {
    expect(buildProviderReasoningPayload({ provider: 'custom-gateway', model: 'glm-4.6', reasoningEffort: 'none' })).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('DeepSeek 保持既有参数语义', () => {
    expect(buildProviderReasoningPayload({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('MiMo 只发送 thinking 开关，不发送会被它忽略的 reasoning_effort', () => {
    expect(buildProviderReasoningPayload({ provider: 'xiaomi', model: 'mimo-v2.6-flash', reasoningEffort: 'high' })).toEqual({
      thinking: { type: 'enabled' },
    })
    expect(buildProviderReasoningPayload({ provider: 'custom-gateway', model: 'xiaomi/mimo-v2.6-flash', reasoningEffort: 'none' })).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('供应商名自定义时也能通过主机名识别 MiMo 网关', () => {
    expect(buildProviderReasoningPayload({ provider: 'proxy', providerBaseUrl: 'https://api.xiaomimimo.com/v1', model: 'thinking-flash', reasoningEffort: 'low' })).toEqual({
      thinking: { type: 'enabled' },
    })
  })
})

describe('输出预算参数名适配', () => {
  it('MiMo 在有界调用中改用 max_completion_tokens，其它供应商保持 max_tokens', () => {
    expect(resolveTextOutputTokenParameter(undefined, { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, true)).toBe('max_completion_tokens')
    expect(resolveTextOutputTokenParameter(undefined, { provider: 'deepseek', model: 'deepseek-v4-flash' }, true)).toBe('max_tokens')
  })

  it('无显式预算的辅助调用与显式能力配置都不被覆盖', () => {
    expect(resolveTextOutputTokenParameter(undefined, { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, false)).toBe('max_tokens')
    expect(resolveTextOutputTokenParameter('max_tokens', { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, true)).toBe('max_tokens')
    expect(resolveTextOutputTokenParameter('max_completion_tokens', { provider: 'deepseek', model: 'deepseek-v4-flash' }, false)).toBe('max_completion_tokens')
  })
})
