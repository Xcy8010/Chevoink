import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { appReleaseIdSchema, appReleaseManifestSchema, type AppReleaseManifest } from '../../shared/contracts/app-release.js'
import { DataAccessError } from './prisma.js'

export const appReleaseArtifactRoot=()=>path.resolve(process.env.APP_RELEASE_ARTIFACT_ROOT ?? '/srv/chevoink-data/beta-releases')
export const artifactDigest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
function invalid():never{throw new DataAccessError(503,'APP_RELEASE_ARTIFACT_INVALID','应用版本文件不可用或校验不一致，请管理员核对。')}
async function regularFile(root:string,relative:string){
 const target=path.resolve(root,relative)
 if(path.relative(root,target).startsWith('..')||path.isAbsolute(path.relative(root,target)))invalid()
 let cursor=root
 for(const part of relative.split('/')){cursor=path.join(cursor,part);if((await lstat(cursor)).isSymbolicLink())invalid()}
 const stat=await lstat(target)
 if(!stat.isFile()||stat.size>209715200)invalid()
 return {target,stat}
}
export async function readAppReleaseFile(installed:{directory:string;manifest:AppReleaseManifest},filename:string){
 const entry=installed.manifest.files.find(file=>file.path===filename)
 if(!entry)throw new DataAccessError(404,'APP_RELEASE_FILE_NOT_FOUND','版本文件不存在。')
 try{const {target,stat}=await regularFile(installed.directory,filename);if(stat.size!==entry.size)invalid();const bytes=await readFile(target);if(artifactDigest(bytes)!==entry.sha256)invalid();return bytes}catch(error){if(error instanceof DataAccessError)throw error;return invalid()}
}
export async function readInstalledAppRelease(id:string,full=false){
 if(!appReleaseIdSchema.safeParse(id).success)throw new DataAccessError(400,'VALIDATION_ERROR','版本编号无效。')
 try{
  const root=appReleaseArtifactRoot()
  if((await lstat(root)).isSymbolicLink())invalid()
  const directory=path.join(await realpath(root),id)
  if((await lstat(directory)).isSymbolicLink()||!((await lstat(directory)).isDirectory()))invalid()
  const descriptor=await regularFile(directory,'manifest.json')
  if(descriptor.stat.size>4194304)invalid()
  const bytes=await readFile(descriptor.target)
  const manifest=appReleaseManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  if(manifest.id!==id)invalid()
  const installed={directory,manifest,artifactSha256:artifactDigest(bytes)}
  if(full){
   const actual:string[]=[]
   async function walk(folder:string,prefix=''){for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())invalid();const filename=prefix+entry.name;if(entry.isDirectory())await walk(path.join(folder,entry.name),filename+'/');else if(entry.isFile())actual.push(filename);else invalid()}}
   await walk(directory)
   const expected=manifest.files.map(file=>file.path).concat('manifest.json').sort()
   if(JSON.stringify(actual.sort())!==JSON.stringify(expected))invalid()
   for(const file of manifest.files)await readAppReleaseFile(installed,file.path)
  }else await readAppReleaseFile(installed,'index.html')
  return installed
 }catch(error){if(error instanceof DataAccessError)throw error;return invalid()}
}