import type { Request } from 'express'
import { evaluateAccountObservation, type AccountObservationInput } from '../../shared/account-security-observation.js'
import { resolveDeviceLocation } from './device-location.js'
import { prisma } from './prisma.js'

type ObservedAction = Exclude<AccountObservationInput['action'], 'ordinary_activity'>
type ObservedDevice = { id: string; userId: string; tokenVersion: number; createdAt: Date; location: string | null }
const windowMs = 10 * 60_000
const failureThreshold = 5
const failures = new Map<string, { count: number; until: number }>()

// Keys are existing internal account IDs (sign-in) or verified session IDs (revoke).
// Expiration order follows insertion order. No submitted login identifiers are kept.
function expireFailures(now: number) {
  for (const [key, bucket] of failures) {
    if (bucket.until > now) break
    failures.delete(key)
  }
}
setInterval(() => expireFailures(Date.now()), windowMs).unref()

function report(input: AccountObservationInput, stage: 'failed' | 'succeeded') {
  const decision = evaluateAccountObservation(input)
  if (decision !== 'allow') console.info('[account-security-observation]', {
    action: input.action, stage, decision, repeatedFailures: input.repeatedFailures,
    countryChanged: input.countryChanged, deviceEvidence: input.deviceEvidence,
  })
}

export function recordAccountPasswordFailure(action: ObservedAction, id: string) {
  const now = Date.now()
  expireFailures(now)
  const key = action + ':' + id
  let bucket = failures.get(key)
  if (!bucket) {
    if (failures.size >= 5000) failures.delete(failures.keys().next().value!)
    bucket = { count: 0, until: now + windowMs }
    failures.set(key, bucket)
  }
  if (++bucket.count === failureThreshold) {
    report({ action, repeatedFailures: true, countryChanged: false, deviceEvidence: 'unknown' }, 'failed')
  }
}

function consumeFailures(action: ObservedAction, id: string) {
  const key = action + ':' + id
  const bucket = failures.get(key)
  failures.delete(key)
  return Boolean(bucket && bucket.until > Date.now() && bucket.count >= failureThreshold)
}

function country(location: string | null) {
  if (!location || location === '本机' || location === '局域网') return null
  return location.split(' · ', 1)[0]
}

async function observeSuccess(action: ObservedAction, device: ObservedDevice, deviceEvidence: AccountObservationInput['deviceEvidence'], repeatedFailures: boolean) {
  const currentCountry = country(device.location)
  let countryChanged = false
  if (currentCountry && deviceEvidence !== 'existing_session') {
    const prior = await prisma.accountDeviceSession.findMany({
      where: { userId: device.userId, tokenVersion: device.tokenVersion, createdAt: { lt: device.createdAt },
        lastActiveAt: { gte: new Date(Date.now() - 30 * 86400_000) }, location: { not: null } },
      orderBy: { lastActiveAt: 'desc' }, take: 8, select: { location: true },
    })
    const known = prior.map(row => country(row.location)).filter(Boolean)
    countryChanged = known.length > 0 && !known.includes(currentCountry)
  }
  report({ action, deviceEvidence, repeatedFailures, countryChanged }, 'succeeded')
}

// Observation reads run after successful authentication/authorization and cannot alter its response.
export async function observePasswordLogin(device: ObservedDevice, sameAccountSession: boolean) {
  const repeatedFailures = consumeFailures('password_login', device.userId)
  if (!repeatedFailures) return
  await observeSuccess('password_login', device, sameAccountSession ? 'existing_session' : 'unknown', repeatedFailures)
}

export async function observeOtherDeviceRemoval(req: Request, identity: { userId: string; deviceId: string; tokenVersion: number }) {
  const { userId, deviceId: id, tokenVersion } = identity
  const repeatedFailures = consumeFailures('device_revoke', id)
  // Capture the trusted peer before the response completes and its socket closes.
  const [location, device] = await Promise.all([
    resolveDeviceLocation(req),
    prisma.accountDeviceSession.findFirst({ where: { id, userId, tokenVersion }, select: { createdAt: true } }),
  ])
  if (!device) return
  // Legacy upgrades only record when the old token was first seen.
  const recentlyIssued = !/^(?:carry|shared|legacy)-/.test(id) && device.createdAt.getTime() >= Date.now() - windowMs
  if (!recentlyIssued && !repeatedFailures) return
  await observeSuccess('device_revoke', { ...device, userId, id, tokenVersion, location },
    recentlyIssued ? 'recent_session' : 'existing_session', repeatedFailures)
}
