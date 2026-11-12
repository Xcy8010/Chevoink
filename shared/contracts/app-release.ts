import { z } from 'zod'
export const appReleaseIdSchema=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export const appReleaseCapabilities=['siteContent','testerManagement','imageQuality','modelPromotions','imageWeightedRoutes','publicModelDetails','legacyEmailBinding'] as const
export type AppReleaseCapability=typeof appReleaseCapabilities[number]
export const publicReleaseNotesSchema=z.object({changes:z.array(z.string().trim().min(1).max(1000)).max(50),features:z.array(z.string().trim().min(1).max(1000)).max(50),fixes:z.array(z.string().trim().min(1).max(1000)).max(50)}).refine(value=>value.changes.length+value.features.length+value.fixes.length>0,'请提供具体更新说明')
const ciSchema=z.object({headSha:z.string().regex(/^[a-f0-9]{40}$/),workflowName:z.literal('CI'),status:z.literal('completed'),conclusion:z.literal('success'),jobs:z.array(z.object({name:z.string(),status:z.literal('completed'),conclusion:z.literal('success')})).min(5).max(100)})
export const appReleaseManifestSchema=z.object({
 format:z.literal(1),entryProtocol:z.literal(1),id:appReleaseIdSchema,label:z.string().trim().min(1).max(100),sourceSha:z.string().regex(/^[a-f0-9]{40}$/),basePath:z.string(),
 compatibility:z.object({api:z.number().int().positive(),schema:z.number().int().positive(),task:z.number().int().positive(),legalConsentUi:z.boolean()}),
 capabilities:z.array(z.enum(appReleaseCapabilities)).max(appReleaseCapabilities.length).refine(value=>new Set(value).size===value.length),publicNotes:publicReleaseNotesSchema,
 files:z.array(z.object({path:z.string().max(400).regex(/^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*$/).refine(value=>value.split('/').every(part=>part!=='.'&&part!=='..')),size:z.number().int().nonnegative().max(209715200),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(2).max(5000),
 validation:z.discriminatedUnion('status',[z.object({status:z.literal('draft')}),z.object({status:z.literal('verified'),verifiedAt:z.iso.datetime(),ciRunId:z.string().regex(/^[1-9]\d*$/),originalAttempt:z.literal(1),ci:ciSchema})]),
}).superRefine((value,ctx)=>{
 if(value.basePath!==`/api/app-releases/artifacts/${value.id}/`)ctx.addIssue({code:'custom',message:'Artifact base path mismatch'})
 const paths=value.files.map(file=>file.path)
 if(new Set(paths).size!==paths.length||!paths.includes('index.html')||!paths.includes('release-entry.js')||paths.includes('manifest.json'))ctx.addIssue({code:'custom',message:'Artifact file manifest mismatch'})
 if(value.validation.status==='verified'){
  const ci=value.validation.ci,names=ci.jobs.map(job=>job.name),required=['plan test shards','check / lint / build / audit','merge coverage / test report','check / lint / test / build / audit']
  const shards=names.filter(name=>/^test shard \d+\/\d+$/.test(name)),count=Number(shards[0]?.split('/')[1])
  if(ci.headSha!==value.sourceSha||required.some(name=>names.filter(item=>item===name).length!==1)||!Number.isInteger(count)||count<1||shards.length!==count||Array.from({length:count},(_,i)=>`test shard ${i+1}/${count}`).some(name=>shards.filter(item=>item===name).length!==1)||names.length!==required.length+count)ctx.addIssue({code:'custom',message:'Incomplete original same-SHA CI evidence'})
 }
})
export type AppReleaseManifest=z.infer<typeof appReleaseManifestSchema>
export type PublicReleaseNotes=z.infer<typeof publicReleaseNotesSchema>
export type PublicAppRelease={id:string;label:string;notes:PublicReleaseNotes;entryUrl:string;capabilities:AppReleaseCapability[];activatedAt?:string}
export type AppReleaseBootstrap={mode:'legacy'|'artifact';channel:'stable'|'test';release:PublicAppRelease|null}
export const appReleaseActions=['assign_test','full_release','rollback','withdraw_test','discard_candidate'] as const
export type AppReleaseAction=typeof appReleaseActions[number]
export const appReleasePreviewSchema=z.object({action:z.enum(appReleaseActions),releaseId:appReleaseIdSchema})
export const appReleaseExecuteSchema=appReleasePreviewSchema.extend({expectedRevision:z.number().int().nonnegative(),previewHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:z.string().uuid()})
export type AppReleaseExecute=z.infer<typeof appReleaseExecuteSchema>
export type AppReleaseChannelState={releaseId:string;revision:number;enabled:boolean}|null
export type AdminAppRelease={id:string;label:string;sourceSha:string;artifactSha256:string;publicNotes:PublicReleaseNotes;validationState:string;verifiedAt:string|null;compatibility:AppReleaseManifest['compatibility'];capabilities:AppReleaseCapability[];ciRunId:string|null;createdAt:string;effectivePeriods?:Array<{channel:'stable'|'test';startsAt:string|null;endsAt:string|null}>;lifecycle?:'retained'|'candidate'}
export type AppReleaseReceipt={operationId:string;status:'applied';action:AppReleaseAction;releaseId:string;previousReleaseId:string|null;revision:number;appliedAt:string;testRevision?:number;replayed?:boolean}
export type AppReleasePreview={action:AppReleaseAction;release:AdminAppRelease;stable:AppReleaseChannelState;test:AppReleaseChannelState;expectedRevision:number;previewHash:string;blockers:string[];impact:string}
export type AdminAppReleaseIndex={releases:AdminAppRelease[];stable:AppReleaseChannelState;test:AppReleaseChannelState;operations:AppReleaseReceipt[];retention?:{limit:number;pending:number;failed:number};emailAuthPreviewAvailable?:boolean}
