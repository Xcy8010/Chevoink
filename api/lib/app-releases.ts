import { createHash } from 'node:crypto'
import type { AppRelease, AppReleaseChannel, Prisma } from '@prisma/client'
import type { Request } from 'express'
import { appReleaseManifestSchema, type AdminAppRelease, type AppReleaseAction, type AppReleaseBootstrap, type AppReleaseCapability, type AppReleaseExecute, type AppReleasePreview, type AppReleaseReceipt } from '../../shared/contracts/app-release.js'
import { DataAccessError, prisma } from './prisma.js'
import { getSessionUserId } from './auth-session.js'
import { isEffectiveTester } from './tester-entitlement.js'
import { readInstalledAppRelease } from './app-release-artifacts.js'
import { readPublicSiteContent } from './site-content.js'

type Transaction=Prisma.TransactionClient
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([left],[right])=>left.localeCompare(right,'en'))):item)).digest('hex')
const channelView=(row:AppReleaseChannel|undefined|null)=>row?{releaseId:row.releaseId,revision:row.revision,enabled:row.enabled}:null
async function superAdmin(tx:Transaction,actorId:string){const actor=await tx.user.findUnique({where:{id:actorId},select:{role:true,isSuperAdmin:true,bannedAt:true}});if(!actor||actor.role!=='admin'||!actor.isSuperAdmin||actor.bannedAt)throw new DataAccessError(403,'SUPER_ADMIN_REQUIRED','应用版本操作仅限超级管理员。')}
function present(row:AppRelease):AdminAppRelease{const manifest=appReleaseManifestSchema.parse(row.manifest);return{id:row.id,label:row.label,sourceSha:row.sourceSha,artifactSha256:row.artifactSha256,publicNotes:manifest.publicNotes,validationState:row.validationState,verifiedAt:row.verifiedAt?.toISOString()??null,compatibility:manifest.compatibility,capabilities:manifest.capabilities,ciRunId:manifest.validation.status==='verified'?manifest.validation.ciRunId:null,createdAt:row.createdAt.toISOString()}}
const compatible=(row:AppRelease)=>{const manifest=appReleaseManifestSchema.parse(row.manifest);return manifest.compatibility.api===1&&manifest.compatibility.schema===1&&manifest.compatibility.task===1&&manifest.compatibility.legalConsentUi&&row.compatibilityVersion===1}
async function installedRelease(row:AppRelease,full=false){const installed=await readInstalledAppRelease(row.id,full);if(installed.artifactSha256!==row.artifactSha256||installed.manifest.sourceSha!==row.sourceSha||fingerprint(installed.manifest)!==fingerprint(appReleaseManifestSchema.parse(row.manifest)))throw new DataAccessError(503,'APP_RELEASE_ARTIFACT_CHANGED','应用版本文件与登记信息不一致。');return installed}
export async function importAppRelease(actorId:string,releaseId:string,ip:string|null){
 await superAdmin(prisma,actorId)
 const installed=await readInstalledAppRelease(releaseId,true),manifest=installed.manifest
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`
  await superAdmin(tx,actorId)
  const old=await tx.appRelease.findUnique({where:{id:releaseId}})
  if(old){if(old.artifactSha256!==installed.artifactSha256)throw new DataAccessError(409,'APP_RELEASE_IMMUTABLE','版本编号已绑定其他不可变产物。');return present(old)}
  const verified=manifest.validation.status==='verified'
  const row=await tx.appRelease.create({data:{id:releaseId,label:manifest.label,sourceSha:manifest.sourceSha,artifactSha256:installed.artifactSha256,manifest:JSON.parse(JSON.stringify(manifest)) as Prisma.InputJsonObject,publicNotes:JSON.parse(JSON.stringify(manifest.publicNotes)) as Prisma.InputJsonObject,compatibilityVersion:manifest.compatibility.api,verifiedAt:verified&&manifest.validation.status==='verified'?new Date(manifest.validation.verifiedAt):null,validationState:verified?'verified':'draft',registeredById:actorId}})
  await tx.adminAuditLog.create({data:{adminId:actorId,action:'app_release.import',targetType:'app_release',targetId:releaseId,ip,detail:{sourceSha:row.sourceSha,artifactSha256:row.artifactSha256,validationState:row.validationState}}})
  return present(row)
 })
}
export async function selectAppRelease(req:Request,tx:Transaction=prisma):Promise<AppReleaseBootstrap>{return selectAppReleaseForUser(getSessionUserId(req),tx)}
export async function selectAppReleaseForUser(userId:string|null,tx:Transaction=prisma):Promise<AppReleaseBootstrap>{
 const channels=await tx.appReleaseChannel.findMany()
 const stable=channels.find(row=>row.channel==='stable'&&row.enabled),test=channels.find(row=>row.channel==='test'&&row.enabled)
 const channel=test&&userId&&await isEffectiveTester(tx,userId)?'test':'stable'
 const selected=channel==='test'?test:stable
 if(!selected)return{mode:'legacy',channel:'stable',release:null}
 const row=await tx.appRelease.findUnique({where:{id:selected.releaseId}})
 if(!row||row.validationState!=='verified'||!row.verifiedAt||!compatible(row))throw new DataAccessError(503,'APP_RELEASE_UNAVAILABLE','已配置的应用版本尚未通过兼容验证。')
 await installedRelease(row)
 const manifest=appReleaseManifestSchema.parse(row.manifest)
 return{mode:'artifact',channel,release:{id:row.id,label:row.label,notes:manifest.publicNotes,entryUrl:`${manifest.basePath}index.html`,capabilities:manifest.capabilities}}
}
export async function requireAppReleaseCapability(req:Request,capability:AppReleaseCapability){const selection=await selectAppRelease(req);if(selection.mode==='artifact'&&!selection.release!.capabilities.includes(capability))throw new DataAccessError(403,'APP_RELEASE_CAPABILITY_DISABLED','当前应用版本尚未开放此功能。');return selection}
export async function listAppReleases(actorId:string){await superAdmin(prisma,actorId);const[releases,channels,operations]=await Promise.all([prisma.appRelease.findMany({orderBy:{createdAt:'desc'},take:100}),prisma.appReleaseChannel.findMany(),prisma.appReleaseOperation.findMany({where:{status:'applied'},orderBy:{createdAt:'desc'},take:50})]);return{releases:releases.map(present),stable:channelView(channels.find(row=>row.channel==='stable')),test:channelView(channels.find(row=>row.channel==='test')),operations:operations.map(row=>row.result as unknown as AppReleaseReceipt)}}
async function preview(tx:Transaction,actorId:string,action:AppReleaseAction,releaseId:string):Promise<AppReleasePreview>{
 await superAdmin(tx,actorId)
 const row=await tx.appRelease.findUnique({where:{id:releaseId}})
 if(!row)throw new DataAccessError(404,'APP_RELEASE_NOT_FOUND','应用版本尚未登记。')
 const channels=await tx.appReleaseChannel.findMany(),stable=channelView(channels.find(item=>item.channel==='stable')),test=channelView(channels.find(item=>item.channel==='test'))
 const blockers:string[]=[]
 if(action!=='withdraw_test'&&(row.validationState!=='verified'||!row.verifiedAt))blockers.push('版本缺少原始同 SHA 完整 CI 验证证据。')
 if(action!=='withdraw_test'&&!compatible(row))blockers.push('版本与当前 API、加法数据库结构、任务协议或注册政策界面不兼容。')
 if(action!=='withdraw_test'){try{await installedRelease(row,true)}catch{blockers.push('版本文件或不可变清单校验失败。')}}
 else {const fallback=stable?.enabled?await tx.appRelease.findUnique({where:{id:stable.releaseId}}):null;if(!fallback||fallback.validationState!=='verified'||!compatible(fallback))blockers.push('稳定版回退入口尚未通过兼容验证。');else{try{await installedRelease(fallback,true)}catch{blockers.push('稳定版回退入口文件校验失败。')}}}
 const {legal}=await readPublicSiteContent(tx)
 if(action==='assign_test'&&(!stable||!stable.enabled))blockers.push('请先登记并启用经过验证的稳定版，保证测试入口与稳定入口有明确身份。')
 if(action==='withdraw_test'&&(!test||!test.enabled||test.releaseId!==releaseId))blockers.push('目标不是当前启用的测试版。')
 if(action==='rollback'){
  if(!stable||stable.releaseId===releaseId)blockers.push('请选择另一已发布的稳定版本。')
  const historical=await tx.appReleaseOperation.findFirst({where:{releaseId,status:'applied',action:{in:['full_release','rollback']}}})
  if(!historical)blockers.push('该版本没有稳定版发布历史，不能作为回退目标。')
 }
 const expectedRevision=(action==='assign_test'||action==='withdraw_test'?test:stable)?.revision??0
 const identity={actorId,action,releaseId,artifactSha256:row.artifactSha256,stable,test,legal:{terms:legal.terms?.id??null,privacy:legal.privacy?.id??null}}
 return{action,release:present(row),stable,test,expectedRevision,previewHash:fingerprint(identity),blockers,impact:action==='assign_test'?'仅有效测试员和超级管理员使用此版本；其他账号继续使用稳定版。':action==='withdraw_test'?'停止测试分流，测试员后续入口与新功能权限回到稳定版。':action==='rollback'?`将应用前端与新功能能力切换到指定历史稳定版本；不恢复数据库，不修改已接纳任务的模型、价格或版本绑定。${test?.enabled?' 当前测试分流继续使用 '+test.releaseId+'，可另行撤回。':' 当前未启用测试分流。'}`:'将所有账号切换到此稳定版本，并同时停用测试分流；保留原测试版指针和历史记录。'}
}
export async function previewAppRelease(actorId:string,action:AppReleaseAction,releaseId:string){return prisma.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`;return preview(tx,actorId,action,releaseId)},{timeout:30000})}
export async function executeAppRelease(actorId:string,input:AppReleaseExecute,ip:string|null){
 const requestHash=fingerprint({actorId,...input})
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`
  await superAdmin(tx,actorId)
  const old=await tx.appReleaseOperation.findUnique({where:{id:input.operationId}})
  if(old){if(old.actorId!==actorId||old.requestHash!==requestHash)throw new DataAccessError(409,'APP_RELEASE_OPERATION_CONFLICT','同一操作编号已绑定其他请求。');if(old.status!=='applied'||!old.result)throw new DataAccessError(409,'APP_RELEASE_OPERATION_UNKNOWN','操作结果需要先核对。');return{...(old.result as unknown as AppReleaseReceipt),replayed:true}}
  const view=await preview(tx,actorId,input.action,input.releaseId)
  if(view.previewHash!==input.previewHash||view.expectedRevision!==input.expectedRevision)throw new DataAccessError(409,'APP_RELEASE_PREVIEW_CHANGED','版本、资格、政策或通道已变化，请重新预览。')
  if(view.blockers.length)throw new DataAccessError(409,'APP_RELEASE_BLOCKED',view.blockers.join(' '))
  const channel=input.action==='assign_test'||input.action==='withdraw_test'?'test':'stable'
  const previous=channel==='test'?view.test:view.stable
  const revision=input.expectedRevision+1,enabled=input.action!=='withdraw_test'
  await tx.appReleaseChannel.upsert({where:{channel},create:{channel,releaseId:input.releaseId,revision,enabled},update:{releaseId:input.releaseId,revision,enabled}})
  if(input.action==='full_release'&&view.test)await tx.appReleaseChannel.update({where:{channel:'test'},data:{enabled:false,revision:{increment:1}}})
  const receipt:AppReleaseReceipt={operationId:input.operationId,status:'applied',action:input.action,releaseId:input.releaseId,previousReleaseId:previous?.releaseId??null,revision,appliedAt:new Date().toISOString(),...(input.action==='full_release'&&view.test?{testRevision:view.test.revision+1}:{})}
  await tx.appReleaseOperation.create({data:{id:input.operationId,actorId,action:input.action,requestHash,releaseId:input.releaseId,previousReleaseId:receipt.previousReleaseId,status:'applied',result:receipt}})
  await tx.adminAuditLog.create({data:{adminId:actorId,action:`app_release.${input.action}`,targetType:'app_release',targetId:input.releaseId,ip,detail:{operationId:input.operationId,artifactSha256:view.release.artifactSha256,sourceSha:view.release.sourceSha,previousReleaseId:receipt.previousReleaseId,previousRevision:input.expectedRevision,revision,...(input.action==='full_release'?{previousTestChannel:view.test,testRevision:receipt.testRevision??0}:{})}}})
  return receipt
 },{timeout:30000})
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
