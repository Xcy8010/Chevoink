// @vitest-environment jsdom
import vm from 'node:vm'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { showAppReleaseUpdateNotice } from '../../shared/app-release-update-notice'
import { bootstrapAppRelease } from '../../src/features/app-releases/bootstrap'
import { releaseEntryScript } from '../../scripts/app-release-artifact.mjs'
import type { AppReleaseBootstrap } from '../../shared/contracts/app-release'
const mocks=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('../../src/app/api-client',()=>({requestJson:mocks.request}))
const selected:AppReleaseBootstrap={mode:'artifact',channel:'test',release:{id:'selected-b',label:'Synthetic B',notes:{features:['Synthetic fixture'],fixes:['Synthetic fix'],changes:['Synthetic change']},activatedAt:'2026-11-07T10:28:59.756Z',entryUrl:'/api/app-releases/artifacts/selected-b/index.html',capabilities:[]}}
const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close')
let legacyFocus:EventListener|undefined
beforeEach(()=>{
 vi.clearAllMocks();delete document.documentElement.dataset.appRelease
 document.body.innerHTML='<main><button id="prior">继续写作</button><textarea>合成未发送草稿</textarea></main>';document.body.style.overflow='scroll'
 document.getElementById('prior')!.focus()
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:vi.fn(function(this:HTMLDialogElement){this.setAttribute('open','')})})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');this.dispatchEvent(new Event('close'))}})
})
afterEach(()=>{
 if(legacyFocus)window.removeEventListener('focus',legacyFocus);legacyFocus=undefined
 document.body.replaceChildren();document.body.style.overflow='';vi.restoreAllMocks();vi.unstubAllGlobals()
 if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShow);else Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal')
 if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose);else Reflect.deleteProperty(HTMLDialogElement.prototype,'close')
})
it('opens a fixed accessible dialog outside normal page flow without refreshing and initially focuses Later',()=>{
 const refresh=vi.fn(),main=document.querySelector('main')!,before=main.innerHTML
 showAppReleaseUpdateNotice('Synthetic B 已可用。',refresh)
 const dialog=screen.getByRole('dialog',{name:'应用版本已更新'})
 expect(dialog.tagName).toBe('DIALOG');expect(dialog.getAttribute('aria-modal')).toBe('true');expect(dialog.getAttribute('aria-describedby')).toBe('app-release-update-description')
 expect(dialog.style.position).toBe('fixed');expect(dialog.parentElement).toBe(document.body);expect(main.innerHTML).toBe(before)
 expect(document.querySelector('aside#app-release-update')).toBeNull();expect(document.body.style.overflow).toBe('hidden')
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'稍后'}));expect(refresh).not.toHaveBeenCalled()
})
it.each(['later','close','Escape'] as const)('%s preserves the current page, restores focus and keeps the existing single-notice gate',kind=>{
 const refresh=vi.fn(),prior=document.getElementById('prior')!
 showAppReleaseUpdateNotice('Synthetic B',refresh)
 if(kind==='later')fireEvent.click(screen.getByRole('button',{name:'稍后'}))
 else if(kind==='close')fireEvent.click(screen.getByRole('button',{name:'关闭版本更新提示'}))
 else fireEvent(screen.getByRole('dialog'),new Event('cancel',{cancelable:true}))
 expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(prior);expect(document.body.style.overflow).toBe('scroll')
 expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('合成未发送草稿');expect(refresh).not.toHaveBeenCalled()
 showAppReleaseUpdateNotice('Synthetic C',refresh)
 expect(document.querySelectorAll('#app-release-update')).toHaveLength(1);expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();expect(screen.queryByRole('dialog')).toBeNull()
})
it('runs only the supplied refresh path on an explicit single click',()=>{
 const refresh=vi.fn();showAppReleaseUpdateNotice('Synthetic B',refresh)
 const button=screen.getByRole('button',{name:'立即刷新'}) as HTMLButtonElement
 expect(refresh).not.toHaveBeenCalled();button.click();button.click()
 expect(refresh).toHaveBeenCalledOnce();expect(button.disabled).toBe(true)
})
it('keeps Tab and Shift+Tab within the dialog and centers the accessible close control',()=>{
 showAppReleaseUpdateNotice('Synthetic B',vi.fn())
 const first=screen.getByRole('button',{name:'关闭版本更新提示'}),last=screen.getByRole('button',{name:'立即刷新'})
 last.focus();fireEvent.keyDown(last,{key:'Tab'});expect(document.activeElement).toBe(first)
 fireEvent.keyDown(first,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(last)
 expect(first.style.alignItems).toBe('center');expect(first.style.justifyContent).toBe('center')
})
it('uses the actual Studio neutral token scope while leaving non-Studio pages in their existing theme',()=>{
 document.querySelector('main')!.className='studio-workspace';showAppReleaseUpdateNotice('Synthetic B',vi.fn())
 expect(screen.getByRole('dialog').classList.contains('studio-workspace')).toBe(true)
 expect(screen.getByRole('dialog').style.background).toBe('var(--surface-default,#fff)')
})
it('keeps the launcher watcher and exact route refresh callback without automatic navigation or repeated prompting',async()=>{
 const location={pathname:'/studio',search:'?novel=synthetic',hash:'#draft',replace:vi.fn(),assign:vi.fn()};vi.stubGlobal('location',location)
 const listener=vi.spyOn(window,'addEventListener');vi.spyOn(window,'setInterval').mockReturnValue(123 as unknown as ReturnType<typeof window.setInterval>)
 mocks.request.mockResolvedValueOnce({mode:'legacy',channel:'stable',release:null}).mockResolvedValue(selected)
 expect(await bootstrapAppRelease()).toBe(true)
 legacyFocus=listener.mock.calls.find(([event])=>event==='focus')![1] as EventListener
 window.dispatchEvent(new Event('focus'));await screen.findByRole('dialog',{name:'应用版本已更新'})
 expect(screen.getByRole('heading',{name:'更新日志'})).toBeTruthy()
 expect(screen.getByText('Synthetic fixture')).toBeTruthy()
 expect(screen.getByText(/更新时间 .*18:28:59（北京时间）/).getAttribute('datetime')).toBe(selected.release!.activatedAt)
 expect(location.assign).not.toHaveBeenCalled();expect(location.replace).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'立即刷新'}))
 expect(location.assign).toHaveBeenCalledExactlyOnceWith('/api/app-releases/artifacts/selected-b/index.html?route=%2Fstudio%3Fnovel%3Dsynthetic%23draft')
 fireEvent.click(screen.getByRole('button',{name:'稍后'}));window.dispatchEvent(new Event('focus'));await Promise.resolve()
 expect(mocks.request).toHaveBeenCalledTimes(2);expect(screen.queryByRole('dialog')).toBeNull()
})
function artifact(fetch:ReturnType<typeof vi.fn>){
 const location={pathname:'/studio',search:'?draft=synthetic',hash:'#chapter',assign:vi.fn()}
 const listeners:Record<string,()=>void>={}
 vm.runInNewContext(releaseEntryScript('loaded-a'),{document,HTMLElement,URLSearchParams,location,history:{replaceState:vi.fn()},window:{addEventListener:(event:string,listener:()=>void)=>{listeners[event]=listener}},setInterval:vi.fn(),fetch})
 return {location,check:()=>listeners.focus()}
}
it.each(['artifact','legacy'] as const)('executes the serialized artifact notice without module closures and preserves the %s refresh route',async mode=>{
 const selection=mode==='artifact'?selected:{mode:'legacy',channel:'stable',release:null}
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({success:true,data:selection})})),run=artifact(fetch)
 run.check();run.check();await screen.findByRole('dialog',{name:'应用版本已更新'})
 if(mode==='artifact'){
  expect(screen.getAllByRole('listitem').map(item=>item.textContent)).toEqual(['Synthetic fixture','Synthetic fix','Synthetic change'])
  expect(screen.getByText(/更新时间 .*18:28:59（北京时间）/).getAttribute('datetime')).toBe(selected.release!.activatedAt)
 }else{
  expect(screen.queryByRole('heading',{name:'更新日志'})).toBeNull()
  expect(screen.queryByText(/更新时间/)).toBeNull()
 }
 expect(fetch).toHaveBeenCalledOnce();expect(fetch).toHaveBeenCalledWith('/api/app-releases/bootstrap',{credentials:'include',cache:'no-store'})
 expect(run.location.assign).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'立即刷新'}))
 expect(run.location.assign).toHaveBeenCalledExactlyOnceWith(mode==='artifact'?'/api/app-releases/artifacts/selected-b/index.html?route=%2Fstudio%3Fdraft%3Dsynthetic%23chapter':'/studio?draft=synthetic#chapter')
})
it.each(['same','failed','unknown'] as const)('keeps the artifact %s detection outcome unchanged without a prompt or navigation',async outcome=>{
 const fetch=vi.fn(async()=>{if(outcome==='unknown')throw Error('synthetic network result unknown');return {ok:outcome!=='failed',json:async()=>({success:true,data:{...selected,release:{...selected.release!,id:'loaded-a'}}})}}),run=artifact(fetch)
 run.check();await waitFor(()=>expect(fetch).toHaveBeenCalledOnce());await new Promise(resolve=>setTimeout(resolve,0))
 expect(screen.queryByRole('dialog')).toBeNull();expect(run.location.assign).not.toHaveBeenCalled()
})
