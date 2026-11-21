import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync(new URL('../../public/boot-theme.js', import.meta.url), 'utf8')
const marker = '/api/app-releases/legacy-foreground.js'

function legacyPage() {
  let session = { userId: 'writer', deviceId: 'one' }
  const stored = new Map<string, string>()
  const reports: unknown[] = []
  const events = new EventTarget()
  const document = Object.assign(events, {
    currentScript: { getAttribute: () => marker },
    documentElement: { dataset: {} }, visibilityState: 'hidden',
  })
  const network = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      reports.push(body)
      return new Response(null, { status: body.deviceId === session.deviceId ? 200 : 409 })
    }
    return Response.json({ data: session })
  })
  const window = Object.assign(new EventTarget(), { fetch: network })
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) }
  runInNewContext(script, { window, document, localStorage: storage, location: new URL('https://preview.example/'),
    navigator: { userAgent: 'Chrome' }, Headers, URL, setTimeout, clearTimeout })
  function visibility(state: string) {
    document.visibilityState = state
    document.dispatchEvent(new Event('visibilitychange'))
  }
  function switchSession(userId: string, deviceId: string) {
    session = { userId, deviceId }
    storage.setItem('chevoink-selected-device', JSON.stringify({ userId, id: deviceId }))
  }
  return { window, network, reports, visibility, switchSession }
}

describe('foreground activity in pre-protocol pages', () => {
  it('keeps hidden boot and background reads silent and resumes without author input',async()=>{
    const p = legacyPage()
    expect(p.network).not.toHaveBeenCalled()
    await p.window.fetch('/api/app-releases/bootstrap')
    expect(p.reports).toEqual([])
    p.visibility('visible')
    await vi.waitFor(()=>expect(p.reports).toHaveLength(1))
    p.visibility('hidden')
    await p.window.fetch('/api/users/me')
    expect(new Headers(p.network.mock.lastCall?.[1]?.headers).get('x-chevoink-device')).toBe('one')
    expect(p.reports).toHaveLength(1)
    await p.window.fetch('https://other.example/api/users/me')
    expect(p.network.mock.lastCall?.[1]).toBeUndefined()
  })

  it('rebinds on a real reopen for the same writer and never credits another writer',async()=>{
    const p = legacyPage()
    p.visibility('visible')
    await vi.waitFor(()=>expect(p.reports).toHaveLength(1))
    p.visibility('hidden')
    p.switchSession('writer','two')
    p.visibility('visible')
    await vi.waitFor(()=>expect(p.reports[1]).toMatchObject({ userId:'writer',deviceId:'two' }))
    p.visibility('hidden')
    p.switchSession('someone-else','three')
    const calls = p.network.mock.calls.length
    p.visibility('visible')
    await vi.waitFor(()=>expect(p.network.mock.calls.length).toBeGreaterThan(calls))
    await new Promise(resolve=>setTimeout(resolve, 0))
    expect(p.reports).toHaveLength(2)
  })
})
