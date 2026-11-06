import { registerActiveRun, deregisterActiveRun } from '../../api/lib/agent/active-runs.js'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { initializeNewUserCredits, consumeCredits, recordImageRefundIntent, reconcileCreditRefunds } from '../../api/lib/credits.js'
import { setCreditsGloballyPaused, setAdminUsersSuspended } from '../../api/lib/admin-credit-model.js'
import { isEffectiveTester, updateTester } from '../../api/lib/tester-entitlement.js'
import { createUnsetPasswordHash } from '../../api/lib/password.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
const available = await prisma.$queryRaw`SELECT 1`.then(()=>true).catch(handleTestDatabaseUnavailable)
const ids: string[]=[], localRunIds: string[]=[]
let originalPaused=false
beforeAll(async()=>{if(available){const setting=await prisma.creditSystemSetting.findUnique({where:{id:'global'}});originalPaused=setting?.globallyPaused??false}})
afterEach(async()=>{if(available){for(const id of localRunIds.splice(0))deregisterActiveRun(id);const owned=ids.slice();await prisma.aiUsageLog.deleteMany({where:{userId:{in:owned}}});await prisma.user.deleteMany({where:{id:{in:owned}}});ids.splice(0);await prisma.creditSystemSetting.updateMany({where:{id:'global'},data:{globallyPaused:originalPaused}})}})
afterAll(async()=>{await prisma.$disconnect()})
async function user(tester=false,superAdmin=false,balance=450000) {
 const id=randomUUID();ids.push(id)
 await prisma.user.create({data:{id,email:id+'@example.invalid',nickname:'合成测试员',passwordHash:createUnsetPasswordHash(),role:superAdmin?'admin':'user',isSuperAdmin:superAdmin}})
 await prisma.$transaction(async tx=>{await initializeNewUserCredits(tx,id);await tx.creditAccount.update({where:{userId:id},data:{dailyAllowanceMilli:450000,dailyUsedMilli:450000-balance,bonusBalanceMilli:0}});if(tester)await tx.testerEntitlement.create({data:{userId:id,reason:'synthetic-fixture',grantedById:id}})})
 return id
}
const debit=(userId:string,key:string,amountMilli=1000)=>consumeCredits({userId,amountMilli,kind:'usage',sourceType:'image_generation',idempotencyKey:key})
const balance=async(userId:string)=>{const a=await prisma.creditAccount.findUniqueOrThrow({where:{userId}});return Math.max(0,a.dailyAllowanceMilli-a.dailyUsedMilli)+a.bonusBalanceMilli}
describe.skipIf(!available)('tester entitlement real isolated PostgreSQL',()=>{
 it('grants independent tester status without administrator role and keeps ordinary suspension',async()=>{
  const tester=await user(true),ordinary=await user()
  await setAdminUsersSuspended([tester,ordinary],true)
  expect((await prisma.user.findUniqueOrThrow({where:{id:tester}})).role).toBe('user')
  await expect(debit(tester,'image:'+randomUUID())).resolves.toMatchObject({chargedMilli:1000})
  await expect(debit(ordinary,'image:'+randomUUID())).rejects.toMatchObject({code:'CREDITS_ACCOUNT_SUSPENDED'})
 })
 it('covers global pause and default super-admin qualification for newly created accounts',async()=>{
  await setCreditsGloballyPaused(true)
  const tester=await user(true),superAdmin=await user(false,true),ordinary=await user()
  expect(await isEffectiveTester(prisma,superAdmin)).toBe(true)
  await expect(debit(tester,'image:'+randomUUID())).resolves.toMatchObject({chargedMilli:1000})
  await expect(debit(superAdmin,'image:'+randomUUID())).resolves.toMatchObject({chargedMilli:1000})
  await expect(debit(ordinary,'image:'+randomUUID())).rejects.toMatchObject({code:'CREDITS_GLOBALLY_PAUSED'})
 })
 it('does not refill exactly20C but does refill below20C and preserves rewards/usage',async()=>{
  const tester=await user(true,false,20000)
  await debit(tester,'image:'+randomUUID(),0)
  expect(await prisma.creditLedgerEntry.count({where:{userId:tester,kind:'tester_topup'}})).toBe(0)
  await prisma.creditAccount.update({where:{userId:tester},data:{dailyUsedMilli:439000,bonusBalanceMilli:8000}})
  await debit(tester,'image:'+randomUUID(),1000)
  const entry=await prisma.creditLedgerEntry.findFirstOrThrow({where:{userId:tester,kind:'tester_topup'}})
  expect(entry.deltaMilli).toBe(431000)
  expect(entry.bonusDeltaMilli).toBe(431000)
  expect(await balance(tester)).toBe(449000)
  expect((await prisma.creditAccount.findUniqueOrThrow({where:{userId:tester}})).dailyUsedMilli).toBe(440000)
 })
 it('concurrent admissions and duplicate settlement create one topup and exact charges',async()=>{
  const tester=await user(true,false,19000),a='image:'+randomUUID(),b='image:'+randomUUID()
  await Promise.all([debit(tester,a,1000),debit(tester,b,2000)])
  await debit(tester,a,1000)
  expect(await balance(tester)).toBe(447000)
  expect(await prisma.creditLedgerEntry.count({where:{userId:tester,kind:'tester_topup'}})).toBe(1)
  expect(await prisma.creditLedgerEntry.count({where:{userId:tester,kind:'usage'}})).toBe(2)
  expect((await prisma.creditAccount.findUniqueOrThrow({where:{userId:tester}})).testerTopupSequence).toBe(1)
 })
 it('reservations alone do not trigger consumption-based refill',async()=>{
  const tester=await user(true,false,25000)
  await prisma.aiUsageLog.create({data:{userId:tester,providerType:'text',providerMode:'mock',modelName:'synthetic-private-id',action:'synthetic-reservation',targetType:'synthetic-reservation',durationMs:0,reservedCreditMilli:24000,reservationExpiresAt:new Date(Date.now()+600000),billingStatus:'prepared',usageSource:'prepared'}})
  await debit(tester,'image:'+randomUUID(),0)
  expect(await balance(tester)).toBe(25000)
  expect(await prisma.creditLedgerEntry.count({where:{userId:tester,kind:'tester_topup'}})).toBe(0)
 })
 it('late refund references original charge after refill and is not capped or recomputed',async()=>{
  const tester=await user(true,false,25000),key='image:'+randomUUID()
  await debit(tester,key,6000)
  expect(await balance(tester)).toBe(450000)
  await recordImageRefundIntent(tester,key,{outcome:'rejected',deliveredImages:0})
  await reconcileCreditRefunds({userId:tester,limit:10})
  expect(await balance(tester)).toBe(456000)
  const refund=await prisma.creditLedgerEntry.findUniqueOrThrow({where:{idempotencyKey:'refund:'+key}})
  const original=await prisma.creditLedgerEntry.findUniqueOrThrow({where:{idempotencyKey:key}})
  expect(refund.deltaMilli).toBe(-original.deltaMilli)
  expect(refund.metadata).toMatchObject({originalEntryId:original.id})
 })
 it('audits ordinary-admin grants/revocation idempotently and refuses user self-declaration',async()=>{
  const target=await user(),ordinaryAdmin=await user()
  await prisma.user.update({where:{id:ordinaryAdmin},data:{role:'admin'}})
  const input={enabled:true,reason:'合成资格变更',expiresAt:null,expectedRevision:0,operationId:randomUUID()}
  await expect(updateTester(target,target,input,null)).rejects.toMatchObject({code:'ADMIN_REQUIRED'})
  expect(await updateTester(ordinaryAdmin,target,input,null)).toMatchObject({revision:1,replayed:false})
  expect(await updateTester(ordinaryAdmin,target,input,null)).toMatchObject({revision:1,replayed:true})
  await expect(updateTester(ordinaryAdmin,target,{...input,enabled:false},null)).rejects.toMatchObject({code:'TESTER_OPERATION_CONFLICT'})
  await setCreditsGloballyPaused(true)
  await updateTester(ordinaryAdmin,target,{enabled:false,reason:'撤销合成资格',expiresAt:null,expectedRevision:1,operationId:randomUUID()},null)
  expect(await isEffectiveTester(prisma,target)).toBe(false)
  await expect(debit(target,'image:'+randomUUID())).rejects.toMatchObject({code:'CREDITS_GLOBALLY_PAUSED'})
 })
 it('uses exclusive expiry and never exempts a banned tester or super-admin',async()=>{
  const tester=await user(true),superAdmin=await user(false,true),instant=new Date('2026-11-06T12:00:00Z')
  await prisma.testerEntitlement.update({where:{userId:tester},data:{expiresAt:instant}})
  expect(await isEffectiveTester(prisma,tester,new Date(instant.getTime()-1))).toBe(true)
  expect(await isEffectiveTester(prisma,tester,instant)).toBe(false)
  await prisma.testerEntitlement.update({where:{userId:tester},data:{expiresAt:null}})
  await prisma.user.updateMany({where:{id:{in:[tester,superAdmin]}},data:{bannedAt:instant}})
  expect(await isEffectiveTester(prisma,tester,instant)).toBe(false)
  expect(await isEffectiveTester(prisma,superAdmin,instant)).toBe(false)
 })

 it.each(['global','account'] as const)('preserves normal local non-loop abort while exempting tester: %s',async scope=>{
  const tester=await user(true),ordinary=await user(),testerController=new AbortController(),ordinaryController=new AbortController()
  const a=randomUUID(),b=randomUUID();localRunIds.push(a,b)
  registerActiveRun(a,{userId:tester,sessionId:randomUUID(),controller:testerController})
  registerActiveRun(b,{userId:ordinary,sessionId:randomUUID(),controller:ordinaryController})
  const result=scope==='global'?await setCreditsGloballyPaused(true):await setAdminUsersSuspended([tester,ordinary],true)
  expect(result.stoppedRuns).toBe(1)
  expect(ordinaryController.signal.aborted).toBe(true)
  expect(testerController.signal.aborted).toBe(false)
 })

})
