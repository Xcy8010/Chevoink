import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
const mocks = vi.hoisted(() => ({ owned: vi.fn(), readFile: vi.fn(), describe: vi.fn() }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readFile: mocks.readFile }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: { coverAsset: { findFirst: mocks.owned } } }))
vi.mock('../../api/lib/vision-service.js', () => ({ describeImageWithVision: mocks.describe }))
import { viewImageTool } from '../../api/lib/agent/tools/attachment-tools.js'

const ctx: ToolContext = { userId: 'author', novelId: 'novel', sessionId: 'session', runId: 'run', chapterId: null, callId: 'call',
  mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
beforeEach(() => { vi.resetAllMocks(); mocks.readFile.mockResolvedValue(Buffer.from('original-image')); mocks.describe.mockResolvedValue('实际图片描述') })
describe('managed cover viewing ownership', () => {
  it('refuses a guessed managed path before local IO or a vision request', async () => {
    mocks.owned.mockResolvedValue(null)
    expect(await viewImageTool.execute(ctx, { url: '/api/uploads/novel-covers/other.png' })).toMatchObject({ outcome: 'failed' })
    expect(mocks.owned).toHaveBeenCalledWith({ where: { imageUrl: '/api/uploads/novel-covers/other.png', ownerUserId: 'author' }, select: { id: true } })
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.describe).not.toHaveBeenCalled()
  })
  it.each(['url', 'assetId'] as const)('retains owned %s viewing and passes actual bytes to vision', async source => {
    mocks.owned.mockImplementation(async (query: { where: { id?: string } }) => query.where.id
      ? { id: 'original-asset', imageUrl: '/api/uploads/novel-covers/original.png' } : { id: 'original-asset' })
    const result = await viewImageTool.execute(ctx, { url: source === 'url' ? '/api/uploads/novel-covers/original.png' : 'original-asset' })
    expect(result).toMatchObject({ display: { kind: 'viewedImage', images: [{ url: '/api/uploads/novel-covers/original.png' }] } })
    expect(mocks.describe).toHaveBeenCalledWith({ buffer: Buffer.from('original-image'), mime: 'image/png' }, expect.any(String), expect.objectContaining({ userId: 'author' }))
    expect(mocks.readFile).toHaveBeenCalledOnce()
  })
})
