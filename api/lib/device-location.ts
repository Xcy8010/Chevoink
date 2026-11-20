import { readFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { Request } from 'express'
import { Reader, type CountryResponse } from 'mmdb-lib'

const decompress = promisify(gunzip)
const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' })
const localNetworks = new BlockList()
localNetworks.addSubnet('10.0.0.0', 8)
localNetworks.addSubnet('172.16.0.0', 12)
localNetworks.addSubnet('192.168.0.0', 16)
localNetworks.addSubnet('169.254.0.0', 16)
localNetworks.addSubnet('fc00::', 7, 'ipv6')
localNetworks.addSubnet('fe80::', 10, 'ipv6')

let countries: Promise<Reader<CountryResponse>> | undefined
function countryDatabase() {
  countries ??= readFile(new URL('../data/dbip-country-lite.mmdb.gz', import.meta.url))
    .then(bytes => decompress(bytes))
    .then(bytes => new Reader<CountryResponse>(bytes))
    .catch((error: unknown) => {
      countries = undefined
      throw error
    })
  return countries
}

function normalize(address: string | undefined) {
  return address?.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '') ?? ''
}

function isLoopback(address: string) {
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))
}

export async function resolveDeviceLocation(req: Request): Promise<string | null> {
  const peer = normalize(req.socket?.remoteAddress)
  // The project's loopback nginx overwrites X-Real-IP with its connection peer.
  const ip = normalize(isLoopback(peer) ? req.get('x-real-ip') || peer : peer)
  const family = isIP(ip)
  if (!family) return null
  if (isLoopback(ip)) return '本机'
  if (localNetworks.check(ip, family === 6 ? 'ipv6' : 'ipv4')) return '局域网'
  try {
    const code = (await countryDatabase()).get(ip)?.country?.iso_code
    return code && /^[A-Z]{2}$/.test(code) ? countryNames.of(code) ?? null : null
  } catch {
    // A missing location must not interrupt sign-in.
    return null
  }
}
