import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapAppRelease } from './features/app-releases/bootstrap'
import { setupKeyboardInsetWatcher } from './lib/keyboard-inset'
import { setupSafeAreaFallback } from './lib/safe-area'
import './index.css'
import { setupDesktopLifecycle } from './lib/desktop-lifecycle'

setupSafeAreaFallback()
setupKeyboardInsetWatcher()
setupDesktopLifecycle()

async function start(){
  if(!await bootstrapAppRelease())return
  const {default:App}=await import('./App')
  createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>)
}
void start().catch(()=>{
  const root=document.getElementById('root')!
  root.replaceChildren()
  const message=document.createElement('p');message.textContent='应用版本暂时无法核对，请重试。'
  const retry=document.createElement('button');retry.textContent='重试';retry.onclick=()=>location.reload()
  root.append(message,retry)
})