import { expectToolDenied } from '../support/expect-tool-denied.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import app from '../../api/app.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { getAgentAttachmentDirectory, getUploadsRootDirectory, MANAGED_AGENT_ATTACHMENT_PREFIX, readManagedImageDataUrl, storeAgentAttachment } from '../../api/lib/agent-attachment-storage.js'
import { readFileTool, viewImageTool } from '../../api/lib/agent/tools/attachment-tools.js'
import { applyReviewedLegacyAttachment, listLegacyAttachmentReferences } from '../../api/lib/legacy-agent-attachment-grants.js'
import { assertManagedAttachmentsAccess } from '../../api/lib/agent-attachment-storage.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const vision = vi.hoisted(() => vi.fn().mockResolvedValue('fixture description'))
vi.mock('../../api/lib/vision-service.js', () => ({ describeImageWithVision: vision }))
const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const owner = randomUUID(), other = randomUUID()
const files: string[] = []
let ownedUrl = '', imageUrl = ''
const legacyName = `${randomUUID()}.txt`
const legacyUrl = `${MANAGED_AGENT_ATTACHMENT_PREFIX}${legacyName}`
const secret = 'private-fixture-not-for-other-users'
const publicNamespaces = ['avatars', 'profile-covers', 'novel-covers', 'post-images', 'message-images', 'feedback-images']
const publicFilename = `${randomUUID()}.txt`
const novelId = randomUUID(), sessionId = randomUUID(), runId = randomUUID(), messageId = randomUUID()
const review = { url: legacyUrl, ownerUserId: owner, contentSha256: createHash('sha256').update(secret).digest('hex'), evidenceRef: 'fixture-review-ticket', verification: 'operator_verified_ownership' }
const cookie = (userId: string) => `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`
const context = (userId: string): ToolContext => ({ userId, novelId: 'fixture', chapterId: null, sessionId: 'fixture', runId: 'fixture', callId: 'fixture', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal })

