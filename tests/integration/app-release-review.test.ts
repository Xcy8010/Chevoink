import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { createSession } from '../../api/lib/auth-session.js'
import { executeAppRelease, previewAppRelease, reconcileAppRelease } from '../../api/lib/app-releases.js'
import { getAdminModelLifecyclePreview } from '../../api/lib/admin-model-lifecycle.js'
import { sealAppArtifact } from '../../scripts/app-release-artifact.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'
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
async function artifact(id:string){
 const directory=path.join(root,id);await mkdir(path.join(directory,'assets'),{recursive:true});await writeFile(path.join(directory,'assets/app.js'),'synthetic-only');await writeFile(path.join(directory,'index.html'),`<html><head><script type="module" src="/api/app-releases/artifacts/${id}/assets/app.js"></script></head></html>`)
 const sourceSha='a'.repeat(40),jobs=['plan test shards','check / lint / build / audit','merge coverage / test report','check / lint / test / build / audit','test shard 1/1'].map(name=>({name,status:'completed',conclusion:'success'}))
 const sealed=await sealAppArtifact(directory,{id,label:'Synthetic review release',sourceSha,compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities:[],publicNotes:{features:['Synthetic test fixture'],fixes:[],changes:[]},validation:{status:'verified',verifiedAt:new Date().toISOString(),ciRunId:'123',originalAttempt:1,ci:{headSha:sourceSha,workflowName:'CI',status:'completed',conclusion:'success',jobs}}})
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
 await artifact(ids[0]);await artifact(ids[1])
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
