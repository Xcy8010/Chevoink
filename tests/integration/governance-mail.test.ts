import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { governanceDelivery, processGovernanceMail, queueGovernanceMail } from '../../api/lib/governance-mail.js'
import { prisma } from '../../api/lib/prisma.js'

const available = await prisma.$queryRaw`SELECT 1`.then(()=>true).catch(handleTestDatabaseUnavailable)
describe.skipIf(!available)('transactional governance mail in isolated PostgreSQL',()=>{
  const ids:string[] = []
  const email = () => randomUUID()+'@chevoink.invalid'
  afterEach(async()=>{
    vi.unstubAllEnvs()
    await prisma.governanceMail.deleteMany({where:{userId:{in:ids}}})
    await prisma.user.deleteMany({where:{id:{in:ids}}})
    ids.length=0
  })
  afterAll(()=>prisma.$disconnect())
  it('commits a single notice for a banned recipient, survives restart uncertainty and distinguishes provider acceptance',async()=>{
    vi.stubEnv('GOVERNANCE_MAIL_MODE','mock')
    const user=await prisma.user.create({data:{nickname:'合成处置账号',passwordHash:'unused',bannedAt:new Date(),email:email(),emailVerifiedAt:new Date()}})
    ids.push(user.id)
    const event={eventId:randomUUID(),userId:user.id,kind:'enforcement' as const,reason:'合成处置理由',measure:'7 天'}
    await expect(prisma.$transaction(async tx=>{await queueGovernanceMail(tx,event);throw Error('rollback')})).rejects.toThrow('rollback')
    expect(await prisma.governanceMail.count({where:{eventId:event.eventId}})).toBe(0)
    await prisma.$transaction(async tx=>{await queueGovernanceMail(tx,event);await queueGovernanceMail(tx,event)})
    const delivery=governanceDelivery()!
    const send=vi.fn(delivery.provider.send)
    const isolated={...delivery,provider:{...delivery.provider,send}}
    const time=new Date()
    await Promise.all([processGovernanceMail(isolated,time),processGovernanceMail(isolated,time)])
    expect(send.mock.calls.filter(([m])=>m.to===user.email)).toHaveLength(1)
    const stored=()=>prisma.governanceMail.findFirstOrThrow({where:{eventId:event.eventId}})
    expect((await stored()).state).toBe('accepted')
    await processGovernanceMail(isolated,new Date(+time+600_001))
    expect((await stored()).state).toBe('delivered')
    await prisma.governanceMail.update({where:{id:(await stored()).id},data:{state:'unknown',messageId:null}})
    await processGovernanceMail(isolated,new Date(+time+1_200_000))
    expect((await stored()).state).toBe('unknown')
    expect(send.mock.calls.filter(([m])=>m.to===user.email)).toHaveLength(1)
  })
  it('keeps a historical notice created with delivery disabled out of future dispatches',async()=>{
    vi.stubEnv('GOVERNANCE_MAIL_MODE','off')
    const user=await prisma.user.create({data:{nickname:'合成留存账号',passwordHash:'unused',email:email(),emailVerifiedAt:new Date()}})
    ids.push(user.id)
    const event={eventId:randomUUID(),userId:user.id,kind:'warning' as const,reason:'合成提醒'}
    await prisma.$transaction(tx=>queueGovernanceMail(tx,event))
    expect((await prisma.governanceMail.findFirstOrThrow({where:{eventId:event.eventId}})).state).toBe('unconfigured')
  })
})
