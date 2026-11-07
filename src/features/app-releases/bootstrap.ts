import { requestJson } from '@/app/api-client'
import { showAppReleaseUpdateNotice } from '../../../shared/app-release-update-notice'
import type { AppReleaseBootstrap } from '../../../shared/contracts/app-release'
export function selectedArtifactUrl(selection:AppReleaseBootstrap,route:string){
 if(selection.mode!=='artifact'||!selection.release)return null
 if(!/^\/(?!\/)/.test(route)||/[\r\n\\]/.test(route))route='/'
 return `${selection.release.entryUrl}?route=${encodeURIComponent(route)}`
}
export async function bootstrapAppRelease():Promise<boolean>{
 const selection=await requestJson<AppReleaseBootstrap>('/api/app-releases/bootstrap')
 const loaded=document.documentElement.dataset.appRelease
 if(selection.mode==='artifact'&&selection.release?.id!==loaded){
  location.replace(selectedArtifactUrl(selection,location.pathname+location.search+location.hash)!)
  return false
 }
 if(selection.mode==='legacy'&&loaded){location.replace(location.pathname+location.search+location.hash);return false}
 if(!loaded)watchLegacyRelease()
 return true
}
function watchLegacyRelease(){
 let busy=false
 async function check(){
  if(busy||document.getElementById('app-release-update'))return
  busy=true
  try{
   const selection=await requestJson<AppReleaseBootstrap>('/api/app-releases/bootstrap')
   if(selection.mode!=='artifact')return
   showAppReleaseUpdateNotice(`应用版本 ${selection.release!.label} 已可用。`,()=>location.assign(selectedArtifactUrl(selection,location.pathname+location.search+location.hash)!))
  }finally{busy=false}
 }
 window.addEventListener('focus',()=>{void check().catch(()=>{})})
 window.setInterval(()=>{void check().catch(()=>{})},60000)
}
