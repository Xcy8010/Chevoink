import { describe, expect, it } from 'vitest'

import { toolEnvironmentFallback } from '../../api/lib/admin-credit-model.js'

const baseEnvironment = {
  aiImageApiKeyConfigured: false,
  aiImageProvider: 'openai-compatible',
  aiImageModel: 'image-model',
  aiImageBaseUrl: 'https://image.example/v1',
  aiVisionApiKeyConfigured: false,
  aiVisionModel: 'vision-model',
  aiVisionBaseUrl: 'https://vision.example/v1',
  webSearchProvider: 'auto',
  webSearchBochaApiKeyConfigured: false,
}

describe('admin built-in tool model environment fallback', () => {
  it('reports direct Fetch separately without borrowing Search or chat credentials', () => {
    expect(toolEnvironmentFallback('web_fetch', baseEnvironment)).toBeNull()
  })
  it('reports image and vision tools as configured when their runtime keys are configured', () => {
    expect(toolEnvironmentFallback('image_generation', { ...baseEnvironment, aiImageApiKeyConfigured: true })).toMatchObject({ modelName: 'image-model', apiKeyConfigured: true })
    expect(toolEnvironmentFallback('vision', { ...baseEnvironment, aiVisionApiKeyConfigured: true })).toMatchObject({ modelName: 'vision-model', apiKeyConfigured: true })
  })

  it('reports free web-search fallback as ready without pretending a key exists', () => {
    expect(toolEnvironmentFallback('web_search', baseEnvironment)).toEqual({
      provider: 'auto',
      modelName: 'sogou-bing-fallback',
      baseUrl: null,
      apiKeyConfigured: false,
    })
  })

  it('does not configure disabled tools', () => {
    expect(toolEnvironmentFallback('web_search', { ...baseEnvironment, webSearchProvider: 'disabled' })).toBeNull()
    expect(toolEnvironmentFallback('image_generation', baseEnvironment)).toBeNull()
  })
})
