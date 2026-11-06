import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdminAppRelease, AppReleasePreview, AppReleaseReceipt } from '../../shared/contracts/app-release.js'
import { parseMaintenanceArguments, runAppReleaseMaintenance, verifyMaintenanceSource, maintenanceDatabaseIdentity, type MaintenanceDependencies, type MaintenanceInput } from '../../scripts/app-release-maintenance.js'
const baseline='07da47b79586185538fd644b0c0540453287a32f',candidate='1'.repeat(40),artifact='a'.repeat(64),proofHash='b'.repeat(64),previewHash='c'.repeat(64)
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
function fixture(mode:MaintenanceInput['mode']='initialize_stable') {
  const directory=mkdtempSync(path.join(tmpdir(),'chevoink-maintenance-unit-'))
  const input:MaintenanceInput={command:'preview',mode,actorId:'synthetic-super',candidateSha:candidate,candidateProof:path.join(directory,'proof.json'),candidateProofSha256:proofHash,
    releaseId:'synthetic-release',artifactSha256:artifact,receiptPath:path.join(directory,'receipt.jsonl'),operationId:randomUUID()}
  const release:AdminAppRelease={id:input.releaseId,label:'Synthetic release',sourceSha:mode==='initialize_stable'?baseline:candidate,artifactSha256:artifact,publicNotes:{features:['Synthetic fixture'],fixes:[],changes:[]},validationState:'verified',verifiedAt:new Date(0).toISOString(),compatibility:{api:1,schema:1,task:1,legalConsentUi:true},capabilities:[],ciRunId:'1',createdAt:new Date(0).toISOString()}
  const preview:AppReleasePreview={action:mode==='initialize_stable'?'full_release':'assign_test',release,stable:mode==='assign_test'?{releaseId:'stable-07',revision:1,enabled:true}:null,test:null,expectedRevision:0,previewHash,blockers:[],impact:'Synthetic preview'}
  const receipt:AppReleaseReceipt={operationId:input.operationId,status:'applied',action:preview.action,releaseId:input.releaseId,previousReleaseId:null,revision:1,appliedAt:new Date(0).toISOString()}
  const context={candidateSha:candidate,candidateProofSha256:proofHash,observedCurrentSha:baseline,database:{host:'fixture-db',database:'chevoink',schema:'public'},channelCount:mode==='assign_test'?1:0,registeredArtifact:{releaseId:input.releaseId,sourceSha:release.sourceSha,artifactSha256:artifact}}
  const dependencies={host:()=>({osUser:'ubuntu',uid:1000,hostname:'synthetic-host',sshConnectionPresent:true}),
    verifyContext:vi.fn(async()=>{expect(JSON.parse(readFileSync(input.receiptPath,'utf8').split('\n')[0]).state).toBe('started');return context}),
    installed:vi.fn(async()=>({artifactSha256:artifact,manifest:{sourceSha:release.sourceSha,validation:{status:'verified'}}})),
    register:vi.fn<MaintenanceDependencies['register']>(async()=>release),preview:vi.fn<MaintenanceDependencies['preview']>(async()=>preview),execute:vi.fn<MaintenanceDependencies['execute']>(async()=>receipt),
    reconcile:vi.fn<MaintenanceDependencies['reconcile']>(async()=>({status:'not_applied',receipt:null as AppReleaseReceipt|null})),
  } satisfies MaintenanceDependencies
  const rows=()=>readFileSync(input.receiptPath,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  return {directory,input,release,preview,receipt,context,dependencies,rows}
}
function execution(f:ReturnType<typeof fixture>) {return {...f.input,command:'execute' as const,previewHash,expectedRevision:0}}
describe('bounded source-verified maintenance wrapper',()=>{
  it('previews without importing, executing, HTTP login or channel writes and records real host provenance first',async()=>{
    const f=fixture(),result=await runAppReleaseMaintenance(f.input,f.dependencies)
    expect(result.state).toBe('previewed');expect(f.dependencies.register).not.toHaveBeenCalled();expect(f.dependencies.execute).not.toHaveBeenCalled()
    expect(f.dependencies.preview).toHaveBeenCalledWith('synthetic-super','full_release','synthetic-release')
    expect(f.rows()[0]).toMatchObject({state:'started',source:'ssh_maintenance',osUser:'ubuntu',hostname:'synthetic-host',sshConnectionPresent:true,candidateSha:candidate,targetArtifactSha256:artifact,operationId:f.input.operationId})
    expect(f.rows()[1]).toMatchObject({state:'previewed',preview:{previewHash,expectedRevision:0}})
  })
  it('registers only through the existing import service with ip null and does not silently activate it',async()=>{
    const f=fixture();f.input.command='register'
    expect((await runAppReleaseMaintenance(f.input,f.dependencies)).state).toBe('registered')
    expect(f.dependencies.register).toHaveBeenCalledWith(f.input.actorId,f.input.releaseId,null)
    expect(f.dependencies.preview).not.toHaveBeenCalled();expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
  it('initializes only the exact observed 07 artifact with zero channels using the reviewed full_release service',async()=>{
    const f=fixture();expect((await runAppReleaseMaintenance(execution(f),f.dependencies)).state).toBe('applied')
    expect(f.dependencies.reconcile.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.execute.mock.invocationCallOrder[0])
    expect(f.dependencies.execute).toHaveBeenCalledWith(f.input.actorId,{action:'full_release',releaseId:f.input.releaseId,expectedRevision:0,previewHash,operationId:f.input.operationId},null)
  })
  it.each(['source','marker','channel','disabled-channel','revision','hash','blocker','artifact','draft','candidate-proof'] as const)('rejects initialize %s before any mutation',async kind=>{
    const f=fixture()
    if(kind==='source')f.release.sourceSha=candidate
    if(kind==='marker')f.context.observedCurrentSha=candidate
    if(kind==='channel')f.context.channelCount=1
    if(kind==='disabled-channel')f.preview.test={releaseId:'old-test',revision:2,enabled:false}
    if(kind==='revision')f.preview.expectedRevision=1
    if(kind==='hash')f.preview.previewHash='d'.repeat(64)
    if(kind==='blocker')f.preview.blockers=['Synthetic blocker']
    if(kind==='artifact')f.dependencies.installed.mockResolvedValue({artifactSha256:'d'.repeat(64),manifest:{sourceSha:baseline,validation:{status:'verified'}}})
    if(kind==='draft')f.dependencies.installed.mockResolvedValue({artifactSha256:artifact,manifest:{sourceSha:baseline,validation:{status:'draft'}}})
    if(kind==='candidate-proof')f.context.candidateProofSha256='d'.repeat(64)
    expect((await runAppReleaseMaintenance(execution(f),f.dependencies)).state).toBe('rejected')
    expect(f.dependencies.register).not.toHaveBeenCalled();expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
  it('assigns the candidate only to an enabled stable channel and never exposes arbitrary full/rollback commands',async()=>{
    const f=fixture('assign_test')
    expect((await runAppReleaseMaintenance(execution(f),f.dependencies)).state).toBe('applied')
    expect(f.dependencies.execute.mock.calls[0][1].action).toBe('assign_test')
    for(const mode of ['full_release','rollback','withdraw_test'])await expect(runAppReleaseMaintenance({...f.input,mode,receiptPath:path.join(f.directory,mode+'.jsonl')},f.dependencies)).rejects.toBeDefined()
    expect(f.dependencies.execute).toHaveBeenCalledOnce()
  })
  it.each(['missing','disabled','same-target','wrong-source'] as const)('rejects test assignment with %s stable/target identity before writes',async kind=>{
    const f=fixture('assign_test')
    if(kind==='missing')f.preview.stable=null
    if(kind==='disabled')f.preview.stable!.enabled=false
    if(kind==='same-target')f.preview.stable!.releaseId=f.input.releaseId
    if(kind==='wrong-source')f.release.sourceSha=baseline
    expect((await runAppReleaseMaintenance(execution(f),f.dependencies)).state).toBe('rejected')
    expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
  it.each(['applied','unknown'])('reconciles existing %s operations before refusing an execution replay',async status=>{
    const f=fixture();f.dependencies.reconcile.mockResolvedValue({status,receipt:status==='applied'?f.receipt:null})
    expect(await runAppReleaseMaintenance(execution(f),f.dependencies)).toMatchObject({state:'rejected',errorCode:'OPERATION_REQUIRES_RECONCILIATION',reconciliation:{status}})
    expect(f.dependencies.installed).not.toHaveBeenCalled();expect(f.dependencies.preview).not.toHaveBeenCalled();expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
  it('reconciles a committed operation without reading a damaged artifact or executing another request',async()=>{
    const f=fixture();f.input.command='reconcile';f.dependencies.reconcile.mockResolvedValue({status:'applied',receipt:f.receipt})
    f.dependencies.installed.mockRejectedValue(new Error('damaged artifact must not block DB reconciliation'))
    expect((await runAppReleaseMaintenance(f.input,f.dependencies)).state).toBe('applied')
    expect(f.dependencies.installed).not.toHaveBeenCalled();expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
  it('refuses an applied receipt for another target instead of claiming success for the requested artifact',async()=>{
    const f=fixture();f.input.command='reconcile';f.dependencies.reconcile.mockResolvedValue({status:'applied',receipt:{...f.receipt,releaseId:'other'}})
    expect(await runAppReleaseMaintenance(f.input,f.dependencies)).toMatchObject({state:'rejected',errorCode:'MAINTENANCE_OPERATION_TARGET_MISMATCH'})
  })
  it.each(['execute','reconcile'] as const)('preserves unknown DB outcome at %s and never prints credential-bearing errors',async command=>{
    const f=fixture();f.dependencies.reconcile.mockRejectedValue(new Error('postgresql://synthetic-user:synthetic-secret@private-db/chevoink'))
    const result=await runAppReleaseMaintenance(command==='execute'?execution(f):{...f.input,command},f.dependencies)
    expect(result.state).toBe('unknown');expect(JSON.stringify(f.rows())).not.toContain('synthetic-secret')
    expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
  it('preserves a possibly committed mutation as unknown without reissuing it',async()=>{
    const f=fixture();f.dependencies.execute.mockRejectedValue(new Error('synthetic transport result unavailable'))
    expect((await runAppReleaseMaintenance(execution(f),f.dependencies)).state).toBe('unknown')
    expect(f.dependencies.execute).toHaveBeenCalledOnce();expect(f.rows()[0].state).toBe('started');expect(f.rows()[1].state).toBe('unknown')
  })
  it('never overwrites an existing receipt or performs service calls after wx failure',async()=>{
    const f=fixture();writeFileSync(f.input.receiptPath,'original evidence')
    await expect(runAppReleaseMaintenance(f.input,f.dependencies)).rejects.toBeDefined()
    expect(readFileSync(f.input.receiptPath,'utf8')).toBe('original evidence');expect(f.dependencies.verifyContext).not.toHaveBeenCalled();expect(f.dependencies.execute).not.toHaveBeenCalled()
  })
})
function sourceFixture(){
  const f=fixture(),root=path.join(f.directory,'stage');mkdirSync(root)
  const values:Record<string,string>={'.node-version':'22.23.2\n','package.json':JSON.stringify({engines:{node:'22.23.2',npm:'10.9.8'}}),'package-lock.json':'{}','ecosystem.config.cjs':'module.exports={}\n','scripts/app-release-maintenance.ts':'// synthetic CLI\n','api/service.ts':'// synthetic API\n','shared/contract.ts':'// synthetic contract\n','prisma/schema.prisma':'// synthetic schema\n'}
  for(const [relative,bytes]of Object.entries(values)){const full=path.join(root,relative);mkdirSync(path.dirname(full),{recursive:true});writeFileSync(full,bytes)}
  const proof={revision:candidate,files:Object.entries(values).map(([relative,bytes])=>({path:relative,sha256:sha(bytes)}))}
  const save=()=>{const bytes=JSON.stringify(proof);writeFileSync(f.input.candidateProof,bytes);f.input.candidateProofSha256=sha(bytes)}
  save();return{...f,root,proof,save}
}
describe('explicit checked-file candidate proof, not fabricated Git/CI identity',()=>{
  it('verifies all backend/shared/schema/runtime files and requires the CLI itself',()=>{const f=sourceFixture();expect(()=>verifyMaintenanceSource(f.input,f.root)).not.toThrow()})
  it.each(['file','extra','missing-cli','wrong-revision','proof-hash','private-path','traversal'] as const)('rejects %s before production services are loaded',kind=>{
    const f=sourceFixture()
    if(kind==='file')writeFileSync(path.join(f.root,'api/service.ts'),'changed')
    if(kind==='extra')writeFileSync(path.join(f.root,'api/extra.ts'),'extra')
    if(kind==='missing-cli')f.proof.files=f.proof.files.filter(file=>file.path!=='scripts/app-release-maintenance.ts')
    if(kind==='wrong-revision')f.proof.revision='2'.repeat(40)
    if(kind==='private-path')f.proof.files.push({path:'.env',sha256:sha('no real file')})
    if(kind==='traversal')f.proof.files.push({path:'api/../../outside',sha256:sha('no real file')})
    if(kind!=='proof-hash')f.save();else f.input.candidateProofSha256='d'.repeat(64)
    expect(()=>verifyMaintenanceSource(f.input,f.root)).toThrow()
  })
  it('parses only fixed named maintenance commands and exact preview binding',()=>{
    const f=fixture(),args=['preview','--mode',f.input.mode,'--actor-id',f.input.actorId,'--candidate-sha',candidate,'--candidate-proof',f.input.candidateProof,'--candidate-proof-sha256',proofHash,'--release-id',f.input.releaseId,'--artifact-sha256',artifact,'--receipt-path',f.input.receiptPath,'--operation-id',f.input.operationId]
    expect(parseMaintenanceArguments(args)).toEqual(f.input)
    for(const bad of [[...args,'--database-url','not accepted'],[...args,'--mode','assign_test'],['full_release',...args.slice(1)],['execute',...args.slice(1)]])expect(()=>parseMaintenanceArguments(bad)).toThrow()
  })
})

describe('fixed observed production database identity',()=>{
  it('returns only the checked host/port/database/schema, never username/password or URL',()=>{
    const identity=maintenanceDatabaseIdentity('postgresql://synthetic-user:synthetic-secret@127.0.0.1:5432/chevoink_prod?schema=public')
    expect(identity).toEqual({host:'127.0.0.1',port:5432,database:'chevoink_prod',schema:'public'})
    expect(JSON.stringify(identity)).not.toMatch(/synthetic-user|synthetic-secret|postgresql/)
  })
  it.each(['postgresql://127.0.0.2:5432/chevoink_prod','postgresql://127.0.0.1:55497/chevoink_prod','postgresql://127.0.0.1:5432/chevoink_test','postgresql://127.0.0.1:5432/chevoink_prod?schema=other','https://127.0.0.1:5432/chevoink_prod','not a URL'])('rejects an unverified database target without exposing the input',value=>expect(()=>maintenanceDatabaseIdentity(value)).toThrow(/^MAINTENANCE_DATABASE_/))
})

it.each(['execute','reconcile'] as const)('keeps %s unknown when the verified target cannot be read during preflight',async command=>{
  const f=fixture();f.dependencies.verifyContext.mockRejectedValue(Object.assign(new Error('sanitized'),{code:'MAINTENANCE_DATABASE_UNAVAILABLE'}))
  expect((await runAppReleaseMaintenance(command==='execute'?execution(f):{...f.input,command},f.dependencies)).state).toBe('unknown')
  expect(f.dependencies.execute).not.toHaveBeenCalled();expect(f.dependencies.reconcile).not.toHaveBeenCalled()
})

it('keeps an applied status with a missing durable receipt unknown instead of claiming completion',async()=>{
  const f=fixture();f.input.command='reconcile';f.dependencies.reconcile.mockResolvedValue({status:'applied',receipt:null})
  expect((await runAppReleaseMaintenance(f.input,f.dependencies)).state).toBe('unknown')
  expect(f.dependencies.execute).not.toHaveBeenCalled()
})
