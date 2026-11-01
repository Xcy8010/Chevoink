import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'

const mocks = vi.hoisted(() => ({ auth:vi.fn(), calls:vi.fn(), runs:vi.fn(), health:vi.fn(), logs:vi.fn() }))
vi.mock('../../api/lib/admin-auth.js', async original => ({...await original<object>(),requireAdmin:mocks.auth}))
vi.mock('../../api/lib/admin-operations.js',()=>({listAdminOperationCalls:mocks.calls,listAdminOperationRuns:mocks.runs,getAdminOperationsHealth:mocks.health}))
vi.mock('../../api/lib/data-access.js',async original=>({...await original<object>(),listAdminAuditLogsData:mocks.logs}))
import router from '../../api/routes/admin.js'

const app = express().use('/api/admin',router)
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({id:'synthetic-admin'});for(const fn of [mocks.calls,mocks.runs,mocks.health,mocks.logs])fn.mockResolvedValue({items:[]})})

it('authenticates every operations and audit query before validation or data access',async()=>{
  mocks.auth.mockRejectedValue(new DataAccessError(403,'ADMIN_REQUIRED','无管理权限'))
  for(const path of ['calls','runs','health'])expect((await request(app).get('/api/admin/operations/'+path).query({page:'bad'})).status).toBe(403)
  expect((await request(app).get('/api/admin/logs').query({from:'bad'})).status).toBe(403)
  expect((await request(app).get('/api/admin/integrations/status')).status).toBe(403)
  for(const fn of [mocks.calls,mocks.runs,mocks.health,mocks.logs])expect(fn).not.toHaveBeenCalled()
})
it('exposes only local blocked integration status with no fabricated production version or external snapshot', async()=>{
  const response = await request(app).get('/api/admin/integrations/status')
  expect(response.status).toBe(200)
  expect(response.body.data.system.releaseVersion).toBeNull()
  expect(response.body.data.resources).toHaveLength(4)
  for(const resource of response.body.data.resources)expect(resource).toMatchObject({state:'blocked',canRead:false,snapshot:null,lastSuccessAt:null})
  expect(JSON.stringify(response.body)).not.toMatch(/DATABASE_URL|apiKeyCiphertext|apiKey|password/)
})
it('validates bounded queries and paired dates once before forwarding typed filters',async()=>{
  expect((await request(app).get('/api/admin/operations/calls').query({source:'usage',page:2,pageSize:20,model:'synthetic-model'})).status).toBe(200)
  expect(mocks.calls).toHaveBeenCalledWith({source:'usage',period:'today',page:2,pageSize:20,model:'synthetic-model'})
  mocks.calls.mockClear()
  for(const query of [{page:0},{pageSize:101},{source:'all'},{from:'2026-11-01T00:00:00Z'},{from:'2026-11-02T00:00:00Z',to:'2026-11-01T00:00:00Z'},{body:'private'}])expect((await request(app).get('/api/admin/operations/calls').query(query)).status).toBe(400)
  expect(mocks.calls).not.toHaveBeenCalled()
  expect((await request(app).get('/api/admin/operations/runs').query({status:'failed',user:'synthetic-user'})).status).toBe(200)
  expect(mocks.runs).toHaveBeenCalledWith(expect.objectContaining({status:'failed',user:'synthetic-user'}))
  expect((await request(app).get('/api/admin/operations/health').query({errorCategory:'unknown_result'})).status).toBe(200)
  expect(mocks.health).toHaveBeenCalledWith(expect.objectContaining({errorCategory:'unknown_result'}))
})
it('rejects invalid calendar days and forwards UTC+8 audit day bounds and server filters',async()=>{
  for(const query of [{from:'2026-02-30'},{from:'2026-11-02',to:'2026-11-01'},{pageSize:101},{operator:'x'.repeat(101)}])expect((await request(app).get('/api/admin/logs').query(query)).status).toBe(400)
  expect(mocks.logs).not.toHaveBeenCalled()
  expect((await request(app).get('/api/admin/logs').query({operator:' synthetic-admin ',objectId:'synthetic-model',from:'2026-11-01',to:'2026-11-01'})).status).toBe(200)
  expect(mocks.logs).toHaveBeenCalledWith(expect.objectContaining({operator:'synthetic-admin',objectId:'synthetic-model',from:new Date('2026-10-31T16:00:00.000Z'),to:new Date('2026-11-01T15:59:59.999Z')}))
})
