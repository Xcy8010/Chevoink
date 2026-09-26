import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({
  novelFindFirst: vi.fn(),
  messageFindFirst: vi.fn(),
  readAttachment: vi.fn(),
  storeCover: vi.fn(),
  recoverCover: vi.fn(),
  coverAssetFindFirst: vi.fn(),
  txNovelFindFirst: vi.fn(),
  txCoverAssetUpsert: vi.fn(),
  txCoverAssetFindFirst: vi.fn(),
  txCoverAssetUpdate: vi.fn(),
  txNovelUpdate: vi.fn(),
}))

vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message)
    }
  },
  prisma: {
    novel: { findFirst: mocks.novelFindFirst },
    agentMessage: { findFirst: mocks.messageFindFirst },
    coverAsset: { findFirst: mocks.coverAssetFindFirst },
  },
}))
vi.mock('../../api/lib/agent-attachment-storage.js', () => ({ readAuthorizedAgentAttachment: mocks.readAttachment }))
vi.mock('../../api/lib/novel-cover-storage.js', () => ({ storeImportedNovelCoverDataUrl: mocks.storeCover }))
vi.mock('../../api/lib/data-access.js', () => ({ recoverCoverAssetStorageData: mocks.recoverCover }))

import { prepareAttachmentCover } from '../../api/lib/agent/tools/attachment-cover.js'
import { applyCoverSelection, prepareCoverSelection } from '../../api/lib/agent/tools/cover-application.js'

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  userId: 'user-1',
  novelId: 'novel-1',
  runId: 'run-1',
  sessionId: 'session-1',
  chapterId: null,
  callId: 'call-1',
  mode: 'build',
  creativeFreedom: 'stable',
  qualityMode: 'premium',
  signal: new AbortController().signal,
  emit: vi.fn(),
  ...overrides,
})

const attachmentUrl = '/api/uploads/agent-attachments/user-1/upload.webp'
const otherWindowUrl = '/api/uploads/agent-attachments/user-1/other-window.webp'
const makeMessagePart = (url: string) => ({ id: 'message-1', parts: [{ type: 'attachment', kind: 'image', url }] })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.novelFindFirst.mockResolvedValue({ id: 'novel-1' })
  mocks.messageFindFirst.mockResolvedValue(makeMessagePart(attachmentUrl))
  mocks.readAttachment.mockImplementation(async (url: string) => {
    if (!url.startsWith('/api/uploads/agent-attachments/user-1/')) {
      throw Object.assign(new Error('附件不存在或不属于当前用户'), { code: 'FORBIDDEN', status: 403 })
    }
    return sharp({ create: { width: 2, height: 2, channels: 4, background: '#40a0ff' } }).webp().toBuffer()
  })
  mocks.storeCover.mockResolvedValue('/api/uploads/novel-covers/imported.png')
  mocks.recoverCover.mockResolvedValue({ id: 'asset-1', imageUrl: '/api/uploads/novel-covers/asset-1.png' })
  mocks.coverAssetFindFirst.mockResolvedValue({ id: 'asset-1' })
  mocks.txNovelFindFirst.mockResolvedValue({ title: '作品一', coverAssetId: 'old-asset' })
  mocks.txCoverAssetUpsert.mockResolvedValue(undefined)
  mocks.txCoverAssetFindFirst.mockResolvedValue({ id: 'asset-1', imageUrl: '/api/uploads/novel-covers/asset-1.png' })
  mocks.txCoverAssetUpdate.mockResolvedValue(undefined)
  mocks.txNovelUpdate.mockResolvedValue(undefined)
})

