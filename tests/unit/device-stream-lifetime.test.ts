import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { guardDeviceStreams } from '../../api/lib/device-stream-lifetime'
import { isDeviceSessionActive } from '../../api/lib/auth-session'

vi.mock('../../api/lib/auth-session', () => ({
  getSessionUserId: () => 'owner',
  requireDeviceIdentity: (req: { device: string }) => ({ userId: 'owner', deviceId: req.device, tokenVersion: 4 }),
  isDeviceSessionActive: vi.fn(),
}))

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

it('checks all streams of one device together and disconnects only the revoked device', async () => {
  vi.useFakeTimers()
  vi.mocked(isDeviceSessionActive).mockImplementation(async identity => identity.deviceId === 'phone')
  function open(device: string) {
    const res = Object.assign(new EventEmitter(), { destroy: vi.fn(() => res.emit('close')) })
    const next = vi.fn()
    guardDeviceStreams({ device } as unknown as Request, res as unknown as Response, next)
    expect(next).toHaveBeenCalledOnce()
    return res
  }
  const run = open('desktop'), session = open('desktop'), other = open('phone')
  await vi.advanceTimersByTimeAsync(15000)
  expect(isDeviceSessionActive).toHaveBeenCalledTimes(2)
  expect(run.destroy).toHaveBeenCalledOnce()
  expect(session.destroy).toHaveBeenCalledOnce()
  expect(other.destroy).not.toHaveBeenCalled()
  other.emit('close')
  await vi.advanceTimersByTimeAsync(15000)
  expect(isDeviceSessionActive).toHaveBeenCalledTimes(2)
})
