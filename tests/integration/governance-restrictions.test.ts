import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertGovernanceAllowed } from '../../api/lib/governance-access.js'
import { changeRestriction, issueRestrictions } from '../../api/lib/governance-restrictions.js'
import { correctSafetyEscalation, reviewSafetyEvent } from '../../api/lib/governance-safety.js'
import { restrictionScopes, type RestrictionScope } from '../../shared/contracts/governance-restrictions.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import type { Prisma } from '@prisma/client'
import { createPostData, createCommentData, sendMessageData, publishNovelData } from '../../api/lib/data-access.js'
import { enqueueRequest } from '../../api/lib/agent/request-queue.js'
import { startLoopRun } from '../../api/lib/agent/run-service.js'
import { generateCoverImageData } from '../../api/lib/ai-service.js'
import { FIXED_NOVEL_COVER_SIZE } from '../../shared/contracts/index.js'


const dbReady = await prisma.$queryRaw`SELECT 1`.then(()=>true).catch(handleTestDatabaseUnavailable)
afterAll(()=>prisma.$disconnect())
const future = () => new Date(Date.now()+86_400_000).toISOString()
async function fixture(tx: Prisma.TransactionClient) {
  const actor = await tx.user.create({data:{nickname:'治理测试管理员',passwordHash:'synthetic',role:'admin'}})
  const user = await tx.user.create({data:{nickname:'治理合成账号',passwordHash:'synthetic'}})
  const issue = (scopes:RestrictionScope[]) => issueRestrictions(tx,actor.id,{ userId:user.id,scopes,confirmPlatform:true,reason:'合成案件已核实',clause:'合成条款',expiresAt:future() })
  return { actor, user, issue }
}

