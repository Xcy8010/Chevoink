import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
const mocks = vi.hoisted(() => ({ operation: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(),
  prisma: { agentOperation: { findUnique: mocks.operation } } }))
import { inspectVisionResponse, readVisionExemption, visionRequest, visionWorkSchema } from '../../api/lib/agent/runtime-vision-contract.js'

beforeEach(() => vi.resetAllMocks())
describe('vision observations and explicit platform-paid policy', () => {
  it.each([undefined, null, {}, { prompt_tokens: -1, completion_tokens: 4 }, { prompt_tokens: 0, completion_tokens: 0 }])('does not invent missing usage: %j', usage => {
    const parsed = inspectVisionResponse(200, JSON.stringify({ choices: [{ message: { content: ' 实际描述 ' } }], usage }))
    expect(parsed).toMatchObject({ description: '实际描述', invalid: false,
      promptTokens: usage?.prompt_tokens === 0 ? 0 : null, completionTokens: usage?.completion_tokens ?? null })
  })
  it.each(['<html>upstream down</html>', '{}', JSON.stringify({ choices: [{ message: { content: ' ' } }] }),
    JSON.stringify({ choices: [{ message: { content: '字'.repeat(300001) } }] })])('preserves a known invalid response without a fabricated description', body => {
    expect(inspectVisionResponse(503, body)).toMatchObject({ httpStatus: 503, invalid: true, description: null })
  })
  it.each(['valid', 'other-action', 'changed-work', 'wrong-parent', 'wrong-request', 'wrong-attempt', 'bad-parent-hash', 'fake-policy'] as const)('%s requires the exact original vision policy and request', async scenario => {
    const work = visionWorkSchema.parse({ kind: 'vision', version: 1, route: { provider: 'fixture', modelName: 'fixture', baseUrl: 'https://vision.invalid/v1', providerMode: 'mock', options: {} },
      pixelHash: 'a'.repeat(64), mime: 'image/png', displayUrl: '/original.png', question: '核查实际图片', maxOutputTokens: 4096, billingPolicy: 'platform_vision_v1' })
    if (work.kind !== 'vision') throw Error('Expected vision work')
    const parentInput = runtimeJson({ kind: 'tool', action: 'view_image', input: { work } })
    const request = visionRequest(work), requestSnapshot = runtimeJson({ provider: 'fixture', model: 'fixture', request })
    const childInput = runtimeJson({ input: { parentInputHash: parentInput.hash, workHash: scenario === 'changed-work' ? 'f'.repeat(64) : runtimeJson(work).hash, request } })
    mocks.operation.mockResolvedValue({ kind: 'provider', action: scenario === 'other-action' ? 'ordinary_text' : 'view_image_vision', parentOperationId: 'parent', taskRootId: 'root',
      inputSnapshot: childInput.value, inputHash: childInput.hash, attempts: [{ id: scenario === 'wrong-attempt' ? 'other' : 'attempt', requestHash: requestSnapshot.hash,
        requestSnapshot: scenario === 'wrong-request' ? { changed: true } : requestSnapshot.value }],
      parent: { kind: 'tool', action: 'view_image', taskRootId: scenario === 'wrong-parent' ? 'other-root' : 'root',
        inputHash: scenario === 'bad-parent-hash' ? 'b'.repeat(64) : parentInput.hash, inputSnapshot: parentInput.value } })
    expect(await readVisionExemption('attempt', { type: 'credit.exempt', payload: { operationId: 'provider', attemptId: 'attempt', parentOperationId: 'parent',
      parentInputHash: parentInput.hash, requestHash: requestSnapshot.hash, policy: scenario === 'fake-policy' ? 'free_text' : 'platform_vision_v1', chargedMilli: 0 } })).toBe(scenario === 'valid')
  })
})
