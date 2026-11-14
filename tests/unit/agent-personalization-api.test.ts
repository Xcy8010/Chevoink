import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import agentPersonalizationRouter from '../../api/routes/agent-personalization.js'
import { hasAgentPersonalizationCapability } from '../../api/lib/app-releases.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { DEFAULT_AGENT_PERSONALIZATION_SETTINGS } from '../../shared/contracts/agent-personalization.js'

const service = vi.hoisted(() => ({
  getAgentPersonalization: vi.fn(),
  patchAgentPersonalization: vi.fn(),
  listPersonalizationMemories: vi.fn(),
  createPersonalizationMemory: vi.fn(),
  updatePersonalizationMemory: vi.fn(),
  deletePersonalizationMemory: vi.fn(),
  clearPersonalizationMemories: vi.fn(),
  restorePersonalizationMemory: vi.fn(),
  changePersonalizationRule: vi.fn(),
}))
const operations = vi.hoisted(() => ({
  assertPersonalizationRuleOperation: vi.fn(),
  listPersonalizationRuleOperations: vi.fn(),
}))
vi.mock('../../api/lib/agent/personalization.js', () => service)
vi.mock('../../api/lib/agent/personalization-tool-policy.js', () => operations)
vi.mock('../../api/lib/app-releases.js', () => ({ hasAgentPersonalizationCapability: vi.fn() }))
vi.mock('../../api/lib/auth-session.js', () => ({
  requireSessionUserId(req: Request) {
    if (req.headers['x-test-session'] === 'signed') return 'test-account'
    throw new DataAccessError(401, 'AUTH_REQUIRED', '请先登录后再继续。')
  },
}))

const settingsUrl = '/personalization'
const memoriesUrl = `${settingsUrl}/memories`
const memoryUrl = `${memoriesUrl}/:memoryId`

async function invoke(method: string, path: string, input: { signed?: boolean; body?: unknown; revision?: string | string[]; current?: boolean } = {}) {
  const route = agentPersonalizationRouter.stack.find(layer =>
    layer.route?.path === path && layer.route.stack.some(handler => handler.method === method))?.route
  const handler = route?.stack.find(layer => layer.method === method)
  if (!handler) throw new Error(`Missing route ${method} ${path}`)
  const req = { body: input.body, headers: input.signed ? { 'x-test-session': 'signed' } : {}, params: { memoryId: 'memory-a', toolName: 'chapter_read' },
    get: (header: string) => header === 'X-Chevoink-Personalization' && input.current !== false ? '2' : undefined,
    query: input.revision === undefined ? {} : { expectedRevision: input.revision } } as Request
  const result = { status: 200, headers: new Map<string, string>(), body: {} as Record<string, unknown> }
  const res = {
    status(code: number) { result.status = code; return this },
    setHeader(key: string, value: string) { result.headers.set(key, value); return this },
    json(body: Record<string, unknown>) { result.body = body; return this },
  } as unknown as Response
  await handler.handle(req, res, () => { throw new Error('Unexpected next handler') })
  return result
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(hasAgentPersonalizationCapability).mockResolvedValue(true)
})

