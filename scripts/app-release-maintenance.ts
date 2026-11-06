import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'
import { z } from 'zod'
import type { AdminAppRelease, AppReleasePreview, AppReleaseReceipt } from '../shared/contracts/app-release.js'
import { appReleaseIdSchema } from '../shared/contracts/app-release.js'

const baseline = '07da47b79586185538fd644b0c0540453287a32f'
const sharedEnvironment = '/opt/chevoink/shared/app.env'
const activeMarker = '/opt/chevoink/app/current/.chevoink-release.json'
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const inputSchema = z.object({ command: z.enum(['register', 'preview', 'execute', 'reconcile']), mode: z.enum(['initialize_stable', 'assign_test']),
  actorId: z.string().min(1).max(64), candidateSha: sha, candidateProof: z.string().min(1), candidateProofSha256: digest,
  releaseId: appReleaseIdSchema, artifactSha256: digest, receiptPath: z.string().min(1), operationId: z.string().uuid(),
  previewHash: digest.optional(), expectedRevision: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.command === 'execute' && (value.previewHash === undefined || value.expectedRevision === undefined)) ctx.addIssue({code:'custom',message:'Execute requires the exact preview hash and revision'})
  if (value.command !== 'execute' && (value.previewHash !== undefined || value.expectedRevision !== undefined)) ctx.addIssue({code:'custom',message:'Only execute accepts preview binding'})
  if (![value.candidateProof, value.receiptPath].every(file => path.isAbsolute(file))) ctx.addIssue({code:'custom',message:'Explicit absolute proof and receipt paths required'})
})
export type MaintenanceInput = z.infer<typeof inputSchema>
type Host = { osUser: string; uid: number; hostname: string; sshConnectionPresent: boolean }
type Context = { candidateSha: string; candidateProofSha256: string; observedCurrentSha: string; database: { host: string; database: string; schema: string }; channelCount: number; registeredArtifact?: {releaseId:string;sourceSha:string;artifactSha256:string}|null }
type Reconciliation = { status: string; receipt: AppReleaseReceipt | null }
export type MaintenanceDependencies = {
  host: () => Host
  verifyContext: (input: MaintenanceInput) => Promise<Context>
  installed: (releaseId: string) => Promise<{artifactSha256:string;manifest:{sourceSha:string;validation:{status:string}}}>
  register: (actorId: string, releaseId: string, ip: null) => Promise<AdminAppRelease>
  preview: (actorId: string, action: 'full_release' | 'assign_test', releaseId: string) => Promise<AppReleasePreview>
  execute: (actorId: string, input: {action:'full_release'|'assign_test';releaseId:string;expectedRevision:number;previewHash:string;operationId:string}, ip:null) => Promise<AppReleaseReceipt>
  reconcile: (actorId: string, operationId: string) => Promise<Reconciliation>
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function refuse(code: string): never { throw Object.assign(new Error(code), {code}) }
function errorCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : 'APP_RELEASE_MAINTENANCE_FAILED'
}

/** Verified production target only; neither credentials nor a connection URL leave this boundary. */
export function maintenanceDatabaseIdentity(value:string) {
  let target:URL
  try{target=new URL(value)}catch{refuse('MAINTENANCE_DATABASE_INVALID')}
  let database:string
  try{database=decodeURIComponent(target.pathname.slice(1))}catch{refuse('MAINTENANCE_DATABASE_INVALID')}
  const schema=target.searchParams.get('schema')||'public'
  if(!['postgres:','postgresql:'].includes(target.protocol)||target.hostname!=='127.0.0.1'||(target.port||'5432')!=='5432'
    ||database!=='chevoink_prod'||schema!=='public')refuse('MAINTENANCE_DATABASE_MISMATCH')
  return {host:target.hostname,port:5432,database,schema}
}

/** The caller pins this checked file from its original same-SHA CI archive.
 * It is source identity evidence, never a substitute for the independent CI gate. */
