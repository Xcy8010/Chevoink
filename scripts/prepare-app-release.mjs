import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appReleaseIdSchema, appReleaseCapabilities, publicReleaseNotesSchema } from '../shared/contracts/app-release.ts'
import { readReleaseCi, ghApi } from './release-ci-read.mjs'
import { sealAppArtifact, installPreparedAppArtifact, verifyPreparedAppArtifact } from './app-release-artifact.mjs'

// This tool never deploys the API, changes channels, migrates DBs or executes arbitrary API commands.
export async function prepareAppRelease({root,revision,id,label,notes,capabilities,out,draft=false,ciRunId},dependencies={execute:execFileSync,readCi:readReleaseCi,request:ghApi}){
 if(process.version!=='v22.23.2')throw Error('Node22.23.2 is required')
 appReleaseIdSchema.parse(id);publicReleaseNotesSchema.parse(notes)
 if(!/^[a-f0-9]{40}$/.test(revision)||!label||capabilities.some(value=>!appReleaseCapabilities.includes(value)))throw Error('Invalid release identity')
 const git=args=>dependencies.execute('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
 if(git(['rev-parse','HEAD'])!==revision||git(['status','--porcelain','--untracked-files=all']))throw Error('Preparation requires the clean exact candidate checkout')
 let validation={status:'draft'}
 if(!draft){
  const evidence=await dependencies.readCi(revision,ciRunId)
  const original=await dependencies.request(`repos/Xcy8010/Chevoink/actions/runs/${evidence.ciRunId}`)
  if(original.run_attempt!==1||original.head_sha!==revision)throw Error('Only original same-SHA CI is release evidence')
  validation={status:'verified',verifiedAt:new Date().toISOString(),originalAttempt:1,ciRunId:evidence.ciRunId,ci:evidence.ci}
 }
 const authSource=git(['show',`${revision}:src/app/routes/AuthPage.tsx`])
 const legalConsentUi=authSource.includes('legalConsent:')&&authSource.includes('termsVersionId')&&authSource.includes('privacyVersionId')
 await mkdir(out,{recursive:false})
 dependencies.execute(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--base',`/api/app-releases/artifacts/${id}/`,'--outDir',out],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,VITE_API_BASE_URL:''}})
 const enabledCapabilities=[...new Set([...capabilities,'legacyEmailBinding'])]
 return sealAppArtifact(out,{id,label,sourceSha:revision,compatibility:{api:1,schema:1,task:1,legalConsentUi},capabilities:enabledCapabilities,publicNotes:notes,validation})
}
async function main(){
 const args=process.argv.slice(2),command=args.shift(),options={}
 for(let index=0;index<args.length;index+=2){if(!args[index]?.startsWith('--')||!args[index+1])throw Error('Expected named option/value pairs');options[args[index].slice(2)]=args[index+1]}
 if(command==='prepare'){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
  const result=await prepareAppRelease({root,revision:options.revision,id:options.id,label:options.label,notes:JSON.parse(await readFile(options.notes,'utf8')),capabilities:(options.capabilities??'').split(',').filter(Boolean),out:path.resolve(options.out),draft:options.draft==='true',ciRunId:options['ci-run-id']})
  console.log(JSON.stringify({releaseId:result.manifest.id,sourceSha:result.manifest.sourceSha,artifactSha256:result.artifactSha256,validationState:result.manifest.validation.status,legalConsentUi:result.manifest.compatibility.legalConsentUi}))
 }else if(command==='install')console.log(JSON.stringify(await installPreparedAppArtifact(path.resolve(options.source),options.root)))
 else if(command==='verify'){const result=await verifyPreparedAppArtifact(path.resolve(options.source));console.log(JSON.stringify({releaseId:result.manifest.id,artifactSha256:result.artifactSha256,validationState:result.manifest.validation.status}))}
 else throw Error('Usage: prepare-app-release.mjs prepare --revision SHA --id ID --label LABEL --notes PUBLIC_NOTES_JSON --capabilities CSV --out NEW_DIRECTORY [--draft true|--ci-run-id ID]; install --source DIRECTORY [--root PROTECTED_ROOT]; verify --source DIRECTORY')
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
