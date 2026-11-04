import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { applyPlanMetadataPatch, findPlanByIdentity, novelPlanHash, planLinkFields } from '../../api/lib/agent/novel-plan-contract.js'
import { assertWritingPlanContextCurrent, bindFutureWritingPlan, prepareWritingPlanContext, readWritingPlanContext, writingPlanContextHash } from '../../api/lib/agent/writing-plan-context.js'
import { readPlanAlignment } from '../../api/lib/agent/plan-alignment.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'

const subject = { userId: 'u', novelId: 'n' }
const outline = { id: 'o', title: '大纲', content: '第一章取得钥匙。终局返回故乡。', metadata: { savedAsPlan: true, planKind: 'outline' } }
const detail = () => ({ id: 'd', title: '细纲', content: '本章人物取得钥匙，并留下一封信。', metadata: { savedAsPlan: true, planKind: 'detail', parentPlanId: 'o', parentPlanHash: novelPlanHash(outline), target: { kind: 'future', targetOrderIndex: 1 } } })
const database = (rows = [outline, detail()]) => ({ agentArtifact: {
  findMany: vi.fn().mockResolvedValue(rows), findFirst: vi.fn().mockResolvedValue(outline), findFirstOrThrow: vi.fn().mockResolvedValue(detail()), update: vi.fn(),
}, chapter: { findFirst: vi.fn().mockResolvedValue({ id: 'c' }) }, storyCompilation: { update: vi.fn() } })
const tx = (db: ReturnType<typeof database>) => db as unknown as Prisma.TransactionClient
const future = { chapter: null, targetOrderIndex: 1 }

describe('typed plan metadata and compatibility', () => {
  it('hashes semantic fields but ignores display fields and never reclassifies legacy plans', () => {
    expect(planLinkFields({ ...outline, metadata: {} }, []).planKind).toBe('legacy')
    expect(novelPlanHash(outline)).toBe(novelPlanHash({ ...outline, title: '改名', metadata: { ...outline.metadata, planOrder: 7, timestamp: 'later' } }))
    expect(novelPlanHash(detail())).not.toBe(novelPlanHash({ ...detail(), metadata: { ...detail().metadata, target: { kind: 'chapter', chapterId: 'c' } } }))
  })
  it('preserves stale parent evidence across reads, and marks hidden parents missing without deleting children', () => {
    const child = detail()
    expect(planLinkFields(child, [outline]).reviewState).toBe('current')
    expect(planLinkFields(child, [{ ...outline, content: '作者修订大纲' }]).reviewState).toBe('stale')
    expect(planLinkFields(child, [{ ...outline, metadata: { ...outline.metadata, savedAsPlan: false } }]).reviewState).toBe('missing_parent')
    expect(child.metadata.parentPlanHash).toBe(novelPlanHash(outline))
    expect(planLinkFields({ ...child, metadata: { ...child.metadata, target: null } }, [outline]).reviewState).toBe('unlinked')
  })
  it('requires current semantic and parent hashes while allowing unlinked drafts', async () => {
    const db = database(), child = detail()
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', child, {}, '修改细纲')).rejects.toMatchObject({ code: 'PLAN_REVISION_CONFLICT' })
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', child, { expectedPlanHash: novelPlanHash(child) }, '修改细纲')).resolves.toMatchObject(child.metadata)
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', null, { planKind: 'detail', parentPlanId: 'o' }, '草稿')).rejects.toMatchObject({ code: 'PLAN_PARENT_STALE' })
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', null, { planKind: 'detail' }, '草稿')).resolves.toMatchObject({ planKind: 'detail' })
    db.agentArtifact.findFirst.mockResolvedValue(null as never)
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', null, { planKind: 'detail', parentPlanId: 'foreign', expectedParentPlanHash: novelPlanHash(outline) }, '草稿')).rejects.toMatchObject({ code: 'PLAN_PARENT_INVALID' })
  })
  it('rejects foreign chapter identities but permits distant future ordinals', async () => {
    const db = database(); db.chapter.findFirst.mockResolvedValue(null as never)
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', null, { planKind: 'detail', target: { kind: 'chapter', chapterId: 'foreign' } }, '')).rejects.toMatchObject({ code: 'PLAN_TARGET_INVALID' })
    await expect(applyPlanMetadataPatch(tx(db), 'u', 'n', null, { planKind: 'detail', target: { kind: 'future', targetOrderIndex: 200 } }, '')).resolves.toMatchObject({ target: { kind: 'future', targetOrderIndex: 200 } })
  })
  it('matches title fallback by kind, parent and target and refuses duplicate typed identities', async () => {
    const child = { ...detail(), title: outline.title }, db = database([outline, child])
    expect(await findPlanByIdentity(tx(db), 'u', 'n', { title: outline.title, planKind: 'detail', parentPlanId: 'o', target: child.metadata.target })).toBe(child)
    expect(await findPlanByIdentity(tx(db), 'u', 'n', { title: outline.title })).toBeNull()
    db.agentArtifact.findMany.mockResolvedValue([child, { ...child, id: 'duplicate' }])
    await expect(findPlanByIdentity(tx(db), 'u', 'n', { title: child.title, planKind: 'detail', parentPlanId: 'o', target: child.metadata.target })).rejects.toMatchObject({ code: 'PLAN_TARGET_AMBIGUOUS' })
  })
})