export function verifyMaintenanceSource(input: MaintenanceInput, root: string) {
  if (lstatSync(input.candidateProof).isSymbolicLink() || !lstatSync(input.candidateProof).isFile()) refuse('MAINTENANCE_PROOF_INVALID')
  const bytes = readFileSync(input.candidateProof)
  if (hash(bytes) !== input.candidateProofSha256) refuse('MAINTENANCE_PROOF_CHANGED')
  const proof = z.object({revision:sha,files:z.array(z.object({path:z.string(),sha256:digest}).strict()).min(1)}).strict().parse(JSON.parse(bytes.toString('utf8')))
  const required = ['.node-version','package.json','package-lock.json','ecosystem.config.cjs','scripts/app-release-maintenance.ts','scripts/prune-application-copies.mjs']
  const allowed = (file:string) => /^(api|shared|prisma)\//.test(file) || required.includes(file)
  if (proof.revision !== input.candidateSha || new Set(proof.files.map(file=>file.path)).size !== proof.files.length
    || required.some(file=>!proof.files.some(entry=>entry.path===file))) refuse('MAINTENANCE_PROOF_INCOMPLETE')
  for (const file of proof.files) {
    if (!allowed(file.path) || file.path.split('/').some(part=>!part || part==='.' || part==='..') || file.path.includes('\\')) refuse('MAINTENANCE_PROOF_INVALID')
    let current = root
    for (const part of file.path.split('/')) { current=path.join(current,part);if(lstatSync(current).isSymbolicLink())refuse('MAINTENANCE_SOURCE_LINK') }
    if (!lstatSync(current).isFile() || hash(readFileSync(current)) !== file.sha256) refuse('MAINTENANCE_SOURCE_CHANGED')
  }
  const actual:string[]=[]
  function walk(relative:string) { for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true})) {
    const key=relative+'/'+entry.name
    if(entry.isSymbolicLink())refuse('MAINTENANCE_SOURCE_LINK')
    if(entry.isDirectory())walk(key);else if(entry.isFile())actual.push(key);else refuse('MAINTENANCE_SOURCE_INVALID')
  } }
  for(const directory of ['api','shared','prisma'])walk(directory)
  const expected=proof.files.map(file=>file.path).filter(file=>/^(api|shared|prisma)\//.test(file)).sort()
  if(JSON.stringify(actual.sort())!==JSON.stringify(expected))refuse('MAINTENANCE_PROOF_INCOMPLETE')
  const runtime=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')) as {engines?:{node?:string;npm?:string}}
  if(readFileSync(path.join(root,'.node-version'),'utf8').trim()!=='22.23.2'||runtime.engines?.node!=='22.23.2'||runtime.engines?.npm!=='10.9.8')refuse('MAINTENANCE_RUNTIME_MISMATCH')
}

/** New JSONL receipt: started is fsynced before any service call. Existing files
 * are never overwritten, and a possibly committed mutation is recorded unknown. */
