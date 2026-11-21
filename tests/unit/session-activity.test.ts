// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ApiClientError, requestJson } from '../../src/app/api-client'
import { listenForSessionActivity, REAUTHENTICATION_REQUIRED } from '../../src/app/session-activity'
import { getSessionToken, selectDevice, selectedDevice, setSessionToken } from '../../src/lib/auth-token'
import { useShellStore } from '../../src/store/useShellStore'
import type { User } from '../../shared/contracts'

vi.mock('../../src/app/api-client', async original => ({
  ...await original<typeof import('../../src/app/api-client')>(), requestJson: vi.fn(),
}))
const send = vi.mocked(requestJson)
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); send.mockReset() })

function fixture() {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const events = vi.spyOn(document, 'addEventListener')
  const current = vi.fn(() => true)
  const stop = listenForSessionActivity('user', 'device', current)
  visibility.mockReturnValue('visible')
  // jsdom cannot create trusted hardware events. Exercise the installed handler.
  const handler = events.mock.calls.find(([name]) => name === 'keydown')![1] as EventListener
  const interact = (trusted: boolean) => handler({ isTrusted: trusted } as Event)
  return { visibility, current, stop, interact }
}

it('reports a visible opening without input and does not treat a hidden load as use', () => {
  send.mockResolvedValue({})
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const first = listenForSessionActivity('reader', 'this-login', () => true)
  first()
  expect(send.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"userId":"reader","deviceId":"this-login","elapsedMs":0}' })
  visibility.mockReturnValue('hidden')
  const hidden = listenForSessionActivity('reader', 'this-login', () => true)
  try {
    expect(send).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(send).toHaveBeenCalledTimes(2)
  } finally { hidden() }
})

it('ends a stale tab locally without erasing the newer login selected by another tab', () => {
  const shell = useShellStore.getState()
  shell.setAuthenticated({ user: { id: 'first-user' } as User, tokens: {
    deviceSessionId: 'first-login', accessToken: 'first-access', refreshToken: 'first-refresh', expiresInSeconds: 900,
  } })
  selectDevice('second-login')
  setSessionToken('second-refresh')
  shell.setGuest()
  expect(useShellStore.getState().authStatus).toBe('guest')
  expect(selectedDevice()).toBe('second-login')
  expect(getSessionToken()).toBe('second-refresh')
  selectDevice(null)
  setSessionToken(null)
})

it('coalesces typing and reports the final interaction time; reopening a visible page counts without typing', () => {
  send.mockResolvedValue({})
  const { visibility, stop, interact } = fixture()
  try {
    interact(false)
    expect(send).not.toHaveBeenCalled()
    interact(true)
    vi.advanceTimersByTime(10_000)
    interact(true)
    interact(true)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50_000)
    expect(send.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"userId":"user","deviceId":"device","elapsedMs":50000}' })
    vi.advanceTimersByTime(120_000)
    expect(send).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    interact(true)
    vi.advanceTimersByTime(120_000)
    expect(send).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(send.mock.lastCall?.[1]).toMatchObject({ method: 'POST', body: '{"userId":"user","deviceId":"device","elapsedMs":0}' })
  } finally { stop() }
})

it('keeps a transport failure recoverable and only signals a verified 401 for the same session', async () => {
  const expired = vi.fn()
  window.addEventListener(REAUTHENTICATION_REQUIRED, expired)
  const { interact, current, stop } = fixture()
  try {
    send.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new ApiClientError('expired', 401))
    interact(true)
    await Promise.resolve()
    expect(expired).not.toHaveBeenCalled()
    interact(true)
    vi.advanceTimersByTime(5_000)
    await Promise.resolve()
    expect(expired).toHaveBeenCalledOnce()
    send.mockRejectedValueOnce(new ApiClientError('expired', 401))
    interact(true)
    vi.advanceTimersByTime(5_000)
    current.mockReturnValue(false)
    await Promise.resolve()
    expect(expired).toHaveBeenCalledOnce()
  } finally {
    stop()
    window.removeEventListener(REAUTHENTICATION_REQUIRED, expired)
  }
})