describe('frozen chapter plan dependencies', () => {
  it('preserves old works and freezes both full plans for a matching linked detail', async () => {
    const db = database([])
    expect(await prepareWritingPlanContext(tx(db), subject, future)).toBeNull()
    db.agentArtifact.findMany.mockResolvedValue([outline, detail()])
    const context = await prepareWritingPlanContext(tx(db), subject, future)
    expect(context?.outline.content).toBe(outline.content)
    expect(context?.detail.content).toBe(detail().content)
    expect(readWritingPlanContext({ planContext: context })).toEqual(context)
    expect(readWritingPlanContext({})).toBeNull()
  })
  it('blocks missing, stale, ambiguous or incorrectly identified chapter plans', async () => {
    const db = database([outline])
    await expect(prepareWritingPlanContext(tx(db), subject, future)).rejects.toMatchObject({ code: 'DETAIL_PLAN_REQUIRED' })
    db.agentArtifact.findMany.mockResolvedValue([outline, detail(), { ...detail(), id: 'd2' }])
    await expect(prepareWritingPlanContext(tx(db), subject, future)).rejects.toMatchObject({ code: 'PLAN_TARGET_AMBIGUOUS' })
    expect((await prepareWritingPlanContext(tx(db), subject, future, 'd2'))?.detail.id).toBe('d2')
    await expect(prepareWritingPlanContext(tx(db), subject, { chapter: { id: 'created-manually' }, targetOrderIndex: 1 })).rejects.toMatchObject({ code: 'DETAIL_PLAN_REQUIRED' })
    db.agentArtifact.findMany.mockResolvedValue([{ ...outline, content: '新大纲' }, detail()])
    await expect(prepareWritingPlanContext(tx(db), subject, future)).rejects.toMatchObject({ code: 'PLAN_REVIEW_REQUIRED' })
  })
  it('blocks a changed or hidden dependency before effects and upgrades only the frozen future identity', async () => {
    const db = database(), context = await prepareWritingPlanContext(tx(db), subject, future)
    db.agentArtifact.findMany.mockResolvedValue([{ ...outline, content: '并发修改' }, detail()])
    await expect(assertWritingPlanContextCurrent(tx(db), subject, { planContext: context })).rejects.toMatchObject({ code: 'PLAN_CONTEXT_STALE' })
    db.agentArtifact.findMany.mockResolvedValue([outline, detail()])
    const compilation = { id: 'comp', preparedContext: { planContext: context, otherState: 'kept' }, targetOrderIndex: 1 }
    await expect(bindFutureWritingPlan(tx(db), subject, compilation, { id: 'c', orderIndex: 2 })).rejects.toMatchObject({ code: 'PLAN_TARGET_INVALID' })
    expect(db.agentArtifact.update).not.toHaveBeenCalled()
    await bindFutureWritingPlan(tx(db), subject, compilation, { id: 'c', orderIndex: 1 })
    expect(db.agentArtifact.update).toHaveBeenCalledWith(expect.objectContaining({ data: { metadata: expect.objectContaining({ target: { kind: 'chapter', chapterId: 'c' } }) } }))
    expect(db.storyCompilation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ chapterId: 'c', preparedContext: expect.objectContaining({ otherState: 'kept', planContext: expect.objectContaining({ target: { kind: 'chapter', chapterId: 'c' } }) }) }) }))
  })
})

