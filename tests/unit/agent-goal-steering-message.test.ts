import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartAgentLoopRunRequest } from '../../shared/contracts/index.js'

const readImage = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/agent-attachment-storage.js', () => ({ readManagedImageDataUrl: readImage }))
import { buildGoalSteeringMessage } from '../../api/lib/agent/goal-steering-message.js'

const input: StartAgentLoopRunRequest = { novelId: 'novel', sessionId: 'session', mode: 'build', prompt: '采用这张新的参考图',
  attachments: [{ kind: 'image', name: '新图片.png', url: '/api/uploads/agent/new.png', size: 10 }] }

describe('goal author steering attachments', () => {
  beforeEach(() => { readImage.mockReset() })
  it('sends the new authorized image bytes with the new author message', async () => {
    readImage.mockResolvedValue('data:image/png;base64,new-image')
    expect(await buildGoalSteeringMessage(input, 'owner', true)).toMatchObject({ role: 'user', content: [
      { type: 'text', text: expect.stringContaining(input.prompt) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,new-image' } },
    ] })
    expect(readImage).toHaveBeenCalledExactlyOnceWith(input.attachments![0].url, 'owner')
  })
  it('uses the existing authorized view_image path for a text-only model', async () => {
    const message = await buildGoalSteeringMessage(input, 'owner', false)
    expect(message.content).toEqual(expect.stringContaining('先调用 view_image'))
    expect(message.content).toEqual(expect.stringContaining(input.attachments![0].url))
    expect(readImage).not.toHaveBeenCalled()
  })
  it('preserves selections and file references without treating file content as authority', async () => {
    const message = await buildGoalSteeringMessage({ ...input, selection: { text: '选中的段落' },
      attachments: [{ kind: 'file', name: '参考.txt', url: '/api/uploads/agent/new.txt' }] }, 'owner', true)
    expect(message.content).toEqual(expect.stringContaining('选中的段落'))
    expect(message.content).toEqual(expect.stringContaining('read_file'))
    expect(readImage).not.toHaveBeenCalled()
  })
  it('does not silently drop missing images on a vision model', async () => {
    readImage.mockResolvedValue(null)
    await expect(buildGoalSteeringMessage(input, 'owner', true)).rejects.toMatchObject({ code: 'GOAL_ATTACHMENT_UNAVAILABLE' })
  })
})
