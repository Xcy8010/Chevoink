import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapAppRelease } from './features/app-releases/bootstrap'
import AppState from './components/ui/AppState'
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
  document.getElementById('app-loading')?.remove()
  createRoot(root).render(
    <AppState
      tone="error"
      className="min-h-dvh md:min-h-dvh"
      title="暂时无法打开应用"
      description="请检查网络连接后重试。"
      primaryAction={{label:'重新加载',onClick:()=>location.reload()}}
    />,
  )
})
