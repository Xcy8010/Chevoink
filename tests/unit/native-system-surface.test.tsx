// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeSystemSurface } from '@/lib/useNativeSystemSurface'
import { exitNativeImmersive, normalizeSystemSurfaceColor, restoreNativeSystemBarsToTheme, syncNativeSystemBars } from '@/lib/native-app'
import { useNativeReaderImmersive } from '@/features/reader/useNativeReaderImmersive'

const color = vi.fn(async (_options: { color: string }) => {})
const style = vi.fn(async (_options: { style: string }) => {})
const navigation = vi.fn(async () => {})
const enter = vi.fn(async () => ({ top: 40, bottom: 0, immersive: true }))
const exit = vi.fn(async () => ({ top: 0, bottom: 0, immersive: false }))

function Surface({ background = '#ffffff', hidden = false, text = '工作台' }: { background?: string; hidden?: boolean; text?: string }) {
  const ref = useNativeSystemSurface<HTMLElement>()
  return <header ref={ref} style={{ backgroundColor: background, display: hidden ? 'none' : 'block' }}>{text}</header>
}

function Reader({ background = '#f8f4eb' }: { background?: string }) {
  useNativeReaderImmersive(false, background)
  return <div>阅读</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  color.mockImplementation(async () => {})
  exit.mockImplementation(async () => ({ top: 0, bottom: 0, immersive: false }))
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android ChevoinkApp/1.0.8' })
  Object.defineProperty(window, 'Capacitor', { configurable: true, value: { Plugins: {
    StatusBar: { setBackgroundColor: color, setStyle: style },
    NavigationBar: { setNavigationBarColor: navigation },
    ImmersiveMode: { enter, exit },
  } } })
  document.documentElement.className = 'light'
  document.documentElement.style.cssText = '--app-bg: #f4f0e8'
  const meta = document.createElement('meta')
  meta.name = 'theme-color'; meta.content = '#f4f0e8'
  document.head.append(meta)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.style.display === 'none' ? [] : [new DOMRect(0, 0, 390, 56)]) as unknown as DOMRectList
  })
})

afterEach(async () => {
  cleanup()
  await exitNativeImmersive()
  document.querySelector('meta[name="theme-color"]')?.remove()
  vi.restoreAllMocks()
})

