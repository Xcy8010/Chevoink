import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ model: vi.fn(), route: vi.fn(), preview: vi.fn(), find: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn(), job: vi.fn(), human: vi.fn() }))
vi.mock('../api/lib/ai-service.js', () => ({ chatWithTools: f.model }))
vi.mock('../api/lib/novel-import/model-router.js', () => ({ resolveImportModelRoute: f.route, assertImportStructureBudget: vi.fn() }))
vi.mock('../api/lib/novel-import-service.js', () => ({ assertNovelImportHuman: f.human, getNovelImportPreview: f.preview, novelImportCapabilities: () => ({ enabled: true }), novelImportTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ novelImportJob: { findFirst: f.job }, novelImportSuggestion: { findFirst: f.find, count: f.count, create: f.create } }) }))
vi.mock('../api/lib/prisma.js', async original => ({ ...await original<typeof import('../api/lib/prisma.js')>(), prisma: { novelImportJob: { findFirstOrThrow: f.job }, novelImportSuggestion: { findFirst: f.find, update: f.update } } }))
import { requestImportSuggestion, validateImportSuggestion } from '../api/lib/novel-import/suggestions.js'
import type { NovelImportHuman } from '../api/lib/novel-import-service.js'
const human = { userId: 'owner', novelId: 'book' } as NovelImportHuman
const input = { manifestRevision: 1, manifestHash: 'a'.repeat(64), volumeIndex: 0, chapterIndex: 0, fingerprint: 'b'.repeat(64), confirmed: true as const }
beforeEach(() => {
  vi.clearAllMocks()
  f.find.mockResolvedValue(null); f.count.mockResolvedValue(0)
  f.job.mockResolvedValue({ status: 'ready', expiresAt: new Date(Date.now() + 10000), modelSelection: { kind: 'basic' } })
  f.preview.mockResolvedValue({ manifestHash: input.manifestHash, manifestRevision: 1, volumes: [{ chapters: [{ content: '第一章\n正文\n第二章\n后文' }] }] })
  f.route.mockResolvedValue({ runtime: { tier: 'basic', modelName: 'chosen', provider: 'compatible', contextWindowTokens: 128000, multiplierBps: 10000 }, route: { fingerprint: input.fingerprint, reasoningEffort: 'low' } })
  f.create.mockImplementation(async ({ data }) => ({ ...data, status: 'pending', createdAt: new Date(), result: null, errorCode: null }))
  f.update.mockImplementation(async ({ data }) => ({ id: 'request', createdAt: new Date(), ...data, errorCode: data.errorCode ?? null }))
  f.model.mockResolvedValue({ content: JSON.stringify({ boundaries: [{ offset: 0, title: '一' }, { offset: 7, title: '二' }], note: '按标题' }), finishReason: 'stop' })
})
describe('import paid suggestions', () => {
  it('preserves exact source by allowing only ordered newline boundaries', () => {
    const text = '甲\n乙\n丙'
    const result = validateImportSuggestion({ boundaries: [{ offset: 0, title: '甲' }, { offset: 2, title: '乙' }], note: '' }, text)
    expect(result.boundaries.map((b, i) => text.slice(b.offset, result.boundaries[i + 1]?.offset)).join('')).toBe(text)
    for (const offsets of [[1], [0, 1], [0, 2, 2], [0, 5]]) expect(() => validateImportSuggestion({ boundaries: offsets.map(offset => ({ offset, title: '章' })), note: '' }, text)).toThrow()
  })
  it('uses chosen basic low once and caches the result without writing source', async () => {
    const result = await requestImportSuggestion(human, 'job', input)
    expect(result.status).toBe('succeeded')
    expect(f.model).toHaveBeenCalledOnce()
    expect(f.model.mock.calls[0][0]).toMatchObject({ model: 'chosen', reasoningEffort: 'low', maxOutputTokens: 2000, tools: [], usageLog: { modelTier: 'basic', action: 'novelImportStructure' } })
  })
  it('replays uncertain pending requests without another provider request', async () => {
    f.find.mockResolvedValue({ id: 'old', status: 'pending', createdAt: new Date(0), manifestHash: input.manifestHash, fingerprint: input.fingerprint })
    expect(await requestImportSuggestion(human, 'job', input)).toMatchObject({ status: 'failed', errorCode: 'IMPORT_AI_RESULT_UNKNOWN' })
    expect(f.model).not.toHaveBeenCalled()
  })
  it('rejects missing explicit fee consent, stale fingerprint, and exhausted budget', async () => {
    await expect(requestImportSuggestion(human, 'job', { ...input, confirmed: false } as never)).rejects.toThrow()
    await expect(requestImportSuggestion(human, 'job', { ...input, fingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'IMPORT_MODEL_CHANGED' })
    f.count.mockResolvedValue(4)
    await expect(requestImportSuggestion(human, 'job', input)).rejects.toMatchObject({ code: 'IMPORT_BUDGET_REQUIRED' })
    expect(f.model).not.toHaveBeenCalled()
  })
  it('does not retry provider failure or incomplete suggestions', async () => {
    f.model.mockRejectedValue(new Error('network'))
    expect(await requestImportSuggestion(human, 'job', input)).toMatchObject({ status: 'failed', errorCode: 'IMPORT_AI_FAILED' })
    expect(f.model).toHaveBeenCalledOnce()
  })
})
