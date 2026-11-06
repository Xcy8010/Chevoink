import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import router, { publicSiteContentRouter } from '../../api/routes/site-content.js'
import { DataAccessError } from '../../api/lib/prisma.js'
const mocks=vi.hoisted(()=>({admin:vi.fn(),create:vi.fn(),mutate:vi.fn(),list:vi.fn(),public:vi.fn()}))
vi.mock('../../api/lib/admin-auth.js',()=>({requireAdmin:mocks.admin,getRequestIp:()=>null}))
vi.mock('../../api/lib/site-content.js',()=>({createSiteContent:mocks.create,mutateSiteContent:mocks.mutate,listSiteContent:mocks.list,readPublicSiteContent:mocks.public}))
const app=express();app.use(express.json());app.use('/admin',router);app.use('/public',publicSiteContentRouter)
beforeEach(()=>{vi.clearAllMocks();mocks.admin.mockResolvedValue({id:'admin'});mocks.list.mockResolvedValue([]);mocks.public.mockResolvedValue({announcements:[]})})
it.each([['get','/admin'],['post','/admin'],['post','/admin/some-id']] as const)('authenticates before parsing or mutating content %s %s',async(method,path)=>{
  mocks.admin.mockRejectedValue(new DataAccessError(403,'ADMIN_REQUIRED','需要管理员权限。'))
  const response=await request(app)[method](path).send({malformed:true})
  expect(response.status).toBe(403);expect(mocks.create).not.toHaveBeenCalled();expect(mocks.mutate).not.toHaveBeenCalled();expect(mocks.list).not.toHaveBeenCalled()
})
it('rejects stale-operation payload shape before entering business mutation',async()=>{
  const response=await request(app).post('/admin/notice').send({action:'publish',expectedRevision:0})
  expect(response.status).toBe(400);expect(mocks.mutate).not.toHaveBeenCalled()
})
it('keeps public read anonymous and returns only its public service projection',async()=>{
  const response=await request(app).get('/public')
  expect(response.status).toBe(200);expect(response.body.data).toEqual({announcements:[]});expect(mocks.admin).not.toHaveBeenCalled()
})