it('keeps semantic review unknown without a current complete response and binds actual plan/manuscript evidence', async () => {
  const context = (await prepareWritingPlanContext(tx(database()), subject, future))!
  const content = '人物离开现场，没有拿钥匙。', table = buildQualityEvidenceSources({ ...subject, chapterId: 'c', chapterRevision: 1 }, content)
  const sources = [{ source: 'current' as const, content, table }]
  const finding = { stage: 'detail_to_chapter', kind: 'contradiction', severity: 'error', explanation: '本章明确离开却未取得钥匙，与本章任务冲突。', planEvidence: [{ planId: context.detail.id, planHash: context.detail.planHash, quote: '本章人物取得钥匙' }], chapterEvidence: [{ sourceId: table.entries[0].id }] }
  const raw = (changes = {}) => JSON.stringify({ findings: [], planAlignment: { version: 1, planContextHash: writingPlanContextHash(context), status: 'reviewed', findings: [finding], ...changes } })
  expect(readPlanAlignment('{"findings":[]}', context, sources).status).toBe('unknown')
  expect(readPlanAlignment(raw(), context, sources).status).toBe('reviewed')
  expect(readPlanAlignment(raw({ planContextHash: 'a'.repeat(64) }), context, sources).status).toBe('unknown')
  expect(readPlanAlignment(raw({ findings: [{ ...finding, chapterEvidence: [] }] }), context, sources).status).toBe('unknown')
  expect(readPlanAlignment(raw({ findings: [{ ...finding, planEvidence: [{ ...finding.planEvidence[0], quote: '编造原文' }] }] }), context, sources).status).toBe('unknown')
  expect(readPlanAlignment(raw({ findings: [{ ...finding, kind: 'omission', chapterEvidence: [] }] }), context, sources).status).toBe('reviewed')
  expect(readPlanAlignment(raw({ findings: [{ ...finding, kind: 'omission', planEvidence: [{ planId: 'o', planHash: context.outline.planHash, quote: '终局返回故乡' }] }] }), context, sources).status).toBe('unknown')
})

 it('distinguishes outline→detail obligations from detail→chapter evidence', async () => {
  const context = (await prepareWritingPlanContext(tx(database()), subject, future))!
  const parent = { planId: context.outline.id, planHash: context.outline.planHash, quote: '第一章取得钥匙' }
  const child = { planId: context.detail.id, planHash: context.detail.planHash, quote: '本章人物取得钥匙' }
  const finding = { stage: 'outline_to_detail', kind: 'omission', severity: 'error', explanation: '本章明确义务在细纲中未落实。', planEvidence: [parent], chapterEvidence: [] }
  const read = (changes = {}) => readPlanAlignment(JSON.stringify({ findings: [], planAlignment: { version: 1,
    planContextHash: writingPlanContextHash(context), status: 'reviewed', findings: [{ ...finding, ...changes }] } }), context, [])
  expect(read().status).toBe('reviewed')
  expect(read({ kind: 'contradiction', planEvidence: [parent, child] }).status).toBe('reviewed')
  expect(read({ kind: 'contradiction', planEvidence: [parent] }).status).toBe('unknown')
  expect(read({ planEvidence: [child] }).status).toBe('unknown')
  expect(read({ planEvidence: [{ ...parent, quote: '并不存在的大纲要求' }] }).status).toBe('unknown')
  expect(read({ stage: 'detail_to_chapter', planEvidence: [parent] }).status).toBe('unknown')
  expect(read({ stage: 'detail_to_chapter', planEvidence: [child] }).status).toBe('reviewed')
})
