import { requestJson } from '@/app/api-client'
import type { AppReleaseBootstrap } from '../../../shared/contracts/app-release'
export function selectedArtifactUrl(selection:AppReleaseBootstrap,route:string){
 if(selection.mode!=='artifact'||!selection.release)return null
 if(!/^\/(?!\/)/.test(route)||/[\r\n\\]/.test(route))route='/'
 return `${selection.release.entryUrl}?route=${encodeURIComponent(route)}`
}
export async function bootstrapAppRelease():Promise<boolean>{
 // The current control-plane UI remains reachable after selecting an older artifact.
 // Backend operations still require a freshly verified super administrator.
 if(/^\/admin\/app-releases(?:\/|$)/.test(location.pathname))return true
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
  if(busy||document.getElementById('app-release-update')||/^\/admin\/app-releases(?:\/|$)/.test(location.pathname))return
  busy=true
  try{
   const selection=await requestJson<AppReleaseBootstrap>('/api/app-releases/bootstrap')
   if(selection.mode!=='artifact')return
   const box=document.createElement('aside');box.id='app-release-update';box.setAttribute('role','status');box.className='fixed bottom-5 left-5 right-5 z-[150] flex items-center justify-between gap-4 rounded-xl border bg-[var(--surface-default)] p-4 text-sm'
   const text=document.createElement('span');text.textContent=`应用版本 ${selection.release!.label} 已可用。`
   const button=document.createElement('button');button.textContent='刷新切换';button.onclick=()=>location.assign(selectedArtifactUrl(selection,location.pathname+location.search+location.hash)!)
   box.append(text,button);document.body.appendChild(box)
  }finally{busy=false}
 }
 window.addEventListener('focus',()=>{void check().catch(()=>{})})
 window.setInterval(()=>{void check().catch(()=>{})},60000)
}