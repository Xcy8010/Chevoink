import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma'
import { handleTestDatabaseUnavailable } from '../support/database-availability'

// Real database state/locks; synthetic provider only. Never send test samples to a paid provider.
vi.mock('../../api/lib/credits', () => ({ getModelTierRuntime: vi.fn(async () => ({ tier: 'custom', multiplierBps: 0, provider: 'test', modelName: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-only', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000 })) }))
vi.mock('../../api/lib/ai-service', () => ({ generateTextCompletion: vi.fn() }))
import { generateTextCompletion } from '../../api/lib/ai-service'
import { extractAuthorStyleProfile, revokeCorpusSource } from '../../api/lib/agent/craft-library'
import { changeStyleLearning, getLearnedStyleDigest, getStyleLearningWorkspace, previewStyleSamples, processStyleChunk, startStyleLearning } from '../../api/lib/agent/style-learning'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
describe.skipIf(!dbAvailable)('Style learning ownership, durable progress and approval (real DB)', () => {
  let userId = '', novelId = '', otherNovelId = '', profileId = '', sourceId = ''
  const content = '甲：走。\n乙：等等。\n'.repeat(700)
  const model = { modelTier: 'custom' as const, customModelId: 'fixture', reasoningEffort: 'high' as const }
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { nickname: 'Style学习测试', passwordHash: 'not-a-login-hash' } })
    userId = user.id
    for (const other of [false, true]) {
      const novel = await prisma.novel.create({ data: { authorId: userId, title: 'Style合成样章', slug: randomUUID(), summary: '' } })
      if (other) otherNovelId = novel.id; else novelId = novel.id
    }
    const profile = await extractAuthorStyleProfile({ userId, novelId, title: '剧本样章', chapterIds: [], uploadedFile: { name: 'sample.md', size: Buffer.byteLength(content), content } })
    profileId = profile.profileId; sourceId = profile.sourceId
  })
  afterAll(async () => {
    if (userId) {
      await prisma.novel.deleteMany({ where: { authorId: userId } })
      await prisma.user.delete({ where: { id: userId } })
    }
    await prisma.$disconnect()
  })
  it('lists sources without raw text, previews exact full source only within owned novel', async () => {
    expect(JSON.stringify(await getStyleLearningWorkspace(userId, novelId))).not.toContain('甲：走')
    expect((await previewStyleSamples(userId, novelId, profileId)).files[0].content).toBe(content.trim())
    await expect(previewStyleSamples(userId, otherNovelId, profileId)).rejects.toMatchObject({ status: 404 })
    expect(await getLearnedStyleDigest(userId, novelId)).toBe('')
  })
  it('duplicate submissions create one job; persists every segment before requesting the next', async () => {
    const input = { requestId: randomUUID(), profileId, model, consent: true as const }
    const [a, b] = await Promise.all([startStyleLearning(userId, novelId, input), startStyleLearning(userId, novelId, input)])
    expect(a.id).toBe(b.id)
    vi.mocked(generateTextCompletion).mockImplementation(async (_system, prompt) => JSON.stringify({ rules: [{ dimension: '对白', rule: '使用短促的对白推进动作', evidence: JSON.parse(prompt).sample.slice(0, 4) }] }))
    let job = await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: a.id } })
    while (job.status === 'queued') { await processStyleChunk(job); job = await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: job.id } }) }
    expect(job.status).toBe('ready')
    expect(job.processed).toBe(a.total)
    expect(generateTextCompletion).toHaveBeenCalledTimes(a.total)
    expect(await getLearnedStyleDigest(userId, novelId)).toBe('')
    const workspace = await getStyleLearningWorkspace(userId, novelId)
    const enabled = await changeStyleLearning(userId, novelId, job.id, { revision: job.revision, action: 'enable', rules: workspace.jobs[0].rules })
    expect(enabled.enabled).toBe(true)
    expect(await getLearnedStyleDigest(userId, novelId)).toContain('使用短促的对白推进动作')
    expect(await getLearnedStyleDigest(userId, otherNovelId)).toBe('')
    await expect(changeStyleLearning(userId, novelId, job.id, { revision: job.revision, action: 'disable' })).rejects.toMatchObject({ status: 409 })
    await changeStyleLearning(userId, novelId, job.id, { revision: enabled.revision, action: 'disable' })
    expect(await getLearnedStyleDigest(userId, novelId)).toBe('')
  })
  it('provider errors preserve completed reports and never automatically retry', async () => {
    vi.mocked(generateTextCompletion).mockRejectedValue(new Error('fixture connection lost'))
    const created = await startStyleLearning(userId, novelId, { requestId: randomUUID(), profileId, model, consent: true })
    await processStyleChunk(await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: created.id } }))
    const failed = await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: created.id } })
    expect(failed.status).toBe('interrupted')
    const count = vi.mocked(generateTextCompletion).mock.calls.length
    await processStyleChunk(failed)
    expect(generateTextCompletion).toHaveBeenCalledTimes(count)
    await expect(changeStyleLearning(userId, novelId, failed.id, { revision: failed.revision, action: 'retry' })).rejects.toThrow()
  })
  it('import invalidation cannot be resumed, retried, enabled or bypassed with a new request ID', async () => {
    const job = await prisma.styleLearningJob.findFirstOrThrow({ where: { profileId } })
    const stale = await prisma.styleLearningJob.update({ where: { id: job.id }, data: { error: 'IMPORT_SOURCE_ARCHIVED', status: 'paused', enabled: false, revision: { increment: 1 } } })
    for (const action of ['resume', 'retry', 'enable'] as const) {
      await expect(changeStyleLearning(userId, novelId, job.id, { revision: stale.revision, action, consent: true })).rejects.toMatchObject({ status: 409, code: 'IMPORT_SCOPE_CHANGED' })
    }
    await expect(startStyleLearning(userId, novelId, { requestId: randomUUID(), profileId, model, consent: true })).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect((await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: job.id } })).revision).toBe(stale.revision)
    expect(await getLearnedStyleDigest(userId, novelId)).toBe('')
    // Subsequent revocation exercises a newly selected sample, not the retained old profile.
    const profile = await extractAuthorStyleProfile({ userId, novelId, title: '重新选择样章', chapterIds: [], uploadedFile: { name: 'fresh.md', size: Buffer.byteLength(content), content } })
    profileId = profile.profileId; sourceId = profile.sourceId
  })
  it('revocation deletes source, learning records and fences a late paid response', async () => {
    let release!: (result: string) => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    vi.mocked(generateTextCompletion).mockImplementation(() => { started(); return new Promise(resolve => { release = resolve }) })
    const created = await startStyleLearning(userId, novelId, { requestId: randomUUID(), profileId, model, consent: true })
    const worker = processStyleChunk(await prisma.styleLearningJob.findUniqueOrThrow({ where: { id: created.id } }))
    await entered
    await revokeCorpusSource({ actorUserId: userId, novelId, sourceId, admin: false, reason: '测试撤回' })
    release(JSON.stringify({ rules: [{ dimension: '对白', rule: '不能写回', evidence: '甲：走。' }] }))
    await worker
    expect(await prisma.styleLearningJob.count({ where: { profileId } })).toBe(0)
    expect(await getLearnedStyleDigest(userId, novelId)).toBe('')
    const document = await prisma.corpusDocument.findFirstOrThrow({ where: { sourceId } })
    expect(document.metadata).toEqual({})
  })
})