export async function runAppReleaseMaintenance(raw: unknown, dependencies: MaintenanceDependencies) {
  const input=inputSchema.parse(raw), host=dependencies.host()
  const fd=openSync(input.receiptPath,'wx',0o600)
  const record=(value:Record<string,unknown>)=>{writeSync(fd,JSON.stringify({...value,at:new Date().toISOString()})+'\n');fsyncSync(fd)}
  let mutationStarted=false, reconciliationStarted=false, context:Context|undefined, reconciliation:Reconciliation|undefined
  try {
    record({state:'started',source:'ssh_maintenance',...host,command:input.command,mode:input.mode,actorId:input.actorId,candidateSha:input.candidateSha,candidateProofSha256:input.candidateProofSha256,
      targetReleaseId:input.releaseId,targetArtifactSha256:input.artifactSha256,previewHash:input.previewHash??null,expectedRevision:input.expectedRevision??null,operationId:input.operationId})
    context=await dependencies.verifyContext(input)
    if(context.candidateSha!==input.candidateSha||context.candidateProofSha256!==input.candidateProofSha256)refuse('MAINTENANCE_SOURCE_CHANGED')
    // Reconciliation deliberately needs neither a healthy artifact nor a new preview.
    if(input.command==='reconcile') {
      reconciliationStarted=true
      reconciliation=await dependencies.reconcile(input.actorId,input.operationId)
      if(reconciliation.receipt&&(reconciliation.receipt.operationId!==input.operationId||reconciliation.receipt.releaseId!==input.releaseId
        ||reconciliation.receipt.action!==(input.mode==='initialize_stable'?'full_release':'assign_test')
        ||context.registeredArtifact?.releaseId!==input.releaseId||context.registeredArtifact.artifactSha256!==input.artifactSha256))refuse('MAINTENANCE_OPERATION_TARGET_MISMATCH')
      const result={state:reconciliation.status==='applied'&&reconciliation.receipt?'applied':reconciliation.status==='not_applied'?'not_applied':'unknown',context,reconciliation}
      record(result);return result
    }
    if(input.command==='execute') {
      reconciliationStarted=true
      reconciliation=await dependencies.reconcile(input.actorId,input.operationId)
      if(reconciliation.status!=='not_applied')refuse('OPERATION_REQUIRES_RECONCILIATION')
    }
    const installed=await dependencies.installed(input.releaseId)
    if(installed.artifactSha256!==input.artifactSha256||installed.manifest.validation.status!=='verified')refuse('MAINTENANCE_ARTIFACT_MISMATCH')
    const action=input.mode==='initialize_stable'?'full_release':'assign_test'
    if(input.mode==='initialize_stable') {
      if(context.observedCurrentSha!==baseline||installed.manifest.sourceSha!==baseline)refuse('MAINTENANCE_BASELINE_MISMATCH')
      if(input.command!=='register'&&context.channelCount!==0)refuse('MAINTENANCE_CHANNELS_EXIST')
    } else if(installed.manifest.sourceSha!==input.candidateSha)refuse('MAINTENANCE_CANDIDATE_MISMATCH')
    if(input.command==='register') {
      mutationStarted=true
      const release=await dependencies.register(input.actorId,input.releaseId,null)
      if(release.artifactSha256!==input.artifactSha256||release.sourceSha!==installed.manifest.sourceSha)refuse('MAINTENANCE_ARTIFACT_MISMATCH')
      const result={state:'registered',context,release};record(result);return result
    }
    const preview=await dependencies.preview(input.actorId,action,input.releaseId)
    if(preview.release.id!==input.releaseId||preview.release.artifactSha256!==input.artifactSha256||preview.release.sourceSha!==installed.manifest.sourceSha)refuse('MAINTENANCE_ARTIFACT_MISMATCH')
    if(input.mode==='initialize_stable'&&(preview.stable||preview.test||preview.expectedRevision!==0))refuse('MAINTENANCE_CHANNELS_EXIST')
    if(input.mode==='assign_test'&&(!preview.stable?.enabled||preview.stable.releaseId===input.releaseId))refuse('MAINTENANCE_STABLE_REQUIRED')
    if(preview.blockers.length)refuse('APP_RELEASE_BLOCKED')
    if(input.command==='preview'){const result={state:'previewed',context,preview};record(result);return result}
    if(preview.previewHash!==input.previewHash||preview.expectedRevision!==input.expectedRevision)refuse('APP_RELEASE_PREVIEW_CHANGED')
    mutationStarted=true
    const receipt=await dependencies.execute(input.actorId,{action,releaseId:input.releaseId,expectedRevision:input.expectedRevision!,previewHash:input.previewHash!,operationId:input.operationId},null)
    const result={state:'applied',context,verifiedTarget:{releaseId:input.releaseId,sourceSha:installed.manifest.sourceSha,artifactSha256:installed.artifactSha256},receipt};record(result);return result
  } catch(error) {
    const code=errorCode(error)
    const unknown=mutationStarted||reconciliationStarted&&!reconciliation||((input.command==='execute'||input.command==='reconcile')&&code==='MAINTENANCE_DATABASE_UNAVAILABLE')
    const result={state:unknown?'unknown':'rejected',errorCode:code,...(context?{context}:{}),...(reconciliation?{reconciliation}:{})}
    record(result);return result
  } finally { closeSync(fd) }
}

