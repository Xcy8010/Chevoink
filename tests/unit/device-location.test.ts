import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { resolveDeviceLocation } from '../../api/lib/device-location.js'

function request(peer: string, realIp?: string) {
  return { socket: { remoteAddress: peer }, get: (name: string) => name === 'x-real-ip' ? realIp : undefined } as Request
}

describe('offline device location', () => {
  it('uses the peer observed by the local reverse proxy', async () => {
    expect(await resolveDeviceLocation(request('::ffff:127.0.0.1', '8.8.8.8'))).toBe('美国 · California')
    expect(await resolveDeviceLocation(request('::1', '113.118.113.77'))).toBe('中国 · 广东省 · 深圳市')
    expect(await resolveDeviceLocation(request('::1', '240e:3b7:3272:d8d0:db09:c067:8d59:539e'))).toBe('中国 · 广东省 · 深圳市')
    expect(await resolveDeviceLocation(request('::1', '1.2.3.4'))).toBe('澳大利亚 · Queensland · Brisbane')
  })

  it('uses the connection address for direct clients and keeps unknown locations unknown', async () => {
    expect(await resolveDeviceLocation(request('192.0.2.1', '8.8.8.8'))).toBeNull()
    expect(await resolveDeviceLocation(request('::1'))).toBe('本机')
    expect(await resolveDeviceLocation(request('fd00::1'))).toBe('局域网')
    expect(await resolveDeviceLocation(request('127.0.0.1', 'invalid'))).toBeNull()
  })
})