describe('current system-bar surface ownership', () => {
  it('prefers the new atomic native appearance capability without legacy writes or fullscreen transitions', async () => {
    const appearance = vi.fn(async () => {})
    Object.assign((window as unknown as { Capacitor: { Plugins: { ImmersiveMode: object } } }).Capacitor.Plugins.ImmersiveMode, { setSystemBarAppearance: appearance })
    render(<Surface background="#000000" />)
    await waitFor(() => expect(appearance).toHaveBeenLastCalledWith({ color: '#000000', dark: true }))
    expect(color).not.toHaveBeenCalled()
    expect(style).not.toHaveBeenCalled()
    expect(navigation).not.toHaveBeenCalled()
    expect(enter).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('retains the old APK path when a proxy exposes an unavailable new method', async () => {
    const appearance = vi.fn(async () => { throw Error('UNIMPLEMENTED') })
    Object.assign((window as unknown as { Capacitor: { Plugins: { ImmersiveMode: object } } }).Capacitor.Plugins.ImmersiveMode, { setSystemBarAppearance: appearance })
    render(<Surface />)
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#ffffff' }))
    expect(style).toHaveBeenLastCalledWith({ style: 'LIGHT' })
    expect(appearance).toHaveBeenCalledOnce()
  })
  it('uses actual studio white/black rather than the different root palette and restores on leaving', async () => {
    const view = render(<Surface />)
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#ffffff' }))
    expect(style).toHaveBeenLastCalledWith({ style: 'LIGHT' })
    view.rerender(<Surface background="#000000" />)
    document.documentElement.className = 'dark'
    document.documentElement.style.setProperty('--app-bg', '#111318')
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
    expect(style).toHaveBeenLastCalledWith({ style: 'DARK' })
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000')
    view.unmount()
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#111318' }))
  })

  it('yields a hidden desktop header to root and restores the real surface after viewport changes', async () => {
    const view = render(<Surface />)
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#ffffff' }))
    view.rerender(<Surface hidden />)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#f4f0e8' }))
    view.rerender(<Surface background="#000000" />)
    fireEvent(window, new Event('orientationchange'))
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
    expect(enter).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('lets global theme synchronization resolve the registered surface instead of overwriting it', async () => {
    render(<Surface background="#000000" />)
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
    document.documentElement.style.setProperty('--app-bg', '#ffffff')
    restoreNativeSystemBarsToTheme()
    await act(async () => {})
    expect(color).toHaveBeenLastCalledWith({ color: '#000000' })
    expect(style).toHaveBeenLastCalledWith({ style: 'DARK' })
  })

  it('reasserts the same palette after configuration or foreground resets native icon appearance', async () => {
    render(<Surface background="#000000" />)
    await waitFor(() => expect(style).toHaveBeenCalledWith({ style: 'DARK' }))
    style.mockClear()
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(style).toHaveBeenCalledWith({ style: 'DARK' }))
    style.mockClear()
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(style).toHaveBeenCalledWith({ style: 'DARK' }))
    expect(enter).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('restores the latest studio theme after a reader exit resolves late', async () => {
    let finishExit!: () => void
    exit.mockImplementationOnce(() => new Promise(resolve => {
      finishExit = () => resolve({ top: 0, bottom: 0, immersive: false })
    }))
    const view = render(<Reader />)
    await waitFor(() => expect(enter).toHaveBeenCalledOnce())
    view.rerender(<Surface background="#ffffff" />)
    await waitFor(() => expect(exit).toHaveBeenCalledOnce())
    view.rerender(<Surface background="#000000" />)
    document.documentElement.className = 'dark'
    finishExit()
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
    expect(style).toHaveBeenLastCalledWith({ style: 'DARK' })
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000')
  })

  it('keeps a newer reader owner when an earlier reader exit completes', async () => {
    let finishExit!: () => void
    exit.mockImplementationOnce(() => new Promise(resolve => {
      finishExit = () => resolve({ top: 0, bottom: 0, immersive: false })
    }))
    const view = render(<Reader key="old" background="#f8f4eb" />)
    await waitFor(() => expect(enter).toHaveBeenCalledOnce())
    view.rerender(<Reader key="new" background="#123456" />)
    await waitFor(() => expect(exit).toHaveBeenCalledOnce())
    finishExit()
    await waitFor(() => expect(enter).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#123456' }))
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#123456')
  })

  it('updates reader tone without reentering immersive mode', async () => {
    const view = render(<Reader />)
    await waitFor(() => expect(enter).toHaveBeenCalledOnce())
    view.rerender(<Reader background="#000000" />)
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
    expect(enter).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
  })

  it('serializes asynchronous color writes so a slow old palette cannot finish after the new palette', async () => {
    let finishOld!: () => void
    color.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    const view = render(<Surface />)
    await waitFor(() => expect(color).toHaveBeenCalledWith({ color: '#ffffff' }))
    view.rerender(<Surface background="#000000" />)
    await waitFor(() => expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000'))
    expect(color).toHaveBeenCalledTimes(1)
    finishOld()
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
  })

  it('updates mobile browser chrome with no native writes and ignores streamed body text', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Android Chrome' })
    const view = render(<Surface background="#000000" />)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000000')
    const computedStyle = vi.spyOn(window, 'getComputedStyle')
    view.rerender(<Surface background="#000000" text="正在流式新增正文" />)
    const streamed = document.createElement('p')
    document.body.append(streamed); streamed.textContent = '其他正文'
    await act(async () => {})
    expect(computedStyle).not.toHaveBeenCalled()
    expect(color).not.toHaveBeenCalled()
    streamed.remove()
  })

  it('deduplicates colors but retries after a bridge method becomes available', async () => {
    const plugins = window as unknown as { Capacitor: { Plugins: { StatusBar: { setBackgroundColor?: typeof color; setStyle?: typeof style } } } }
    delete plugins.Capacitor.Plugins.StatusBar.setBackgroundColor
    render(<Surface />)
    await waitFor(() => expect(style).toHaveBeenCalled())
    expect(color).not.toHaveBeenCalled()
    plugins.Capacitor.Plugins.StatusBar.setBackgroundColor = color
    restoreNativeSystemBarsToTheme()
    await waitFor(() => expect(color).toHaveBeenCalledOnce())
    syncNativeSystemBars('#ffffff', false)
    await act(async () => {})
    expect(color).toHaveBeenCalledOnce()
  })

  it('releases observers and repairs older meta cleanup without replaying a released surface', async () => {
    function Page() {
      const [shown, setShown] = useState(true)
      return <><button onClick={() => setShown(false)}>离开</button>{shown && <Surface background="#000000" />}</>
    }
    render(<Page />)
    await waitFor(() => expect(color).toHaveBeenLastCalledWith({ color: '#000000' }))
    fireEvent.click(screen.getByRole('button', { name: '离开' }))
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#obsolete')
    await waitFor(() => expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f4f0e8'))
    const calls = color.mock.calls.length
    fireEvent(window, new Event('resize'))
    await act(async () => {})
    expect(color).toHaveBeenCalledTimes(calls)
  })
})

it('normalizes actual opaque computed RGB colors without guessing translucent surfaces', () => {
  expect(normalizeSystemSurfaceColor('rgb(255, 255, 255)')).toBe('#ffffff')
  expect(normalizeSystemSurfaceColor('rgb(0 0 0 / 1)')).toBe('#000000')
  expect(normalizeSystemSurfaceColor('#ABC')).toBe('#aabbcc')
  expect(normalizeSystemSurfaceColor('rgba(0, 0, 0, 0.5)')).toBeNull()
  expect(normalizeSystemSurfaceColor('rgb(999, 0, 0)')).toBeNull()
})