function productionDependencies(): MaintenanceDependencies & {close:()=>Promise<void>} {
  let db:typeof import('../api/lib/prisma.js').prisma|undefined
  let closeClient:(()=>Promise<void>)|undefined
  const services=()=>import('../api/lib/app-releases.js')
  return {
    host:()=>({osUser:userInfo().username,uid:userInfo().uid,hostname:hostname(),sshConnectionPresent:Boolean(process.env.SSH_CONNECTION)}),
    async verifyContext(input) {
      const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
      if(process.platform!=='linux'||process.version!=='v22.23.2'||userInfo().username!=='ubuntu'
        ||realpathSync(process.execPath)!=='/opt/chevoink/runtime/node-v22.23.2-linux-x64/bin/node')refuse('MAINTENANCE_HOST_MISMATCH')
      if(realpathSync(root)!==`/opt/chevoink/app/maintenance-${input.candidateSha}`)refuse('MAINTENANCE_STAGE_MISMATCH')
      verifyMaintenanceSource(input,root)
      if(process.env.APP_ENV!=='production'||process.env.DOTENV_PATH!==sharedEnvironment||realpathSync(sharedEnvironment)!==sharedEnvironment)refuse('MAINTENANCE_ENVIRONMENT_MISMATCH')
      const configured=parse(readFileSync(sharedEnvironment))
      if(configured.APP_ENV!=='production'||!configured.DATABASE_URL||process.env.DATABASE_URL&&process.env.DATABASE_URL!==configured.DATABASE_URL)refuse('MAINTENANCE_ENVIRONMENT_MISMATCH')
      const database=maintenanceDatabaseIdentity(configured.DATABASE_URL)
      const marker=JSON.parse(readFileSync(activeMarker,'utf8')) as {revision?:unknown;archiveSha256?:unknown}
      if(!sha.safeParse(marker.revision).success||!digest.safeParse(marker.archiveSha256).success)refuse('MAINTENANCE_ACTIVE_MARKER_INVALID')
      Object.assign(process.env,configured,{APP_ENV:'production',DOTENV_PATH:sharedEnvironment,DOTENV_CONFIG_QUIET:'true'})
      // The application normally logs Prisma errors. This one-shot maintenance
      // process uses its supported singleton with logging disabled, so neither
      // driver diagnostics nor credential-bearing errors reach stdout/stderr.
      if(globalThis.__chevoinkPrisma__)refuse('MAINTENANCE_CLIENT_ALREADY_INITIALIZED')
      const {PrismaClient}=await import('@prisma/client')
      const sessionUrl=new URL(configured.DATABASE_URL),options=sessionUrl.searchParams.get('options')?.trim()
      sessionUrl.searchParams.set('options',[options,'-c timezone=UTC'].filter(Boolean).join(' '))
      const client=new PrismaClient({log:[],datasourceUrl:sessionUrl.toString()})
      globalThis.__chevoinkPrisma__=client;closeClient=()=>client.$disconnect()
      db=(await import('../api/lib/prisma.js')).prisma
      const inspected=await db.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
        const [actual]=await tx.$queryRaw<Array<{database:string;schema:string}>>`SELECT current_database() AS database,current_schema() AS schema`
        if(actual?.database!==database.database||actual.schema!==database.schema)refuse('MAINTENANCE_DATABASE_MISMATCH')
        const actor=await tx.user.findUnique({where:{id:input.actorId},select:{role:true,isSuperAdmin:true,bannedAt:true}})
        if(!actor||actor.role!=='admin'||!actor.isSuperAdmin||actor.bannedAt)refuse('SUPER_ADMIN_REQUIRED')
        const registered=await tx.appRelease.findUnique({where:{id:input.releaseId},select:{id:true,sourceSha:true,artifactSha256:true}})
        return {channelCount:await tx.appReleaseChannel.count(),registeredArtifact:registered?{releaseId:registered.id,sourceSha:registered.sourceSha,artifactSha256:registered.artifactSha256}:null}
      }).catch(error=>{
        if(['SUPER_ADMIN_REQUIRED','MAINTENANCE_DATABASE_MISMATCH'].includes(errorCode(error)))throw error
        return refuse('MAINTENANCE_DATABASE_UNAVAILABLE')
      })
      return {candidateSha:input.candidateSha,candidateProofSha256:input.candidateProofSha256,observedCurrentSha:marker.revision as string,database,...inspected}
    },
    installed:async id=>(await import('../api/lib/app-release-artifacts.js')).readInstalledAppRelease(id,true),
    register:async(actor,id,ip)=>(await services()).importAppRelease(actor,id,ip),
    preview:async(actor,action,id)=>(await services()).previewAppRelease(actor,action,id),
    execute:async(actor,input,ip)=>(await services()).executeAppRelease(actor,input,ip),
    reconcile:async(actor,id)=>(await services()).reconcileAppRelease(actor,id),
    close:async()=>{await closeClient?.()},
  }
}
export function parseMaintenanceArguments(args:string[]):MaintenanceInput {
  const command=args[0],raw:Record<string,unknown>={command}
  const names:Record<string,string>={'mode':'mode','actor-id':'actorId','candidate-sha':'candidateSha','candidate-proof':'candidateProof','candidate-proof-sha256':'candidateProofSha256','release-id':'releaseId','artifact-sha256':'artifactSha256','receipt-path':'receiptPath','operation-id':'operationId','preview-hash':'previewHash','expected-revision':'expectedRevision'}
  for(let index=1;index<args.length;index+=2){const key=names[args[index]?.replace(/^--/,'')];if(!args[index]?.startsWith('--')||!key||args[index+1]===undefined||key in raw)refuse('MAINTENANCE_ARGUMENTS_INVALID');raw[key]=key==='expectedRevision'?Number(args[index+1]):args[index+1]}
  return inputSchema.parse(raw)
}
async function main(){
  const dependencies=productionDependencies()
  try {
    const input=parseMaintenanceArguments(process.argv.slice(2)),result=await runAppReleaseMaintenance(input,dependencies)
    process.stdout.write(JSON.stringify({state:result.state,receiptPath:input.receiptPath,operationId:input.operationId})+'\n')
    if(!['registered','previewed','applied','not_applied'].includes(result.state))process.exitCode=1
  } catch(error){process.stderr.write(errorCode(error)+'\n');process.exitCode=1}
  finally{await dependencies.close().catch(()=>{process.stderr.write('MAINTENANCE_CLOSE_FAILED\n');process.exitCode=1})}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
