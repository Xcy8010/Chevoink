import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AppRelease, AppReleaseRetirement, Prisma } from '@prisma/client'
import { appReleaseManifestSchema } from '../../shared/contracts/app-release.js'
import { appReleaseArtifactRoot, artifactDigest, readAppReleaseFile, readInstalledAppRelease } from './app-release-artifacts.js'
import { DataAccessError, prisma } from './prisma.js'

type Transaction = Prisma.TransactionClient
export function claimAppReleaseRetirement(tx: Transaction, row: Pick<AppRelease, 'id' | 'artifactSha256'>, triggerOperationId: string | null) {
  const operationId = randomUUID()
  return tx.appReleaseRetirement.create({ data: { releaseId: row.id, operationId, artifactSha256: row.artifactSha256,
    quarantineName: row.id + '-' + operationId, triggerOperationId, state: 'pending' } })
}
export async function requireRetainedRelease(tx: Transaction, id: string) {
  if (await tx.appReleaseRetirement.findUnique({ where: { releaseId: id } }))
    throw new DataAccessError(409, 'APP_RELEASE_RETIRED', '此版本文件已进入自动清理流程，不能再次指派。')
}
export async function pendingReleaseCandidates(tx: Transaction) {
  const [rows, channels, operations, retired] = await Promise.all([
    tx.appRelease.findMany(), tx.appReleaseChannel.findMany(),
    tx.appReleaseOperation.findMany({ where: { status: 'applied' } }), tx.appReleaseRetirement.findMany(),
  ])
  const used = new Set([...channels.filter(row => row.enabled).map(row => row.releaseId), ...operations.map(row => row.releaseId)])
  const unavailable = new Set(retired.map(row => row.releaseId))
  return rows.filter(row => !used.has(row.id) && !unavailable.has(row.id))
}

/** Caller holds 804726. Only durable claims are written here; I/O starts after commit. */
export async function planAppReleaseRetention(tx: Transaction, triggerOperationId: string | null = null) {
  const [rows, channels, operations, retired] = await Promise.all([
    tx.appRelease.findMany(), tx.appReleaseChannel.findMany(),
    tx.appReleaseOperation.findMany({ where: { status: 'applied' }, orderBy: { createdAt: 'desc' } }),
    tx.appReleaseRetirement.findMany(),
  ])
  if (!channels.some(row => row.channel === 'stable' && row.enabled)) return []
  const claimed = new Set(retired.map(row => row.releaseId))
  const keep = new Set(channels.filter(row => row.enabled).map(row => row.releaseId))
  const applied = new Set(operations.map(row => row.releaseId))
  const candidates = new Set(rows.filter(row => !claimed.has(row.id) && !applied.has(row.id) && !keep.has(row.id)).map(row => row.id))
  const historical = operations.filter(row => row.action === 'full_release' || row.action === 'rollback')
    .sort((a, b) => Date.parse((b.result as { appliedAt?: string } | null)?.appliedAt ?? b.createdAt.toISOString()) - Date.parse((a.result as { appliedAt?: string } | null)?.appliedAt ?? a.createdAt.toISOString()))
    .flatMap(row => [row.releaseId, ...(row.previousReleaseId ? [row.previousReleaseId] : [])])
  for (const id of historical) {
    if (keep.size >= 2) break
    if (keep.has(id) || claimed.has(id)) continue
    const row = rows.find(item => item.id === id)
    if (!row || row.validationState !== 'verified' || !row.verifiedAt || row.compatibilityVersion !== 1) continue
    try {
      const installed = await readInstalledAppRelease(id, true), manifest = appReleaseManifestSchema.parse(row.manifest)
      if (installed.artifactSha256 === row.artifactSha256 && installed.manifest.sourceSha === row.sourceSha && installed.manifest.validation.status === 'verified'
        && manifest.compatibility.api === 1 && manifest.compatibility.schema === 1 && manifest.compatibility.task === 1 && manifest.compatibility.legalConsentUi) keep.add(id)
    } catch { /* A broken artifact is not a usable rollback copy. */ }
  }
  const jobs: AppReleaseRetirement[] = []
  for (const row of rows) {
    if (keep.has(row.id) || candidates.has(row.id) || claimed.has(row.id)) continue
    jobs.push(await claimAppReleaseRetirement(tx, row, triggerOperationId))
  }
  return jobs
}

