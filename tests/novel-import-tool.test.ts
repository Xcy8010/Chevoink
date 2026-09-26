import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../api/lib/agent/tools/types.js'

const { db } = vi.hoisted(() => ({ db: {
  novel: { findFirst: vi.fn() }, agentRun: { findFirst: vi.fn() },
  agentMessage: { findFirst: vi.fn() }, legacyAgentAttachmentGrant: { findUnique: vi.fn() },
  novelImportJob: { findFirst: vi.fn() },
} }))
vi.mock('../api/lib/prisma.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/lib/prisma.js')>()
  return { ...actual, prisma: db }
})
const { status } = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock('../api/lib/novel-import-service.js', () => ({ getNovelImportStatus: status }))
import { assertOriginalImportAttachment, novelImportTool } from '../api/lib/agent/tools/import-tools.js'

const url = '/api/uploads/agent-attachments/owner/file.txt'
const context = (): ToolContext => ({ userId: 'owner', novelId: 'book', runId: 'run', sessionId: 'session',
  chapterId: null, callId: 'call', mode: 'build', creativeFreedom: 'stable', qualityMode: 'premium',
  signal: new AbortController().signal, emit: vi.fn() })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
  db.novel.findFirst.mockResolvedValue({ id: 'book' })
  db.agentRun.findFirst.mockResolvedValue({ id: 'run' })
  db.agentMessage.findFirst.mockResolvedValue({ parts: [{ type: 'attachment', kind: 'file', name: '原文.txt', url }] })
  db.legacyAgentAttachmentGrant.findUnique.mockResolvedValue(null)
})
afterEach(() => vi.unstubAllEnvs())

describe('Agent import is a verified human handoff, not implicit write approval', () => {
  it('is unavailable by default and makes no reads when disabled', async () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', '')
    await expect(novelImportTool.execute(context(), { action: 'prepare', attachmentUrl: url }))
      .rejects.toMatchObject({ code: 'IMPORT_NOT_ENABLED' })
    expect(db.novel.findFirst).not.toHaveBeenCalled()
  })
  it('verifies original run and prepares an ordinary human import without a write exemption', async () => {
    expect(await assertOriginalImportAttachment(context(), url)).toMatchObject({ url })
    expect(db.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'run', userId: 'owner', novelId: 'book', sessionId: 'session',
    } }))
    const result = await novelImportTool.execute(context(), { action: 'prepare', attachmentUrl: url })
    expect(result.output).toContain('尚未写入作品')
    expect(result.output).toContain('importRunId=run')
    expect(result.output).toContain(encodeURIComponent(url))
    expect(result.output).not.toContain('importCallId')
    await expect(novelImportTool.execute(context(), { action: 'commit', jobId: '77777777-7777-4777-8777-777777777777' })).rejects.toMatchObject({ code: 'IMPORT_DURABLE_RUNTIME_REQUIRED' })
    expect(novelImportTool.readOnly).toBe(false)
    expect(novelImportTool.dangerous).toBe(true)
  })
  it('does not accept a model-created commit or confirmation boolean', () => {
    expect(novelImportTool.parameters.safeParse({ action: 'commit', jobId: 'x', confirmed: true }).success).toBe(false)
    expect(novelImportTool.parameters.safeParse({ action: 'prepare', attachmentUrl: url, confirmed: true }).success).toBe(false)
    const jobId = '77777777-7777-4777-8777-777777777777'
    expect(novelImportTool.parameters.safeParse({ action: 'commit', jobId }).success).toBe(true)
    for (const extra of [{ approvalId: jobId }, { idempotencyKey: 'model-key' }, { allow: true }, { overwrite: true }]) {
      expect(novelImportTool.parameters.safeParse({ action: 'commit', jobId, ...extra }).success).toBe(false)
    }
  })
  it.each(['https://example.com/book.txt', '/api/uploads/agent-attachments/other/book.txt',
    '/api/uploads/agent-attachments/owner/../other/book.txt'])('rejects unprovided or foreign source %s', async source => {
    await expect(assertOriginalImportAttachment(context(), source))
      .rejects.toMatchObject({ code: 'IMPORT_ATTACHMENT_SCOPE' })
  })
  it('does not accept an attachment merely because it appears in a tool/assistant message', async () => {
    db.agentMessage.findFirst.mockResolvedValue({ parts: [{ type: 'text', text: url }] })
    await expect(assertOriginalImportAttachment(context(), url))
      .rejects.toMatchObject({ code: 'IMPORT_ATTACHMENT_SCOPE' })
    expect(db.agentMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      runId: 'run', sessionId: 'session', role: 'user',
    } }))
  })
  it('fails closed for an absent current work', async () => {
    db.novel.findFirst.mockResolvedValue(null)
    await expect(novelImportTool.execute(context(), { action: 'prepare', attachmentUrl: url }))
      .rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
  })
  it('requires independent grants for legacy attachments', async () => {
    const legacy = '/api/uploads/agent-attachments/legacy.txt'
    db.agentMessage.findFirst.mockResolvedValue({ parts: [{ type: 'attachment', kind: 'file', name: '书.txt', url: legacy }] })
    await expect(assertOriginalImportAttachment(context(), legacy))
      .rejects.toMatchObject({ code: 'IMPORT_ATTACHMENT_SCOPE' })
  })
  it('status always scopes to owner and work and does not expose source text', async () => {
    const jobId = '77777777-7777-4777-8777-777777777777'
    status.mockResolvedValue({ jobId, status: 'ready', errorCode: null, receipt: null })
    const result = await novelImportTool.execute(context(), { action: 'status', jobId })
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', novelId: 'book' }), jobId)
    expect(result.output).toContain('尚未确认提交完成')
    expect(result.output).not.toContain('storageKey')
  })
  it('keeps scoped history readable when import is disabled and requires a success receipt', async () => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', '')
    const jobId = '77777777-7777-4777-8777-777777777777'
    status.mockResolvedValue({ jobId, status: 'succeeded', errorCode: null, receipt: null })
    expect((await novelImportTool.execute(context(), { action: 'status', jobId })).output).toContain('尚未确认提交完成')
  })
  it('a cancelled execution cannot prepare a handoff', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(novelImportTool.execute({ ...context(), signal: abort.signal }, { action: 'prepare', attachmentUrl: url })).rejects.toThrow()
    expect(db.novel.findFirst).not.toHaveBeenCalled()
  })
})
