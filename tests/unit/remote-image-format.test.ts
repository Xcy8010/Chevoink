import { afterEach, describe, expect, it, vi } from 'vitest'
import { viewImageTool } from '../../api/lib/agent/tools/attachment-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ download: vi.fn(), vision: vi.fn() }))
vi.mock('../../api/lib/public-http.js', () => ({ getPublicHttpBytes: mocks.download }))
vi.mock('../../api/lib/vision-service.js', () => ({ describeImageWithVision: mocks.vision }))
const context = (signal = new AbortController().signal): ToolContext => ({
  userId: 'fixture', novelId: 'fixture', sessionId: 'fixture', runId: 'fixture',
  chapterId: null, callId: 'fixture', mode: 'build', creativeFreedom: 'balanced',
  qualityMode: 'premium', emit: vi.fn(), signal,
})
afterEach(() => { mocks.download.mockReset(); mocks.vision.mockReset() })

describe('remote image bytes and model handoff', () => {
  it.each([
    { mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) },
    { mime: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 224]) },
    { mime: 'image/webp', bytes: Buffer.from('RIFF1234WEBP1234') },
  ])('uses the $mime signature, not a misleading header', async ({ mime, bytes }) => {
    mocks.download.mockResolvedValue({ bytes, contentType: 'text/plain' })
    mocks.vision.mockResolvedValue('fixture description')
    const ctx = context()
    const result = await viewImageTool.execute(ctx, { url: 'https://example.com/file' })
    expect(result.output).toContain('fixture description')
    expect(mocks.vision).toHaveBeenCalledWith({ buffer: bytes, mime }, expect.any(String), {
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, signal: ctx.signal, modelAssignments: undefined,
    })
  })
  it('does not send HTML disguised as a PNG to a paid model', async () => {
    mocks.download.mockResolvedValue({ bytes: Buffer.from('<html>access denied</html>'), contentType: 'image/png' })
    const result = await viewImageTool.execute(context(), { url: 'https://example.com/file.png' })
    expect(result.output).toContain('失败')
    expect(mocks.vision).not.toHaveBeenCalled()
  })
  it('does not call vision when stopped immediately after the download', async () => {
    const controller = new AbortController()
    mocks.download.mockImplementation(async () => {
      controller.abort(new Error('fixture stopped'))
      return { bytes: Buffer.from([255, 216, 255, 224]), contentType: 'image/jpeg' }
    })
    await expect(viewImageTool.execute(context(controller.signal), { url: 'https://example.com/file.jpg' })).rejects.toThrow('fixture stopped')
    expect(mocks.vision).not.toHaveBeenCalled()
    expect(mocks.download).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal, maxBytes: 8 * 1024 * 1024, timeoutMs: 60000 }))
  })
})
