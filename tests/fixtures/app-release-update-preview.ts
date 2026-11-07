import { showAppReleaseUpdateNotice } from '../../shared/app-release-update-notice'
import '../../src/index.css'
const params=new URLSearchParams(location.search),studio=params.get('surface')!=='public'
document.documentElement.classList.toggle('dark',params.get('theme')==='dark')
const main=document.createElement('main');main.id='notice-preview-main';if(studio)main.className='studio-workspace'
Object.assign(main.style,{display:'flex',height:'100dvh',flexDirection:'column',background:'var(--app-bg)',color:'var(--text-primary)'})
const header=document.createElement('header');header.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;border-bottom:1px solid var(--border-subtle)'
const title=document.createElement('h1');title.textContent='应用更新提示 · 公开合成预览';title.style.cssText='font-size:16px;font-weight:600'
const trigger=document.createElement('button');trigger.id='notice-preview-trigger';trigger.textContent='模拟检测到更新';trigger.style.cssText='min-height:44px;border:1px solid var(--border-strong);border-radius:8px;padding:0 12px'
header.append(title,trigger)
const content=document.createElement('section');content.style.cssText='flex:1;min-height:0;padding:20px'
const description=document.createElement('p');description.textContent=params.get('source')==='artifact'?'实际生成的 release-entry.js + 合成刷新 spy，不访问服务器或导航。':'实际共享通知 renderer + 合成刷新 spy，不访问服务器或导航。';description.style.cssText='font-size:14px;line-height:24px'
const output=document.createElement('output');output.id='notice-preview-status';output.textContent='刷新调用：0';output.style.cssText='display:block;margin-top:20px;font-size:14px'
content.append(description,output)
const composer=document.createElement('footer');composer.id='notice-preview-composer';composer.style.cssText='margin:16px;padding:16px;border:1px solid var(--border-strong);border-radius:12px;background:var(--surface-default)'
const draft=document.createElement('textarea');draft.setAttribute('aria-label','合成未发送草稿');draft.value='保留当前界面的合成未发送草稿';draft.style.cssText='width:100%;height:80px;resize:none;background:transparent'
composer.append(draft);main.append(header,content,composer);document.body.appendChild(main)
const preview=Object.assign(window,{__previewRefreshCalls:0,__previewRefreshUrls:[] as string[],__previewLocation:{pathname:'/studio',search:'?novel=synthetic',hash:'#draft',assign:(url:string)=>{preview.__previewRefreshCalls++;preview.__previewRefreshUrls.push(url);output.textContent='刷新调用：'+preview.__previewRefreshCalls+'（合成 spy，未导航）'}},__previewHistory:{replaceState:()=>{}},__previewFetch:async()=>({ok:true,json:async()=>({success:true,data:{mode:'artifact',channel:'test',release:{id:'preview-b',label:'合成新版',entryUrl:'/api/app-releases/artifacts/preview-b/index.html'}}})})})
trigger.onclick=()=>{
 trigger.disabled=true;draft.focus()
 if(params.get('source')==='artifact'){
  const script=document.createElement('script');script.src='/__preview-release-entry.js';script.onload=()=>window.dispatchEvent(new Event('focus'));document.body.appendChild(script)
 }else showAppReleaseUpdateNotice('合成新版已可用。',()=>preview.__previewLocation.assign('/api/app-releases/artifacts/preview-b/index.html?route='+encodeURIComponent('/studio?novel=synthetic#draft')))
}
