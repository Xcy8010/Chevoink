import { beforeEach, expect, it, vi } from 'vitest'
import type { AppRelease, AppReleaseChannel, AppReleaseOperation, AppReleaseRetirement } from '@prisma/client'
import type { Request } from 'express'
import { executeAppRelease, importAppRelease, previewAppRelease, reconcileAppRelease, requireAppReleaseCapability, selectAppRelease } from '../../api/lib/app-releases.js'
import type { AppReleaseManifest, AppReleaseAction } from '../../shared/contracts/app-release.js'
const state=vi.hoisted(()=>({releases:[] as AppRelease[],channels:[] as AppReleaseChannel[],operations:[] as AppReleaseOperation[],retirements:[] as AppReleaseRetirement[],audits:[] as unknown[],artifacts:new Map<string,{manifest:AppReleaseManifest;artifactSha256:string}>(),superAdmin:true,testers:new Set<string>(),policy:true,terms:'terms' as string|null,privacy:'privacy' as string|null,failAudit:false,serial:Promise.resolve<unknown>(undefined)}))
const db={
 $executeRaw:vi.fn(async()=>1),
 appReleaseRetirement:{findUnique:vi.fn(async({where}:{where:{releaseId:string}})=>state.retirements.find(row=>row.releaseId===where.releaseId)??null),findMany:vi.fn(async()=>state.retirements),create:vi.fn(async({data}:{data:AppReleaseRetirement})=>{const row={...data,createdAt:new Date(),updatedAt:new Date(),completedAt:null,errorCode:null};state.retirements.push(row);return row})},
 user:{findUnique:vi.fn(async()=>({role:'admin',isSuperAdmin:state.superAdmin,bannedAt:null}))},
 appRelease:{findUnique:vi.fn(async({where}:{where:{id:string}})=>state.releases.find(row=>row.id===where.id)??null),create:vi.fn(async({data}:{data:AppRelease})=>{const row={...data,createdAt:new Date()};state.releases.push(row);return row}),findMany:vi.fn(async()=>state.releases)},
 appReleaseChannel:{findMany:vi.fn(async()=>state.channels),upsert:vi.fn(async({where,create,update}:{where:{channel:string};create:AppReleaseChannel;update:Partial<AppReleaseChannel>})=>{let row=state.channels.find(item=>item.channel===where.channel);if(row)Object.assign(row,update);else{row={...create,updatedAt:new Date()};state.channels.push(row)}return row}),update:vi.fn(async({where,data}:{where:{channel:string};data:{enabled:boolean;revision:{increment:number}}})=>{const row=state.channels.find(item=>item.channel===where.channel)!;row.enabled=data.enabled;row.revision+=data.revision.increment;return row})},
 appReleaseOperation:{findUnique:vi.fn(async({where}:{where:{id:string}})=>state.operations.find(row=>row.id===where.id)??null),findFirst:vi.fn(async({where}:{where:{releaseId:string;status:string;action:{in:string[]}}})=>state.operations.find(row=>row.releaseId===where.releaseId&&row.status===where.status&&where.action.in.includes(row.action))??null),findMany:vi.fn(async()=>state.operations),create:vi.fn(async({data}:{data:AppReleaseOperation})=>{const row={...data,createdAt:new Date(),updatedAt:new Date()};state.operations.push(row);return row})},
 adminAuditLog:{create:vi.fn(async({data}:{data:unknown})=>{if(state.failAudit)throw Error('audit failure');state.audits.push(data);return data})},
}
const prisma={...db,$transaction:async<T>(work:(tx:typeof db)=>Promise<T>)=>{const run=state.serial.then(async()=>{const snapshot=structuredClone({releases:state.releases,channels:state.channels,operations:state.operations,retirements:state.retirements,audits:state.audits});try{return await work(db)}catch(error){Object.assign(state,snapshot);throw error}});state.serial=run.catch(()=>{});return run}}
vi.mock('../../api/lib/prisma.js',()=>({prisma:new Proxy({}, {get:(_target,key)=>prisma[key as keyof typeof prisma]}),DataAccessError:class extends Error{constructor(public status:number,public code:string,message:string){super(message)}}}))
vi.mock('../../api/lib/auth-session.js',()=>({getSessionUserId:(req:Request)=>req.headers['fixture-user']??null}))
vi.mock('../../api/lib/tester-entitlement.js',()=>({isEffectiveTester:async(_db:unknown,id:string)=>state.testers.has(id)}))
vi.mock('../../api/lib/site-content.js',()=>({readPublicSiteContent:async()=>({legal:{registrationAvailable:state.policy,terms:state.terms?{id:state.terms}:null,privacy:state.privacy?{id:state.privacy}:null}})}))
vi.mock('../../api/lib/app-release-artifacts.js',()=>({readInstalledAppRelease:async(id:string)=>{const artifact=state.artifacts.get(id);if(!artifact)throw Error('missing artifact');return artifact}}))
function manifest(id:string):AppReleaseManifest{return{format:1,entryProtocol:1,id,label:id,sourceSha:'a'.repeat(40),basePath:`/api/app-releases/artifacts/${id}/`,compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities:id==='test-version'?['siteContent','imageQuality']:[],publicNotes:{features:['Synthetic public feature'],fixes:[],changes:[]},files:[{path:'index.html',size:1,sha256:'1'.repeat(64)},{path:'release-entry.js',size:1,sha256:'2'.repeat(64)}],validation:{status:'verified',verifiedAt:'2026-11-06T00:00:00.000Z',ciRunId:'123',originalAttempt:1,ci:{headSha:'a'.repeat(40),workflowName:'CI',status:'completed',conclusion:'success',jobs:['plan test shards','check / lint / build / audit','merge coverage / test report','check / lint / test / build / audit','test shard 1/1'].map(name=>({name,status:'completed',conclusion:'success'}))}}}}
function release(id:string){const data=manifest(id);state.artifacts.set(id,{manifest:data,artifactSha256:'b'.repeat(64)});const row:AppRelease={id,label:id,sourceSha:data.sourceSha,artifactSha256:'b'.repeat(64),manifest:JSON.parse(JSON.stringify(data)),publicNotes:JSON.parse(JSON.stringify(data.publicNotes)),compatibilityVersion:1,verifiedAt:new Date(),validationState:'verified',registeredById:'admin',createdAt:new Date()};state.releases.push(row);return row}
function channel(name:string,id:string,revision=1){state.channels.push({channel:name,releaseId:id,revision,enabled:true,updatedAt:new Date()})}
const req=(user?:string,extra:Record<string,string>={})=>({headers:{...(user?{'fixture-user':user}:{}),...extra}} as unknown as Request)
let sequence=0
async function operation(action:AppReleaseAction,releaseId:string){const view=await previewAppRelease('admin',action,releaseId);return{action,releaseId,expectedRevision:view.expectedRevision,previewHash:view.previewHash,operationId:`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`}}
beforeEach(()=>{vi.clearAllMocks();state.releases=[];state.channels=[];state.operations=[];state.retirements=[];state.audits=[];state.artifacts.clear();state.superAdmin=true;state.testers.clear();state.policy=true;state.terms='terms';state.privacy='privacy';state.failAudit=false;state.serial=Promise.resolve()})
it('selects real assigned artifacts from server tester qualification, never a URL or header',async()=>{release('stable-version');release('test-version');channel('stable','stable-version');channel('test','test-version');state.testers.add('tester');expect((await selectAppRelease(req('ordinary',{'x-release-channel':'test','x-release-id':'test-version'}))).release!.id).toBe('stable-version');expect((await selectAppRelease(req('tester'))).release).toMatchObject({id:'test-version',activatedAt:state.channels.find(row=>row.channel==='test')!.updatedAt.toISOString()});state.testers.delete('tester');expect((await selectAppRelease(req('tester'))).release!.id).toBe('stable-version');await expect(requireAppReleaseCapability(req('ordinary'),'siteContent')).rejects.toMatchObject({code:'APP_RELEASE_CAPABILITY_DISABLED'})})
it('preserves unconfigured legacy behavior but fails configured missing or incompatible artifacts',async()=>{expect(await selectAppRelease(req())).toEqual({mode:'legacy',channel:'stable',release:null});const row=release('stable-version');channel('stable',row.id);state.artifacts.clear();await expect(selectAppRelease(req())).rejects.toThrow('missing artifact');const data=manifest(row.id);data.compatibility.legalConsentUi=false;row.manifest=JSON.parse(JSON.stringify(data));await expect(selectAppRelease(req())).rejects.toMatchObject({code:'APP_RELEASE_UNAVAILABLE'})})
it('imports only protected manifest identity, retaining drafts honestly and forbidding replacement',async()=>{const data=manifest('draft-version');data.validation={status:'draft'};state.artifacts.set(data.id,{manifest:data,artifactSha256:'c'.repeat(64)});const imported=await importAppRelease('admin',data.id,null);expect(imported).toMatchObject({validationState:'draft',verifiedAt:null,sourceSha:'a'.repeat(40)});state.artifacts.set(data.id,{manifest:data,artifactSha256:'d'.repeat(64)});await expect(importAppRelease('admin',data.id,null)).rejects.toMatchObject({code:'APP_RELEASE_IMMUTABLE'})})
it('requires a concrete stable baseline and compatible consent UI but allows routing when official policies are absent',async()=>{
 release('test-version');let view=await previewAppRelease('admin','assign_test','test-version');expect(view.blockers.join(' ')).toContain('稳定版')
 release('stable-version');channel('stable','stable-version');state.policy=false;state.terms=null;state.privacy=null
 view=await previewAppRelease('admin','assign_test','test-version');expect(view.blockers).toEqual([])
 await expect(executeAppRelease('admin',await operation('assign_test','test-version'),null)).resolves.toMatchObject({status:'applied'})
 const row=state.releases.find(item=>item.id==='test-version')!,incompatible=manifest(row.id);incompatible.compatibility.legalConsentUi=false;row.manifest=JSON.parse(JSON.stringify(incompatible))
 view=await previewAppRelease('admin','assign_test','test-version');expect(view.blockers.join(' ')).toContain('不兼容')
 await expect(executeAppRelease('admin',await operation('assign_test','test-version'),null)).rejects.toMatchObject({code:'APP_RELEASE_BLOCKED'})
})
it.each(['terms','privacy'] as const)('invalidates a preview when %s changes while the other policy is absent',async kind=>{
 release('stable-version');release('test-version');channel('stable','stable-version');state.policy=false;state.terms=null;state.privacy=null;state[kind]='first'
 const input=await operation('assign_test','test-version');state[kind]='second'
 await expect(executeAppRelease('admin',input,null)).rejects.toMatchObject({code:'APP_RELEASE_PREVIEW_CHANGED'})
 expect(state.operations).toHaveLength(0);expect(state.channels).toHaveLength(1);expect(state.audits).toHaveLength(0)
})
it('full release atomically assigns exact stable artifact and disables test with both revisions retained',async()=>{release('stable-version');release('test-version');channel('stable','stable-version',3);channel('test','test-version',7);const input=await operation('full_release','test-version');const receipt=await executeAppRelease('admin',input,null);expect(receipt).toMatchObject({status:'applied',releaseId:'test-version',revision:4,testRevision:8});expect(state.channels).toEqual(expect.arrayContaining([expect.objectContaining({channel:'stable',releaseId:'test-version',revision:4,enabled:true}),expect.objectContaining({channel:'test',releaseId:'test-version',revision:8,enabled:false})]));state.testers.add('tester');expect((await selectAppRelease(req('tester'))).release!.id).toBe('test-version');expect(state.audits).toHaveLength(1)})
it('binds both channel revisions in preview, denies changed impact and rechecks super-admin authority',async()=>{release('stable-version');release('test-version');channel('stable','stable-version');channel('test','test-version');const input=await operation('full_release','test-version');state.channels[1].revision++;await expect(executeAppRelease('admin',input,null)).rejects.toMatchObject({code:'APP_RELEASE_PREVIEW_CHANGED'});expect(state.operations).toHaveLength(0);state.superAdmin=false;await expect(executeAppRelease('admin',input,null)).rejects.toMatchObject({code:'SUPER_ADMIN_REQUIRED'})})
it('uses stable idempotency and reconciles an acknowledged or unknown client result without replaying mutation',async()=>{release('stable-version');const input=await operation('full_release','stable-version');const first=await executeAppRelease('admin',input,null);const replay=await executeAppRelease('admin',input,null);expect(replay).toMatchObject({...first,replayed:true});expect(state.operations).toHaveLength(1);expect(state.audits).toHaveLength(1);await expect(executeAppRelease('admin',{...input,releaseId:'another-version'},null)).rejects.toMatchObject({code:'APP_RELEASE_OPERATION_CONFLICT'});expect(await reconcileAppRelease('admin',input.operationId)).toMatchObject({status:'applied',receipt:first});expect(await reconcileAppRelease('admin','unknown')).toEqual({status:'not_applied',receipt:null})})
it('withdraws a broken test artifact using verified stable fallback, even when policy activation is unavailable',async()=>{release('stable-version');release('test-version');channel('stable','stable-version');channel('test','test-version',5);state.artifacts.delete('test-version');state.policy=false;const view=await previewAppRelease('admin','withdraw_test','test-version');expect(view.blockers).toEqual([]);await executeAppRelease('admin',await operation('withdraw_test','test-version'),null);expect(state.channels[0]).toMatchObject({releaseId:'stable-version',revision:1});expect(state.channels[1]).toMatchObject({releaseId:'test-version',revision:6,enabled:false})})
it('requires real stable history for rollback and previews continuing test impact',async()=>{release('stable-version');release('previous-version');release('test-version');channel('stable','stable-version');channel('test','test-version');let view=await previewAppRelease('admin','rollback','previous-version');expect(view.blockers.join(' ')).toContain('稳定版发布历史');state.operations.push({id:'prior',requestHash:'h',action:'full_release',actorId:'admin',releaseId:'previous-version',previousReleaseId:null,status:'applied',result:{},createdAt:new Date(),updatedAt:new Date()});view=await previewAppRelease('admin','rollback','previous-version');expect(view.blockers).toEqual([]);expect(view.impact).toContain('test-version');await executeAppRelease('admin',await operation('rollback','previous-version'),null);expect(state.channels[1]).toMatchObject({enabled:true,releaseId:'test-version',revision:1})})
it('rolls back channel pointers, operation receipt and audits together on failure',async()=>{release('stable-version');release('test-version');channel('stable','stable-version');channel('test','test-version');const input=await operation('full_release','test-version');state.failAudit=true;await expect(executeAppRelease('admin',input,null)).rejects.toThrow('audit failure');expect(state.channels).toEqual(expect.arrayContaining([expect.objectContaining({channel:'stable',releaseId:'stable-version',revision:1}),expect.objectContaining({channel:'test',enabled:true,revision:1})]));expect(state.operations).toHaveLength(0);expect(state.audits).toHaveLength(0)})
it('compares retained JSONB manifest semantically after database key-order normalization',async()=>{
 const row=release('stable-version');channel('stable','stable-version')
 row.manifest=Object.fromEntries(Object.entries(row.manifest as Record<string,unknown>).reverse()) as AppRelease['manifest']
 expect((await selectAppRelease(req())).release!.id).toBe('stable-version')
})
it('does not report absence while a concurrent execute transaction is still in flight',async()=>{
 release('stable-version')
 const input=await operation('full_release','stable-version')
 let entered!:()=>void,releaseWrite!:()=>void
 const writing=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{releaseWrite=resolve})
 const original=db.appReleaseChannel.upsert.getMockImplementation()!
 db.appReleaseChannel.upsert.mockImplementationOnce(async args=>{entered();await gate;return original(args)})
 const execute=executeAppRelease('admin',input,null)
 await writing
 let settled=false
 const reconciliation=reconcileAppRelease('admin',input.operationId).then(result=>{settled=true;return result})
 await Promise.resolve();await Promise.resolve()
 expect(settled).toBe(false)
 releaseWrite()
 await execute
 expect(await reconciliation).toMatchObject({status:'applied',receipt:{operationId:input.operationId}})
})
it('admits only one durable unassigned candidate under concurrent registration',async()=>{
 for(const id of ['candidate-a','candidate-b'])state.artifacts.set(id,{manifest:manifest(id),artifactSha256:'b'.repeat(64)})
 const results=await Promise.allSettled([importAppRelease('admin','candidate-a',null),importAppRelease('admin','candidate-b',null)])
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
 expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'APP_RELEASE_CANDIDATE_PENDING'}})
 expect(state.releases).toHaveLength(1);expect(state.audits).toHaveLength(1)
})
it('can explicitly discard an unverified candidate to release its slot without changing channels or falsifying CI',async()=>{
 const draft=manifest('draft-candidate');draft.validation={status:'draft'}
 state.artifacts.set(draft.id,{manifest:draft,artifactSha256:'b'.repeat(64)})
 await importAppRelease('admin',draft.id,null)
 const before=structuredClone(state.channels),input=await operation('discard_candidate',draft.id)
 expect((await previewAppRelease('admin','discard_candidate',draft.id)).impact).toContain('不改变当前稳定版或测试版')
 await expect(executeAppRelease('admin',input,null)).resolves.toMatchObject({action:'discard_candidate',revision:0,previousReleaseId:null})
 expect(state.channels).toEqual(before)
 expect(state.retirements[0]).toMatchObject({releaseId:draft.id,state:'pending',triggerOperationId:input.operationId})
 expect(state.releases[0].validationState).toBe('draft')
 state.artifacts.set('next-candidate',{manifest:manifest('next-candidate'),artifactSha256:'b'.repeat(64)})
 await expect(importAppRelease('admin','next-candidate',null)).resolves.toMatchObject({id:'next-candidate'})
})
it('blocks candidate discard when a version is active, previously used or has an unknown operation',async()=>{
 release('active');await executeAppRelease('admin',await operation('full_release','active'),null)
 expect((await previewAppRelease('admin','discard_candidate','active')).blockers).not.toEqual([])
 release('unknown-candidate');state.operations.push({id:'unknown',releaseId:'unknown-candidate',status:'unknown'} as AppReleaseOperation)
 expect((await previewAppRelease('admin','discard_candidate','unknown-candidate')).blockers).not.toEqual([])
 expect(state.retirements).toEqual([])
})
it('keeps successful historical UUID receipts available after the obsolete version is claimed and its files disappear',async()=>{
 release('release-a');const original=await operation('full_release','release-a');const applied=await executeAppRelease('admin',original,null)
 release('release-b');await executeAppRelease('admin',await operation('full_release','release-b'),null)
 release('release-c');await executeAppRelease('admin',await operation('assign_test','release-c'),null)
 expect(state.retirements.map(row=>row.releaseId)).toEqual(['release-a'])
 state.artifacts.delete('release-a')
 await expect(previewAppRelease('admin','assign_test','release-a')).rejects.toMatchObject({code:'APP_RELEASE_RETIRED'})
 await expect(executeAppRelease('admin',original,null)).resolves.toMatchObject({...applied,replayed:true})
 await expect(reconcileAppRelease('admin',original.operationId)).resolves.toMatchObject({status:'applied',receipt:applied})
 expect(state.channels.find(row=>row.channel==='stable')?.releaseId).toBe('release-b')
 expect(state.channels.find(row=>row.channel==='test')?.releaseId).toBe('release-c')
})
it('rolls back the new channel and receipt when its durable retirement claim cannot be saved',async()=>{
 release('release-a');await executeAppRelease('admin',await operation('full_release','release-a'),null)
 release('release-b');await executeAppRelease('admin',await operation('full_release','release-b'),null)
 release('release-c');const input=await operation('assign_test','release-c'),before=structuredClone({channels:state.channels,operations:state.operations,audits:state.audits})
 db.appReleaseRetirement.create.mockRejectedValueOnce(Error('claim persistence failed'))
 await expect(executeAppRelease('admin',input,null)).rejects.toThrow('claim persistence failed')
 expect(state.channels).toEqual(before.channels);expect(state.operations).toEqual(before.operations);expect(state.audits).toEqual(before.audits);expect(state.retirements).toEqual([])
})
