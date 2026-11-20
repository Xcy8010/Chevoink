import { readFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { Request } from 'express'
import { IPv4, IPv6, newWithBuffer, type Searcher } from 'ip2region.js'

const decompress = promisify(gunzip)
const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' })
const localNetworks = new BlockList()
localNetworks.addSubnet('10.0.0.0', 8)
localNetworks.addSubnet('172.16.0.0', 12)
localNetworks.addSubnet('192.168.0.0', 16)
localNetworks.addSubnet('169.254.0.0', 16)
localNetworks.addSubnet('fc00::', 7, 'ipv6')
localNetworks.addSubnet('fe80::', 10, 'ipv6')

const databases = new Map<4 | 6, Promise<Searcher>>()
function database(family: 4 | 6) {
  const existing = databases.get(family)
  if (existing) return existing
  const loading = readFile(new URL(`../data/ip2region_v${family}.xdb.gz`, import.meta.url))
    .then(bytes => decompress(bytes))
    .then(bytes => newWithBuffer(family === 4 ? IPv4 : IPv6, bytes))
    .catch((error: unknown) => {
      databases.delete(family)
      throw error
    })
  databases.set(family, loading)
  return loading
}

function normalize(address: string | undefined) {
  return address?.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '') ?? ''
}

function isLoopback(address: string) {
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))
}

export async function resolveDeviceLocation(req: Request): Promise<string | null> {
  const peer = normalize(req.socket?.remoteAddress)
  // The loopback nginx overwrites X-Real-IP with its connection peer.
  const ip = normalize(isLoopback(peer) ? req.get('x-real-ip') || peer : peer)
  const family = isIP(ip)
  if (family !== 4 && family !== 6) return null
  if (isLoopback(ip)) return '本机'
  if (localNetworks.check(ip, family === 6 ? 'ipv6' : 'ipv4')) return '局域网'
  try {
    const result = await (await database(family)).search(ip)
    const [, province, city, , code] = result.split('|')
    if (!code || !/^[A-Z]{2}$/.test(code)) return null
    const country = countryNames.of(code)
    const parts = [country, province, city].filter(value => value && value !== '0')
    return [...new Set(parts)].join(' · ') || null
  } catch {
    return null
  }
}
