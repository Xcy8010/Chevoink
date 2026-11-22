import { Suspense, useEffect, useSyncExternalStore, type ComponentType } from 'react'
import StudioSurfaceStatus from './StudioSurfaceStatus'

/** Cache successful imports across tasks. A failed chunk is retryable within its own pane. */
export function loadStudioSurface<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  label: string,
  dialog?: (props: P) => { open: boolean; onClose: () => void },
) {
  type State = 'idle' | 'loading' | 'failed' | ComponentType<P>
  let state: State = 'idle'
  const listeners = new Set<() => void>()
  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  function publish(next: State) {
    state = next
    listeners.forEach(listener => listener())
  }
  const snapshot = () => state
  function start() {
    if (state !== 'idle' && state !== 'failed') return
    publish('loading')
    void load().then(module => publish(module.default), () => publish('failed'))
  }
  return function StudioSurface(props: P) {
    const current = useSyncExternalStore(subscribe, snapshot, snapshot)
    const modal = dialog?.(props)
    const visible = modal?.open ?? true
    useEffect(() => { if (visible && current === 'idle') start() }, [current, visible])
    const pending = visible ? <StudioSurfaceStatus label={label} close={modal?.onClose}
      retry={current === 'failed' ? start : undefined} /> : null
    if (typeof current === 'string') return pending
    const Loaded = current
    return <Suspense fallback={pending}><Loaded {...props} /></Suspense>
  }
}
