import { randomUUID } from 'node:crypto'
import { access, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppRelease, AppReleaseRetirement } from '@prisma/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sealAppArtifact } from '../../scripts/app-release-artifact.mjs'
import { assertRetirementMounts, retireAppReleaseArtifact } from '../../api/lib/app-release-retention.js'

const state=vi.hoisted(()=>({row:null as AppRelease|null,job:null as AppReleaseRetirement|null,active:false,beforeUpdate:null as null|((data:Partial<AppReleaseRetirement>)=>Promise<void>)}))
const db={
 $executeRaw:vi.fn(async()=>1),
 appReleaseChannel:{findFirst:vi.fn(async()=>state.active?{enabled:true}:null)},
 appRelease:{findUniqueOrThrow:vi.fn(async()=>structuredClone(state.row!))},
 appReleaseRetirement:{
  findUnique:vi.fn(async()=>state.job?structuredClone(state.job):null),
  update:vi.fn(async({data}:{data:Partial<AppReleaseRetirement>})=>{Object.assign(state.job!,data);return structuredClone(state.job!)}),
  updateMany:vi.fn(async({where,data}:{where:{releaseId:string;operationId:string;state:{not:string}};data:Partial<AppReleaseRetirement>})=>{
   await state.beforeUpdate?.(data)
   const job=state.job
   if(!job||job.releaseId!==where.releaseId||job.operationId!==where.operationId||job.state===where.state.not)return {count:0}
   Object.assign(job,data);return {count:1}
  }),
 },
}
vi.mock('../../api/lib/prisma.js',()=>({prisma:new Proxy({}, {get:(_target,key)=>key==='$transaction'?async(work:(tx:typeof db)=>Promise<unknown>)=>work(db):db[key as keyof typeof db]}),DataAccessError:class extends Error{constructor(public status:number,public code:string,message:string){super(message)}}}))
const previousRoot=process.env.APP_RELEASE_ARTIFACT_ROOT
let base='',root='',source='',quarantine=''
async function exists(file:string){return access(file).then(()=>true,()=>false)}
async function fixture(stage='pending') {
 base=await realpath(await mkdtemp(path.join(os.tmpdir(),'chevoink-retirement-storage-')))
 root=path.join(base,'artifacts');await mkdir(root);process.env.APP_RELEASE_ARTIFACT_ROOT=root
 const id='synthetic-retirement',operationId=randomUUID();source=path.join(root,id)
 await mkdir(path.join(source,'assets'),{recursive:true});await writeFile(path.join(source,'assets/app.js'),'synthetic-public-code')
 await writeFile(path.join(source,'index.html'),`<html><head><script type="module" src="/api/app-releases/artifacts/${id}/assets/app.js"></script></head></html>`)
 const sealed=await sealAppArtifact(source,{id,label:'Synthetic retirement fixture',sourceSha:'a'.repeat(40),compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities:[],publicNotes:{features:['Synthetic fixture'],fixes:[],changes:[]},validation:{status:'draft'}})
 state.row={id,label:sealed.manifest.label,sourceSha:sealed.manifest.sourceSha,artifactSha256:sealed.artifactSha256,manifest:JSON.parse(JSON.stringify(sealed.manifest)),publicNotes:sealed.manifest.publicNotes,compatibilityVersion:1,validationState:'draft',verifiedAt:null,registeredById:'synthetic-admin',createdAt:new Date()}
 state.job={releaseId:id,operationId,artifactSha256:sealed.artifactSha256,quarantineName:id+'-'+operationId,triggerOperationId:null,state:stage,errorCode:null,createdAt:new Date(),updatedAt:new Date(),completedAt:null}
 quarantine=path.join(root,'.retired',state.job.quarantineName)
 return {id,operationId}
}
async function isolate(){await mkdir(path.dirname(quarantine));await rename(source,quarantine)}
beforeEach(()=>{vi.clearAllMocks();state.row=null;state.job=null;state.active=false;state.beforeUpdate=null})
afterEach(async()=>{
 vi.restoreAllMocks()
 if(previousRoot===undefined)delete process.env.APP_RELEASE_ARTIFACT_ROOT;else process.env.APP_RELEASE_ARTIFACT_ROOT=previousRoot
 if(base){const resolved=path.resolve(base),temp=path.resolve(os.tmpdir());if(!resolved.startsWith(temp+path.sep))throw Error('Unsafe synthetic fixture cleanup');await rm(resolved,{recursive:true,force:true});base=''}
})
it('refuses an enabled channel before isolating files or advancing a durable pending claim',async()=>{
 const {id}=await fixture();state.active=true
 await expect(retireAppReleaseArtifact(id)).rejects.toMatchObject({code:'APP_RELEASE_RETIREMENT_ACTIVE'})
 expect(state.job).toMatchObject({state:'pending',errorCode:null});expect(await exists(source)).toBe(true);expect(await exists(quarantine)).toBe(false)
 expect(db.appReleaseRetirement.update).not.toHaveBeenCalled();expect(db.appReleaseRetirement.updateMany).not.toHaveBeenCalled()
})
it('isolates and deletes the exact pending artifact while retaining external bytes and hardlink counterparts',async()=>{
 const {id,operationId}=await fixture();const sentinel=path.join(base,'external-sentinel.txt'),hardlink=path.join(base,'external-hardlink.js')
 await writeFile(sentinel,'outside-synthetic-sentinel');await link(path.join(source,'assets/app.js'),hardlink)
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({operationId,state:'deleted',errorCode:null,completedAt:expect.any(Date)})
 expect(await exists(source)).toBe(false);expect(await exists(quarantine)).toBe(false)
 expect(await readFile(sentinel,'utf8')).toBe('outside-synthetic-sentinel');expect(await readFile(hardlink,'utf8')).toBe('synthetic-public-code')
 expect(db.$executeRaw).toHaveBeenCalledOnce()
 expect(db.appReleaseRetirement.update.mock.calls[0][0].data).toMatchObject({state:'isolating'})
 expect(db.appReleaseRetirement.updateMany.mock.calls.map(([call])=>call.data.state)).toEqual(['deleting','deleted'])
})
it('resumes an isolating claim after rename with the same durable UUID and quarantine name',async()=>{
 const {id,operationId}=await fixture('isolating');await isolate()
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({operationId,quarantineName:id+'-'+operationId,state:'deleted',errorCode:null})
 expect(await exists(source)).toBe(false);expect(await exists(quarantine)).toBe(false)
 expect(db.appReleaseRetirement.update).not.toHaveBeenCalled()
})
it('resumes partial deletion from the retained DB manifest even after manifest.json was already deleted',async()=>{
 const {id,operationId}=await fixture('deleting');await isolate();await rm(path.join(quarantine,'manifest.json'));await rm(path.join(quarantine,'assets/app.js'))
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({operationId,state:'deleted',errorCode:null});expect(await exists(quarantine)).toBe(false)
})
it('refuses extra bytes during deleting and preserves that phase for exact-UUID recovery',async()=>{
 const {id,operationId}=await fixture('deleting');await isolate();await rm(path.join(quarantine,'manifest.json'));await writeFile(path.join(quarantine,'unexpected.txt'),'untracked')
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({operationId,state:'deleting',errorCode:'APP_RELEASE_RETIREMENT_EXTRA_FILE',completedAt:null})
 expect(await readFile(path.join(quarantine,'unexpected.txt'),'utf8')).toBe('untracked')
 await rm(path.join(quarantine,'unexpected.txt'));await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({operationId,state:'deleted',errorCode:null})
})
it('retains isolating evidence when immutable manifest bytes have changed',async()=>{
 const {id}=await fixture();await writeFile(path.join(source,'manifest.json'),(await readFile(path.join(source,'manifest.json'),'utf8'))+' ')
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({state:'isolating',errorCode:'APP_RELEASE_RETIREMENT_HASH',completedAt:null})
 expect(await exists(source)).toBe(true);expect(await exists(quarantine)).toBe(false)
})
it('refuses a directory junction without following it or deleting its external sentinel',async()=>{
 const {id}=await fixture();const outside=path.join(base,'outside'),linked=path.join(source,'linked');await mkdir(outside);await writeFile(path.join(outside,'sentinel.txt'),'junction-sentinel')
 await symlink(outside,linked,'junction')
 try {
  await retireAppReleaseArtifact(id)
  expect(state.job).toMatchObject({state:'isolating',errorCode:'APP_RELEASE_RETIREMENT_PATH'})
  expect(await readFile(path.join(outside,'sentinel.txt'),'utf8')).toBe('junction-sentinel');expect(await exists(source)).toBe(true)
 }finally{await rm(linked,{force:true})}
})
it('rejects same-device bind mount points at the artifact, within it, or in the quarantine tree',()=>{
 const root='/srv/synthetic artifacts',target=root+'/release-a'
 for(const mount of [target,target+'/assets',root+'/.retired',root+'/.retired/release-a-job']) {
  const encoded=mount.split(' ').join('\\040')
  const mountInfo=`141 82 8:1 / ${encoded} rw,relatime - ext4 /dev/sda1 rw`
  expect(()=>assertRetirementMounts(root,target,mountInfo)).toThrow('APP_RELEASE_RETIREMENT_MOUNT')
 }
 expect(()=>assertRetirementMounts(root,target,'141 82 8:1 / /srv/unrelated rw - ext4 /dev/sda1 rw')).not.toThrow()
})
it('refuses a current working directory inside the retiring tree',async()=>{
 const {id}=await fixture();vi.spyOn(process,'cwd').mockReturnValue(path.join(source,'assets'))
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({state:'isolating',errorCode:'APP_RELEASE_RETIREMENT_CWD'});expect(await exists(source)).toBe(true)
})
it('does not downgrade a concurrent completed deletion with a late filesystem error',async()=>{
 const {id,operationId}=await fixture('deleting');await isolate();await writeFile(path.join(quarantine,'unexpected.txt'),'late-failure')
 state.beforeUpdate=async data=>{if(!data.errorCode)return;await rm(quarantine,{recursive:true});Object.assign(state.job!,{state:'deleted',completedAt:new Date(),errorCode:null})}
 await retireAppReleaseArtifact(id)
 expect(state.job).toMatchObject({operationId,state:'deleted',errorCode:null,completedAt:expect.any(Date)});expect(await exists(quarantine)).toBe(false)
 expect(db.appReleaseRetirement.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{releaseId:id,operationId,state:{not:'deleted'}},data:{errorCode:'APP_RELEASE_RETIREMENT_EXTRA_FILE'}}))
})
it('leaves a completed durable claim idempotent without touching files',async()=>{
 const {id}=await fixture('deleted');await retireAppReleaseArtifact(id)
 expect(await exists(source)).toBe(true);expect(db.appReleaseRetirement.updateMany).not.toHaveBeenCalled()
})