describe('personalization HTTP boundary', () => {
  it('authenticates before validating any personalization write or listing author data', async () => {
    expect(await invoke('patch', settingsUrl, { body: { style: 'nonsense' } })).toMatchObject({ status: 401 })
    expect(await invoke('get', memoriesUrl)).toMatchObject({ status: 401 })
    expect(await invoke('delete', memoriesUrl)).toMatchObject({ status: 401 })
    expect(hasAgentPersonalizationCapability).not.toHaveBeenCalled()
    expect(service.patchAgentPersonalization).not.toHaveBeenCalled()
    expect(service.listPersonalizationMemories).not.toHaveBeenCalled()
    expect(service.clearPersonalizationMemories).not.toHaveBeenCalled()
  })

  it('denies settings and memory access before input validation when the assigned version lacks the capability', async () => {
    vi.mocked(hasAgentPersonalizationCapability).mockResolvedValue(false)
    const requests = [
      ['get', settingsUrl], ['patch', settingsUrl],
      ['get', memoriesUrl], ['post', memoriesUrl], ['delete', memoriesUrl],
      ['patch', memoryUrl], ['delete', memoryUrl],
      ['post', `${memoryUrl}/restore`], ['get', `${settingsUrl}/rule-operations`],
      ['put', `${settingsUrl}/rules`], ['delete', `${settingsUrl}/rules/:toolName`],
    ]
    for (const [method, path] of requests) {
      expect(await invoke(method, path, { signed: true })).toMatchObject({
        status: 403,
        body: { success: false, error: { code: 'APP_RELEASE_CAPABILITY_DISABLED' } },
      })
    }
    expect(vi.mocked(hasAgentPersonalizationCapability).mock.calls).toEqual(requests.map(() => ['test-account']))
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled()
  })

  it('uses the session as its account boundary and validates strict sparse patches', async () => {
    const payload = { settings: { ...DEFAULT_AGENT_PERSONALIZATION_SETTINGS, customInstructions: '先给结论' }, revision: 3, rules: [] }
    service.patchAgentPersonalization.mockResolvedValue(payload)
    const patch = (body: unknown) => invoke('patch', settingsUrl, { signed: true, body })
    expect(await patch({ userId: 'other', expectedRevision: 2, preferredName: '小叶' })).toMatchObject({ status: 400 })
    expect(await patch({ expectedRevision: 2, preferredName: '小叶' })).toMatchObject({ status: 400 })
    expect(await patch({ expectedRevision: 2 })).toMatchObject({ status: 400 })
    expect(await patch({ expectedRevision: 2, customInstructions: ' 先给结论 ' })).toMatchObject({ status: 200, body: { success: true, data: payload } })
    expect(service.patchAgentPersonalization).toHaveBeenCalledExactlyOnceWith('test-account', { expectedRevision: 2, customInstructions: '先给结论' })
  })

  it('prevents caching of personal reads and hides the internal memory epoch', async () => {
    service.getAgentPersonalization.mockResolvedValue({ settings: DEFAULT_AGENT_PERSONALIZATION_SETTINGS, revision: 0, rules: [] })
    service.listPersonalizationMemories.mockResolvedValue({ memories: [], archived: [], revision: 2, memoryEpoch: 4 })
    const settings = await invoke('get', settingsUrl, { signed: true })
    expect(settings.status).toBe(200)
    expect(settings.headers.get('Cache-Control')).toBe('no-store')
    const response = await invoke('get', memoriesUrl, { signed: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.body.data).toEqual({ memories: [], archived: [], revision: 2 })
    expect(service.listPersonalizationMemories).toHaveBeenCalledExactlyOnceWith('test-account')
  })

  it('keeps already loaded legacy assets readable using empty, read-only compatibility fields', async () => {
    const payload = { settings: DEFAULT_AGENT_PERSONALIZATION_SETTINGS, revision: 0, rules: [] }
    service.getAgentPersonalization.mockResolvedValue(payload)
    const legacy = await invoke('get', settingsUrl, { signed: true, current: false })
    const current = await invoke('get', settingsUrl, { signed: true })
    expect(legacy.body.data).toEqual({ ...payload, settings: { ...payload.settings, preferredName: '', aboutMe: '' } })
    expect(current.body.data).toEqual(payload)
    expect(await invoke('patch', settingsUrl, { signed: true, current: false, body: { expectedRevision: 0, aboutMe: 'obsolete' } }))
      .toMatchObject({ status: 400 })
    expect(service.patchAgentPersonalization).not.toHaveBeenCalled()
  })

  it('validates memory input and preserves revision conflicts through the HTTP envelope', async () => {
    const post = (text: string) => invoke('post', memoriesUrl, { signed: true, body: { text } })
    expect(await post('   ')).toMatchObject({ status: 400 })
    expect(await post('a\u0000b')).toMatchObject({ status: 400 })
    expect(await post('x'.repeat(501))).toMatchObject({ status: 400 })
    expect(service.createPersonalizationMemory).not.toHaveBeenCalled()
    expect(await invoke('delete', memoryUrl, { signed: true, revision: '' })).toMatchObject({ status: 400 })
    expect(await invoke('delete', memoriesUrl, { signed: true, revision: ['1', '2'] })).toMatchObject({ status: 400 })
    expect(service.clearPersonalizationMemories).not.toHaveBeenCalled()
    service.deletePersonalizationMemory.mockRejectedValue(new DataAccessError(409, 'PERSONALIZATION_MEMORY_CONFLICT', '记忆已更新，请刷新后重试。'))
    const response = await invoke('delete', memoryUrl, { signed: true, revision: '1' })
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ success: false, error: { code: 'PERSONALIZATION_MEMORY_CONFLICT' } })
    expect(service.deletePersonalizationMemory).toHaveBeenCalledExactlyOnceWith('test-account', 'memory-a', 1)
  })

  it('checks the registered operation and account before updating any rules', async () => {
    const put = (body: unknown) => invoke('put', `${settingsUrl}/rules`, { signed: true, body })
    const rule = { toolName: 'chapter_read', permission: 'deny', expectedRevision: 2 }
    expect(await put({ ...rule, userId: 'other' })).toMatchObject({ status: 400 })
    expect(service.changePersonalizationRule).not.toHaveBeenCalled()
    operations.assertPersonalizationRuleOperation.mockRejectedValueOnce(new DataAccessError(400, 'PERSONALIZATION_RULE_UNKNOWN_TOOL', '操作不可用'))
    expect(await put({ ...rule, toolName: 'unknown_operation' })).toMatchObject({ status: 400 })
    expect(service.changePersonalizationRule).not.toHaveBeenCalled()
    service.changePersonalizationRule.mockResolvedValue({ revision: 3 })
    expect(await put(rule)).toMatchObject({ status: 200 })
    expect(operations.assertPersonalizationRuleOperation).toHaveBeenLastCalledWith('chapter_read')
    expect(service.changePersonalizationRule).toHaveBeenLastCalledWith('test-account', 'chapter_read', 'deny', 2)
  })
})
