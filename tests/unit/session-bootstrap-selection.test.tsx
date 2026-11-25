// @vitest-environment jsdom
import type { PropsWithChildren } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AppProviders from '../../src/app/AppProviders'
import { requestJson } from '../../src/app/api-client'
import { selectDevice, selectedDevice } from '../../src/lib/auth-token'
import { useShellStore } from '../../src/store/useShellStore'

vi.mock('../../src/app/api-client', async original => ({ ...await original<typeof import('../../src/app/api-client')>(), requestJson: vi.fn() }))
vi.mock('../../src/components/layout/DeviceProvider', () => ({ DeviceProvider: ({ children }: PropsWithChildren) => children }))
vi.mock('../../src/components/ui/UpdateBanner', () => ({ default: () => null }))
vi.mock('../../src/lib/native-app', () => ({ restoreNativeSystemBarsToTheme: vi.fn() }))
vi.mock('../../src/features/home/reading-sync', () => ({ hydrateReadingSync: async () => false }))
let client: QueryClient
function CaptureClient() { client = useQueryClient(); return null }
const me = (deviceSessionId: string) => ({ deviceSessionId, user: { id: 'user-' + deviceSessionId } })
afterEach(() => {
  cleanup()
  client.clear()
  useShellStore.getState().setGuest()
  selectDevice(null)
  vi.mocked(requestJson).mockReset()
})

it.each(['same', 'changed', 'changed-twice'])('finishes concurrent initial hydration when another tab selects a login (%s)', async mode => {
  const requests: Array<(result: unknown) => void> = []
  vi.mocked(requestJson).mockImplementation(() => new Promise(resolve => requests.push(resolve)))
  render(<AppProviders><CaptureClient /></AppProviders>)
  await waitFor(() => expect(requests).toHaveLength(1))
  selectDevice('second', 'user-second')
  await act(async () => requests[0](me(mode === 'same' ? 'second' : 'first')))
  if (mode !== 'same') {
    await waitFor(() => expect(requests).toHaveLength(2))
    if (mode === 'changed-twice') selectDevice('third', 'user-third')
    await act(async () => requests[1](me('second')))
  }
  const shell = useShellStore.getState()
  expect(shell.authStatus).toBe(mode === 'changed-twice' ? 'unavailable' : 'authenticated')
  expect(shell.sessionUser?.id).toBe(mode === 'changed-twice' ? undefined : 'user-second')
  expect(client.getQueryData(['community', 'me'])).toEqual(mode === 'changed-twice' ? undefined : me('second'))
  expect(selectedDevice()).toBe(mode === 'changed-twice' ? 'third' : 'second')
  expect(requestJson).toHaveBeenCalledTimes(mode === 'same' ? 1 : 2)
})