const missing = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
async function stat(file: string) { try { return await lstat(file) } catch (error) { if (missing(error)) return null; throw error } }
function refuse(code: string): never { throw Object.assign(new Error(code), { code }) }
export function assertRetirementMounts(root: string, target: string, mountInfo: string) {
  for (const line of mountInfo.trim().split('\n')) {
    const point = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, value: string) => String.fromCharCode(Number.parseInt(value, 8)))
    if (!point) continue
    const relative = path.posix.relative(root, point)
    if (point === target || point.startsWith(target + '/') || relative === '.retired' || relative.startsWith('.retired/')) refuse('APP_RELEASE_RETIREMENT_MOUNT')
  }
}
async function safeTree(directory: string, root: string, allowed?: Set<string>) {
  const base = await lstat(root), files: string[] = []
  const cwdRelative = path.relative(directory, process.cwd())
  if (cwdRelative === '' || !cwdRelative.startsWith('..') && !path.isAbsolute(cwdRelative)) refuse('APP_RELEASE_RETIREMENT_CWD')
  async function walk(file: string) {
    const info = await lstat(file)
    if (info.isSymbolicLink() || info.dev !== base.dev || info.uid !== base.uid || !info.isDirectory() && !info.isFile()) refuse('APP_RELEASE_RETIREMENT_PATH')
    if (info.isDirectory()) for (const entry of await readdir(file)) await walk(path.join(file, entry))
    else {
      const relative = path.relative(directory, file).split(path.sep).join('/')
      if (allowed && !allowed.has(relative)) refuse('APP_RELEASE_RETIREMENT_EXTRA_FILE')
      files.push(relative)
    }
  }
  await walk(directory)
  return files
}
async function retirementPaths(job: AppReleaseRetirement) {
  const root = appReleaseArtifactRoot(), info = await lstat(root)
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== root) refuse('APP_RELEASE_RETIREMENT_ROOT')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(job.releaseId) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.operationId)
    || job.quarantineName !== job.releaseId + '-' + job.operationId) refuse('APP_RELEASE_RETIREMENT_PATH')
  const source = path.join(root, job.releaseId), quarantineRoot = path.join(root, '.retired'), quarantine = path.join(quarantineRoot, job.quarantineName)
  if (process.platform === 'linux') assertRetirementMounts(root, source, await readFile('/proc/self/mountinfo', 'utf8'))
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
  const quarantineInfo = await lstat(quarantineRoot)
  if (quarantineInfo.isSymbolicLink() || !quarantineInfo.isDirectory() || quarantineInfo.dev !== info.dev || quarantineInfo.uid !== info.uid
    || await realpath(quarantineRoot) !== quarantineRoot) refuse('APP_RELEASE_RETIREMENT_PATH')
  return { root, source, quarantine }
}
async function verifyRetiringArtifact(directory: string, job: AppReleaseRetirement, row: AppRelease, root: string) {
  const bytes = await readFile(path.join(directory, 'manifest.json'))
  if (artifactDigest(bytes) !== job.artifactSha256 || job.artifactSha256 !== row.artifactSha256) refuse('APP_RELEASE_RETIREMENT_HASH')
  const manifest = appReleaseManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (manifest.id !== row.id || manifest.sourceSha !== row.sourceSha) refuse('APP_RELEASE_RETIREMENT_HASH')
  const expected = manifest.files.map(file => file.path).concat('manifest.json').sort(), actual = await safeTree(directory, root, new Set(expected))
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) refuse('APP_RELEASE_RETIREMENT_EXTRA_FILE')
  for (const file of manifest.files) await readAppReleaseFile({ directory, manifest }, file.path)
}
/** Committed claims fence activation even if the PG connection is lost during filesystem work. */
export async function retireAppReleaseArtifact(releaseId: string) {
  const claimed = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`
    const job = await tx.appReleaseRetirement.findUnique({ where: { releaseId } })
    if (!job || job.state === 'deleted') return null
    if (await tx.appReleaseChannel.findFirst({ where: { releaseId, enabled: true } })) refuse('APP_RELEASE_RETIREMENT_ACTIVE')
    const row = await tx.appRelease.findUniqueOrThrow({ where: { id: releaseId } })
    if (row.artifactSha256 !== job.artifactSha256) refuse('APP_RELEASE_RETIREMENT_HASH')
    if (job.state === 'pending') return { row, job: await tx.appReleaseRetirement.update({ where: { releaseId }, data: { state: 'isolating', errorCode: null } }) }
    if (!['isolating', 'deleting'].includes(job.state)) refuse('APP_RELEASE_RETIREMENT_STATE')
    return { row, job }
  }, { timeout: 30000 })
  if (!claimed) return
  const { job, row } = claimed
  try {
    const { root, source, quarantine } = await retirementPaths(job), original = await stat(source), isolated = await stat(quarantine)
    if (original && isolated) refuse('APP_RELEASE_RETIREMENT_CONFLICT')
    if (job.state !== 'deleting') {
      if (original) { await verifyRetiringArtifact(source, job, row, root); await rename(source, quarantine) }
      if (await stat(quarantine)) await verifyRetiringArtifact(quarantine, job, row, root)
      await prisma.appReleaseRetirement.updateMany({ where: { releaseId, operationId: job.operationId, state: { not: 'deleted' } }, data: { state: 'deleting', errorCode: null } })
    } else if (original) refuse('APP_RELEASE_RETIREMENT_CONFLICT')
    const manifest = appReleaseManifestSchema.parse(row.manifest), allowed = new Set(manifest.files.map(file => file.path).concat('manifest.json'))
    if (await stat(quarantine)) {
      const remaining = await safeTree(quarantine, root, allowed)
      for (const file of remaining) {
        if (file === 'manifest.json') { if (artifactDigest(await readFile(path.join(quarantine, file))) !== job.artifactSha256) refuse('APP_RELEASE_RETIREMENT_HASH') }
        else await readAppReleaseFile({ directory: quarantine, manifest }, file)
      }
      await rm(quarantine, { recursive: true, force: false })
    }
    if (await stat(source) || await stat(quarantine)) refuse('APP_RELEASE_RETIREMENT_INCOMPLETE')
    await prisma.appReleaseRetirement.updateMany({ where: { releaseId, operationId: job.operationId, state: { not: 'deleted' } }, data: { state: 'deleted', errorCode: null, completedAt: new Date() } })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'APP_RELEASE_RETIREMENT_FAILED'
    await prisma.appReleaseRetirement.updateMany({ where: { releaseId, operationId: job.operationId, state: { not: 'deleted' } }, data: { errorCode: code } })
  }
}
export async function runAppReleaseRetention() {
  await prisma.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(804726)`; await planAppReleaseRetention(tx) }, { timeout: 30000 })
  const jobs = await prisma.appReleaseRetirement.findMany({ where: { state: { not: 'deleted' } }, orderBy: { createdAt: 'asc' } })
  for (const job of jobs) await retireAppReleaseArtifact(job.releaseId)
}
let running: Promise<void> | null = null
let workerEnabled = false
export function enableAppReleaseRetention() { workerEnabled = true; scheduleAppReleaseRetention() }
export function scheduleAppReleaseRetention() {
  if (!workerEnabled || process.env.APP_ENV !== 'production' || running) return
  running = runAppReleaseRetention().catch(() => { console.error('[app-release-retention] cleanup needs reconciliation; durable claims retained') }).finally(() => { running = null })
}
