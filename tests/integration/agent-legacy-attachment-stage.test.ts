import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import { storeAgentAttachment, resolveManagedAttachmentPath } from '../../api/lib/agent-attachment-storage.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { readLegacyAttachmentResumeNote } from '../../api/lib/agent/legacy-attachment-resume.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import * as titles from '../../api/lib/agent/session-title.js'
import { prisma } from '../../api/lib/prisma.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

const files: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(files.splice(0).map(file => rm(file, { force: true }))) })

describe.runIf(available)('long attachment through the admitted legacy loop', () => {
  it.each(['continue', 'direct answer', 'repeat explicit opening', 'exhausted budget'] as const)('respects attachment receipts through author continue: %s', async scenario => fixture(async f => {
    const novel = await prisma.novel.create({ data: { authorId: f.userId, title: '离线附件测试', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: novel.id, title: '阅读原稿' } })
    const runId = randomUUID()
    const prompt = scenario === 'repeat explicit opening' ? '请通读整份附件，再核对开头船的停泊地。' : '请通读整份附件。'
    const tokenBudget = scenario === 'exhausted budget' ? 100_000 : undefined
    const body = '船在北岸靠泊。'.repeat(3500)
    const attachment = await storeAgentAttachment({ userId: f.userId, kind: 'file', name: '长稿.txt',
      dataUrl: 'data:application/octet-stream;base64,' + Buffer.from(body).toString('base64') })
    files.push(resolveManagedAttachmentPath(attachment.url)!)
    const subject = { runId, novelId: novel.id, sessionId: session.id, userId: f.userId, chapterId: null }
    await prisma.agentRun.create({ data: { id: runId, novelId: novel.id, sessionId: session.id, userId: f.userId,
      status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
      runtimeProtocolVersion: 0, manuscriptRevision: novel.manuscriptRevision, modelTier: 'speed',
      // The legacy persisted-start schema owns internal limits. Public HTTP
      // admission strips this field, exactly as it does for real users.
      startRequest: { ...withHumanAdmission({ prompt, mode: 'build', sessionId: session.id, novelId: novel.id, attachments: [attachment] }),
        ...(tokenBudget ? { tokenBudget } : {}) } } })
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live network is forbidden'))
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 0, provider: 'fixture',
      modelName: 'fixture-main', baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high',
      reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: 128000, maxOutputTokens: 4096 })
    const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, promptCacheHitTokens: null, promptCacheMissTokens: null }
    let turn = 0
    const chat = vi.spyOn(ai, 'chatWithTools').mockImplementation(async request => {
      if (++turn === 1) return { finishReason: 'tool_calls', usage, content: '', reasoning: '',
        toolCalls: [0, 6000, 12000, 18000].map(offset => ({ id: 'page-' + offset, name: 'read_file', arguments: JSON.stringify({ url: attachment.url, offset }) })) }
      if (turn === 2) {
        expect(request.tools).toEqual([])
        expect(JSON.stringify(request.messages)).toContain('船在北岸靠泊')
        // The mock provider's final authoritative usage can reach the original
        // ceiling. The real continue entry must preserve it without a new call.
        const observed = tokenBudget ? { ...usage, promptTokens: tokenBudget - usage.totalTokens - 20, totalTokens: tokenBudget - usage.totalTokens } : usage
        return { finishReason: 'stop', usage: observed, content: '已读片段反复描写船在北岸靠泊。', reasoning: '', toolCalls: [] }
      }
      if (turn === 3) {
        expect(JSON.stringify(request.messages)).toContain('offset=18000')
        if (scenario === 'exhausted budget') throw Error('exhausted run issued another provider request')
        if (scenario === 'direct answer') return { finishReason: 'stop', usage, content: '我已经读完了整份附件。', reasoning: '', toolCalls: [] }
        const offsets = scenario === 'repeat explicit opening' ? [0, 0, 0] : [0, 24000]
        return { finishReason: 'tool_calls', usage, content: '', reasoning: '',
          toolCalls: offsets.map((offset, index) => ({ id: 'continued-' + index, name: 'read_file', arguments: JSON.stringify({ url: attachment.url, offset }) })) }
      }
      if (scenario !== 'continue' || turn > 4) throw Error('unexpected extra paid turn')
      expect(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'continued-0')?.content).toContain('[18000,24000)')
      expect(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'continued-1')?.content).toContain('已到提取文字末尾')
      return { finishReason: 'stop', usage, content: '船在北岸靠泊。', reasoning: '', toolCalls: [] }
    })
    await executeAgentRun({ ...subject, prompt, attachments: [attachment], mode: 'build', modelTier: 'speed', tokenBudget })
    expect(chat).toHaveBeenCalledTimes(2)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('paused')
    expect(run.usage).toMatchObject({ totalTokens: tokenBudget ?? 240 })
    const reads = await prisma.agentRunEvent.count({ where: { runId, type: 'tool.result', payload: { path: ['toolName'], equals: 'read_file' } } })
    expect(reads).toBe(3)
    const saved = await prisma.agentMessage.findMany({ where: { runId, role: 'assistant' }, orderBy: { createdAt: 'asc' } })
    expect(JSON.stringify(saved.at(-1)?.parts)).toContain('已读片段反复描写')
    const resume = await readLegacyAttachmentResumeNote(runId, [attachment], run.errorMessage)
    expect(resume?.note).toContain('offset=18000')
    expect(resume?.coverage).toEqual([{ url: attachment.url, total: body.length, spans: [{ start: 0, end: 18_000 }] }])
    vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
    expect(await continueLoopRun(f.userId, runId)).toMatchObject({ runId, status: 'running' })
    await vi.waitFor(async () => {
      expect(await prisma.agentRunEvent.count({ where: { runId, type: 'run.started' } })).toBe(2)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(scenario === 'continue' ? 'completed' : 'paused')
    }, { timeout: 10000, interval: 25 })
    expect(chat).toHaveBeenCalledTimes(scenario === 'continue' ? 4 : scenario === 'exhausted budget' ? 2 : 3)
    const readCount = await prisma.agentRunEvent.count({ where: { runId, type: 'tool.result', payload: { path: ['toolName'], equals: 'read_file' } } })
    expect(readCount).toBe(scenario === 'continue' ? 5 : scenario === 'repeat explicit opening' ? 4 : 3)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).usage).toMatchObject({ totalTokens: tokenBudget ?? (scenario === 'continue' ? 480 : 360) })
    const final = await prisma.agentMessage.findFirstOrThrow({ where: { runId, role: 'assistant' }, orderBy: { createdAt: 'desc' } })
    const text = JSON.stringify(final.parts)
    if (scenario !== 'continue') expect(text).toContain('offset=18000')
    if (scenario === 'direct answer') expect(text).not.toContain('我已经读完')
    if (scenario === 'exhausted budget') expect(text).toContain('额度不足')
    if (scenario === 'repeat explicit opening') expect(text).toContain('原文片段')
  }))
})