describe.skipIf(!dbReady)('governance transaction and account boundaries',()=>{
  it('平台封禁在普通登录和已签发凭据上即时生效，独立申诉凭据仅可查看本人记录', async () => {
    const [{ default: request }, { default: app }, { hashPassword }, { buildSessionTokens, evictUserBanCache }] = await Promise.all([
      import('supertest'), import('../../api/app.js'), import('../../api/lib/password.js'), import('../../api/lib/auth-session.js'),
    ])
    const phone = '+86139' + String(randomInt(0, 100000000)).padStart(8, '0')
    const password = randomUUID()
    const user = await prisma.user.create({ data: { nickname: '合成申诉人', phone, passwordHash: hashPassword(password) } })
    const api = request(app)
    const cookie = 'chevoink_session=' + buildSessionTokens(user.id, user.tokenVersion).accessToken
    try {
      const admin = await api.get('/api/admin/governance/restrictions').set('Cookie', cookie)
      expect(admin.body.error.code).toBe('ADMIN_REQUIRED')
      const restriction = await prisma.accountRestriction.create({ data: {
        userId: user.id, scope: 'platform', reason: '合成封禁申诉', clause: '合成条款',
      } })
      evictUserBanCache(user.id)
      const login = await api.post('/api/auth/login').send({ phone, password })
      expect(login.status).toBe(403)
      expect(login.body.error.code).toBe('AUTH_ACCOUNT_BANNED')
      expect(login.body.data?.tokens).toBeUndefined()
      expect((await api.get('/api/auth/devices').set('Cookie', cookie)).status).toBe(401)
      expect((await api.get('/api/governance/appeal').set('Cookie', cookie)).status).toBe(401)
      const verification = await api.post('/api/governance/appeal/verify-password').set('Cookie', cookie).send({ identity: phone, password })
      expect(verification.status).toBe(200)
      const proof = verification.body.data.proof
      expect(typeof proof).toBe('string')
      const appeals = await api.get('/api/governance/appeal').set('X-Appeal-Proof', proof)
      expect(appeals.status).toBe(200)
      expect(appeals.body.data.subjects.map((subject: {id: string}) => subject.id)).toEqual([restriction.id])
      expect((await api.get('/api/auth/devices').set('X-Appeal-Proof', proof)).status).toBe(401)
    } finally {
      evictUserBanCache(user.id)
      await prisma.user.delete({ where: { id: user.id } })
    }
  })

  it('实际业务入口在保存、扣费和供应商派发前执行范围判定，用户稿件仍可读取',async()=>{
    const user=await prisma.user.create({data:{nickname:'合成受限用户',passwordHash:'synthetic'}})
    const novel=await prisma.novel.create({data:{authorId:user.id,slug:randomUUID(),title:'合成私稿',summary:'',visibility:'private'}})
    const req={sessionId:'synthetic-session',novelId:novel.id,mode:'build' as const,prompt:'合成输入'}
    const fetch=vi.fn(()=>{throw Error('synthetic provider must not be reached')})
    vi.stubGlobal('fetch',fetch)
    try{
      await prisma.accountRestriction.createMany({data:restrictionScopes.filter(scope=>scope!=='platform').map(scope=>({userId:user.id,scope,reason:'合成复核',clause:'测试',expiresAt:new Date(Date.now()+86400_000)}))})
      const blocked={code:'ACCOUNT_FEATURE_RESTRICTED'}
      for(const targetType of ['post','novel','chapter'] as const) await expect(createCommentData(user.id,{targetType,targetId:novel.id,content:'合成评论',rating:4})).rejects.toMatchObject(blocked)
      await expect(createPostData(user.id,{content:'合成帖子'})).rejects.toMatchObject(blocked)
      await expect(sendMessageData(user.id,'synthetic-conversation',{type:'text',content:'合成私信'})).rejects.toMatchObject(blocked)
      await expect(publishNovelData(user.id,novel.id,[])).rejects.toMatchObject(blocked)
      await expect(enqueueRequest(user.id,randomUUID(),req)).rejects.toMatchObject(blocked)
      await expect(startLoopRun(user.id,req)).rejects.toMatchObject(blocked)
      await expect(generateCoverImageData(user.id,{prompt:'合成封面',count:1,size:FIXED_NOVEL_COVER_SIZE})).rejects.toMatchObject(blocked)
      expect(await prisma.creditLedgerEntry.count({where:{userId:user.id}})).toBe(0)
      expect(await prisma.novel.findUniqueOrThrow({where:{id:novel.id}})).toMatchObject({title:'合成私稿',visibility:'private'})
      expect(fetch).not.toHaveBeenCalled()
    }finally {vi.unstubAllGlobals();await prisma.novel.delete({where:{id:novel.id}});await prisma.user.delete({where:{id:user.id}})}
  })

  it('七类权限仅影响有效范围，组合和重叠独立，过期即时恢复，保留旧封禁和私产',async()=>{
    const rollback = Error('isolated restriction fixture rollback')
    await expect(prisma.$transaction(async tx=>{
      const {actor,user,issue}=await fixture(tx)
      const draft=await tx.novel.create({data:{authorId:user.id,title:'合成草稿',summary:'',slug:randomUUID()}})
      for(const scope of restrictionScopes) {
        const [row]=await issue([scope])
        for(const action of restrictionScopes) {
          if(scope==='platform'||scope===action) await expect(assertGovernanceAllowed(user.id,action,tx)).rejects.toMatchObject({code:'ACCOUNT_FEATURE_RESTRICTED'})
          else await expect(assertGovernanceAllowed(user.id,action,tx)).resolves.toBeUndefined()
        }
        await changeRestriction(tx,actor.id,row.id,{action:'revoke',reason:'独立复核'})
      }
      const [first,second]=await issue(['agent','post'])
      const [overlap]=await issue(['agent'])
      await changeRestriction(tx,actor.id,first.id,{action:'revoke',reason:'针对第一项复核'})
      await expect(assertGovernanceAllowed(user.id,'agent',tx)).rejects.toMatchObject({status:403})
      await tx.accountRestriction.update({where:{id:overlap.id},data:{expiresAt:new Date(Date.now()-1000)}})
      await expect(assertGovernanceAllowed(user.id,'agent',tx)).resolves.toBeUndefined()
      const corrected=await changeRestriction(tx,actor.id,overlap.id,{action:'revoke',reason:'到期后仍纠正错误处置'})
      expect(corrected.revokedAt).toBeTruthy()
      expect(corrected.expiresAt!.getTime()).toBeLessThan(Date.now())
      await expect(assertGovernanceAllowed(user.id,'post',tx)).rejects.toMatchObject({status:403})
      await tx.user.update({where:{id:user.id},data:{bannedAt:new Date()}})
      const legacy=await tx.accountRestriction.findFirstOrThrow({where:{userId:user.id,sourceId:'legacy-ban',revokedAt:null}})
      await changeRestriction(tx,actor.id,legacy.id,{action:'revoke',reason:'旧封禁申诉通过'},user.id)
      expect(await tx.user.findUniqueOrThrow({where:{id:user.id}})).toMatchObject({bannedAt:null})
      expect(await tx.accountRestriction.findUniqueOrThrow({where:{id:second.id}})).toMatchObject({revokedAt:null})
      expect(await tx.novel.findUnique({where:{id:draft.id}})).toBeTruthy()
      throw rollback
    },{timeout:20_000})).rejects.toBe(rollback)
  })
  it('同一原始动作只计一次，观察模式不发信；启用时分别提醒、限时封禁，复核纠正计数并解除误判',async()=>{
    const rollback=Error('isolated policy fixture rollback')
    await expect(prisma.$transaction(async tx=>{
      const {actor,user}=await fixture(tx)
      const policy=await tx.agentSafetyPolicy.update({where:{id:'active'},data:{mode:'observe',windowDays:30,banDays:7}})
      expect(policy.windowDays).toBe(30)
      const reviewed={ decision:'confirmed' as const,category:'合成违规',reason:'独立材料确认',evasion:'high' as const,evidenceRef:'synthetic-evidence' }
      const signal=(key:string)=>tx.agentSafetyEvent.upsert({where:{userId_actionKey:{userId:user.id,actionKey:key}},create:{userId:user.id,actionKey:key,source:'agent',policyVersion:'test',status:'pending',category:'模型拒绝',evasion:'none'},update:{}})
      const ids:string[]=[]
      for(let i=1;i<=5;i++){
        const event=await signal('message:synthetic-'+i)
        ids.push(event.id)
        expect(await signal(event.actionKey)).toMatchObject({id:event.id})
        const result=await reviewSafetyEvent(tx,actor.id,event.id,reviewed)
        expect(result).toMatchObject({level:i===5?'platform':i>=3?'warning':'record',applied:false})
      }
      expect(await tx.governanceMail.count({where:{userId:user.id}})).toBe(0)
      for(const id of ids.slice(2)) await reviewSafetyEvent(tx,actor.id,id,{...reviewed, decision:'dismissed'})
      await tx.agentSafetyPolicy.update({where:{id:'active'},data:{mode:'enforce'}})
      for(const id of ids.slice(2)) await reviewSafetyEvent(tx,actor.id,id,reviewed)
      await reviewSafetyEvent(tx,actor.id,ids[4],reviewed)
      expect(await tx.governanceMail.count({where:{userId:user.id,kind:'warning'}})).toBe(1)
      expect(await tx.governanceMail.count({where:{userId:user.id,kind:'enforcement'}})).toBe(1)
      const escalation=await tx.agentSafetyEscalation.findFirstOrThrow({where:{userId:user.id,level:'platform'}})
      const ban=await tx.accountRestriction.findUniqueOrThrow({where:{id:escalation.restrictionId!}})
      expect(Math.abs(ban.expiresAt!.getTime()-ban.createdAt.getTime()-7*86_400_000)).toBeLessThan(15_000)
      await correctSafetyEscalation(tx,actor.id,escalation.id,user.id,'证据被纠正',[ids[4]])
      await expect(assertGovernanceAllowed(user.id,'agent',tx)).resolves.toBeUndefined()
      expect(await tx.agentSafetyEvent.count({where:{userId:user.id,status:'confirmed'}})).toBe(4)
      const unknown=await signal('unverified:test')
      await expect(reviewSafetyEvent(tx,actor.id,unknown.id,reviewed)).rejects.toMatchObject({code:'ORIGINAL_ACTION_UNKNOWN'})
      throw rollback
    },{timeout:20_000})).rejects.toBe(rollback)
  })
})
