import { extractAuthorStyleProfile } from '../../api/lib/agent/craft-library.js'
import { startStyleLearning } from '../../api/lib/agent/style-learning.js'
import { preflightNovelImport, prepareNovelImport } from '../../api/lib/novel-import-service.js'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'express'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { createSession } from '../../api/lib/auth-session.js'
import { encryptSecret } from '../../api/lib/secret-box.js'
import { updateTester, updateUserIdentity } from '../../api/lib/tester-entitlement.js'
import { assertCreditAccess, getCreditSummary, getModelTierRuntime, initializeNewUserCredits } from '../../api/lib/credits.js'
import { resolveAssignedModel } from '../../api/lib/agent/model-assignments.js'
import { modelListTool } from '../../api/lib/agent/tools/configuration-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { captureAdminModelVersion } from '../../api/lib/model-lifecycle.js'
import { generateTextCompletion } from '../../api/lib/ai-service.js'
import { verifyTestDatabase } from '../support/database-preflight.js'

// Version/capability projection has its own actual-router regressions. This group
// verifies real auth, transactions, selection and billing against synthetic rows.
vi.mock('../../api/lib/app-releases.js', async original => ({ ...await original<object>(),
  selectAppReleaseForUser: async () => ({ mode: 'legacy', channel: 'stable' }),
  selectAppRelease: async () => ({ mode: 'legacy', channel: 'stable' }),
  requireAppReleaseCapability: async () => ({ mode: 'legacy', channel: 'stable' }),
}))
await verifyTestDatabase(true)
const users: string[] = [], models: string[] = [], novels: string[] = [], sessions: string[] = [], runs: string[] = []
async function user(role: 'user' | 'admin' = 'user', tester = false, superAdmin = false) {
  const id = randomUUID(); users.push(id)
  await prisma.user.create({ data: { id, nickname: 'Synthetic identity fixture', role, isSuperAdmin: superAdmin, passwordHash: 'unusable' } })
  await prisma.$transaction(tx => initializeNewUserCredits(tx, id))
  if (tester) await prisma.testerEntitlement.create({ data: { userId: id, reason: 'Synthetic grant', grantedById: id } })
  const response = { append: () => response } as unknown as Response
  const token = (await createSession(id, response)).accessToken
  return { id, token }
}
async function model(flag?: boolean, namedTier?: 'standard') {
  const tier = namedTier ?? `builtin_${randomBytes(8).toString('hex')}`
  const row = await prisma.aiModelConfig.create({ data: { key: tier, tier, provider: 'openai', displayName: 'Synthetic tester model', modelName: 'synthetic-text',
    baseUrl: 'https://synthetic.invalid/v1', apiKeyCiphertext: encryptSecret('synthetic-offline-key'), enabled: true, selectable: false, multiplierBps: 0,
    metadata: { modelKind: 'text', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', reasoningParameterMode: 'omit', ...(flag === undefined ? {} : { testerSelectable: flag }) } } })
  models.push(row.id)
  return { ...row, tier: tier as 'standard' | `builtin_${string}` }
}
async function novel(userId: string) {
  const row=await prisma.novel.create({data:{authorId:userId,title:'Synthetic selection boundary',slug:randomUUID(),summary:''}})
  novels.push(row.id);return {userId,novelId:row.id}
}
const grant = (enabled = true, expectedRevision = 0) => ({ enabled, expectedRevision, reason: 'Synthetic identity change', expiresAt: null })
const identity = (token: string, id: string, body: unknown) => request(app).put(`/api/admin/users/${id}/identity`).set('Authorization', `Bearer ${token}`).send(body)
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await prisma.aiUsageLog.deleteMany({ where: { userId: { in: users } } })
  await prisma.agentRun.deleteMany({ where: { id: { in: runs.splice(0) } } })
  await prisma.agentSession.deleteMany({ where: { id: { in: sessions.splice(0) } } })
  await prisma.novel.deleteMany({ where: { id: { in: novels.splice(0) } } })
  await prisma.aiModelConfigVersion.deleteMany({ where: { modelConfigId: { in: models } } })
  await prisma.aiModelConfig.deleteMany({ where: { id: { in: models.splice(0) } } })
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } })
})
afterAll(async () => { await prisma.$disconnect() })