afterAll(async () => {
  try {
    if (available) {
      await prisma.$transaction([
        prisma.agentMessage.deleteMany({ where: { runId, sessionId } }),
        prisma.agentRun.deleteMany({ where: { id: runId, userId: other } }),
        prisma.agentSession.deleteMany({ where: { id: sessionId, userId: other } }),
        prisma.novel.deleteMany({ where: { id: novelId, authorId: other } }),
        prisma.user.deleteMany({ where: { id: { in: [owner, other] } } }),
      ])
    }
    for (const file of files) await unlink(file)
  } finally { await prisma.$disconnect() }
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (available) await prisma.legacyAgentAttachmentGrant.deleteMany({ where: { url: legacyUrl } })
})
describe.skipIf(!available)('R05 private attachment access paths', () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [owner, other].map(id => ({ id, nickname: 'attachment-fixture', passwordHash: 'fixture-only' })) })
    const attachment = await storeAgentAttachment({ userId: owner, kind: 'file', name: 'private.txt', dataUrl: `data:text/plain;base64,${Buffer.from(secret).toString('base64')}` })
    ownedUrl = attachment.url
    files.push(path.join(getAgentAttachmentDirectory(), owner, path.basename(ownedUrl)))
    await mkdir(getAgentAttachmentDirectory(), { recursive: true })
    files.push(path.join(getAgentAttachmentDirectory(), legacyName))
    await writeFile(files[1], secret)
    imageUrl = `${MANAGED_AGENT_ATTACHMENT_PREFIX}${owner}/${randomUUID()}.png`
    files.push(path.join(getAgentAttachmentDirectory(), owner, path.basename(imageUrl)))
    await writeFile(files[2], Buffer.from('fixture-image-bytes'))
    for (const namespace of publicNamespaces) {
      const directory = path.join(getUploadsRootDirectory(), namespace)
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, publicFilename)
      await writeFile(file, 'public-static-fixture')
      files.push(file)
    }
    await prisma.novel.create({ data: { id: novelId, authorId: other, title: 'attachment-fixture', slug: randomUUID(), summary: '' } })
    await prisma.agentSession.create({ data: { id: sessionId, userId: other, novelId, title: 'fixture' } })
    await prisma.agentRun.create({ data: { id: runId, userId: other, sessionId, novelId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator' } })
  })
  it('retains the owner URL and requires login', async () => {
    expect((await request(app).get(ownedUrl)).status).toBe(401)
    const res = await request(app).get(ownedUrl).set('Cookie', cookie(owner))
    expect(res.status).toBe(200)
    expect(res.text).toBe(secret)
    expect(res.headers['cache-control']).toContain('no-store')
  })
  it.each(publicNamespaces)('preserves the existing static namespace %s and its caching policy', async namespace => {
    const res = await request(app).get(`/api/uploads/${namespace}/${publicFilename}`)
    expect(res.status).toBe(200)
    expect(res.text).toBe('public-static-fixture')
    expect(res.headers['cache-control']).toContain('immutable')
  })
  it('denies another owner even when the URL is known', async () => {
    expect((await request(app).get(ownedUrl).set('Cookie', cookie(other))).status).toBe(403)
  })
  it('does not use login alone as ownership proof for an unresolved legacy file', async () => {
    expect((await request(app).get(legacyUrl).set('Cookie', cookie(other))).status).toBe(403)
  })
  it.each(['%61gent-attachments', 'AGENT-ATTACHMENTS', 'agent-attachments%2f', 'agent-attachments.', 'agent-attachments%20', 'avatars/..%2fagent-attachments', 'AGENT-~1'])('does not fall through to public static files via %s', async prefix => {
    const url = `/api/uploads/${prefix}/${owner}/${path.basename(ownedUrl)}`
    const response = await request(app).get(url)
    expect(response.status).not.toBe(200)
    expect(response.text).not.toContain(secret)
  })
  it('does not let read_file read another user file', async () => {
    await expectToolDenied(readFileTool.execute(context(other), { url: ownedUrl }), { code: 'FORBIDDEN' })
  })
  it('does not send another user image to the vision provider', async () => {
    await expectToolDenied(viewImageTool.execute(context(other), { url: imageUrl }), { code: 'FORBIDDEN' })
    expect(vision).not.toHaveBeenCalled()
  })
  it('does not load another user image into main-model inputs', async () => {
    await expect(readManagedImageDataUrl(imageUrl, other)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('preserves owned tool reads and main-model image loading', async () => {
    expect((await readFileTool.execute(context(owner), { url: ownedUrl })).output).toContain(secret)
    expect(await readManagedImageDataUrl(imageUrl, owner)).toMatch(/^data:image\/png;base64,/)
  })
  it('rejects forged attachment lists before run or queue admission', async () => {
    await expect(assertManagedAttachmentsAccess([{ url: ownedUrl }], other)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(assertManagedAttachmentsAccess([{ url: legacyUrl }], other)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(assertManagedAttachmentsAccess([{ url: ownedUrl }], owner)).resolves.toBeUndefined()
  })
  it('restores only the verified owner through the original legacy URL and is idempotent', async () => {
    const grant = await applyReviewedLegacyAttachment(review, 'fixture-operator')
    expect(await applyReviewedLegacyAttachment(review, 'second-replay-operator')).toEqual(grant)
    const response = await request(app).get(legacyUrl).set('Cookie', cookie(owner))
    expect(response.status).toBe(200)
    expect(response.text).toBe(secret)
    expect((await request(app).get(legacyUrl).set('Cookie', cookie(other))).status).toBe(403)
    expect((await readFileTool.execute(context(owner), { url: legacyUrl })).output).toContain(secret)
  })
  it('does not overwrite an existing owner or reactivate revoked grants', async () => {
    await applyReviewedLegacyAttachment(review, 'fixture-operator')
    await expect(applyReviewedLegacyAttachment({ ...review, ownerUserId: other }, 'fixture-operator')).rejects.toMatchObject({ code: 'ATTACHMENT_GRANT_CONFLICT' })
    await prisma.legacyAgentAttachmentGrant.update({ where: { url: legacyUrl }, data: { revokedAt: new Date() } })
    expect((await request(app).get(legacyUrl).set('Cookie', cookie(owner))).status).toBe(403)
    await expect(applyReviewedLegacyAttachment(review, 'fixture-operator')).rejects.toMatchObject({ code: 'ATTACHMENT_GRANT_CONFLICT' })
  })
  it('rejects mismatched files at approval and on later read without deleting them', async () => {
    await expect(applyReviewedLegacyAttachment({ ...review, contentSha256: '0'.repeat(64) }, 'fixture-operator')).rejects.toMatchObject({ code: 'ATTACHMENT_CHANGED' })
    await applyReviewedLegacyAttachment(review, 'fixture-operator')
    await writeFile(files[1], 'changed-private-fixture')
    try {
      expect((await request(app).get(legacyUrl).set('Cookie', cookie(owner))).status).toBe(409)
    } finally { await writeFile(files[1], secret) }
  })
  it('never auto-grants ownership from a persisted message reference', async () => {
    await prisma.agentMessage.create({ data: { id: messageId, sessionId, runId, role: 'user', parts: [{ type: 'attachment', kind: 'file', name: 'claimed.txt', url: legacyUrl }] } })
    const refs = await listLegacyAttachmentReferences()
    expect(refs).toContainEqual({ messageId, userId: other, url: legacyUrl })
    expect(await prisma.legacyAgentAttachmentGrant.findUnique({ where: { url: legacyUrl } })).toBeNull()
    expect((await request(app).get(legacyUrl).set('Cookie', cookie(other))).status).toBe(403)
    expect(await listLegacyAttachmentReferences(messageId)).not.toContainEqual({ messageId, userId: other, url: legacyUrl })
  })
  it('fails closed with no-store and no cookie clearing when legacy authorization is unavailable', async () => {
    vi.spyOn(prisma.legacyAgentAttachmentGrant, 'findUnique').mockRejectedValueOnce(new Error('private database internals'))
    const response = await request(app).get(legacyUrl).set('Cookie', cookie(owner))
    expect(response.status).toBe(503)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.text).not.toContain('database internals')
  })
  it('authorizes HEAD and conditional requests instead of bypassing permissions', async () => {
    expect((await request(app).head(ownedUrl).set('Cookie', cookie(owner))).status).toBe(200)
    expect((await request(app).head(ownedUrl).set('Cookie', cookie(other))).status).toBe(403)
    expect((await request(app).get(ownedUrl).set('If-None-Match', '*').set('Cookie', cookie(other))).status).toBe(403)
  })
  it('preserves authorized byte ranges without exposing them to another user', async () => {
    const response = await request(app).get(ownedUrl).set('Cookie', cookie(owner)).set('Range', 'bytes=0-6')
    expect(response.status).toBe(206)
    expect(response.text).toBe(secret.slice(0, 7))
    expect(response.headers['content-range']).toBe(`bytes 0-6/${Buffer.byteLength(secret)}`)
    expect((await request(app).get(ownedUrl).set('Cookie', cookie(other)).set('Range', 'bytes=0-6')).status).toBe(403)
    expect((await request(app).get(ownedUrl).set('Cookie', cookie(owner)).set('Range', 'bytes=99999-')).status).toBe(416)
    const changed = await request(app).get(ownedUrl).set('Cookie', cookie(owner)).set('Range', 'bytes=0-6').set('If-Range', '"different"')
    expect(changed.status).toBe(200)
    expect(changed.text).toBe(secret)
  })
})
