import type { NovelImportJob } from '@prisma/client'
import { prisma } from '../prisma.js'

export const NOVEL_IMPORT_PARSE_DEADLINE_MS = 30 * 60_000
const LEASE_MS = 150_000
type ParseClaim = Pick<NovelImportJob, 'id' | 'userId' | 'novelId' | 'leaseOwner' | 'leaseEpoch' | 'parseDeadlineAt'>

/** One bounded lifetime across worker work and private persistence. CAS renewal
 * cannot revive an expired lease, steal another epoch, or reset the job deadline. */
export function startNovelImportParseLease(claim: ParseClaim) {
  const controller = new AbortController()
  let timedOut = false; let checking = false; let stopped = false; let nextRenewal = Date.now() + 20_000
  const remaining = Math.max(0, Math.min(NOVEL_IMPORT_PARSE_DEADLINE_MS, (claim.parseDeadlineAt?.getTime() ?? 0) - Date.now()))
  const expire = () => { timedOut = true; controller.abort() }
  const timer = setTimeout(expire, remaining)
  if (!remaining) expire()
  const poll = setInterval(() => {
    if (checking || stopped || controller.signal.aborted) return
    checking = true
    void (async () => {
      const now = new Date()
      if (Date.now() >= nextRenewal) {
        const renewed = await prisma.novelImportJob.updateMany({ where: { id: claim.id, userId: claim.userId, novelId: claim.novelId, status: 'parsing', leaseOwner: claim.leaseOwner, leaseEpoch: claim.leaseEpoch, leaseUntil: { gt: now }, expiresAt: { gt: now }, parseDeadlineAt: { gt: now } }, data: { leaseUntil: new Date(Math.min(now.getTime() + LEASE_MS, claim.parseDeadlineAt!.getTime())) } })
        if (renewed.count !== 1) controller.abort()
        nextRenewal = Date.now() + 20_000
      } else {
        const current = await prisma.novelImportJob.findUnique({ where: { id: claim.id }, select: { status: true, leaseEpoch: true, leaseOwner: true, leaseUntil: true, expiresAt: true } })
        if (!current || current.status !== 'parsing' || current.leaseEpoch !== claim.leaseEpoch || current.leaseOwner !== claim.leaseOwner || !current.leaseUntil || current.leaseUntil <= now || current.expiresAt <= now) controller.abort()
      }
    })().catch(() => controller.abort()).finally(() => { checking = false })
  }, 1000)
  return { signal: controller.signal, get timedOut() { return timedOut }, stop() { stopped = true; clearTimeout(timer); clearInterval(poll) } }
}
