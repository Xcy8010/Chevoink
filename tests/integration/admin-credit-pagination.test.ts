import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { getAdminCreditsManagement } from '../../api/lib/admin-credit-model.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })
describe.runIf(available)('bounded read-only account management on real isolated PostgreSQL', () => {
  it('pages all matching accounts while retaining global totals and never creating or resetting accounts on GET', async () => {
    const prefix = `creditpage-${randomUUID()}`
    const ids = Array.from({length:41},(_,i)=>`${prefix}-${i}`)
    const old = await prisma.creditSystemSetting.findUnique({where:{id:'global'}})
    const now = new Date(), future = new Date(now.getTime()+86400000), past = new Date(now.getTime()-86400000)
    try {
      await prisma.creditSystemSetting.upsert({where:{id:'global'},create:{id:'global'},update:{publicBetaEnabled:true,dailyAllowanceMilli:450000,globallyPaused:false}})
      await prisma.user.createMany({data:ids.map((id,i)=>({id,nickname:`分页合成作者${i}`,passwordHash:'synthetic-test-only-never-login',email:`${id}@example.invalid`,phone:i===40?'13900139000':null}))})
      await prisma.creditAccount.createMany({data:ids.slice(1).map((userId,i)=>({userId,dailyAllowanceMilli:450000,dailyUsedMilli:(i+1)*1000,bonusBalanceMilli:3000,periodStartedAt:past,periodEndsAt:i===0?past:future}))})
      const first = await getAdminCreditsManagement(prefix,{page:1,pageSize:20})
      const second = await getAdminCreditsManagement(prefix,{page:2,pageSize:20})
      const third = await getAdminCreditsManagement(prefix,{page:3,pageSize:20})
      expect(first.pagination).toMatchObject({page:1,pageSize:20,total:41,hasMore:true})
      expect([first.users.length,second.users.length,third.users.length]).toEqual([20,20,1])
      expect(new Set([...first.users,...second.users,...third.users].map(row=>row.user.id)).size).toBe(41)
      expect(first.summary).toEqual(second.summary)
      const missing = await getAdminCreditsManagement(ids[0])
      expect(missing.users[0]).toMatchObject({dailyUsed:0,dailyAllowance:450,totalRemaining:450})
      expect(await prisma.creditAccount.findUnique({where:{userId:ids[0]}})).toBeNull()
      const expired = await getAdminCreditsManagement(ids[1])
      expect(expired.users.find(row=>row.user.id===ids[1])).toMatchObject({dailyUsed:0,totalRemaining:453})
      expect((await prisma.creditAccount.findUniqueOrThrow({where:{userId:ids[1]}})).dailyUsedMilli).toBe(1000)
      expect(await prisma.creditAccount.count({where:{userId:{in:ids}}})).toBe(40)
      const email = await getAdminCreditsManagement(`${ids[40]}@example.invalid`)
      const phone = await getAdminCreditsManagement('13900139000')
      expect(email.users.map(row=>row.user.id)).toEqual([ids[40]])
      expect(phone.users.map(row=>row.user.id)).toEqual([ids[40]])
      expect(email.summary).toEqual(first.summary)
      expect(JSON.stringify(email)).not.toContain('@example.invalid')
      expect(JSON.stringify(phone)).not.toContain('13900139000')
      const empty = await getAdminCreditsManagement('no-such-'+prefix)
      expect(empty.users).toEqual([]);expect(empty.pagination.total).toBe(0);expect(empty.summary).toEqual(first.summary)
      const bound = await getAdminCreditsManagement(prefix,{page:999,pageSize:20})
      expect(bound.pagination.page).toBe(3);expect(bound.users).toHaveLength(1)
      await prisma.creditSystemSetting.update({where:{id:'global'},data:{publicBetaEnabled:false}})
      expect((await getAdminCreditsManagement(ids[1])).users.find(row=>row.user.id===ids[1])?.dailyUsed).toBe(1)
    } finally {
      await prisma.creditAccount.deleteMany({where:{userId:{in:ids}}})
      await prisma.user.deleteMany({where:{id:{in:ids}}})
      if(old)await prisma.creditSystemSetting.update({where:{id:'global'},data:old})
      else await prisma.creditSystemSetting.deleteMany({where:{id:'global'}})
    }
  })
})
