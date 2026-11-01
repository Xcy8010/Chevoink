import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { DataAccessError } from '../../api/lib/prisma.js'
const mocks = vi.hoisted(() => ({ accounts:vi.fn(),auth:vi.fn(),request:vi.fn() }))
vi.mock('../../api/lib/admin-auth.js', async original => ({ ...await original<object>(),requireAdmin:mocks.auth }))
vi.mock('../../api/lib/admin-credit-accounts.js',()=>({getPagedAdminCreditAccounts:mocks.accounts}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
import {getAdminCreditsManagement} from '../../api/lib/admin-credit-model.js'
import {getAdminCreditsManagement as fetchCredits} from '../../src/features/admin/api'
import adminRouter from '../../api/routes/admin.js'
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({id:'fixture-admin',isSuperAdmin:true});mocks.accounts.mockResolvedValue({users:[],summary:{users:41},pagination:{page:2,pageSize:20,total:41,hasMore:true},summaryScope:'global'});mocks.request.mockResolvedValue({})})
it('forwards bounded page and search while the real SQL/virtual-window behavior is covered by isolated integration', async()=>{
  await getAdminCreditsManagement('作者',{page:2,pageSize:20})
  expect(mocks.accounts).toHaveBeenCalledWith('作者',2,20)
  await getAdminCreditsManagement()
  expect(mocks.accounts).toHaveBeenLastCalledWith(undefined,1,20)
})
it('authenticates before querying and validates page bounds without reducing global totals to the filter',async()=>{
 const app=express().use('/api/admin',adminRouter)
 const found=await request(app).get('/api/admin/credits').query({search:'  outside-user  ',page:2,pageSize:20})
 expect(found.status).toBe(200);expect(mocks.accounts).toHaveBeenLastCalledWith('outside-user',2,20);expect(found.body.data.summary.users).toBe(41)
 mocks.accounts.mockClear()
 for(const query of [{page:0},{pageSize:101},{page:'nope'},{search:'x'.repeat(161)}]) expect((await request(app).get('/api/admin/credits').query(query)).status).toBe(400)
 expect(mocks.accounts).not.toHaveBeenCalled()
 mocks.auth.mockRejectedValue(new DataAccessError(403,'ADMIN_REQUIRED','无管理权限'))
 expect((await request(app).get('/api/admin/credits').query({search:'outside-user'})).status).toBe(403)
 expect(mocks.accounts).not.toHaveBeenCalled()
})
it('encodes search and server pagination and supports clearing search',async()=>{
 await fetchCredits('邮箱+tag@example.invalid & 名字',{page:3,pageSize:20})
 expect(mocks.request).toHaveBeenLastCalledWith('/api/admin/credits?'+new URLSearchParams({search:'邮箱+tag@example.invalid & 名字',page:'3',pageSize:'20'}).toString())
 await fetchCredits();expect(mocks.request).toHaveBeenLastCalledWith('/api/admin/credits')
})
