import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { showAppReleaseUpdateNotice } from '../shared/app-release-update-notice.ts'
import { appReleaseManifestSchema } from '../shared/contracts/app-release.ts'
import { canonicalAppRoute } from '../shared/app-release-route.ts'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
function startReleaseEntry(id, normalizeRoute, showUpdateNotice) {
 document.documentElement.dataset.appRelease=id
 const route=normalizeRoute(new URLSearchParams(location.search).get('route'))
 history.replaceState(null,'',route)

 async function readSelection() {
  const response=await fetch('/api/app-releases/bootstrap',{credentials:'include',cache:'no-store'})
  if(!response.ok)throw Error()
  const result=await response.json()
  if(!result.success)throw Error()
  return result.data
 }

 async function refresh() {
  const current=normalizeRoute(location.pathname+location.search+location.hash)
  const latest=await readSelection().catch(()=>null)
  const entry=latest?.mode==='artifact'&&latest.release?.id!==id ? latest.release?.entryUrl : null
  location.replace(entry ? entry+'?route='+encodeURIComponent(current) : current)
 }

 let checking=false
 async function check() {
  if(checking||document.getElementById('app-release-update'))return
  checking=true
  try {
   const selection=await readSelection()
   if(selection.release?.id===id)return
   showUpdateNotice(selection.release?'版本「'+selection.release.label+'」已可用。':'应用版本已更新。',refresh,selection.release)
  } catch {
   // A later focus or interval can refresh the check after a temporary error.
  } finally {
   checking=false
  }
 }
 window.addEventListener('focus',check)
 setInterval(check,60000)
}

export function releaseEntryScript(id) {
 return `(${startReleaseEntry.toString()})(${JSON.stringify(id)},${canonicalAppRoute.toString()},${showAppReleaseUpdateNotice.toString()});\n`
}
export async function artifactFiles(directory,prefix=''){
 const result=[]
 for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){
  if(entry.isSymbolicLink()||entry.name.startsWith('.'))throw Error('Private files and links are not release artifacts')
  const relative=prefix+entry.name
  if(entry.isDirectory())result.push(...await artifactFiles(directory,relative+'/'))
  else if(entry.isFile()){const bytes=await readFile(path.join(directory,relative));result.push({path:relative,size:bytes.length,sha256:digest(bytes)})}
  else throw Error('Unsupported artifact file')
 }
 return result.sort((a,b)=>a.path.localeCompare(b.path,'en'))
}
export async function sealAppArtifact(directory,metadata){
 const basePath=`/api/app-releases/artifacts/${metadata.id}/`
 const indexPath=path.join(directory,'index.html')
 const html=await readFile(indexPath,'utf8')
 if(!html.includes('<head>')||!html.includes(basePath)||/type="module"[^>]+src="(?!\/api\/app-releases\/artifacts\/)/.test(html))throw Error('Artifact was not built with its immutable base path')
 await writeFile(path.join(directory,'release-entry.js'),releaseEntryScript(metadata.id),{flag:'wx'})
 await writeFile(indexPath,html.replace('<head>',`<head>\n<script src="${basePath}release-entry.js"></script>`))
 const files=await artifactFiles(directory)
 const manifest=appReleaseManifestSchema.parse({...metadata,format:1,entryProtocol:1,basePath,files})
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
 return{manifest,artifactSha256:digest(await readFile(path.join(directory,'manifest.json')))}
}
export async function verifyPreparedAppArtifact(directory){
 if((await lstat(directory)).isSymbolicLink())throw Error('Artifact root must be a real directory')
 const descriptor=path.join(directory,'manifest.json')
 if((await lstat(descriptor)).isSymbolicLink())throw Error('Manifest links are forbidden')
 const manifest=appReleaseManifestSchema.parse(JSON.parse(await readFile(descriptor,'utf8')))
 const actual=(await artifactFiles(directory)).filter(file=>file.path!=='manifest.json')
 if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw Error('Artifact files differ from immutable manifest')
 return{manifest,artifactSha256:digest(await readFile(descriptor))}
}
/** Local maintenance only. No SSH, database migration, process restart or channel switch. */
export async function installPreparedAppArtifact(source,root='/srv/chevoink-data/beta-releases'){
 const verified=await verifyPreparedAppArtifact(source)
 await mkdir(root,{recursive:true,mode:0o700})
 if((await lstat(root)).isSymbolicLink())throw Error('Install root must not be a symbolic link')
 const target=path.join(root,verified.manifest.id)
 await mkdir(target,{recursive:false,mode:0o700})
 for(const file of verified.manifest.files){const destination=path.join(target,file.path);await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await copyFile(path.join(source,file.path),destination,1);await chmod(destination,0o444)}
 await copyFile(path.join(source,'manifest.json'),path.join(target,'manifest.json'),1)
 await chmod(path.join(target,'manifest.json'),0o444)
 await verifyPreparedAppArtifact(target)
 return{releaseId:verified.manifest.id,artifactSha256:verified.artifactSha256}
}