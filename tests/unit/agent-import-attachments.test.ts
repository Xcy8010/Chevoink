import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_FILE_ACCEPT, MAX_AGENT_FILE_BYTES_DOC } from '../../shared/contracts/agent-attachments.js'
import { validateAgentFile } from '../../src/features/studio/agent/agent-attachments.js'
import { resolveManagedAttachmentPath, storeAgentAttachment } from '../../api/lib/agent-attachment-storage.js'
import { readFileTool } from '../../api/lib/agent/tools/attachment-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const files: string[] = []
afterEach(async () => { await Promise.all(files.splice(0).map(file => rm(file, { force: true }))) })
const userId = `import-attachment-${randomUUID()}`
const context = (): ToolContext => ({ userId, novelId: 'book', runId: 'run', sessionId: 'session', chapterId: null,
  callId: 'call', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium', signal: new AbortController().signal, emit: vi.fn() })

describe('chat import-only attachment channel', () => {
  it.each(['zip', 'doc'])('allows %s in the same picker and frontend limits', extension => {
    expect(AGENT_FILE_ACCEPT.split(',')).toContain(`.${extension}`)
    expect(validateAgentFile({ name: `原稿.${extension}`, size: 12 } as File)).toBeNull()
    expect(validateAgentFile({ name: `原稿.${extension}`, size: 0 } as File)).toContain('不能为空')
    expect(validateAgentFile({ name: `原稿.${extension}`, size: MAX_AGENT_FILE_BYTES_DOC + 1 } as File)).toContain('5MB')
  })
  it.each([
    ['zip', '504b0304'], ['zip', '504b0506'], ['doc', 'd0cf11e0a1b11ae1'],
  ])('stores %s opaque bytes under the owner without invoking native parsing', async (extension, magic) => {
    const bytes = Buffer.concat([Buffer.from(magic, 'hex'), Buffer.alloc(32)])
    const attachment = await storeAgentAttachment({ userId, kind: 'file', name: `原稿.${extension}`,
      dataUrl: `data:application/octet-stream;base64,${bytes.toString('base64')}` })
    const diskPath = resolveManagedAttachmentPath(attachment.url)!
    files.push(diskPath)
    expect(attachment.url).toContain(`/agent-attachments/${userId}/`)
    expect(await readFile(diskPath)).toEqual(bytes)
    const result = await readFileTool.execute(context(), { url: attachment.url })
    expect(result.outcome).toBe('failed')
    expect(result.output).toContain('novel_import prepare')
    expect(result.output).toContain('未解压、未转换、未导入')
  })
  it.each(['zip', 'doc', 'exe'])('rejects fake/unsupported %s server side', async extension => {
    await expect(storeAgentAttachment({ userId, kind: 'file', name: `fake.${extension}`,
      dataUrl: `data:application/octet-stream;base64,${Buffer.from('not a container').toString('base64')}` }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
