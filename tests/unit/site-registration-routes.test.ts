import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import router from '../../api/routes/auth.js'
const mocks=vi.hoisted(()=>({register:vi.fn(),session:vi.fn(async()=>({accessToken:'test',refreshToken:'test',expiresInSeconds:60})),verifySms:vi.fn(async()=>({phone:'+8613900000021'}))}))
vi.mock('../../api/lib/data-access.js',()=>({registerUserData:mocks.register,getUserByPhoneData:vi.fn(),loginUserData:vi.fn()}))
vi.mock('../../api/lib/auth-session.js',()=>({createSession:mocks.session,clearSession:vi.fn(),getSessionUserId:vi.fn(),revokeUserSessions:vi.fn()}))
vi.mock('../../api/lib/sms-service.js',()=>({verifyAuthSmsCode:mocks.verifySms,sendAuthSmsCode:vi.fn()}))
const app=express();app.use(express.json());app.use(router)
const legalConsent={termsVersionId:'terms-published-id',privacyVersionId:'privacy-published-id'}
beforeEach(()=>{vi.clearAllMocks();mocks.register.mockResolvedValue({id:'user-id',nickname:'Fixture'})})
it('passes explicit consent IDs through the phone-capable password registration route',async()=>{
  const response=await request(app).post('/register').send({phone:'+8613900000021',nickname:'Fixture',password:'Test-password',legalConsent})
  expect(response.status).toBe(201)
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({phone:'+8613900000021',legalConsent}))
  expect(mocks.session).toHaveBeenCalledOnce()
})
it('passes the same consent IDs through SMS registration after verifying the submitted phone',async()=>{
  const response=await request(app).post('/sms/register').send({phone:'+8613900000021',code:'123456',legalConsent})
  expect(response.status).toBe(201)
  expect(mocks.verifySms).toHaveBeenCalledWith({phone:'+8613900000021',code:'123456',purpose:'register'})
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({phone:'+8613900000021',legalConsent}))
})
it.each(['/register','/sms/register'])('rejects malformed submitted policy IDs at route boundary %s',async path=>{
  const response=await request(app).post(path).send({phone:'+8613900000021',nickname:'Fixture',code:'123456',legalConsent:{termsVersionId:23,privacyVersionId:'x'}})
  expect(response.status).toBe(400);expect(mocks.register).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled()
})