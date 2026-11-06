import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appReleaseManifestSchema } from '../shared/contracts/app-release.ts'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
export function releaseEntryScript(id){
 return `(function(){var id=${JSON.stringify(id)};document.documentElement.dataset.appRelease=id;var route=new URLSearchParams(location.search).get('route')||'/';if(!/^\\/(?!\\/)/.test(route)||route.indexOf('/api/app-releases')===0||/[\\r\\n\\\\]/.test(route))route='/';history.replaceState(null,'',route);var checking=false;function check(){if(checking)return;checking=true;fetch('/api/app-releases/bootstrap',{credentials:'include',cache:'no-store'}).then(function(response){if(!response.ok)throw Error();return response.json()}).then(function(result){if(!result.success)throw Error();var selection=result.data;if(selection.release&&selection.release.id===id)return;if(document.getElementById('app-release-update'))return;var box=document.createElement('aside');box.id='app-release-update';box.setAttribute('role','status');box.style.cssText='position:fixed;bottom:20px;left:20px;right:20px;z-index:200;background:#fff;color:#111;padding:16px;border:1px solid #ccc;border-radius:12px';var message=document.createElement('span');message.textContent='应用版本已更新。';var button=document.createElement('button');button.textContent='刷新切换';button.onclick=function(){var route=location.pathname+location.search+location.hash;location.assign(selection.release?selection.release.entryUrl+'?route='+encodeURIComponent(route):route)};box.append(message,button);document.body.appendChild(box)}).catch(function(){}).finally(function(){checking=false})}window.addEventListener('focus',check);setInterval(check,60000)})();\n`
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