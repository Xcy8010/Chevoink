import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync(new URL('../../public/boot-theme.js', import.meta.url), 'utf8')

function boot(saved: string | null, options: { native?: boolean; userAgent?: string; appearance?: (value: unknown) => Promise<void> } = {}) {
  let theme = ''
  const meta = { setAttribute: vi.fn() }
  const dataset: { sessionActivity: string; bootPlatform?: string } = { sessionActivity: 'native' }
  const root = { dataset, classList: { add: (value: string) => { theme = value } } }
  runInNewContext(script, {
    localStorage: { getItem: () => saved },
    document: { documentElement: root, querySelector: () => meta },
    getComputedStyle: () => ({ getPropertyValue: () => theme === 'dark' ? '#111318' : '#f4f0e8' }),
    navigator: { userAgent: options.userAgent ?? (options.native ? 'Android ChevoinkApp/1.0.13' : 'Chrome') },
    window: { Capacitor: { Plugins: { ImmersiveMode: { setSystemBarAppearance: options.appearance } } } },
  })
  return { theme, meta, dataset }
}

describe('loading page theme before the app bundle mounts', () => {
  it.each(['light', 'dark'])('matches native system bars to the saved %s loading background', theme => {
    const appearance = vi.fn(async () => {})
    const result = boot(JSON.stringify({ state: { theme } }), { native: true, appearance })
    const color = theme === 'dark' ? '#111318' : '#f4f0e8'
    expect(result.theme).toBe(theme)
    expect(result.dataset.bootPlatform).toBe('android')
    expect(result.meta.setAttribute).toHaveBeenCalledWith('content', color)
    expect(appearance).toHaveBeenCalledExactlyOnceWith({ color, dark: theme === 'dark' })
  })

  it('selects the desktop loading surface only in the Windows shell', () => {
    expect(boot(null, { userAgent: 'Edge ChevoinkDesktop/1.0.10' }).dataset.bootPlatform).toBe('windows')
    expect(boot(null, { userAgent: 'Windows Edge' }).dataset.bootPlatform).toBeUndefined()
  })

  it('keeps browser loading independent of native capabilities', () => {
    const appearance = vi.fn(async () => {})
    expect(boot(null, { appearance }).theme).toBe('light')
    expect(appearance).not.toHaveBeenCalled()
  })

  it('keeps loading on older shells, malformed storage and a rejected appearance call', async () => {
    expect(boot('{', { native: true }).theme).toBe('light')
    const appearance = vi.fn(async () => { throw new Error('unsupported') })
    expect(boot(null, { native: true, appearance }).theme).toBe('light')
    await Promise.resolve()
    expect(appearance).toHaveBeenCalledOnce()
  })
})
