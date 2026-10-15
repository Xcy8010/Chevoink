// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enterNativeImmersive, exitNativeImmersive, observeNativeInsets, type ImmersiveInsets } from '@/lib/native-app'
import { setNativeImmersiveSafeArea, setupSafeAreaFallback } from '@/lib/safe-area'
import { useNativeReaderImmersive } from '@/features/reader/useNativeReaderImmersive'

const normal: ImmersiveInsets = { top: 0, bottom: 0, left: 0, right: 0, immersive: false, measurement: 'remaining' }
let current: ImmersiveInsets
let notify: (insets: ImmersiveInsets) => void
let stop: (() => void) | undefined
const remove = vi.fn(async () => {})
const getInsets = vi.fn(async () => current)
const enter = vi.fn(async (): Promise<ImmersiveInsets> => {
  current = { top: 48, bottom: 0, left: 0, right: 0, immersive: true, measurement: 'remaining' }
  return { ...current, measurement: 'stable' }
})
const exit = vi.fn(async () => { current = { ...normal }; return current })
const background = vi.fn(async () => {})

function installBridge(modern = true) {
  Object.defineProperty(window, 'Capacitor', { configurable: true, value: { Plugins: {
    ImmersiveMode: { enter, exit, ...(modern ? { getInsets, addListener: vi.fn((_event: string, listener: typeof notify) => { notify = listener; return { remove } }) } : {}) },
    StatusBar: { setBackgroundColor: background, setStyle: vi.fn(async () => {}) },
  } } })
}

function Reader({ comments = false, color = '#111111' }: { comments?: boolean; color?: string }) {
  useNativeReaderImmersive(comments, color)
  return <input aria-label="评论" />
}

beforeEach(() => {
  vi.clearAllMocks()
  current = { ...normal }
  notify = () => {}
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android ChevoinkApp/1.0.7' })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  Object.defineProperty(window.screen, 'height', { configurable: true, value: 800 })
  document.documentElement.style.setProperty('--app-bg', '#fafafa')
  installBridge()
})

afterEach(async () => {
  cleanup()
  await exitNativeImmersive()
  stop?.()
  stop = undefined
  enter.mockReset().mockImplementation(async () => {
    current = { ...normal, top: 48, immersive: true }
    return { ...current, measurement: 'stable' }
  })
})

describe('native system-bar safe-area ownership', () => {
  it('accepts the real injected synchronous listener handle and cleans it up', async () => {
    stop = setupSafeAreaFallback()
    await waitFor(() => expect(getInsets).toHaveBeenCalled())
    stop?.()
    stop = undefined
    await waitFor(() => expect(remove).toHaveBeenCalledOnce())
  })

  it('keeps app startup working if bridge listener registration throws synchronously', async () => {
    Object.defineProperty(window, 'Capacitor', { configurable: true, value: { Plugins: { ImmersiveMode: {
      getInsets, addListener: () => { throw Error('Bridge not ready') },
    } } } })
    expect(() => { stop = setupSafeAreaFallback() }).not.toThrow()
    await waitFor(() => expect(getInsets).toHaveBeenCalled())
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
  })

  it('does not invent a top band when a fitted native viewport matches screen height', async () => {
    stop = setupSafeAreaFallback()
    await waitFor(() => expect(getInsets).toHaveBeenCalled())
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('0px')
  })

  it('preserves explicit zero hints on old APKs instead of adding fixed gesture padding', () => {
    installBridge(false)
    stop = setupSafeAreaFallback()
    setNativeImmersiveSafeArea(true, { top: 44, bottom: 0 })
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('44px')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('0px')
    setNativeImmersiveSafeArea(false)
    window.dispatchEvent(new Event('resize'))
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
  })

  it('uses changing measured cutout edges and clears stale immersive events after leaving', async () => {
    stop = setupSafeAreaFallback()
    await enterNativeImmersive()
    setNativeImmersiveSafeArea(true, { top: 48, bottom: 0 })
    notify({ top: 0, bottom: 0, left: 52, right: 0, immersive: true, measurement: 'remaining' })
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--safe-left')).toBe('52px')
    setNativeImmersiveSafeArea(false)
    notify({ top: 60, bottom: 24, immersive: true })
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--safe-left')).toBe('0px')
  })

  it('measures edge-to-edge normal layout without double-counting native fitted space', async () => {
    current = { ...normal, top: 36, bottom: 20 }
    stop = setupSafeAreaFallback()
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('36px'))
    current = { ...normal }
    window.dispatchEvent(new Event('orientationchange'))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px'))
  })

  it('rejects malformed bridge insets and removes subscriptions resolved after cleanup', async () => {
    let finish!: (handle: { remove: typeof remove }) => void
    Object.defineProperty(window, 'Capacitor', { configurable: true, value: { Plugins: { ImmersiveMode: {
      getInsets, addListener: (_event: string, listener: typeof notify) => { notify = listener; return new Promise(resolve => { finish = resolve }) },
    } } } })
    const received = vi.fn()
    const dispose = observeNativeInsets(received)
    await waitFor(() => expect(typeof finish).toBe('function'))
    notify({ top: Number.NaN, bottom: 0 })
    expect(received).not.toHaveBeenCalled()
    dispose()
    finish({ remove })
    await waitFor(() => expect(remove).toHaveBeenCalledOnce())
  })

  it('does not restore immersive padding when an enter finishes after comments open', async () => {
    let finish!: (value: ImmersiveInsets) => void
    enter.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    stop = setupSafeAreaFallback()
    const view = render(<Reader />)
    await waitFor(() => expect(enter).toHaveBeenCalledOnce())
    view.rerender(<Reader comments />)
    finish({ top: 60, bottom: 24 })
    await waitFor(() => expect(exit).toHaveBeenCalled())
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('0px')
    await waitFor(() => expect(background).toHaveBeenLastCalledWith({ color: '#111111' }))
  })

  it('restores the normal layout after rapid StrictMode mount and route unmount', async () => {
    stop = setupSafeAreaFallback()
    const view = render(<StrictMode><Reader /></StrictMode>)
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('48px'))
    view.unmount()
    await waitFor(() => expect(current.immersive).toBe(false))
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
  })

  it('retains the browser fallback without invoking a native plugin', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android QQBrowser' })
    stop = setupSafeAreaFallback()
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('32px')
    expect(getInsets).not.toHaveBeenCalled()
  })
})
