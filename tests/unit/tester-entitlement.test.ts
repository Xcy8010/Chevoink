import { userIdentityUpdateSchema } from '../../shared/contracts/tester.js'
import { describe, expect, it, vi } from 'vitest'
import type { CreditAccount, Prisma } from '@prisma/client'
import { applyTesterCreditFloor, isEffectiveTester, testerTopupDelta, TESTER_CREDIT_RULE, presentTesterIdentity } from '../../api/lib/tester-entitlement.js'
const now = new Date('2026-11-06T12:00:00Z')
function fixture(enabled = true, bonus = 0, used = 431000) {
 let account: CreditAccount = { userId: 'synthetic-tester', dailyAllowanceMilli: 450000, dailyUsedMilli: used, bonusBalanceMilli: bonus, testerTopupSequence: 0, suspendedAt: now, periodStartedAt: now, periodEndsAt: new Date(now.getTime()+86400000), createdAt: now, updatedAt: now }
 const db = { user: { findFirst: vi.fn(async () => enabled ? { id: account.userId } : null) }, creditAccount: { update: vi.fn(async (input: { data: { bonusBalanceMilli: { increment: number }; testerTopupSequence: { increment: number } } }) => { account = { ...account, bonusBalanceMilli: account.bonusBalanceMilli + input.data.bonusBalanceMilli.increment, testerTopupSequence: account.testerTopupSequence+input.data.testerTopupSequence.increment }; return account }) }, creditLedgerEntry: { create: vi.fn(async () => ({})) } }
 return { db, tx: db as unknown as Prisma.TransactionClient, account: () => account }
}
describe('independent tester credit entitlement', () => {
 it('uses the confirmed direct20C threshold and450C target, never450extra',()=>{
  expect(TESTER_CREDIT_RULE).toMatchObject({thresholdMilli:20000,targetMilli:450000,balanceBasis:'ledger'})
  expect(testerTopupDelta(19999)).toBe(430001)
  expect(testerTopupDelta(20000)).toBe(0)
  expect(testerTopupDelta(20001)).toBe(0)
  expect(testerTopupDelta(0)).toBe(450000)
 })
 it.each([-1,0.5,Number.NaN,Number.MAX_SAFE_INTEGER+1])('refuses invalid balance %s',value=>expect(()=>testerTopupDelta(value)).toThrow())
 it('does not grant ordinary users or mutate a read-only entitlement check',async()=>{
  const f=fixture(false); const original=f.account()
  expect(await applyTesterCreditFloor(f.tx,original,'charge')).toBe(original)
  expect(f.db.creditAccount.update).not.toHaveBeenCalled();expect(f.db.creditLedgerEntry.create).not.toHaveBeenCalled()
 })
 it('fills by delta while preserving charged usage, reservations and account pause record',async()=>{
  const f=fixture();const result=await applyTesterCreditFloor(f.tx,f.account(),'known-charge-settlement')
  expect(result).toMatchObject({dailyUsedMilli:431000,bonusBalanceMilli:431000,testerTopupSequence:1,suspendedAt:now})
  expect(Math.max(0,result.dailyAllowanceMilli-result.dailyUsedMilli)+result.bonusBalanceMilli).toBe(450000)
  expect(f.db.creditLedgerEntry.create).toHaveBeenCalledWith({data:expect.objectContaining({deltaMilli:431000,dailyDeltaMilli:0,bonusDeltaMilli:431000,kind:'tester_topup',sourceType:'tester_auto_topup',idempotencyKey:'tester-topup:synthetic-tester:1',metadata:expect.objectContaining({beforeBalanceMilli:19000,afterBalanceMilli:450000,trigger:'known-charge-settlement',ruleVersion:TESTER_CREDIT_RULE.version})})})
 })
 it('preserves the existing invitation/reward bucket and never clears it',async()=>{
  const f=fixture(true,8000,439000);const result=await applyTesterCreditFloor(f.tx,f.account(),'model-admission')
  expect(result.bonusBalanceMilli).toBe(439000)
  expect(f.db.creditAccount.update).toHaveBeenCalledWith({where:{userId:'synthetic-tester'},data:{bonusBalanceMilli:{increment:431000},testerTopupSequence:{increment:1}}})
 })
 it('does not top up again when the same settlement is replayed at its resulting balance',async()=>{
  const f=fixture();await applyTesterCreditFloor(f.tx,f.account(),'settlement')
  await applyTesterCreditFloor(f.tx,f.account(),'same-settlement-replayed')
  expect(f.db.creditAccount.update).toHaveBeenCalledTimes(1);expect(f.db.creditLedgerEntry.create).toHaveBeenCalledTimes(1)
 })
 it('does not treat reservations alone as consumed credits',async()=>{
  const f=fixture(true,0,400000)
  await applyTesterCreditFloor(f.tx,f.account(),'reservation')
  expect(f.db.creditAccount.update).not.toHaveBeenCalled()
 })
 it('requires unbanned entitlement, strict expiry, or actualsuperadmin instead of ordinary admin',async()=>{
  const f=fixture();await isEffectiveTester(f.tx,'synthetic-tester',now)
  expect(f.db.user.findFirst).toHaveBeenCalledWith({where:{id:'synthetic-tester',bannedAt:null,OR:[{role:'admin',isSuperAdmin:true},{testerEntitlement:{is:{enabled:true,OR:[{expiresAt:null},{expiresAt:{gt:now}}]}}}]},select:{id:true}})
 })
})

it('requires an actual role revision and rejects self-declared privilege fields at the identity boundary', () => {
 const operationId='00000000-0000-4000-8000-000000000001'
 expect(userIdentityUpdateSchema.safeParse({operationId,role:'admin',expectedRole:'user'}).success).toBe(true)
 for(const input of [{operationId},{operationId,role:'admin'},{operationId,role:'superadmin',expectedRole:'user'},{operationId,isSuperAdmin:true},{operationId,tester:{enabled:true,reason:'synthetic',expiresAt:null,expectedRevision:0},isSuperAdmin:true}])expect(userIdentityUpdateSchema.safeParse(input).success).toBe(false)
})
it('presents intrinsic super-admin tester status and strict grant expiry without changing stored grants', () => {
 const ordinary={role:'user',isSuperAdmin:false,bannedAt:null,testerEntitlement:null}
 expect(presentTesterIdentity(ordinary,now)).toEqual({enabled:false,effective:false,revision:0,expiresAt:null,reason:null})
 expect(presentTesterIdentity({...ordinary,role:'admin',isSuperAdmin:true},now).effective).toBe(true)
 expect(presentTesterIdentity({...ordinary,role:'admin',isSuperAdmin:true,bannedAt:now},now).effective).toBe(false)
 const grant={enabled:true,revision:2,expiresAt:now,reason:'synthetic'}
 expect(presentTesterIdentity({...ordinary,testerEntitlement:grant},now).effective).toBe(false)
 expect(presentTesterIdentity({...ordinary,testerEntitlement:grant},new Date(now.getTime()-1)).effective).toBe(true)
})
