import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import router from '../../api/routes/auth.js'
const mocks=vi.hoisted(()=>({register:vi.fn(),session:vi.fn(async()=>({accessToken:'test',refreshToken:'test',expiresInSeconds:60}))}))
vi.mock('../../api/lib/data-access.js',()=>({registerUserData:mocks.register,getUserByPhoneData:vi.fn(),loginUserData:vi.fn()}))
vi.mock('../../api/lib/auth-session.js',()=>({createSession:mocks.session,clearSession:vi.fn(),getSessionUserId:vi.fn(),revokeUserSessions:vi.fn()}))
vi.mock('../../api/lib/sms-service.js',()=>({verifyAuthSmsCode:vi.fn(),sendAuthSmsCode:vi.fn()}))
const app=express();app.use(express.json());app.use(router)
const legalConsent={termsVersionId:'terms-published-id',privacyVersionId:'privacy-published-id'}
beforeEach(()=>{vi.clearAllMocks();mocks.register.mockResolvedValue({id:'user-id',nickname:'Fixture'})})
it.each(['/register','/sms/register'])('forwards phone proof and explicit policy IDs through %s',async path=>{
  const response=await request(app).post(path).send({phone:'+8613900000021',nickname:'Fixture',password:'Test-password',code:'123456',legalConsent})
  expect(response.status).toBe(201)
  expect(mocks.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({phone:'+8613900000021',code:'123456',legalConsent}))
  expect(mocks.session).toHaveBeenCalledOnce()
})
it.each([
  ['/register',{email:'fixture@example.test',nickname:'Fixture'}],
  ['/register',{phone:'+8613900000021',nickname:'Fixture'}],
  ['/sms/register',{phone:'+8613900000021'}],
] as const)('rejects an unverified signup on %s before calling the registration service',async(path,body)=>{
  const response=await request(app).post(path).send({...body,legalConsent})
  expect(response.status).toBe(400)
  expect(mocks.register).not.toHaveBeenCalled()
  expect(mocks.session).not.toHaveBeenCalled()
})
it.each(['/register','/sms/register'])('rejects malformed submitted policy IDs at route boundary %s',async path=>{
  const response=await request(app).post(path).send({phone:'+8613900000021',nickname:'Fixture',code:'123456',legalConsent:{termsVersionId:23,privacyVersionId:'x'}})
  expect(response.status).toBe(400);expect(mocks.register).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled()
})
