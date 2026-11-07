import { beforeEach, expect, it, vi } from 'vitest'
import { registerUserData } from '../../api/lib/data/user.js'

const state=vi.hoisted(()=>({users:[] as Array<Record<string,unknown>>,consents:[] as Array<Record<string,unknown>>,audits:[] as Array<Record<string,unknown>>,events:[] as string[],creditsFail:false,policies:true,smsClaimed:false}))
const db={
  $executeRaw:vi.fn(async()=>{state.events.push('lock');return 1}),
  siteContent:{findMany:vi.fn(async()=>state.policies ? ['terms','privacy'].map(kind=>({id:kind,kind,key:kind,deletedAt:null,withdrawn:false,publishedVersionId:`${kind}-v1`,versions:[{id:`${kind}-v1`,contentVersion:1,hash:`hash-${kind}`,effectiveAt:new Date('2020-01-01T00:00:00Z'),payload:{title:kind,body:'Synthetic test fixture',effectiveAt:'2020-01-01T00:00:00.000Z'}}]})) : [])},
  user:{findFirst:vi.fn(async()=>null),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{state.events.push('user');state.users.push(data);return data})},
  userLegalConsent:{createMany:vi.fn(async({data}:{data:Array<Record<string,unknown>>})=>{state.events.push('consents');state.consents.push(...data);return {count:data.length}})},
  adminAuditLog:{create:vi.fn(async({data}:{data:Record<string,unknown>})=>{state.events.push('audit');state.audits.push(data);return data})},
}
const prisma={...db,$transaction:async<T>(work:(tx:typeof db)=>Promise<T>)=>{const snapshot=structuredClone({users:state.users,consents:state.consents,audits:state.audits,smsClaimed:state.smsClaimed});try{return await work(db)}catch(error){Object.assign(state,snapshot);throw error}}}
vi.mock('../../api/lib/prisma.js',()=>({prisma:new Proxy({}, {get:(_target,key)=>prisma[key as keyof typeof prisma]}),DataAccessError:class extends Error{constructor(public status:number,public code:string,message:string){super(message)}}}))
vi.mock('../../api/lib/credits.js',()=>({initializeNewUserCredits:vi.fn(async()=>{state.events.push('credits');if(state.creditsFail)throw new Error('credits failure')})}))
vi.mock('../../api/lib/auth-session.js',()=>({evictUserBanCache:vi.fn()}))
vi.mock('../../api/lib/sms-service.js',()=>({prepareAuthSmsCode:async (proof:{phone:string;purpose:string;code:string})=>{
  expect(proof).toEqual({phone:'+8613900000021',purpose:'register',code:'678123'})
  return {phone:proof.phone,consume:async (tx:typeof db)=>{
    expect(tx).toBe(db)
    state.events.push('sms')
    state.smsClaimed=true
  }}
}}))
vi.mock('../../api/lib/data/internal.js',()=>({ensureNonEmptyText:(value:string)=>value,toUser:(value:unknown)=>value,buildAutoNickname:async()=> 'Fixture User'}))
vi.mock('../../api/lib/data/comment.js',()=>({getViewerLikedCommentIds:vi.fn()}))
vi.mock('../../api/lib/data/post.js',()=>({attachPostViewerFlags:vi.fn(),getViewerPostFlags:vi.fn()}))
vi.mock('../../api/lib/data/search.js',()=>({searchableNovelWhere:vi.fn()}))
const input={phone:'+8613900000021',code:'678123',nickname:'Fixture User',password:'Fixture-password',legalConsent:{termsVersionId:'terms-v1',privacyVersionId:'privacy-v1'}}
beforeEach(()=>{vi.useRealTimers();vi.clearAllMocks();state.users=[];state.consents=[];state.audits=[];state.events=[];state.creditsFail=false;state.policies=true;state.smsClaimed=false})
it('records explicit current version/hash/time and audit inside user registration transaction',async()=>{
  const user=await registerUserData(input)
  expect(state.events).toEqual(['lock','sms','user','consents','audit','credits'])
  expect(state.smsClaimed).toBe(true)
  expect(state.consents).toHaveLength(2)
  expect(state.consents[0]).toMatchObject({userId:user.id,kind:'terms',versionId:'terms-v1',hash:'hash-terms',acceptedAt:expect.any(Date)})
  expect(state.consents[1]).toMatchObject({userId:user.id,kind:'privacy',versionId:'privacy-v1',hash:'hash-privacy'})
  expect(state.consents[0].acceptedAt).toBe(state.consents[1].acceptedAt)
  expect(state.audits[0]).toMatchObject({action:'registration.legal_consent',targetId:user.id})
})
it.each([undefined,{termsVersionId:'old',privacyVersionId:'privacy-v1'}])('rejects missing or stale consent for every direct service caller before creating user',async legalConsent=>{
  await expect(registerUserData({...input,legalConsent})).rejects.toMatchObject({code:'POLICY_CONSENT_REQUIRED'})
  expect(state.users).toEqual([]);expect(state.consents).toEqual([]);expect(state.audits).toEqual([])
  expect(state.smsClaimed).toBe(false)
})
it('does not manufacture consent when official policies are unavailable',async()=>{
  state.policies=false
  await expect(registerUserData(input)).rejects.toMatchObject({code:'POLICY_UNAVAILABLE'})
  expect(state.users).toEqual([]);expect(state.consents).toEqual([])
})
it('rolls back the SMS claim, user, consent and audit when credit initialization fails',async()=>{
  state.creditsFail=true
  await expect(registerUserData(input)).rejects.toThrow('credits failure')
  expect(state.users).toEqual([]);expect(state.consents).toEqual([]);expect(state.audits).toEqual([])
  expect(state.smsClaimed).toBe(false)
})
it('binds consent time to policy verification even when user creation crosses a scheduled boundary',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T10:59:59Z'))
  db.user.create.mockImplementationOnce(async({data}:{data:Record<string,unknown>})=>{state.events.push('user');state.users.push(data);vi.setSystemTime(new Date('2026-11-06T11:00:01Z'));return data})
  await registerUserData(input)
  expect(state.consents[0].acceptedAt).toEqual(new Date('2026-11-06T10:59:59Z'))
  vi.useRealTimers()
})
