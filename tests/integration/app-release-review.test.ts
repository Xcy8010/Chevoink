import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import app from '../../api/app.js'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildSessionTokens, createSession } from '../../api/lib/auth-session.js'
import type { AppReleaseCapability } from '../../shared/contracts/app-release.js'
import { executeAppRelease, previewAppRelease, reconcileAppRelease } from '../../api/lib/app-releases.js'
import { getAdminModelLifecyclePreview } from '../../api/lib/admin-model-lifecycle.js'
import { sealAppArtifact } from '../../scripts/app-release-artifact.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { changeRestriction, issueRestrictions } from '../../api/lib/governance-restrictions.js'
import { activeAgentRestriction } from '../../api/lib/governance-access.js'
import { governanceDelivery, processGovernanceMail, queueGovernanceMail } from '../../api/lib/governance-mail.js'
import { integrationLegalConsent } from '../support/legal-consent.js'
import { readPublicSiteContent, verifyRegistrationConsent } from '../../api/lib/site-content.js'

// Synthetic-only isolated database. Never seeds a production policy or artifact.
await verifyTestDatabase(true)
const root=await mkdtemp(path.join(os.tmpdir(),'chevoink-release-review-'))
const previousRoot=process.env.APP_RELEASE_ARTIFACT_ROOT
const adminId=randomUUID(),ids=[`review-${randomUUID()}`,`review-${randomUUID()}`]
let token=''
let channels:Awaited<ReturnType<typeof prisma.appReleaseChannel.findMany>>=[]
const models:string[]=[],roles:string[]=[]
const quality={supportedValues:['high'],defaultValue:'high'}
async function artifact(id:string,capabilities:AppReleaseCapability[]=[]){
 const directory=path.join(root,id);await mkdir(path.join(directory,'assets'),{recursive:true});await writeFile(path.join(directory,'assets/app.js'),'synthetic-only');await writeFile(path.join(directory,'index.html'),`<html><head><script type="module" src="/api/app-releases/artifacts/${id}/assets/app.js"></script></head></html>`)
 const sourceSha='a'.repeat(40),jobs=['plan test shards','check / lint / build / audit','merge coverage / test report','check / lint / test / build / audit','test shard 1/1'].map(name=>({name,status:'completed',conclusion:'success'}))
 const sealed=await sealAppArtifact(directory,{id,label:'Synthetic review release',sourceSha,compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities,publicNotes:{features:['Synthetic test fixture'],fixes:[],changes:[]},validation:{status:'verified',verifiedAt:new Date().toISOString(),ciRunId:'123',originalAttempt:1,ci:{headSha:sourceSha,workflowName:'CI',status:'completed',conclusion:'success',jobs}}})
 await prisma.appRelease.create({data:{id,label:sealed.manifest.label,sourceSha,artifactSha256:sealed.artifactSha256,manifest:JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')),publicNotes:sealed.manifest.publicNotes,compatibilityVersion:1,validationState:'verified',verifiedAt:new Date(),registeredById:adminId}})
}
async function model(metadata:Prisma.InputJsonObject,enabled=false){const row=await prisma.aiModelConfig.create({data:{key:`review-image-${randomUUID()}`,provider:'fixture-provider',displayName:'Synthetic review model',modelName:'fixture-image',baseUrl:'https://fixture.invalid/v1',apiKeyCiphertext:'synthetic-opaque-ciphertext',metadata:{modelKind:'image_generation',...metadata},enabled,selectable:false,isDefault:false,multiplierBps:10000}});models.push(row.id);return row}
const patch=(id:string,body:unknown)=>request(app).patch(`/api/ADMIN/models/${encodeURIComponent(id)}/`).set('Authorization',`Bearer ${token}`).send(body)
beforeAll(async()=>{
 process.env.APP_RELEASE_ARTIFACT_ROOT=root
 channels=await prisma.appReleaseChannel.findMany({where:{channel:{in:['stable','test']}}})
 await prisma.appReleaseChannel.deleteMany({where:{channel:{in:['stable','test']}}})
 await prisma.user.create({data:{id:adminId,nickname:`release-review-${randomUUID()}`,role:'admin',isSuperAdmin:true,passwordHash:'unusable'}})
 const response={append:()=>response} as unknown as Response
 token=(await createSession(adminId,response)).accessToken
 await integrationLegalConsent()
 await artifact(ids[0]);await artifact(ids[1],['siteContent','legacyEmailBinding','platformGovernance'])
 await prisma.appReleaseChannel.create({data:{channel:'stable',releaseId:ids[0],revision:1,enabled:true}})
})
afterAll(async()=>{
 await prisma.appReleaseChannel.deleteMany({where:{channel:{in:['stable','test']}}})
 for(const channel of channels)await prisma.appReleaseChannel.create({data:channel})
 await prisma.appReleaseOperation.deleteMany({where:{actorId:adminId}})
 await prisma.appReleaseRetirement.deleteMany({where:{releaseId:{in:ids}}})
 await prisma.appRelease.deleteMany({where:{id:{in:ids}}})
 await prisma.aiModelSystemBinding.deleteMany({where:{roleKey:{in:roles}}})
 await prisma.aiModelConfigVersion.deleteMany({where:{modelConfigId:{in:models}}})
 await prisma.aiModelConfig.deleteMany({where:{id:{in:models}}})
 await prisma.adminAuditLog.deleteMany({where:{adminId}})
 await prisma.user.deleteMany({where:{id:adminId}})
 if(previousRoot===undefined)delete process.env.APP_RELEASE_ARTIFACT_ROOT;else process.env.APP_RELEASE_ARTIFACT_ROOT=previousRoot
 if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe synthetic cleanup')
 await rm(root,{recursive:true,force:true});await prisma.$disconnect()
})
describe('actual release and admin routers on isolated PostgreSQL',()=>{
 it('dispatches verified governance mail only after public rollout and preserves historical delivery scopes',async()=>{
  const originalChannel=await prisma.appReleaseChannel.findUniqueOrThrow({where:{channel:'stable'}})
  const accounts=Array.from({length:4},()=>({id:randomUUID(),email:randomUUID()+'@synthetic.invalid'}))
  const [owner,changed,suppressed,unverified]=accounts
  const notice=(userId:string)=>({eventId:randomUUID(),userId,kind:'warning' as const,reason:'Synthetic warning'})
  const store=(eventId:string)=>prisma.governanceMail.findFirstOrThrow({where:{eventId}})
  const beforeRollout=notice(owner.id), allowed=notice(owner.id), moved=notice(changed.id), muted=notice(suppressed.id), unbound=notice(unverified.id)
  const oldPending=notice(owner.id), oldReceipt=notice(owner.id), mockReceipt=notice(owner.id)
  const time=new Date()
  const original=await readFile('api/templates/governance/chevoink-account-warning.html','base64')
  const sent:string[]=[], receipts:string[]=[]
  const fetcher=vi.fn<typeof fetch>(async (_url,options)=>{
   const action=new Headers(options?.headers).get('X-TC-Action')
   if(action==='GetEmailTemplate')return globalThis.Response.json({Response:{RequestId:'lookup',TemplateStatus:0,TemplateContent:{Html:original}}})
   if(action==='SendEmail'){
    sent.push(...JSON.parse(String(options?.body)).Destination)
    return globalThis.Response.json({Response:{RequestId:'synthetic-request',MessageId:'synthetic-message'}})
   }
   if(action==='GetSendEmailStatus'){
    const {MessageId,ToEmailAddress}=JSON.parse(String(options?.body))
    receipts.push(MessageId)
    return globalThis.Response.json({Response:{RequestId:'synthetic-status',EmailStatusList:[{MessageId,ToEmailAddress,FromEmailAddress:'notice@chevolink.com',SendStatus:0,DeliverStatus:1}]}})
   }
   throw Error('Unexpected synthetic action: '+action)
  })
  vi.stubEnv('GOVERNANCE_MAIL_MODE','tencent')
  vi.stubEnv('GOVERNANCE_SES_SECRET_ID','synthetic')
  vi.stubEnv('GOVERNANCE_SES_SECRET_KEY','synthetic')
  vi.stubEnv('GOVERNANCE_SES_REPLY_TO','review@synthetic.invalid')
  try{
   await prisma.user.createMany({data:accounts.map(({id,email})=>({id,email,nickname:'Synthetic notice owner',passwordHash:'unused',emailVerifiedAt:id===unverified.id?null:time}))})
   const worker=governanceDelivery(process.env,fetcher)!
   expect(worker.mode).toBe('tencent-verified')
   await prisma.$transaction(tx=>queueGovernanceMail(tx,beforeRollout))
   expect((await store(beforeRollout.eventId)).state).toBe('unconfigured')

   // These rows model persisted attempts across a deployment while public governance is still unavailable.
   const historical={recipient:owner.email,attemptedAt:time}
   await prisma.governanceMail.createMany({data:[
    {...oldPending,recipient:owner.email,state:'pending',mode:'tencent'},
    {...oldReceipt,...historical,state:'accepted',mode:'tencent',messageId:'prior-live'},
    {...mockReceipt,...historical,state:'accepted',mode:'mock',messageId:'prior-mock'},
   ]})
   await processGovernanceMail(worker,time)
   expect(receipts).toEqual(['prior-live'])
   expect((await store(oldReceipt.eventId)).state).toBe('delivered')
   expect((await store(mockReceipt.eventId)).state).toBe('accepted')
   expect(fetcher).toHaveBeenCalledTimes(1)

   await prisma.appReleaseChannel.update({where:{channel:'stable'},data:{releaseId:ids[1]}})
   await prisma.$transaction(async tx=>{for(const event of [allowed,allowed,moved,muted,unbound])await queueGovernanceMail(tx,event)})
   expect(await prisma.governanceMail.count({where:{eventId:allowed.eventId}})).toBe(1)
   expect(await store(allowed.eventId)).toMatchObject({state:'pending',mode:'tencent-verified'})
   expect((await store(unbound.eventId)).state).toBe('unavailable')
   // Withdrawing public capability after enqueue must also pause a pending live send.
   await prisma.appReleaseChannel.update({where:{channel:'stable'},data:{releaseId:originalChannel.releaseId}})
   await processGovernanceMail(worker,time)
   expect((await store(allowed.eventId)).state).toBe('pending')
   expect(fetcher).toHaveBeenCalledTimes(1)
   await prisma.user.update({where:{id:changed.id},data:{email:randomUUID()+'@synthetic.invalid'}})
   await prisma.adminEmailPermission.create({data:{purpose:'governance',email:suppressed.email,suppression:'complained'}})
   await prisma.appReleaseChannel.update({where:{channel:'stable'},data:{releaseId:ids[1]}})
   await Promise.all([processGovernanceMail(worker,time),processGovernanceMail(worker,time)])
   expect(sent).toEqual([owner.email])
   expect(await store(allowed.eventId)).toMatchObject({state:'accepted',messageId:'synthetic-message'})
   expect((await store(moved.eventId)).state).toBe('suppressed')
   expect((await store(muted.eventId)).state).toBe('suppressed')
   expect((await store(beforeRollout.eventId)).state).toBe('unconfigured')
   expect((await store(oldPending.eventId)).state).toBe('pending')
   const limited=governanceDelivery({...process.env,GOVERNANCE_MAIL_MODE:'tencent-allowlist',GOVERNANCE_SES_ALLOWLIST:'allowlisted@synthetic.invalid'},fetcher)!
   await processGovernanceMail(limited,new Date(+time+60_001))
   expect((await store(allowed.eventId)).state).toBe('delivered')
   expect(receipts).toEqual(['prior-live','synthetic-message'])
   expect((await store(mockReceipt.eventId)).state).toBe('accepted')
   expect(sent).toEqual([owner.email])
  }finally{
   vi.unstubAllEnvs()
   await prisma.appReleaseChannel.update({where:{channel:'stable'},data:{releaseId:originalChannel.releaseId}})
   await prisma.adminEmailPermission.deleteMany({where:{email:suppressed.email,purpose:'governance'}})
   const userIds=accounts.map(a=>a.id)
   await prisma.governanceMail.deleteMany({where:{userId:{in:userIds}}})
   await prisma.user.deleteMany({where:{id:{in:userIds}}})
  }
 })
 it('limits governance actions to eligible targets and leaves legacy bans out of the test-channel work sweep',async()=>{
  const rollback=Error('synthetic governance rollback')
  await expect(prisma.$transaction(async tx=>{
   await tx.appReleaseChannel.create({data:{channel:'test',releaseId:ids[1],revision:1,enabled:true}})
   const profile={nickname:'Synthetic governance target',passwordHash:'unusable'}
   const stable=await tx.user.create({data:profile})
   const tester=await tx.user.create({data:{...profile,testerEntitlement:{create:{enabled:true,reason:'Synthetic tester',grantedById:adminId}}}})
   const input={userId:stable.id,scopes:['agent' as const],reason:'合成复核',clause:'合成测试条款',expiresAt:null}
   await expect(issueRestrictions(tx,adminId,input)).rejects.toMatchObject({code:'APP_RELEASE_CAPABILITY_DISABLED'})
   await expect(issueRestrictions(tx,adminId,{...input,userId:adminId})).rejects.toMatchObject({code:'PROTECTED_ACCOUNT'})
   const [limited]=await issueRestrictions(tx,adminId,{...input,userId:tester.id})
   await tx.user.update({where:{id:stable.id},data:{bannedAt:new Date()}})
   const legacy=await tx.accountRestriction.findFirstOrThrow({where:{userId:stable.id,legacyBan:true}})
   expect(await tx.accountRestriction.findMany({where:{...activeAgentRestriction(new Date()),userId:{in:[stable.id,tester.id]}},select:{id:true}})).toEqual([{id:limited.id}])
   await expect(changeRestriction(tx,adminId,legacy.id,{action:'revoke',reason:'合成测试'})).rejects.toMatchObject({code:'APP_RELEASE_CAPABILITY_DISABLED'})
   expect((await tx.user.findUniqueOrThrow({where:{id:stable.id}})).bannedAt).toBeTruthy()
   throw rollback
  },{timeout:15_000})).rejects.toBe(rollback)
 })

 it('preserves manual bans on stable accounts and requires explicit governance decisions for testers',async()=>{
  const stable=randomUUID(), tester=randomUUID(), peer=randomUUID()
  const profile={nickname:'Synthetic manual restriction',passwordHash:'unusable'}
  const endpoint=(user:string,action:string,body:object={})=>request(app).post('/api/admin/users/'+user+'/'+action).set('Authorization','Bearer '+token).send(body)
  try {
   await prisma.appReleaseChannel.create({data:{channel:'test',releaseId:ids[1],revision:1,enabled:true}})
   await prisma.user.createMany({data:[{...profile,id:stable},{...profile,id:peer,role:'admin'}]})
   await prisma.user.create({data:{...profile,id:tester,testerEntitlement:{create:{enabled:true,reason:'Synthetic test',grantedById:adminId}}}})
   expect((await endpoint(tester,'ban')).body.error.code).toBe('GOVERNANCE_REVIEW_REQUIRED')
   expect((await endpoint(peer,'ban')).body.error.code).toBe('PROTECTED_ACCOUNT')
   expect((await endpoint(adminId,'unban')).body.error.code).toBe('PROTECTED_ACCOUNT')
   const work=async (userId:string)=>{
    const novel=await prisma.novel.create({data:{authorId:userId,title:'Synthetic private draft',summary:'',slug:randomUUID(),visibility:'private'}})
    const session=await prisma.agentSession.create({data:{userId,novelId:novel.id,title:'Synthetic session'}})
    const queued=await prisma.agentQueuedRequest.create({data:{id:randomUUID(),sessionId:session.id,userId,payload:{prompt:'retained synthetic request'}}})
    const scheduled=await prisma.agentSchedule.create({data:{userId,sessionId:session.id,novelId:novel.id,name:'Synthetic schedule',prompt:'synthetic',cadenceMinutes:60,nextRunAt:new Date(Date.now()+3600_000)}})
    return {queued:queued.id,scheduled:scheduled.id}
   }
   const affected=await work(stable), unaffected=await work(tester)
   const decision={reason:'Synthetic confirmed facts',clause:'Synthetic named clause',operationId:randomUUID()}
   const replies=await Promise.all([endpoint(stable,'ban',decision),endpoint(stable,'ban',decision)])
   expect(replies.map(reply=>reply.status)).toEqual([200,200])
   const record=await prisma.accountRestriction.findFirstOrThrow({where:{userId:stable,legacyBan:true}})
   expect(record).toMatchObject({reason:decision.reason,clause:decision.clause,sourceId:'legacy-admin',scope:'platform',revokedAt:null})
   expect(await prisma.governanceMail.findMany({where:{userId:stable,kind:'enforcement'}})).toMatchObject([{eventId:record.id,reason:decision.reason,measure:'全平台访问；永久'}])
   for(const [job,status,plan] of [[affected,'held','paused'],[unaffected,'pending','active']] as const) {
    expect(await prisma.agentQueuedRequest.findUniqueOrThrow({where:{id:job.queued}})).toMatchObject({status,payload:{prompt:'retained synthetic request'}})
    expect(await prisma.agentSchedule.findUniqueOrThrow({where:{id:job.scheduled}})).toMatchObject({status:plan})
   }
   const outcome=await endpoint(stable,'unban',{reason:'Synthetic review reversed ban'})
   expect(outcome.status).toBe(200)
   expect((await endpoint(stable,'ban',decision)).status).toBe(200)
   expect((await prisma.user.findUniqueOrThrow({where:{id:stable}})).bannedAt).toBeNull()
   expect((await prisma.accountRestriction.findUniqueOrThrow({where:{id:record.id}})).revokedAt).not.toBeNull()
   expect(await prisma.governanceMail.count({where:{userId:stable}})).toBe(1)
  } finally {
   await prisma.appReleaseChannel.deleteMany({where:{channel:'test',releaseId:ids[1]}})
   await prisma.governanceMail.deleteMany({where:{userId:{in:[stable,tester,peer]}}})
   await prisma.agentSession.deleteMany({where:{userId:{in:[stable,tester]}}})
   await prisma.novel.deleteMany({where:{authorId:{in:[stable,tester]}}})
   await prisma.user.deleteMany({where:{id:{in:[stable,tester,peer]}}})
  }
 })

 it('requires binding only on the selected release and only for phone accounts without an email',async()=>{
  const previous=env.accountEmailAuthEnabled
  const fixtures:string[]=[]
  const phone=(prefix:string)=>`+8613${prefix}${String(Math.floor(Math.random()*1e8)).padStart(8,'0')}`
  const user=async(prefix:string,extra:Prisma.UserCreateInput)=>{
   const row=await prisma.user.create({data:{phone:phone(prefix),phoneVerifiedAt:new Date(),...extra}})
   fixtures.push(row.id)
   return {id:row.id,authorization:`Bearer ${buildSessionTokens(row.id,row.tokenVersion).accessToken}`}
  }
  const common={nickname:'Legacy email binding fixture',passwordHash:'unusable'}
  const bindAccess='/api/conversations'
  try{
   env.accountEmailAuthEnabled=true
   const stable=await user('5',common)
   const test=await user('6',{...common,role:'admin',testerEntitlement:{create:{enabled:true,reason:'Synthetic tester',grantedById:adminId}}})
   const superAdminWithEmail=await user('7',{...common,role:'admin',isSuperAdmin:true,email:`${randomUUID()}@example.test`})
   const superAdminWithoutEmail=await user('8',{...common,role:'admin',isSuperAdmin:true})
   await prisma.appReleaseChannel.create({data:{channel:'test',releaseId:ids[1],revision:1,enabled:true}})
   const read=(url:string,authorization:string)=>request(app).get(url).set('Authorization',authorization)
   expect((await read('/api/app-releases/bootstrap',test.authorization)).body.data).toMatchObject({channel:'test',release:{id:ids[1]}})
   const index='/api/app-releases/artifacts/'+ids[1]+'/index.html'
   const route='/admin/app-releases?tab=history#versions'
   const requested=index+'?route='+encodeURIComponent(route)
   expect((await read(requested,test.authorization).set('Sec-Fetch-Mode','navigate')).status).toBe(200)
   const stale=await read(requested,stable.authorization).set('Sec-Fetch-Mode','navigate')
   expect(stale.status).toBe(303)
   expect(stale.headers.location).toBe(route)
   expect((await read(requested,stable.authorization).set('Sec-Fetch-Mode','cors').set('Accept','text/html')).status).toBe(403)
   const nestedApi=await read(index+'?route='+encodeURIComponent('/settings%2f..%2fapi'),stable.authorization).set('Accept','text/html')
   expect(nestedApi.headers.location).toBe('/')
   expect((await read(bindAccess,stable.authorization).set('X-Release-Channel','test')).status).toBe(200)
   expect((await read(bindAccess,superAdminWithEmail.authorization)).status).toBe(200)
   expect((await read('/api/users/me',superAdminWithEmail.authorization)).body.data.user).toMatchObject({emailVerified:false})
   expect((await read(bindAccess,superAdminWithoutEmail.authorization)).body.error.code).toBe('AUTH_EMAIL_BIND_REQUIRED')
   const adminReleases=await read('/api/admin/app-releases',superAdminWithoutEmail.authorization)
   expect(adminReleases.status).toBe(200)
   expect(adminReleases.body.data.test).toMatchObject({enabled:true,releaseId:ids[1]})
   const deniedReleases=await read('/api/admin/app-releases',test.authorization)
   expect(deniedReleases.status).toBe(403)
   expect(deniedReleases.body.error.code).toBe('SUPER_ADMIN_REQUIRED')
   for(const url of [bindAccess,'/api/agent/sessions','/api/uploads/agent-attachments/sample.txt']){
    const blocked=await read(url,test.authorization).set('X-Release-Channel','stable')
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('AUTH_EMAIL_BIND_REQUIRED')
   }
   expect((await request(app).head('/api/uploads/agent-attachments/sample.txt').set('Authorization',test.authorization)).status).toBe(403)
   expect((await request(app).post('/api/novels').set('Authorization',test.authorization).send({})).body.error.code).toBe('AUTH_EMAIL_BIND_REQUIRED')
   for(const url of ['/api/home','/api/credits/public-policy','/api/site-content','/api/admin/users']){
    expect((await read(url,test.authorization)).status).toBe(200)
   }
   expect((await read('/api/site-content/announcements',test.authorization)).body.error.code).toBe('AUTH_EMAIL_BIND_REQUIRED')
   const me=await read('/api/users/me',test.authorization)
   expect(me.status).toBe(200)
   expect(me.body.data.user).toMatchObject({email:null,phoneVerified:true})
   expect(me.body.data).not.toHaveProperty('authoredNovels')
   await prisma.appReleaseChannel.update({where:{channel:'test'},data:{enabled:false}})
   expect((await read(bindAccess,test.authorization)).status).toBe(200)
   await prisma.appReleaseChannel.update({where:{channel:'test'},data:{enabled:true}})
   expect((await read(bindAccess,test.authorization)).body.error.code).toBe('AUTH_EMAIL_BIND_REQUIRED')

   const email=`${randomUUID()}@example.test`,code='123456',codeId=randomUUID()
   const codeHash=createHmac('sha256',env.authSessionSecret).update(`account-email-code:${codeId}:${code}`).digest('hex')
   await prisma.emailVerificationCode.create({data:{
    id:codeId,email,purpose:'bind',userId:test.id,requesterKey:'a'.repeat(64),codeHash,
    expiresAt:new Date(Date.now()+5*60_000),sendState:'accepted',
   }})
   const bind=(value:string)=>request(app).post('/api/auth/account/email').set('Authorization',test.authorization).send({email,code:value})
   const invalid=await bind('654321')
   expect(invalid.status).toBe(400)
   expect(invalid.body.error.code).toBe('AUTH_CODE_INVALID')
   const bound=await bind(code)
   expect(bound.status).toBe(200)
   expect(bound.body.data.user).toMatchObject({id:test.id,email,emailVerified:true,phoneVerified:true})
   expect(await prisma.emailVerificationCode.findUniqueOrThrow({where:{id:codeId}})).toMatchObject({consumedAt:expect.any(Date)})
   expect((await read(bindAccess,test.authorization)).status).toBe(200)
   expect((await read('/api/users/me',test.authorization)).body.data).toMatchObject({
    user:{id:test.id,email,emailVerified:true},authoredNovels:[],
   })
  }finally{
   env.accountEmailAuthEnabled=previous
   await prisma.appReleaseChannel.deleteMany({where:{channel:'test',releaseId:ids[1]}})
   await prisma.user.deleteMany({where:{id:{in:fixtures}}})
  }
 })
 it('uses the same browser grant for anonymous test assets and registration options, then revokes both on withdrawal',async()=>{
  const previous={webUrl:env.webUrl,accountEmailAuthEnabled:env.accountEmailAuthEnabled,accountEmailAuthTestRecipient:env.accountEmailAuthTestRecipient}
  const webUrl='https://preview.example.test',revision=7,recipient='approved-preview@example.test'
  Object.assign(env,{webUrl,accountEmailAuthEnabled:false,accountEmailAuthTestRecipient:recipient})
  const api=()=>request(app)
  const bootstrap='/api/app-releases/bootstrap',options='/api/auth/options'
  const testAsset=`/api/app-releases/artifacts/${ids[1]}/assets/app.js`
  try{
   await prisma.appReleaseChannel.create({data:{channel:'test',releaseId:ids[1],revision,enabled:true}})
   expect((await api().get(bootstrap+'?channel=test').set('X-Release-Channel','test')).body.data).toMatchObject({channel:'stable',release:{id:ids[0]}})
   expect((await api().get(options)).body.data.emailAuthEnabled).toBe(false)
   expect((await api().get(testAsset)).status).toBe(403)
   const launch=await api().post('/api/admin/app-releases/email-auth-preview').set('Host','preview.example.test')
    .set('Origin',webUrl).set('X-Forwarded-Proto','https').set('Cookie',`chevoink_session=${token}`)
    .send({releaseId:ids[1],revision})
   expect(launch.status).toBe(200)
   const cookies=launch.headers['set-cookie'] as unknown as string[]
   const previewCookie=cookies.find(value=>value.startsWith('__Host-chevoink_email_auth_preview='))!.split(';')[0]
   expect(cookies).toEqual(expect.arrayContaining([expect.stringMatching(/^chevoink_session=;.*Max-Age=0/)]))
   expect((await api().get(bootstrap).set('Cookie',previewCookie)).body.data).toMatchObject({channel:'test',release:{id:ids[1]}})
   expect((await api().get(testAsset).set('Cookie',previewCookie)).status).toBe(200)
   expect((await api().get(options).set('Cookie',previewCookie)).body.data.emailAuthEnabled).toBe(true)
   expect((await api().get(options).set('Cookie',`${previewCookie}; chevoink_session=${token}`)).body.data.emailAuthEnabled).toBe(false)
   const wrongEmail=await api().post('/api/auth/email/send-code').set('Cookie',previewCookie)
    .send({email:'other-preview@example.test',purpose:'register',captchaId:'fixture',captchaAnswer:'fixture'})
   expect(wrongEmail.body.error.code).toBe('AUTH_PREVIEW_RECIPIENT_REQUIRED')
   const smsRegister=await api().post('/api/auth/sms/register').set('Cookie',previewCookie).send({})
   expect(smsRegister.body.error.code).toBe('AUTH_EMAIL_REGISTRATION_REQUIRED')
   await prisma.appReleaseChannel.update({where:{channel:'test'},data:{enabled:false,revision:{increment:1}}})
   expect((await api().get(bootstrap).set('Cookie',previewCookie)).body.data).toMatchObject({channel:'stable',release:{id:ids[0]}})
   expect((await api().get(options).set('Cookie',previewCookie)).body.data.emailAuthEnabled).toBe(false)
   expect((await api().get(testAsset).set('Cookie',previewCookie)).status).toBe(403)
  }finally{
   Object.assign(env,previous)
   await prisma.appReleaseChannel.deleteMany({where:{channel:'test',releaseId:ids[1]}})
  }
 })
 it('routes a compatible test release without official policies while actual registration stays unavailable',async()=>{
  const policies=await prisma.siteContent.findMany({where:{kind:{in:['terms','privacy']}},select:{id:true,withdrawn:true}})
  try{
   await prisma.siteContent.updateMany({where:{id:{in:policies.map(row=>row.id)}},data:{withdrawn:true}})
   expect((await readPublicSiteContent()).legal).toEqual({terms:null,privacy:null,registrationAvailable:false})
   const view=await previewAppRelease(adminId,'assign_test',ids[1])
   expect(view.blockers).toEqual([])
   await expect(prisma.$transaction(tx=>verifyRegistrationConsent(tx,undefined))).rejects.toMatchObject({code:'POLICY_UNAVAILABLE'})
   const receipt=await executeAppRelease(adminId,{action:'assign_test',releaseId:ids[1],expectedRevision:view.expectedRevision,previewHash:view.previewHash,operationId:randomUUID()},null)
   expect(receipt).toMatchObject({status:'applied',releaseId:ids[1]})
   expect((await readPublicSiteContent()).legal.registrationAvailable).toBe(false)
  }finally{
   await prisma.appReleaseChannel.deleteMany({where:{channel:'test',releaseId:ids[1]}})
   for(const policy of policies)await prisma.siteContent.update({where:{id:policy.id},data:{withdrawn:policy.withdrawn}})
  }
 })
 it.each(['/api/ADMIN/site-content','/api/admin/SITE-content/','/api/admin/TESTERS','/api/ADMIN/testers/'])('denies actual router case/trailing variants without selected feature %s',async url=>{const response=await request(app).get(url).set('Authorization',`Bearer ${token}`);expect(response.status).toBe(403);expect(response.body.error.code).toBe('APP_RELEASE_CAPABILITY_DISABLED')})
 it('guards encoded model IDs and trailing slashes on actual model update routes',async()=>{const row=await model({});const encoded=row.id.replace(/^./,char=>'%'+char.charCodeAt(0).toString(16));const response=await request(app).patch(`/api/ADMIN/models/${encoded}/`).set('Authorization',`Bearer ${token}`).send({imageQuality:quality});expect(response.status).toBe(403);expect(response.body.error.code).toBe('APP_RELEASE_CAPABILITY_DISABLED');expect((await prisma.aiModelConfig.findUniqueOrThrow({where:{id:row.id}})).revision).toBe(row.revision)})
 it.each(['routes','weightedRoutes'])('denies nested image quality in parsed actual %s configuration',async field=>{const row=await model({});const route={label:'Synthetic nested route',provider:'fixture',modelName:'fixture',baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic-only-key',imageQuality:quality,enabled:true};const body=field==='routes'?{routes:[route]}:{weightedRoutes:{primaryWeight:50,candidates:[{...route,weight:50}]}};const response=await patch(row.id,body);expect(response.status).toBe(403);expect(response.body.error.code).toBe('APP_RELEASE_CAPABILITY_DISABLED')})
 it.each(['quality','weighted','activity'])('rejects enabled-only activation of retained restricted %s metadata and rolls back revision',async kind=>{
  const metadata:Prisma.InputJsonObject=kind==='quality'?{imageQuality:quality}:kind==='weighted'?{weightedRoutes:{primaryWeight:50,candidates:[{id:randomUUID(),label:'Weighted fixture',provider:'fixture',modelName:'fixture',baseUrl:'https://fixture.invalid/v1',apiKeyCiphertext:'synthetic-opaque',weight:50}]}}:{activities:{revision:1,timezone:'UTC',rules:[]}}
  const row=await model(metadata),response=await patch(row.id,{enabled:true,expectedRevision:row.revision})
  expect(response.status).toBe(403);expect(response.body.error.code).toBe('APP_RELEASE_CAPABILITY_DISABLED')
  const after=await prisma.aiModelConfig.findUniqueOrThrow({where:{id:row.id}});expect(after.enabled).toBe(false);expect(after.revision).toBe(row.revision)
 })
 it('blocks same-fee tool replacement carrying quality/weighted/activity metadata before rebinding, while disabled restore remains allowed',async()=>{
  const metadata={imageQuality:quality,weightedRoutes:{primaryWeight:50,candidates:[{id:randomUUID(),label:'Fixture weighted',provider:'fixture',modelName:'fixture',baseUrl:'https://fixture.invalid/v1',apiKeyCiphertext:'synthetic-opaque',weight:50}]},activities:{revision:1,timezone:'UTC',rules:[]}}
  const source=await model(metadata,true),target=await model(metadata,true),role=`review:${randomUUID()}`;roles.push(role)
  await prisma.aiModelSystemBinding.create({data:{roleKey:role,modelConfigId:source.id}})
  const view=await getAdminModelLifecyclePreview(adminId,source.id),candidate=view.candidates.find(item=>item.id===target.id)!
  expect(candidate.eligible).toBe(true)
  const response=await request(app).post(`/api/admin/models/${source.id}/archive`).set('Authorization',`Bearer ${token}`).send({expectedRevision:view.revision,previewHash:view.previewHash,replacementId:target.id,replacementRevision:candidate.revision,reason:'Synthetic review'})
  expect(response.status).toBe(403);expect(response.body.error.code).toBe('APP_RELEASE_CAPABILITY_DISABLED')
  expect((await prisma.aiModelSystemBinding.findUniqueOrThrow({where:{roleKey:role}})).modelConfigId).toBe(source.id)
  expect((await prisma.aiModelConfig.findUniqueOrThrow({where:{id:source.id}})).archivedAt).toBeNull()
  const archived=await model(metadata);await prisma.aiModelConfig.update({where:{id:archived.id},data:{archivedAt:new Date()}})
  const restored=await request(app).post(`/api/admin/models/${archived.id}/restore`).set('Authorization',`Bearer ${token}`).send({expectedRevision:archived.revision,reason:'Synthetic restore'})
  expect(restored.status).toBe(200);expect((await prisma.aiModelConfig.findUniqueOrThrow({where:{id:archived.id}})).enabled).toBe(false)
 })
 it('linearizes reconciliation behind an execute blocked before its operation row is visible',async()=>{
  const view=await previewAppRelease(adminId,'full_release',ids[1]),operationId=randomUUID()
  let held!:()=>void,release!:()=>void
  const locked=new Promise<void>(resolve=>{held=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const blocker=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT channel FROM app_release_channels WHERE channel = 'stable' FOR UPDATE`;held();await gate},{timeout:10000})
  await locked
  const execute=executeAppRelease(adminId,{action:'full_release',releaseId:ids[1],expectedRevision:view.expectedRevision,previewHash:view.previewHash,operationId},null)
  try{
   let acquired=false
   for(let attempt=0;attempt<100&&!acquired;attempt++){const rows=await prisma.$queryRaw<Array<{held:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=804726 AND granted) AS held`;acquired=rows[0].held;if(!acquired)await new Promise(resolve=>setTimeout(resolve,10))}
   expect(acquired).toBe(true)
   const reconciliation=reconcileAppRelease(adminId,operationId)
   expect(await Promise.race([reconciliation.then(()=> 'settled'),new Promise<string>(resolve=>setTimeout(()=>resolve('waiting'),75))])).toBe('waiting')
   release();await blocker
   const receipt=await execute
   expect(await reconciliation).toMatchObject({status:'applied',receipt:{operationId:receipt.operationId}})
  }finally{release();await blocker;await execute}
 },15000)
})
