import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppReleaseChannel, Prisma } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { executeAppRelease, importAppRelease, previewAppRelease, reconcileAppRelease } from '../../api/lib/app-releases.js'
import { pendingReleaseCandidates, planAppReleaseRetention, retireAppReleaseArtifact } from '../../api/lib/app-release-retention.js'
import { sealAppArtifact } from '../../scripts/app-release-artifact.mjs'
import type { AppReleaseAction, AppReleaseExecute } from '../../shared/contracts/app-release.js'
import { verifyTestDatabase } from '../support/database-preflight.js'

// Real PG is mandatory. Use the original CI command's --no-file-parallelism:
// stable/test are global channel keys. CI shards have separate PostgreSQL services.
// No DB creation, migration, reset, skip or provider is performed by this fixture.
await verifyTestDatabase(true)
const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'chevoink-retirement-pg-')))
const previousRoot=process.env.APP_RELEASE_ARTIFACT_ROOT,adminId=randomUUID(),ids:string[]=[]
const realTransaction=prisma.$transaction.bind(prisma)
let savedChannels:AppReleaseChannel[]=[],channelsCaptured=false
const exists=(file:string)=>access(file).then(()=>true,()=>false)
async function prepare(letter:string) {
 const id='retention-'+letter+'-'+randomUUID().slice(0,8),directory=path.join(root,id);ids.push(id)
 await mkdir(path.join(directory,'assets'),{recursive:true});await writeFile(path.join(directory,'assets/app.js'),'synthetic-retention-code')
 await writeFile(path.join(directory,'index.html'),`<html><head><script type="module" src="/api/app-releases/artifacts/${id}/assets/app.js"></script></head></html>`)
 const sourceSha='a'.repeat(40),jobs=['plan test shards','check / lint / build / audit','merge coverage / test report','check / lint / test / build / audit','test shard 1/1'].map(name=>({name,status:'completed',conclusion:'success'}))
 await sealAppArtifact(directory,{id,label:'Synthetic retention '+letter,sourceSha,compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities:[],publicNotes:{features:['Synthetic retention fixture'],fixes:[],changes:[]},validation:{status:'verified',verifiedAt:new Date().toISOString(),ciRunId:'123',originalAttempt:1,ci:{headSha:sourceSha,workflowName:'CI',status:'completed',conclusion:'success',jobs}}})
 return id
}
async function input(action:AppReleaseAction,releaseId:string):Promise<AppReleaseExecute> {
 const view=await previewAppRelease(adminId,action,releaseId);expect(view.blockers).toEqual([])
 return {action,releaseId,expectedRevision:view.expectedRevision,previewHash:view.previewHash,operationId:randomUUID()}
}
async function apply(action:AppReleaseAction,releaseId:string){const request=await input(action,releaseId);return {request,receipt:await executeAppRelease(adminId,request,null)}}
async function baseline(){
 const a=await prepare('a');await importAppRelease(adminId,a,null);const initial=await apply('full_release',a)
 const b=await prepare('b');await importAppRelease(adminId,b,null);await apply('assign_test',b);await apply('full_release',b)
 const c=await prepare('c');await importAppRelease(adminId,c,null)
 return {a,b,c,initial}
}
async function cleanArtifactRoot(){
 if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe synthetic artifact cleanup')
 await rm(root,{recursive:true,force:true})
}
async function cleanOwnRows(){
 await prisma.appReleaseChannel.deleteMany({where:{releaseId:{in:ids}}})
 await prisma.appReleaseOperation.deleteMany({where:{actorId:adminId}})
 // The durable retirement FK deliberately precedes deletion of lightweight history.
 await prisma.appReleaseRetirement.deleteMany({where:{releaseId:{in:ids}}})
 await prisma.appRelease.deleteMany({where:{id:{in:ids}}})
 await prisma.adminAuditLog.deleteMany({where:{adminId}})
}
beforeAll(async()=>{
 process.env.APP_RELEASE_ARTIFACT_ROOT=root
 await prisma.user.create({data:{id:adminId,nickname:'synthetic-retention-'+randomUUID(),role:'admin',isSuperAdmin:true,passwordHash:'unusable'}})
})
beforeEach(async()=>{
 savedChannels=await prisma.appReleaseChannel.findMany({where:{channel:{in:['stable','test']}}});channelsCaptured=true
 await prisma.appReleaseChannel.deleteMany({where:{channel:{in:['stable','test']}}})
})
afterEach(async()=>{
 vi.restoreAllMocks();await cleanOwnRows()
 if(channelsCaptured)for(const channel of savedChannels)await prisma.appReleaseChannel.create({data:channel})
 savedChannels=[];channelsCaptured=false
})
afterAll(async()=>{
 try{
  await cleanOwnRows()
  if(channelsCaptured)for(const channel of savedChannels)await prisma.appReleaseChannel.create({data:channel})
  await prisma.user.deleteMany({where:{id:adminId}})
 }finally{
  if(previousRoot===undefined)delete process.env.APP_RELEASE_ARTIFACT_ROOT;else process.env.APP_RELEASE_ARTIFACT_ROOT=previousRoot
  await cleanArtifactRoot();await prisma.$disconnect()
 }
})
it('commits an irreversible A claim, fences reassignment, preserves receipts and bounds retained managed artifacts plus one candidate',async()=>{
 const {a,b,c,initial}=await baseline()
 await apply('assign_test',c)
 const claim=await prisma.appReleaseRetirement.findUniqueOrThrow({where:{releaseId:a}})
 expect(claim).toMatchObject({state:'pending',errorCode:null,completedAt:null,artifactSha256:expect.stringMatching(/^[a-f0-9]{64}$/)})
 expect(claim.quarantineName).toBe(a+'-'+claim.operationId)
 // Separate service transactions have committed; files have not been touched yet.
 expect(await exists(path.join(root,a,'manifest.json'))).toBe(true)
 await expect(previewAppRelease(adminId,'assign_test',a)).rejects.toMatchObject({code:'APP_RELEASE_RETIRED'})
 await expect(importAppRelease(adminId,a,null)).rejects.toMatchObject({code:'APP_RELEASE_RETIRED'})
 expect(await executeAppRelease(adminId,initial.request,null)).toEqual({...initial.receipt,replayed:true})
 expect(await reconcileAppRelease(adminId,initial.request.operationId)).toEqual({status:'applied',receipt:initial.receipt})
 expect((await prisma.appReleaseChannel.findUniqueOrThrow({where:{channel:'stable'}})).releaseId).toBe(b)
 expect((await prisma.appReleaseChannel.findUniqueOrThrow({where:{channel:'test'}})).releaseId).toBe(c)
 const d=await prepare('d');await importAppRelease(adminId,d,null)
 await prisma.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`;await planAppReleaseRetention(tx)})
 expect(await prisma.appReleaseRetirement.findUnique({where:{releaseId:d}})).toBeNull()
 expect((await pendingReleaseCandidates(prisma)).map(row=>row.id)).toContain(d)
 const e=await prepare('e'),f=await prepare('f')
 for(const id of [e,f])await expect(importAppRelease(adminId,id,null)).rejects.toMatchObject({code:'APP_RELEASE_CANDIDATE_PENDING'})
 await retireAppReleaseArtifact(a)
 expect(await prisma.appReleaseRetirement.findUniqueOrThrow({where:{releaseId:a}})).toMatchObject({operationId:claim.operationId,state:'deleted',errorCode:null,completedAt:expect.any(Date)})
 expect(await exists(path.join(root,a))).toBe(false);expect(await exists(path.join(root,d,'manifest.json'))).toBe(true)
 // The prior UUID remains the original applied operation even after physical deletion.
 expect(await executeAppRelease(adminId,initial.request,null)).toEqual({...initial.receipt,replayed:true})
 await apply('assign_test',d)
 const imports=await Promise.allSettled([importAppRelease(adminId,e,null),importAppRelease(adminId,f,null)])
 expect(imports.filter(result=>result.status==='fulfilled')).toHaveLength(1)
 const rejected=imports.find(result=>result.status==='rejected') as PromiseRejectedResult
 expect(rejected.reason).toMatchObject({code:'APP_RELEASE_CANDIDATE_PENDING'})
 const candidate=(await pendingReleaseCandidates(prisma)).filter(row=>ids.includes(row.id));expect(candidate).toHaveLength(1)
 const jobs=await prisma.appReleaseRetirement.findMany({where:{releaseId:{in:ids},state:{not:'deleted'}}})
 expect(jobs.map(row=>row.releaseId)).toContain(c)
 for(const job of jobs)await retireAppReleaseArtifact(job.releaseId)
 const retired=await prisma.appReleaseRetirement.findMany({where:{releaseId:{in:ids}}})
 expect(retired.every(row=>row.state==='deleted'&&row.errorCode===null)).toBe(true)
 const rows=await prisma.appRelease.findMany({where:{id:{in:ids}}}),present:string[]=[]
 for(const row of rows)if(await exists(path.join(root,row.id)))present.push(row.id)
 expect(present.sort()).toEqual([b,d,candidate[0].id].sort())
 expect(present).toHaveLength(3) // two assigned artifacts + one never-assigned candidate
 expect(await prisma.appReleaseRetirement.findUnique({where:{releaseId:candidate[0].id}})).toBeNull()
 // A failed import's prepared directory was never managed; cleanup must not delete it.
 const notImported=candidate[0].id===e?f:e
 expect(await prisma.appRelease.findUnique({where:{id:notImported}})).toBeNull()
 expect(await exists(path.join(root,notImported,'manifest.json'))).toBe(true)
 expect(await readFile(path.join(root,b,'assets/app.js'),'utf8')).toBe('synthetic-retention-code')
})
it.each(['channel','receipt','claim'] as const)('rolls actual PostgreSQL channel, receipt and claim writes back together after %s failure',async failure=>{
 const {a,b,c}=await baseline(),request=await input('assign_test',c)
 const before=await prisma.appReleaseChannel.findMany({orderBy:{channel:'asc'}})
 const count=await prisma.appReleaseOperation.count({where:{actorId:adminId}})
 let injected=false
 const delegate=failure==='channel'?'appReleaseChannel':failure==='receipt'?'appReleaseOperation':'appReleaseRetirement',method=failure==='channel'?'upsert':'create'
 const interception=vi.spyOn(prisma,'$transaction').mockImplementationOnce(work=>realTransaction(async tx=>{
  if(typeof work!=='function')throw Error('Expected interactive service transaction')
  const guarded=new Proxy(tx,{get(target,key,receiver){
   if(key!==delegate)return Reflect.get(target,key,receiver)
   return new Proxy(target[delegate],{get(model,field,inner){
    if(field!==method)return Reflect.get(model,field,inner)
    return async(...args:unknown[])=>{
     const result=await Reflect.apply(Reflect.get(model,field),model,args)
     injected=true;throw Object.assign(new Error('Synthetic '+failure+' transaction failure'),{result})
    }
   }})
  }}) as Prisma.TransactionClient
  return work(guarded)
 },{timeout:30000}))
 try{await expect(executeAppRelease(adminId,request,null)).rejects.toThrow('Synthetic '+failure+' transaction failure')}finally{interception.mockRestore()}
 expect(injected).toBe(true)
 expect(await prisma.appReleaseChannel.findMany({orderBy:{channel:'asc'}})).toEqual(before)
 expect(await prisma.appReleaseOperation.count({where:{actorId:adminId}})).toBe(count)
 expect(await prisma.appReleaseOperation.findUnique({where:{id:request.operationId}})).toBeNull()
 expect(await prisma.appReleaseRetirement.findUnique({where:{releaseId:a}})).toBeNull()
 expect(await reconcileAppRelease(adminId,request.operationId)).toEqual({status:'not_applied',receipt:null})
 for(const id of [a,b,c])expect(await exists(path.join(root,id,'manifest.json'))).toBe(true)
 // A determinate rolled-back operation can execute with its exact original UUID.
 await expect(executeAppRelease(adminId,request,null)).resolves.toMatchObject({operationId:request.operationId,status:'applied',releaseId:c})
 expect(await prisma.appReleaseRetirement.findUniqueOrThrow({where:{releaseId:a}})).toMatchObject({state:'pending',triggerOperationId:request.operationId,errorCode:null})
})
