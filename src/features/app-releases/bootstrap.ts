import { requestJson } from '@/app/api-client'
import { showAppReleaseUpdateNotice } from '../../../shared/app-release-update-notice'
import { canonicalAppRoute } from '../../../shared/app-release-route'
import type { AppReleaseBootstrap, AppReleaseCapability } from '../../../shared/contracts/app-release'
let loadedCapabilities: readonly AppReleaseCapability[] | null = null
export function appReleaseSupports(capability: AppReleaseCapability) {
 return loadedCapabilities?.includes(capability) ?? true
}
export function selectedArtifactUrl(selection:AppReleaseBootstrap,route:string){
 if(selection.mode!=='artifact'||!selection.release)return null
 return `${selection.release.entryUrl}?route=${encodeURIComponent(canonicalAppRoute(route))}`
}
export async function bootstrapAppRelease():Promise<boolean>{
 const selection=await requestJson<AppReleaseBootstrap>('/api/app-releases/bootstrap')
 const loaded=document.documentElement.dataset.appRelease
 if(selection.mode==='artifact'&&selection.release?.id!==loaded){
  location.replace(selectedArtifactUrl(selection,location.pathname+location.search+location.hash)!)
  return false
 }
 if(selection.mode==='legacy'&&loaded){location.replace(canonicalAppRoute(location.pathname+location.search+location.hash));return false}
 loadedCapabilities=selection.release?.capabilities??null
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
   if(selection.mode!=='artifact'||!selection.release)return
   showAppReleaseUpdateNotice(`版本「${selection.release.label}」已可用。`,()=>{
    const route=canonicalAppRoute(location.pathname+location.search+location.hash)
    void requestJson<AppReleaseBootstrap>('/api/app-releases/bootstrap')
      .then(latest=>location.replace(selectedArtifactUrl(latest,route)??route))
      .catch(()=>location.replace(route))
   },selection.release)
  }finally{busy=false}
 }
 window.addEventListener('focus',()=>{void check().catch(()=>{})})
 window.setInterval(()=>{void check().catch(()=>{})},60000)
}
