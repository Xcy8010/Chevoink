import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma, SiteContent, SiteContentVersion } from '@prisma/client'
import { announcementSchema, announcementStatus, publicNavigationPaths, publishedAnnouncementSchema, safeSiteLinkSchema, siteNavigationLinkSchema, siteSettingsSchema, type ContentDraft } from '../../shared/contracts/site-content.js'
import { createSiteContent, listSiteContent, mutateSiteContent, readPublicSiteContent, verifyRegistrationConsent } from '../../api/lib/site-content.js'

type Row=SiteContent & {versions:SiteContentVersion[]}
const state=vi.hoisted(()=>({rows:[] as Row[],audits:[] as Array<Record<string,unknown>>,locks:0,failAudit:false,serial:Promise.resolve<unknown>(undefined)}))
const db={
  $executeRaw:vi.fn(async()=>{state.locks++;return 1}),
  siteContent:{
    findMany:vi.fn(async({where}:{where?:{deletedAt?:null;withdrawn?:boolean}}={})=>state.rows.filter(row=>!where || (!row.deletedAt && !row.withdrawn))),
    findUnique:vi.fn(async({where}:{where:{id?:string;kind_key?:{kind:string;key:string}}})=>state.rows.find(row=>where.id ? row.id===where.id : row.kind===where.kind_key!.kind && row.key===where.kind_key!.key) ?? null),
    create:vi.fn(async({data}:{data:{kind:string;key:string;draft:Prisma.JsonValue}})=>{const row:Row={...data,id:`doc-${state.rows.length}`,revision:1,withdrawn:false,deletedAt:null,publishedVersionId:null,createdAt:new Date(),updatedAt:new Date(),versions:[]};state.rows.push(row);return row}),
    update:vi.fn(async({where,data}:{where:{id:string};data:Record<string,unknown>})=>{const row=state.rows.find(item=>item.id===where.id)!;Object.assign(row,{...data,revision:row.revision+1});return row}),
  },
  siteContentVersion:{create:vi.fn(async({data}:{data:Omit<SiteContentVersion,'id'|'publishedAt'>})=>{const row={...data,id:`version-${data.contentId}-${data.contentVersion}`,publishedAt:new Date()};state.rows.find(item=>item.id===data.contentId)!.versions.unshift(row);return row})},
  adminAuditLog:{create:vi.fn(async({data}:{data:Record<string,unknown>})=>{if(state.failAudit)throw new Error('audit unavailable');state.audits.push(data);return data})},
}
const client={...db,$transaction:async<T>(work:(tx:typeof db)=>Promise<T>)=>{
  const run=state.serial.then(async()=>{const snapshot=structuredClone({rows:state.rows,audits:state.audits});try{return await work(db)}catch(error){state.rows=snapshot.rows;state.audits=snapshot.audits;throw error}})
  state.serial=run.catch(()=>{})
  return run
}}
vi.mock('../../api/lib/prisma.js',()=>({prisma:new Proxy({}, {get:(_target,key)=>client[key as keyof typeof client]}),DataAccessError:class extends Error{constructor(public status:number,public code:string,message:string){super(message)}}}))
const announcement:ContentDraft={kind:'announcement',key:'maintenance',payload:{title:'维护安排',body:'服务维护通知',scope:'both',startsAt:'2026-11-06T10:00:00.000Z',endsAt:'2026-11-06T11:00:00.000Z',dismissal:{mode:'ttl',seconds:300}}}
beforeEach(()=>{vi.useRealTimers();vi.clearAllMocks();state.rows=[];state.audits=[];state.locks=0;state.failAudit=false;state.serial=Promise.resolve()})
it('uses inclusive start and exclusive end, and derives unpublished/withdrawn states',()=>{
  const input={published:true,withdrawn:false,...announcement.payload}
  expect(announcementStatus(input,Date.parse('2026-11-06T09:59:59Z'))).toBe('scheduled')
  expect(announcementStatus(input,Date.parse('2026-11-06T10:00:00Z'))).toBe('active')
  expect(announcementStatus(input,Date.parse('2026-11-06T11:00:00Z'))).toBe('ended')
  expect(announcementStatus({...input,published:false},0)).toBe('draft')
  expect(announcementStatus({...input,withdrawn:true},0)).toBe('withdrawn')
  expect(announcementSchema.safeParse({...announcement.payload,endsAt:announcement.payload.startsAt}).success).toBe(false)
})
it('keeps drafts private and immutable publications unchanged by later edits',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T10:30:00Z'))
  const draft=await createSiteContent(announcement,'admin',null)
  expect((await readPublicSiteContent()).announcements).toEqual([])
  const published=await mutateSiteContent(draft.id,{action:'publish',expectedRevision:1},'admin',null)
  expect(published.published).toMatchObject({contentVersion:1,hash:expect.stringMatching(/^[a-f0-9]{64}$/)})
  await mutateSiteContent(draft.id,{action:'save',expectedRevision:2,draft:{...announcement,payload:{...announcement.payload,title:'未发布变更'}}},'admin',null)
  expect((await readPublicSiteContent()).announcements[0].title).toBe('维护安排')
  expect((await listSiteContent())[0].payload).toMatchObject({title:'未发布变更'})
  expect(state.audits.map(item=>item.action)).toEqual(['site_content.create','site_content.publish','site_content.save'])
})
it('rejects stale revisions including concurrent saves without overwriting the winner',async()=>{
  const row=await createSiteContent(announcement,'admin',null)
  const results=await Promise.allSettled([mutateSiteContent(row.id,{action:'save',expectedRevision:1,draft:announcement},'admin',null),mutateSiteContent(row.id,{action:'withdraw',expectedRevision:1},'admin',null)])
  expect(results[0].status).toBe('fulfilled');expect(results[1]).toMatchObject({status:'rejected',reason:{code:'CONTENT_REVISION_CONFLICT'}})
  expect(state.rows[0]).toMatchObject({revision:2,withdrawn:false})
})
it('publishes replacement and withdraws previous announcement atomically with both audits',async()=>{
  const previous=await createSiteContent(announcement,'admin',null)
  await mutateSiteContent(previous.id,{action:'publish',expectedRevision:1},'admin',null)
  const next=await createSiteContent({...announcement,key:'replacement'},'admin',null)
  await mutateSiteContent(next.id,{action:'publish',expectedRevision:1,replace:{id:previous.id,expectedRevision:2}},'admin',null)
  expect(state.rows[0]).toMatchObject({revision:3,withdrawn:true})
  expect(state.rows[1].versions).toHaveLength(1)
  expect(state.audits.slice(-2).map(item=>item.action)).toEqual(['site_content.replaced','site_content.publish'])
})
it('rolls back new snapshot and audit when replacement revision conflicts or audit fails',async()=>{
  const previous=await createSiteContent(announcement,'admin',null)
  const next=await createSiteContent({...announcement,key:'replacement'},'admin',null)
  await expect(mutateSiteContent(next.id,{action:'publish',expectedRevision:1,replace:{id:previous.id,expectedRevision:9}},'admin',null)).rejects.toMatchObject({code:'CONTENT_REVISION_CONFLICT'})
  expect(state.rows[1].versions).toHaveLength(0)
  state.failAudit=true
  await expect(mutateSiteContent(next.id,{action:'publish',expectedRevision:1},'admin',null)).rejects.toThrow('audit unavailable')
  expect(state.rows[1]).toMatchObject({revision:1,publishedVersionId:null,versions:[]})
})
it('tombstones delete and restores same identity/history without manufacturing versions',async()=>{
  const row=await createSiteContent(announcement,'admin',null)
  await mutateSiteContent(row.id,{action:'publish',expectedRevision:1},'admin',null)
  await mutateSiteContent(row.id,{action:'delete',expectedRevision:2},'admin',null)
  expect((await readPublicSiteContent()).announcements).toEqual([])
  await expect(mutateSiteContent(row.id,{action:'publish',expectedRevision:3},'admin',null)).rejects.toMatchObject({code:'CONTENT_DELETED'})
  const restored=await mutateSiteContent(row.id,{action:'restore',expectedRevision:3},'admin',null)
  expect(restored).toMatchObject({id:row.id,revision:4,deletedAt:null});expect(restored.history).toHaveLength(1)
})
it('leaves official policies absent and returns truthful unavailable registration state',async()=>{
  expect((await readPublicSiteContent()).legal).toEqual({terms:null,privacy:null,registrationAvailable:false})
  await expect(verifyRegistrationConsent(db as unknown as Prisma.TransactionClient,undefined)).rejects.toMatchObject({code:'POLICY_UNAVAILABLE'})
})
it('requires submitted current policy IDs and retains older effective version until scheduled replacement takes effect',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
  const terms=await createSiteContent({kind:'terms',key:'terms',payload:{title:'条款测试',body:'Synthetic fixture',effectiveAt:'2026-11-01T00:00:00.000Z'}},'admin',null)
  const privacy=await createSiteContent({kind:'privacy',key:'privacy',payload:{title:'隐私测试',body:'Synthetic fixture',effectiveAt:'2026-11-01T00:00:00.000Z'}},'admin',null)
  const t=await mutateSiteContent(terms.id,{action:'publish',expectedRevision:1},'admin',null)
  const p=await mutateSiteContent(privacy.id,{action:'publish',expectedRevision:1},'admin',null)
  await expect(verifyRegistrationConsent(db as unknown as Prisma.TransactionClient,undefined)).rejects.toMatchObject({code:'POLICY_CONSENT_REQUIRED'})
  const consent={termsVersionId:t.published!.id,privacyVersionId:p.published!.id}
  const verified=await verifyRegistrationConsent(db as unknown as Prisma.TransactionClient,consent)
  expect(verified.acceptedAt).toEqual(new Date('2026-11-06T10:00:00Z'))
  expect(verified.versions).toEqual([{kind:'terms',versionId:t.published!.id,hash:t.published!.hash},{kind:'privacy',versionId:p.published!.id,hash:p.published!.hash}])
  await mutateSiteContent(terms.id,{action:'save',expectedRevision:2,draft:{kind:'terms',key:'terms',payload:{title:'条款下一版',body:'Synthetic v2',effectiveAt:'2026-11-07T00:00:00.000Z'}}},'admin',null)
  await mutateSiteContent(terms.id,{action:'publish',expectedRevision:3},'admin',null)
  expect((await readPublicSiteContent()).legal.terms!.id).toBe(consent.termsVersionId)
  vi.setSystemTime(new Date('2026-11-07T00:00:00Z'))
  await expect(verifyRegistrationConsent(db as unknown as Prisma.TransactionClient,consent)).rejects.toMatchObject({code:'POLICY_CONSENT_REQUIRED'})
  await mutateSiteContent(privacy.id,{action:'withdraw',expectedRevision:2},'admin',null)
  expect((await readPublicSiteContent()).legal.registrationAvailable).toBe(false)
})
it('reports the next start/end and policy boundary with server-derived state',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T09:00:00Z'))
  const row=await createSiteContent(announcement,'admin',null);await mutateSiteContent(row.id,{action:'publish',expectedRevision:1},'admin',null)
  expect((await readPublicSiteContent()).nextBoundaryAt).toBe(announcement.payload.startsAt)
  vi.setSystemTime(new Date(announcement.payload.startsAt));expect((await readPublicSiteContent()).announcements).toHaveLength(1)
  expect((await readPublicSiteContent()).nextBoundaryAt).toBe(announcement.payload.endsAt)
})
it.each(['javascript:alert(1)','data:text/html,<script>alert(1)</script>','//evil.example','http://example.com','https://name:secret@example.com'])('rejects unsafe site links %s',value=>{expect(safeSiteLinkSchema.safeParse(value).success).toBe(false)})
it('accepts safe route and HTTPS navigation without HTML rendering fields',()=>{
  expect(safeSiteLinkSchema.safeParse('/account/docs?doc=faq').success).toBe(true)
  expect(siteSettingsSchema.safeParse({name:'Site',logoUrl:'/logo.png',footer:'Footer',about:'About',docsLabel:'Help',contact:{label:'Contact',url:'https://example.com/contact',details:'Contact instructions'},navigation:[{label:'Docs',url:'/account/docs'}]}).success).toBe(true)
})
it('resolves immediate start from server publication time and keeps unlimited end active without expiry boundaries',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T10:30:00Z'))
 const immediate={...announcement,payload:{...announcement.payload,startsAt:null,endsAt:null}}
 const row=await createSiteContent(immediate,'admin',null)
 expect((await readPublicSiteContent()).announcements).toEqual([])
 vi.setSystemTime(new Date('2026-11-06T11:15:00Z'))
 const published=await mutateSiteContent(row.id,{action:'publish',expectedRevision:1},'admin',null)
 expect(published.published!.payload).toMatchObject({startsAt:'2026-11-06T11:15:00.000Z',endsAt:null})
 expect(published.published!.publishedAt).toBe('2026-11-06T11:15:00.000Z')
 expect(published.status).toBe('active')
 const publicContent=await readPublicSiteContent()
 expect(publicContent.announcements).toHaveLength(1);expect(publicContent.nextBoundaryAt).toBeNull()
 vi.setSystemTime(new Date('2036-11-06T00:00:00Z'))
 expect((await readPublicSiteContent()).announcements).toHaveLength(1)
 expect(publishedAnnouncementSchema.safeParse({...immediate.payload,startsAt:null}).success).toBe(false)
})
it('validates finite immediate end against actual publication time and rolls back an expired draft',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
 const immediate={...announcement,payload:{...announcement.payload,startsAt:null,endsAt:'2026-11-06T10:01:00.000Z'}}
 const row=await createSiteContent(immediate,'admin',null)
 vi.setSystemTime(new Date('2026-11-06T10:01:00Z'))
 await expect(mutateSiteContent(row.id,{action:'publish',expectedRevision:1},'admin',null)).rejects.toMatchObject({code:'ANNOUNCEMENT_TIME_INVALID'})
 expect(state.rows[0]).toMatchObject({revision:1,publishedVersionId:null,versions:[]})
 expect(state.audits).toHaveLength(1)
})
it('preserves scheduled future start with unlimited end and inclusive finite legacy boundaries',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T09:00:00Z'))
 const scheduled={...announcement,payload:{...announcement.payload,endsAt:null}}
 const row=await createSiteContent(scheduled,'admin',null)
 expect((await mutateSiteContent(row.id,{action:'publish',expectedRevision:1},'admin',null)).status).toBe('scheduled')
 expect((await readPublicSiteContent()).nextBoundaryAt).toBe(announcement.payload.startsAt)
 vi.setSystemTime(new Date(announcement.payload.startsAt!))
 expect((await readPublicSiteContent()).announcements).toHaveLength(1)
 expect((await readPublicSiteContent()).nextBoundaryAt).toBeNull()
 expect(announcementStatus({published:true,withdrawn:false,...announcement.payload},Date.parse(announcement.payload.endsAt!))).toBe('ended')
})
it('allows actual normal-user/public navigation routes and HTTPS while keeping asset URLs separate',()=>{
 for(const route of publicNavigationPaths)expect(siteNavigationLinkSchema.safeParse(route).success,route).toBe(true)
 for(const route of ['/account/docs?doc=faq#help','/studio/novel/fixture','/novel/fixture/read/chapter','/community/topic/%E5%88%9B%E4%BD%9C','/author/fixture/follows','/post/fixture','https://example.com/support','HTTPS://example.com/support'])expect(siteNavigationLinkSchema.safeParse(route).success,route).toBe(true)
 expect(safeSiteLinkSchema.safeParse('/branding/custom-logo.png').success).toBe(true)
 expect(siteNavigationLinkSchema.safeParse('/branding/custom-logo.png').success).toBe(false)
})
it.each(['/unknown-public-page','/admin','/admin/users','/api/admin/site-content','javascript:alert(1)','http://example.com/support','//example.com/support','https://name:secret@example.com/support'])('rejects unknown/private navigation or unsafe external URLs %s',url=>{expect(siteNavigationLinkSchema.safeParse(url).success).toBe(false)})