describe('atomic user identity and tester model access on isolated PostgreSQL', () => {
  it('returns real tester identity in admin list/detail and makes super-admin qualification intrinsic', async () => {
    const admin = await user('admin'), target = await user('user', true), superAdmin = await user('admin', false, true)
    const list = await request(app).get('/api/admin/users').query({ search: target.id }).set('Authorization', `Bearer ${admin.token}`)
    expect(list.status).toBe(200)
    expect(list.body.data.items[0]).toMatchObject({ id: target.id, isSuperAdmin: false, role: 'user', tester: { enabled: true, effective: true, revision: 1, expiresAt: null, reason: 'Synthetic grant' } })
    const detail = await request(app).get(`/api/admin/users/${superAdmin.id}`).set('Authorization', `Bearer ${admin.token}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.user).toMatchObject({ isSuperAdmin: true, tester: { enabled: false, effective: true, revision: 0 } })
  })
  it('allows ordinary-admin tester grants and revocations with replay, while preserving administrator role', async () => {
    const admin = await user('admin'), target = await user()
    const input = { operationId: randomUUID(), tester: grant() }
    const first = await identity(admin.token, target.id, input)
    expect(first.status).toBe(200)
    expect(first.body.data).toMatchObject({ role: 'user', tester: { effective: true, revision: 1 }, replayed: false })
    const replay = await identity(admin.token, target.id, input)
    expect(replay.body.data).toMatchObject({ role: 'user', tester: { revision: 1 }, replayed: true })
    expect((await identity(admin.token, target.id, { ...input, tester: grant(false) })).status).toBe(409)
    expect((await identity(admin.token, target.id, { operationId: randomUUID(), tester: grant(false, 1) })).body.data.tester).toMatchObject({ effective: false, revision: 2 })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('user')
    expect(await prisma.adminAuditLog.count({ where: { adminId: admin.id, action: 'user.set_identity' } })).toBe(2)
  })
  it('rejects forged ordinary-user and ordinary-admin role requests without partially saving tester status', async () => {
    const ordinary = await user(), admin = await user('admin'), target = await user()
    expect((await identity(ordinary.token, ordinary.id, { operationId: randomUUID(), tester: grant() })).status).toBe(403)
    const response = await identity(admin.token, target.id, { operationId: randomUUID(), role: 'admin', expectedRole: 'user', tester: grant() })
    expect(response.status).toBe(403)
    expect(await prisma.testerEntitlement.findUnique({ where: { userId: target.id } })).toBeNull()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('user')
  })
  it('saves role plus tester atomically and rolls both back on stale role or grant revision', async () => {
    const admin = await user('admin', false, true), target = await user()
    await expect(updateUserIdentity(admin.id, target.id, { operationId: randomUUID(), role: 'admin', expectedRole: 'user', tester: grant(true, 1) }, null)).rejects.toMatchObject({ code: 'TESTER_REVISION_CONFLICT' })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('user')
    const input = { operationId: randomUUID(), role: 'admin' as const, expectedRole: 'user' as const, tester: grant() }
    expect(await updateUserIdentity(admin.id, target.id, input, null)).toMatchObject({ role: 'admin', tester: { effective: true, revision: 1 } })
    expect(await updateUserIdentity(admin.id, target.id, input, null)).toMatchObject({ replayed: true })
    await expect(updateUserIdentity(admin.id, target.id, { operationId: randomUUID(), role: 'user', expectedRole: 'user', tester: grant(false, 1) }, null)).rejects.toMatchObject({ code: 'USER_IDENTITY_CONFLICT' })
    expect((await prisma.testerEntitlement.findUniqueOrThrow({ where: { userId: target.id } })).enabled).toBe(true)
  })
  it('protects super-admin intrinsic qualification and self-role boundaries, including the legacy tester endpoint', async () => {
    const admin = await user('admin'), superAdmin = await user('admin', false, true)
    await expect(updateUserIdentity(admin.id, superAdmin.id, { operationId: randomUUID(), tester: grant(false) }, null)).rejects.toMatchObject({ code: 'SUPER_ADMIN_TESTER_REQUIRED' })
    await expect(updateTester(admin.id, superAdmin.id, { ...grant(false), operationId: randomUUID() }, null)).rejects.toMatchObject({ code: 'SUPER_ADMIN_TESTER_REQUIRED' })
    await expect(updateUserIdentity(superAdmin.id, superAdmin.id, { operationId: randomUUID(), role: 'user', expectedRole: 'admin' }, null)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const otherSuper = await user('admin', false, true)
    await expect(updateUserIdentity(superAdmin.id, otherSuper.id, { operationId: randomUUID(), role: 'user', expectedRole: 'admin' }, null)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await prisma.user.update({ where: { id: admin.id }, data: { bannedAt: new Date() } })
    await expect(updateUserIdentity(admin.id, superAdmin.id, { operationId: randomUUID(), tester: grant() }, null)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' })
  })
  it('serializes competing revisions and duplicate operations without duplicate audit receipts', async () => {
    const admin = await user('admin'), target = await user()
    const input = { operationId: randomUUID(), tester: grant() }
    const same = await Promise.all([updateUserIdentity(admin.id, target.id, input, null), updateUserIdentity(admin.id, target.id, input, null)])
    expect(same.map(row => row.replayed).sort()).toEqual([false, true])
    const different = await Promise.allSettled([true, false].map(enabled => updateUserIdentity(admin.id, target.id, { operationId: randomUUID(), tester: grant(enabled, 1) }, null)))
    expect(different.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(different.filter(row => row.status === 'rejected')).toHaveLength(1)
    expect(await prisma.adminAuditLog.count({ where: { adminId: admin.id, action: 'user.set_identity' } })).toBe(2)
  })
  it('keeps tester-only models invisible and uncallable for ordinary users/admins but permits granted testers and super-admins', async () => {
    const ordinary = await user(), admin = await user('admin'), tester = await user('user', true), superAdmin = await user('admin', false, true), row = await model(true)
    for (const caller of [ordinary, admin]) {
      expect((await getCreditSummary(caller.id)).models.some(item => item.tier === row.tier)).toBe(false)
      const listed = await modelListTool.execute({ userId: caller.id, novelId: '', sessionId: 'synthetic', runId: 'synthetic', mode: 'build', signal: new AbortController().signal } as ToolContext, {})
      expect(JSON.parse(listed.output).models.some((item: { modelTier: string }) => item.modelTier === row.tier)).toBe(false)
      await expect(assertCreditAccess(caller.id, row.tier)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
      await expect(getModelTierRuntime(row.tier, caller.id)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
      const forged = await request(app).patch('/api/agent/model-assignments').set('Authorization', `Bearer ${caller.token}`).send({ scope: 'global', expectedRevision: 0, assignments: { main: { modelTier: row.tier } } })
      expect(forged.status).toBe(409)
      expect(await prisma.agentModelAssignment.count({ where: { userId: caller.id } })).toBe(0)
    }
    for (const caller of [tester, superAdmin]) {
      expect((await getCreditSummary(caller.id)).models.find(item => item.tier === row.tier)).toMatchObject({ available: true })
      const listed = await modelListTool.execute({ userId: caller.id, novelId: '', sessionId: 'synthetic', runId: 'synthetic', mode: 'build', signal: new AbortController().signal } as ToolContext, {})
      expect(JSON.parse(listed.output).models.some((item: { modelTier: string }) => item.modelTier === row.tier)).toBe(true)
      await expect(assertCreditAccess(caller.id, row.tier)).resolves.toBeUndefined()
      expect((await resolveAssignedModel(caller.id, { modelTier: row.tier }, false, true)).runtime.modelName).toBe('synthetic-text')
    }
  })
  it.each([undefined, false])('defaults the tester-selection metadata to closed (%s)', async flag => {
    const tester = await user('user', true), row = await model(flag)
    expect((await getCreditSummary(tester.id)).models.some(item => item.tier === row.tier)).toBe(false)
    await expect(assertCreditAccess(tester.id, row.tier)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
  })
  it('keeps publicly selectable models public and rejects disabled, archived and invalid configurations for testers', async () => {
    const ordinary = await user(), tester = await user('user', true), row = await model(true)
    await prisma.aiModelConfig.update({ where: { id: row.id }, data: { selectable: true } })
    await expect(assertCreditAccess(ordinary.id, row.tier)).resolves.toBeUndefined()
    expect((await getCreditSummary(ordinary.id)).models.find(item => item.tier === row.tier)).toMatchObject({ available: true })
    for (const data of [{ selectable: false, enabled: false }, { enabled: true, archivedAt: new Date() }, { archivedAt: null, modelName: 'unconfigured' }]) {
      await prisma.aiModelConfig.update({ where: { id: row.id }, data })
      await expect(assertCreditAccess(tester.id, row.tier)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
      await expect(getModelTierRuntime(row.tier, tester.id)).rejects.toBeInstanceOf(Error)
    }
  })
  it('rechecks expiration, revocation and bans on new admission without invoking the provider', async () => {
    const tester = await user('user', true), row = await model(true)
    for (const data of [{ expiresAt: new Date(Date.now() - 1) }, { expiresAt: null, enabled: false }, { enabled: true }]) {
      await prisma.testerEntitlement.update({ where: { userId: tester.id }, data })
      if (data.enabled === true) await prisma.user.update({ where: { id: tester.id }, data: { bannedAt: new Date() } })
      expect((await getCreditSummary(tester.id)).models.some(item => item.tier === row.tier)).toBe(false)
      await expect(assertCreditAccess(tester.id, row.tier)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
    }
  })
  it('calls only the mocked provider for an admitted tester and preserves retained model/version/price and unknown evidence after revocation', async () => {
    const tester = await user('user', true), row = await model(true)
    await assertCreditAccess(tester.id, row.tier)
    const runtime = await getModelTierRuntime(row.tier, tester.id)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"synthetic ready"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })))
    expect(await generateTextCompletion('synthetic system', 'synthetic user', { userId: tester.id, action: 'syntheticTesterSelection', modelRuntime: runtime })).toBe('synthetic ready')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).model).toBe('synthetic-text')
    const novel = await prisma.novel.create({ data: { authorId: tester.id, title: 'Synthetic retained model', slug: randomUUID(), summary: '' } }); novels.push(novel.id)
    const session = await prisma.agentSession.create({ data: { userId: tester.id, novelId: novel.id, title: 'Synthetic retained session' } }); sessions.push(session.id)
    const run = await prisma.agentRun.create({ data: { userId: tester.id, novelId: novel.id, sessionId: session.id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startedAt: new Date(), modelTier: row.tier, modelConfigId: row.id, modelConfigRevision: row.revision, modelPriceSnapshot: JSON.parse(JSON.stringify(runtime.tokenPrice)) } }); runs.push(run.id)
    const unknown = await prisma.aiUsageLog.create({ data: { userId: tester.id, providerType: 'text', providerMode: 'synthetic', modelName: row.modelName, action: 'syntheticUnknown', targetType: 'synthetic', durationMs: 0, requestTokens: null, responseTokens: null, usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 9000 } })
    await prisma.$transaction(async tx => { await captureAdminModelVersion(tx, row); await tx.aiModelConfig.update({ where: { id: row.id }, data: { modelName: 'changed-model', multiplierBps: 20000, revision: { increment: 1 }, metadata: { testerSelectable: false } } }) })
    await prisma.testerEntitlement.update({ where: { userId: tester.id }, data: { enabled: false } })
    const retained = await getModelTierRuntime(row.tier, tester.id, null, 'high', { userId: tester.id, runId: run.id, modelConfigId: row.id, modelConfigRevision: row.revision })
    expect(retained).toMatchObject({ modelConfigId: row.id, modelConfigRevision: row.revision, modelName: row.modelName, multiplierBps: 0, tokenPrice: runtime.tokenPrice })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).modelPriceSnapshot).toEqual(JSON.parse(JSON.stringify(runtime.tokenPrice)))
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 9000, requestTokens: null, responseTokens: null })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('denies a named hidden standard model on genuine new import selection without contacting a provider', async () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED','true')
    expect(await prisma.aiModelConfig.count({where:{ownerUserId:null,tier:'standard',enabled:true,archivedAt:null}})).toBe(0)
    const ordinary=await user(),row=await model(true,'standard'),scope=await novel(ordinary.id)
    const intent=await preflightNovelImport(scope)
    const provider=vi.fn();vi.stubGlobal('fetch',provider)
    await expect(prepareNovelImport(scope,intent.intentId,{kind:'builtin',modelTier:row.tier,reasoningEffort:'high'})).rejects.toMatchObject({code:'MODEL_TIER_UNAVAILABLE'})
    expect(await prisma.novelImportJob.count({where:scope})).toBe(0)
    expect(provider).not.toHaveBeenCalled()
  })
  it('rechecks revoked named-tier assignments for new import/style tasks while replaying existing jobs unchanged', async () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED','true')
    expect(await prisma.aiModelConfig.count({where:{ownerUserId:null,tier:'standard',enabled:true,archivedAt:null}})).toBe(0)
    const tester=await user('user',true),row=await model(true,'standard'),original=await novel(tester.id),next=await novel(tester.id)
    await prisma.agentModelAssignment.create({data:{userId:tester.id,scopeKey:'',assignments:{import_analysis:{modelTier:row.tier,reasoningEffort:'high'},style_learning:{modelTier:row.tier,reasoningEffort:'high'}}}})
    const content='合成样章仅供数据库测试，不发送给任何外部服务。'.repeat(40)
    const profile=await extractAuthorStyleProfile({userId:tester.id,novelId:original.novelId,title:'Synthetic selection sample',chapterIds:[],uploadedFile:{name:'synthetic.md',size:Buffer.byteLength(content),content}})
    const newProfile=await extractAuthorStyleProfile({userId:tester.id,novelId:next.novelId,title:'Synthetic new selection sample',chapterIds:[],uploadedFile:{name:'synthetic.md',size:Buffer.byteLength(content),content}})
    const provider=vi.fn();vi.stubGlobal('fetch',provider)
    const oldIntent=await preflightNovelImport(original)
    const imported=await prepareNovelImport(original,oldIntent.intentId)
    const styleInput={requestId:randomUUID(),profileId:profile.profileId,consent:true as const}
    const learned=await startStyleLearning(tester.id,original.novelId,styleInput)
    const frozenImport=await prisma.novelImportJob.findUniqueOrThrow({where:{id:imported.jobId}})
    const frozenStyle=await prisma.styleLearningJob.findUniqueOrThrow({where:{id:learned.id}})
    await prisma.testerEntitlement.update({where:{userId:tester.id},data:{enabled:false}})
    const nextIntent=await preflightNovelImport(next)
    await expect(prepareNovelImport(next,nextIntent.intentId)).rejects.toMatchObject({code:'MODEL_TIER_UNAVAILABLE'})
    await expect(prepareNovelImport(next,nextIntent.intentId,{kind:'builtin',modelTier:row.tier,reasoningEffort:'high'})).rejects.toMatchObject({code:'MODEL_TIER_UNAVAILABLE'})
    await expect(startStyleLearning(tester.id,next.novelId,{requestId:randomUUID(),profileId:newProfile.profileId,consent:true})).rejects.toMatchObject({code:'MODEL_TIER_UNAVAILABLE'})
    await expect(startStyleLearning(tester.id,next.novelId,{requestId:randomUUID(),profileId:newProfile.profileId,consent:true,model:{modelTier:row.tier,reasoningEffort:'high'}})).rejects.toMatchObject({code:'MODEL_TIER_UNAVAILABLE'})
    expect((await prepareNovelImport(original,oldIntent.intentId)).jobId).toBe(imported.jobId)
    expect((await startStyleLearning(tester.id,original.novelId,styleInput)).id).toBe(learned.id)
    expect(await prisma.novelImportJob.findUniqueOrThrow({where:{id:imported.jobId}})).toEqual(frozenImport)
    expect(await prisma.styleLearningJob.findUniqueOrThrow({where:{id:learned.id}})).toEqual(frozenStyle)
    expect(await prisma.novelImportJob.count({where:next})).toBe(0)
    expect(await prisma.styleLearningJob.count({where:{profileId:newProfile.profileId}})).toBe(0)
    expect(provider).not.toHaveBeenCalled()
  })

})
