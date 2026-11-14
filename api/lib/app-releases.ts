import { createHash } from 'node:crypto'
import { appReleasePeriods } from '../../shared/app-release-periods.js'
import { claimAppReleaseRetirement, pendingReleaseCandidates, planAppReleaseRetention, requireRetainedRelease, scheduleAppReleaseRetention } from './app-release-retention.js'
import type { AppRelease, AppReleaseChannel, Prisma } from '@prisma/client'
import type { Request } from 'express'
import { appReleaseManifestSchema, type AdminAppRelease, type AppReleaseAction, type AppReleaseBootstrap, type AppReleaseCapability, type AppReleaseExecute, type AppReleaseManifest, type AppReleasePreview, type AppReleaseReceipt } from '../../shared/contracts/app-release.js'
import { DataAccessError, prisma } from './prisma.js'
import { getSessionUserId } from './auth-session.js'
import { isEffectiveTester } from './tester-entitlement.js'
import { readInstalledAppRelease } from './app-release-artifacts.js'
import { readPublicSiteContent } from './site-content.js'
import { accountEmailAuthPreview, configuredPreviewRecipient, readAccountEmailAuthPreviewGrant, type AccountEmailAuthPreview } from './account-email-auth-scope.js'

type Transaction=Prisma.TransactionClient
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([left],[right])=>left.localeCompare(right,'en'))):item)).digest('hex')
const channelView=(row:AppReleaseChannel|undefined|null)=>row?{releaseId:row.releaseId,revision:row.revision,enabled:row.enabled}:null
async function superAdmin(tx:Transaction,actorId:string){const actor=await tx.user.findUnique({where:{id:actorId},select:{role:true,isSuperAdmin:true,bannedAt:true}});if(!actor||actor.role!=='admin'||!actor.isSuperAdmin||actor.bannedAt)throw new DataAccessError(403,'SUPER_ADMIN_REQUIRED','应用版本操作仅限超级管理员。')}
function present(row:AppRelease):AdminAppRelease{const manifest=appReleaseManifestSchema.parse(row.manifest);return{id:row.id,label:row.label,sourceSha:row.sourceSha,artifactSha256:row.artifactSha256,publicNotes:manifest.publicNotes,validationState:row.validationState,verifiedAt:row.verifiedAt?.toISOString()??null,compatibility:manifest.compatibility,capabilities:manifest.capabilities,ciRunId:manifest.validation.status==='verified'?manifest.validation.ciRunId:null,createdAt:row.createdAt.toISOString()}}
const compatible=(row:AppRelease,manifest:AppReleaseManifest=appReleaseManifestSchema.parse(row.manifest))=>manifest.compatibility.api===1&&manifest.compatibility.schema===1&&manifest.compatibility.task===1&&manifest.compatibility.legalConsentUi&&row.compatibilityVersion===1
async function installedRelease(row:AppRelease,full=false){const installed=await readInstalledAppRelease(row.id,full);if(installed.artifactSha256!==row.artifactSha256||installed.manifest.sourceSha!==row.sourceSha||fingerprint(installed.manifest)!==fingerprint(appReleaseManifestSchema.parse(row.manifest)))throw new DataAccessError(503,'APP_RELEASE_ARTIFACT_CHANGED','应用版本文件与登记信息不一致。');return installed}
export async function importAppRelease(actorId:string,releaseId:string,ip:string|null){
 await superAdmin(prisma,actorId)
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`
  await superAdmin(tx,actorId)
  await requireRetainedRelease(tx,releaseId)
  const installed=await readInstalledAppRelease(releaseId,true),manifest=installed.manifest
  const old=await tx.appRelease.findUnique({where:{id:releaseId}})
  if(old){if(old.artifactSha256!==installed.artifactSha256)throw new DataAccessError(409,'APP_RELEASE_IMMUTABLE','版本编号已绑定其他不可变产物。');return present(old)}
  if((await pendingReleaseCandidates(tx)).some(row=>row.id!==releaseId))throw new DataAccessError(409,'APP_RELEASE_CANDIDATE_PENDING','已有待分配候选，请先完成或核对该版本，不能继续积累候选。')
  const verified=manifest.validation.status==='verified'
  const row=await tx.appRelease.create({data:{id:releaseId,label:manifest.label,sourceSha:manifest.sourceSha,artifactSha256:installed.artifactSha256,manifest:JSON.parse(JSON.stringify(manifest)) as Prisma.InputJsonObject,publicNotes:JSON.parse(JSON.stringify(manifest.publicNotes)) as Prisma.InputJsonObject,compatibilityVersion:manifest.compatibility.api,verifiedAt:verified&&manifest.validation.status==='verified'?new Date(manifest.validation.verifiedAt):null,validationState:verified?'verified':'draft',registeredById:actorId}})
  await tx.adminAuditLog.create({data:{adminId:actorId,action:'app_release.import',targetType:'app_release',targetId:releaseId,ip,detail:{sourceSha:row.sourceSha,artifactSha256:row.artifactSha256,validationState:row.validationState}}})
  return present(row)
 })
}
export async function selectAppRelease(req:Request,tx:Transaction=prisma):Promise<AppReleaseBootstrap>{return accountEmailAuthPreview()?.selection??selectAppReleaseForUser(getSessionUserId(req),tx)}
async function selectAccountAssignment(tx:Transaction,userId:string|null){
 const channels=await tx.appReleaseChannel.findMany()
 const stable=channels.find(row=>row.channel==='stable'&&row.enabled),test=channels.find(row=>row.channel==='test'&&row.enabled)
 const channel:'test'|'stable'=test&&userId&&await isEffectiveTester(tx,userId)?'test':'stable'
 return {channel,selected:channel==='test'?test:stable}
}
export async function selectAppReleaseForUser(userId:string|null,tx:Transaction=prisma):Promise<AppReleaseBootstrap>{
 const {channel,selected}=await selectAccountAssignment(tx,userId)
 if(!selected)return{mode:'legacy',channel:'stable',release:null}
 return selectAssignedRelease(tx,selected,channel)
}
async function readVerifiedRelease(tx:Transaction,releaseId:string){
 const row=await tx.appRelease.findUnique({where:{id:releaseId}})
 const manifest=appReleaseManifestSchema.safeParse(row?.manifest)
 if(!row||row.validationState!=='verified'||!row.verifiedAt||!manifest.success||!compatible(row,manifest.data))throw new DataAccessError(503,'APP_RELEASE_UNAVAILABLE','已配置的应用版本尚未通过兼容验证。')
 return {row,manifest:manifest.data}
}
export async function hasAgentPersonalizationCapability(userId:string,tx:Transaction=prisma):Promise<boolean>{
 const {selected}=await selectAccountAssignment(tx,userId)
 if(!selected)return true
 const {manifest}=await readVerifiedRelease(tx,selected.releaseId)
 return manifest.capabilities.includes('agentPersonalization')
}
async function selectAssignedRelease(tx:Transaction,selected:AppReleaseChannel,channel:'stable'|'test'):Promise<AppReleaseBootstrap>{
 const {row,manifest}=await readVerifiedRelease(tx,selected.releaseId)
 await installedRelease(row)
 return{mode:'artifact',channel,release:{id:row.id,label:row.label,notes:manifest.publicNotes,entryUrl:`${manifest.basePath}index.html`,capabilities:manifest.capabilities,activatedAt:selected.updatedAt.toISOString()}}
}
async function readActiveTestAssignment(tx:Transaction,releaseId:string,revision:number){
 return (await tx.appReleaseChannel.findMany()).find(row=>row.channel==='test'&&row.enabled&&row.releaseId===releaseId&&row.revision===revision)
}
export async function verifyEmailAuthPreviewLaunch(actorId:string,releaseId:string,revision:number,tx:Transaction=prisma){
 const recipient=configuredPreviewRecipient()
 if(!recipient)throw new DataAccessError(404,'AUTH_PREVIEW_UNAVAILABLE','邮箱注册预览暂未配置。')
 await superAdmin(tx,actorId)
 if(!await isEffectiveTester(tx,actorId))throw new DataAccessError(403,'AUTH_PREVIEW_FORBIDDEN','当前账户无法开启邮箱注册预览。')
 const assignment=await readActiveTestAssignment(tx,releaseId,revision)
 if(!assignment)throw new DataAccessError(409,'AUTH_PREVIEW_ASSIGNMENT_CHANGED','当前测试版已变化，请刷新后重试。')
 await selectAssignedRelease(tx,assignment,'test')
 return recipient
}
export async function resolveEmailAuthPreview(req:Request,tx:Transaction=prisma):Promise<AccountEmailAuthPreview|undefined>{
 const grant=readAccountEmailAuthPreviewGrant(req)
 if(!grant)return undefined
 const userId=getSessionUserId(req)
 const [assignment,issuer]=await Promise.all([
  readActiveTestAssignment(tx,grant.releaseId,grant.revision),
  tx.user.findUnique({where:{id:grant.issuerId},select:{role:true,isSuperAdmin:true,bannedAt:true}}),
 ])
 if(!assignment||issuer?.role!=='admin'||!issuer.isSuperAdmin||issuer.bannedAt||!await isEffectiveTester(tx,grant.issuerId))return undefined
 if(userId){
  const user=await tx.user.findUnique({where:{id:userId},select:{email:true,emailVerifiedAt:true,bannedAt:true}})
  if(!user?.emailVerifiedAt||user.bannedAt||user.email?.toLowerCase()!==grant.recipient)return undefined
 }
 try{
  const selection=await selectAssignedRelease(tx,assignment,'test')
  return{selection,recipient:grant.recipient}
 }catch{
  // A broken or unverified artifact cannot carry preview authorization.
  return undefined
 }
}
export async function requireAppReleaseCapability(req:Request,capability:AppReleaseCapability){const selection=await selectAppRelease(req);if(selection.mode==='artifact'&&!selection.release!.capabilities.includes(capability))throw new DataAccessError(403,'APP_RELEASE_CAPABILITY_DISABLED','当前应用版本尚未开放此功能。');return selection}
export async function listAppReleases(actorId:string){
 await superAdmin(prisma,actorId)
 const[releases,channels,operations,retired]=await Promise.all([prisma.appRelease.findMany({orderBy:{createdAt:'desc'}}),prisma.appReleaseChannel.findMany(),prisma.appReleaseOperation.findMany({where:{status:'applied'},orderBy:{createdAt:'asc'}}),prisma.appReleaseRetirement.findMany()])
 const unavailable=new Set(retired.map(row=>row.releaseId)),used=new Set([...operations.map(row=>row.releaseId),...channels.filter(row=>row.enabled).map(row=>row.releaseId)])
 const receipts=operations.map(row=>row.result as unknown as AppReleaseReceipt),periods=appReleasePeriods(receipts)
 return{releases:releases.filter(row=>!unavailable.has(row.id)).map(row=>({...present(row),lifecycle:used.has(row.id)?'retained' as const:'candidate' as const,effectivePeriods:periods.get(row.id)??[]})),stable:channelView(channels.find(row=>row.channel==='stable')),test:channelView(channels.find(row=>row.channel==='test')),operations:receipts.slice(-50).reverse(),retention:{limit:2,pending:retired.filter(row=>row.state!=='deleted'&&!row.errorCode).length,failed:retired.filter(row=>row.state!=='deleted'&&row.errorCode).length},emailAuthPreviewAvailable:Boolean(configuredPreviewRecipient()&&channels.some(row=>row.channel==='test'&&row.enabled))}
}
async function preview(tx:Transaction,actorId:string,action:AppReleaseAction,releaseId:string):Promise<AppReleasePreview>{
 await superAdmin(tx,actorId)
 const row=await tx.appRelease.findUnique({where:{id:releaseId}})
 if(!row)throw new DataAccessError(404,'APP_RELEASE_NOT_FOUND','应用版本尚未登记。')
 if(action!=='withdraw_test')await requireRetainedRelease(tx,releaseId)
 const channels=await tx.appReleaseChannel.findMany(),stable=channelView(channels.find(item=>item.channel==='stable')),test=channelView(channels.find(item=>item.channel==='test'))
 const blockers:string[]=[]
 const applying=action!=='withdraw_test'&&action!=='discard_candidate'
 if(applying&&(row.validationState!=='verified'||!row.verifiedAt))blockers.push('版本缺少原始同 SHA 完整 CI 验证证据。')
 if(applying&&!compatible(row))blockers.push('版本与当前 API、加法数据库结构、任务协议或注册政策界面不兼容。')
 if(applying){try{await installedRelease(row,true)}catch{blockers.push('版本文件或不可变清单校验失败。')}}
 else if(action==='withdraw_test'){const fallback=stable?.enabled?await tx.appRelease.findUnique({where:{id:stable.releaseId}}):null;if(!fallback||fallback.validationState!=='verified'||!compatible(fallback))blockers.push('稳定版回退入口尚未通过兼容验证。');else{try{await installedRelease(fallback,true)}catch{blockers.push('稳定版回退入口文件校验失败。')}}}
 if(action==='discard_candidate'){
  const history=await tx.appReleaseOperation.findMany({where:{releaseId}})
  if(channels.some(channel=>channel.enabled&&channel.releaseId===releaseId)||history.some(operation=>operation.releaseId===releaseId))blockers.push('该版本已有应用记录或待核对操作，不能作为未分配候选放弃。')
 }
 const {legal}=await readPublicSiteContent(tx)
 if(action==='assign_test'&&(!stable||!stable.enabled))blockers.push('请先登记并启用经过验证的稳定版，保证测试入口与稳定入口有明确身份。')
 if(action==='withdraw_test'&&(!test||!test.enabled||test.releaseId!==releaseId))blockers.push('目标不是当前启用的测试版。')
 if(action==='rollback'){
  if(!stable||stable.releaseId===releaseId)blockers.push('请选择另一已发布的稳定版本。')
  const historical=await tx.appReleaseOperation.findFirst({where:{releaseId,status:'applied',action:{in:['full_release','rollback']}}})
  if(!historical)blockers.push('该版本没有稳定版发布历史，不能作为回退目标。')
 }
 const expectedRevision=action==='discard_candidate'?0:(action==='assign_test'||action==='withdraw_test'?test:stable)?.revision??0
 const identity={actorId,action,releaseId,artifactSha256:row.artifactSha256,stable,test,legal:{terms:legal.terms?.id??null,privacy:legal.privacy?.id??null}}
 return{action,release:present(row),stable,test,expectedRevision,previewHash:fingerprint(identity),blockers,impact:action==='discard_candidate'?'仅放弃尚未分配的候选并自动清理它的文件，不改变当前稳定版或测试版。':action==='assign_test'?'仅有效测试员和超级管理员使用此版本；其他账号继续使用稳定版。':action==='withdraw_test'?'停止测试分流，测试员后续入口与新功能权限回到稳定版。':action==='rollback'?`将应用前端与新功能能力切换到指定历史稳定版本；不恢复数据库，不修改已接纳任务的模型、价格或版本绑定。${test?.enabled?' 当前测试分流继续使用 '+test.releaseId+'，可另行撤回。':' 当前未启用测试分流。'}`:'将所有账号切换到此稳定版本，并同时停用测试分流；保留原测试版指针和历史记录。'}
}
export async function previewAppRelease(actorId:string,action:AppReleaseAction,releaseId:string){return prisma.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`;return preview(tx,actorId,action,releaseId)},{timeout:30000})}
export async function executeAppRelease(actorId:string,input:AppReleaseExecute,ip:string|null){
 const requestHash=fingerprint({actorId,...input})
 const result=await prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`
  await superAdmin(tx,actorId)
  const old=await tx.appReleaseOperation.findUnique({where:{id:input.operationId}})
  if(old){if(old.actorId!==actorId||old.requestHash!==requestHash)throw new DataAccessError(409,'APP_RELEASE_OPERATION_CONFLICT','同一操作编号已绑定其他请求。');if(old.status!=='applied'||!old.result)throw new DataAccessError(409,'APP_RELEASE_OPERATION_UNKNOWN','操作结果需要先核对。');return{...(old.result as unknown as AppReleaseReceipt),replayed:true}}
  const view=await preview(tx,actorId,input.action,input.releaseId)
  if(view.previewHash!==input.previewHash||view.expectedRevision!==input.expectedRevision)throw new DataAccessError(409,'APP_RELEASE_PREVIEW_CHANGED','版本、资格、政策或通道已变化，请重新预览。')
  if(view.blockers.length)throw new DataAccessError(409,'APP_RELEASE_BLOCKED',view.blockers.join(' '))
  const channel=input.action==='assign_test'||input.action==='withdraw_test'?'test':'stable'
  const previous=channel==='test'?view.test:view.stable
  const revision=input.action==='discard_candidate'?0:input.expectedRevision+1,enabled=input.action!=='withdraw_test'
  if(input.action==='discard_candidate')await claimAppReleaseRetirement(tx,view.release,input.operationId)
  else await tx.appReleaseChannel.upsert({where:{channel},create:{channel,releaseId:input.releaseId,revision,enabled},update:{releaseId:input.releaseId,revision,enabled}})
  if(input.action==='full_release'&&view.test)await tx.appReleaseChannel.update({where:{channel:'test'},data:{enabled:false,revision:{increment:1}}})
  const receipt:AppReleaseReceipt={operationId:input.operationId,status:'applied',action:input.action,releaseId:input.releaseId,previousReleaseId:input.action==='discard_candidate'?null:previous?.releaseId??null,revision,appliedAt:new Date().toISOString(),...(input.action==='full_release'&&view.test?{testRevision:view.test.revision+1}:{})}
  await tx.appReleaseOperation.create({data:{id:input.operationId,actorId,action:input.action,requestHash,releaseId:input.releaseId,previousReleaseId:receipt.previousReleaseId,status:'applied',result:receipt}})
  await tx.adminAuditLog.create({data:{adminId:actorId,action:`app_release.${input.action}`,targetType:'app_release',targetId:input.releaseId,ip,detail:{operationId:input.operationId,artifactSha256:view.release.artifactSha256,sourceSha:view.release.sourceSha,previousReleaseId:receipt.previousReleaseId,previousRevision:input.expectedRevision,revision,...(input.action==='full_release'?{previousTestChannel:view.test,testRevision:receipt.testRevision??0}:{})}}})
  await planAppReleaseRetention(tx,input.operationId)
  return receipt
 },{timeout:30000})
 scheduleAppReleaseRetention()
 return result
}
export async function reconcileAppRelease(actorId:string,operationId:string){
 return prisma.$transaction(async tx=>{
  // Absence is determinate only after every earlier channel mutation has committed or rolled back.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`
  await superAdmin(tx,actorId)
  const row=await tx.appReleaseOperation.findUnique({where:{id:operationId}})
  return row?{status:row.status,receipt:row.result as unknown as AppReleaseReceipt|null}:{status:'not_applied',receipt:null}
 },{timeout:30000})
}
