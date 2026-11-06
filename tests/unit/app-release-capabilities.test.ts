import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { appReleaseCapabilityGuard } from '../../api/lib/app-release-capabilities.js'
const mocks=vi.hoisted(()=>({admin:vi.fn(),capability:vi.fn(),select:vi.fn(),model:vi.fn()}))
vi.mock('../../api/lib/admin-auth.js',()=>({requireAdmin:mocks.admin}))
vi.mock('../../api/lib/auth-session.js',()=>({requireSessionUserId:()=> 'fixture-user'}))
vi.mock('../../api/lib/app-releases.js',()=>({requireAppReleaseCapability:mocks.capability,selectAppRelease:mocks.select}))
vi.mock('../../api/lib/prisma.js',()=>({prisma:{aiModelConfig:{findUnique:mocks.model}}}))
const app=express();app.use(express.json());app.use(appReleaseCapabilityGuard);app.use((_req,res)=>res.json({success:true,data:{models:[{label:'Model',multiplier:1,pricing:{inputPerMillion:1},publicDescription:'Details',publicFeatures:['Feature'],activity:{name:'Activity'},freePromotion:{enabled:true}}]}}))
beforeEach(()=>{vi.clearAllMocks();mocks.admin.mockResolvedValue({id:'admin'});mocks.capability.mockResolvedValue({mode:'legacy'});mocks.select.mockResolvedValue({mode:'artifact',release:{capabilities:[]}});mocks.model.mockResolvedValue({metadata:{modelKind:'image_generation'}})})
it.each([['/site-content','siteContent'],['/admin/site-content','siteContent'],['/admin/testers','testerManagement']])('guards actual new route %s with server-selected capability %s',async(path,capability)=>{await request(app).get(path).set('x-release-channel','test');expect(mocks.capability).toHaveBeenCalledWith(expect.anything(),capability)})
it('guards image quality, promotions and public detail configuration on real model updates',async()=>{await request(app).patch('/admin/models/image-id').send({imageQuality:{defaultValue:'high',supportedValues:['high']},activities:null,publicDescription:'Description',weightedRoutes:{primaryWeight:1,candidates:[]}});expect(mocks.admin).toHaveBeenCalledOnce();expect(mocks.capability.mock.calls.map(call=>call[1])).toEqual(['imageQuality','modelPromotions','publicModelDetails','imageWeightedRoutes'])})
it('does not gate or reinterpret existing text weights or admitted Agent task execution',async()=>{mocks.model.mockResolvedValue({metadata:{modelKind:'text'}});await request(app).patch('/admin/models/text-id').send({weightedRoutes:{primaryWeight:1,candidates:[]}});expect(mocks.capability).not.toHaveBeenCalled();await request(app).post('/agent/runs/existing/continue').send({message:'continue'});expect(mocks.capability).not.toHaveBeenCalled()})
it('projects optional public model details without changing current billed price',async()=>{const response=await request(app).get('/credits/summary');expect(response.body.data.models[0]).toEqual({label:'Model',multiplier:1,pricing:{inputPerMillion:1}})})
it('leaves canonical registration policy reads outside the optional content capability',async()=>{await request(app).get('/auth/legal-policies');expect(mocks.capability).not.toHaveBeenCalled();expect(mocks.select).not.toHaveBeenCalled()})
it('keeps tester identity writes behind testerManagement while leaving role-only identity saves on the existing role boundary', async () => {
  await request(app).put('/admin/users/synthetic-user/identity').send({ operationId: 'synthetic', role: 'admin', expectedRole: 'user' })
  expect(mocks.capability).not.toHaveBeenCalled()
  await request(app).put('/ADMIN/users/synthetic-user/IDENTITY/').send({ operationId: 'synthetic', tester: { enabled: true } })
  expect(mocks.admin).toHaveBeenCalledOnce()
  expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), 'testerManagement')
})
it('keeps tester-only model selection within the selected release capability', async () => {
  mocks.model.mockResolvedValue({ metadata: { modelKind: 'text' } })
  await request(app).patch('/admin/models/text-id').send({ testerSelectable: true })
  expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), 'testerManagement')
})