describe('agent attachment cover safety', () => {
  it('validates current novel and message attachment ownership, then converts WebP in memory and uploads without generation', async () => {
    const result = await prepareAttachmentCover(context(), attachmentUrl)

    expect(mocks.novelFindFirst).toHaveBeenCalledWith({ where: { id: 'novel-1', authorId: 'user-1' }, select: { id: true } })
    expect(mocks.messageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sessionId: 'session-1',
        role: 'user',
        parts: { array_contains: [{ type: 'attachment', kind: 'image', url: attachmentUrl }] },
      }),
      select: { id: true },
    }))
    expect(mocks.readAttachment).toHaveBeenCalledWith(attachmentUrl, 'user-1')
    expect(mocks.storeCover).toHaveBeenCalledOnce()
    const dataUrl = mocks.storeCover.mock.calls[0][0] as string
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata()).toMatchObject({ format: 'png', width: 900, height: 1200 })
    expect(result).toMatchObject({ imageUrl: '/api/uploads/novel-covers/imported.png', width: 900, height: 1200 })
  })

  it('rejects a forged URL even when it is not a managed user attachment', async () => {
    const forgedUrl = 'https://attacker.example/cover.webp'
    mocks.messageFindFirst.mockResolvedValue(makeMessagePart(forgedUrl))

    await expect(prepareAttachmentCover(context(), forgedUrl)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(mocks.storeCover).not.toHaveBeenCalled()
  })

  it('rejects an attachment from another task window', async () => {
    mocks.messageFindFirst.mockResolvedValue(null)

    await expect(prepareAttachmentCover(context(), otherWindowUrl)).rejects.toMatchObject({ code: 'COVER_ATTACHMENT_SCOPE' })
    expect(mocks.readAttachment).not.toHaveBeenCalled()
  })

  it('does not upload after cancellation and does not create a cover asset', async () => {
    const controller = new AbortController()
    mocks.readAttachment.mockImplementationOnce(async () => {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#40a0ff' } }).webp().toBuffer()
      controller.abort()
      return bytes
    })

    await expect(prepareAttachmentCover(context({ signal: controller.signal }), attachmentUrl)).rejects.toThrow()
    expect(mocks.storeCover).not.toHaveBeenCalled()
  })

  it('rechecks generated asset ownership before applying it', async () => {
    mocks.txCoverAssetFindFirst.mockResolvedValue(null)
    const tx = {
      novel: { findFirst: mocks.txNovelFindFirst, update: mocks.txNovelUpdate },
      coverAsset: { upsert: mocks.txCoverAssetUpsert, findFirst: mocks.txCoverAssetFindFirst, update: mocks.txCoverAssetUpdate },
    } as never

    await expect(applyCoverSelection(context(), { id: 'asset-1', imageUrl: '/api/uploads/novel-covers/asset-1.png' }, tx))
      .rejects.toMatchObject({ status: 409, code: 'COVER_ASSET_NOT_FOUND' })
    expect(mocks.txCoverAssetFindFirst).toHaveBeenCalledWith({
      where: { id: 'asset-1', ownerUserId: 'user-1', OR: [{ novelId: 'novel-1' }, { novelId: null }] },
      select: { id: true, imageUrl: true },
    })
    expect(mocks.txCoverAssetUpdate).not.toHaveBeenCalled()
    expect(mocks.txNovelUpdate).not.toHaveBeenCalled()
  })

  it('cancels before application writes', async () => {
    const controller = new AbortController()
    mocks.txCoverAssetFindFirst.mockImplementationOnce(async () => {
      controller.abort()
      return { id: 'asset-1', imageUrl: '/api/uploads/novel-covers/asset-1.png' }
    })
    const tx = {
      novel: { findFirst: mocks.txNovelFindFirst, update: mocks.txNovelUpdate },
      coverAsset: { upsert: mocks.txCoverAssetUpsert, findFirst: mocks.txCoverAssetFindFirst, update: mocks.txCoverAssetUpdate },
    } as never

    await expect(applyCoverSelection(context({ signal: controller.signal }), { id: 'asset-1', imageUrl: '/api/uploads/novel-covers/asset-1.png' }, tx))
      .rejects.toThrow()
    expect(mocks.txCoverAssetUpdate).not.toHaveBeenCalled()
    expect(mocks.txNovelUpdate).not.toHaveBeenCalled()
  })

  it('routes an attachment selection through source preparation and avoids candidate lookup', async () => {
    const result = await prepareCoverSelection(context(), { attachmentUrl })

    expect(mocks.readAttachment).toHaveBeenCalledWith(attachmentUrl, 'user-1')
    expect(mocks.storeCover).toHaveBeenCalledOnce()
    expect(mocks.coverAssetFindFirst).not.toHaveBeenCalled()
    expect(result).toEqual({ id: expect.any(String), imageUrl: '/api/uploads/novel-covers/imported.png', upload: { width: 900, height: 1200 } })
  })
})
