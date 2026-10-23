import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import * as attachments from '../../api/lib/agent-attachment-storage.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { bulkReplacePreviewTool, entityRenamePreviewTool, changeSetApplyTool, changeSetRollbackTool } from '../../api/lib/agent/tools/changeset-tools.js'
import { novelCreateTool, novelPublishTool, novelArchiveTool } from '../../api/lib/agent/tools/novel-tools.js'
import { readFileTool } from '../../api/lib/agent/tools/attachment-tools.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0]
const signal = () => new AbortController().signal
const tools = [bulkReplacePreviewTool, entityRenamePreviewTool, changeSetApplyTool, changeSetRollbackTool, novelCreateTool, novelPublishTool, novelArchiveTool, readFileTool]
async function start(f: Fixture, name: string, args: unknown, mode: 'build' | 'plan' = 'build') {
  const lease = await claim(f)
  await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
    toolAuthority: tools.map(tool => ({ name: tool.name, permission: tool.permission[mode], alwaysConfirm: Boolean((tool as AgentTool).alwaysConfirm), dangerous: Boolean((tool as AgentTool).dangerous) })),
    protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      messages: [{ role: 'user', content: 'Original synthetic authorization' }, { role: 'assistant', content: null, toolCalls: [{ id: 'first', name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
  return lease
}
async function next(lease: Awaited<ReturnType<typeof start>>, name: string, args: unknown) {
  const { frame } = await loadExecutionState(lease.userId, lease.runId)
  await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state,
    messages: [...frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }] }] } })
}
async function approve(lease: Awaited<ReturnType<typeof start>>, name: string) {
  const waiting = await executeDurableToolStep(lease, signal())
  expect(waiting.kind).toBe('waiting_approval')
  if (waiting.kind !== 'waiting_approval') throw Error('Missing approval')
  await resolveDurableApproval({ userId: lease.userId, runId: lease.runId, requestId: waiting.approvalId, callId: name, approved: true, alwaysAllow: false })
}

describe.runIf(available)('durable workspace changes', () => {
  it.each(['approved', 'narrowed'] as const)('recovers alwaysConfirm prepared work before its first effect: %s', scenario => fixture(async f => {
    const firstLease = await start(f, 'bulk_replace_preview', { query: '原文', replacement: '新文' })
    await executeDurableToolStep(firstLease, signal())
    const set = await prisma.changeSet.findFirstOrThrow({ where: { userId: f.userId } })
    await next(firstLease, 'changeset_apply', { changeSetId: set.id })
    await approve(firstLease, 'changeset_apply')
    vi.spyOn(operations, 'commitOperationEffect').mockRejectedValueOnce(Error('approved apply interrupted before effect'))
    await expect(executeDurableToolStep(firstLease, signal())).rejects.toThrow('approved apply interrupted before effect')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    const lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'approved-changeset-resume')
    if (scenario === 'narrowed') {
      await prisma.agentSession.update({ where: { id: f.sessionId }, data: { toolPolicy: { bulkWrite: 'deny' } } })
      await expect(executeDurableToolStep(lease, signal())).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
    } else expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: expect.stringContaining('已应用') } })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(scenario === 'approved' ? '新文' : '原文')
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'approval.requested' } })).toBe(1)
    expect(await prisma.changeSet.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
  }))

  it.each(['bulk_replace_preview', 'entity_rename_preview'] as const)('recovers one %s receipt without creating another preview', name => fixture(async f => {
    const lease = await start(f, name, { query: '原文', replacement: '新文' }, 'plan')
    vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after preview'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('interrupted after preview')
    expect(await prisma.changeSet.count({ where: { userId: f.userId } })).toBe(1)
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    expect(await prisma.changeSet.count({ where: { userId: f.userId } })).toBe(1)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
  }))

  it.each(['unchanged', 'body-edited', 'preview-edited'] as const)('applies only the observed preview: %s, then preserves rollback identity', scenario => fixture(async f => {
    const lease = await start(f, 'bulk_replace_preview', { query: '原文', replacement: '新文' })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool' })
    const set = await prisma.changeSet.findFirstOrThrow({ where: { userId: f.userId }, include: { patches: true } })
    await next(lease, 'changeset_apply', { changeSetId: set.id })
    await approve(lease, 'changeset_apply')
    if (scenario === 'body-edited') await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '作者新增原文', revision: { increment: 1 } } })
    if (scenario === 'preview-edited') await prisma.changeSetPatch.update({ where: { id: set.patches[0].id }, data: { after: '未经确认的新替换' } })
    const result = await executeDurableToolStep(lease, signal())
    expect(result).toMatchObject({ kind: 'tool', result: scenario === 'unchanged' ? { summary: expect.stringContaining('已应用') } : { outcome: 'failed', failureCode: 'CHANGESET_PREVIEW_STALE' } })
    const body = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    expect(body.content).toBe(scenario === 'unchanged' ? '新文' : scenario === 'body-edited' ? '作者新增原文' : '原文')
    if (scenario === 'unchanged') {
      await next(lease, 'changeset_rollback', { changeSetId: set.id })
      await approve(lease, 'changeset_rollback')
      expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: '已整体回滚变更集' } })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
    }
  }))

  it.each(['real-placeholder', 'formal-work', 'stale-counts'] as const)('initializes only the actual empty placeholder: %s', scenario => fixture(async f => {
    if (scenario === 'real-placeholder') await prisma.chapter.delete({ where: { id: f.chapterId } })
    if (scenario !== 'formal-work') await prisma.novel.update({ where: { id: f.novelId }, data: {
      title: '未命名作品', displayTitle: null, summary: '先创建一部作品，再继续完善简介、章节和封面。', chapterCount: 0, wordCount: 0 } })
    const lease = await start(f, 'novel_create', { title: '新作品', summary: '新简介', tags: ['科幻'] })
    if (scenario === 'real-placeholder') {
      vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after initialization'))
      await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('interrupted after initialization')
      expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    } else expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    const novel = await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })
    expect(novel.title).toBe(scenario === 'real-placeholder' ? '新作品' : scenario === 'formal-work' ? '持久执行测试' : '未命名作品')
    expect(await prisma.novel.count({ where: { authorId: f.userId } })).toBe(1)
  }))

  it.each((['novel_publish', 'novel_archive'] as const).flatMap(action => (['approved', 'denied', 'renamed', 'receipt-recovery'] as const).map(scenario => [action, scenario] as const)))('%s %s preserves the original confirmation and one final receipt', (action, scenario) => fixture(async f => {
    const lease = await start(f, action, { confirmTitle: '持久执行测试' })
    const waiting = await executeDurableToolStep(lease, signal())
    expect(waiting.kind).toBe('waiting_approval')
    if (waiting.kind !== 'waiting_approval') throw Error('Missing confirmation')
    await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'first', approved: scenario !== 'denied', alwaysAllow: false })
    if (scenario === 'renamed') await prisma.novel.update({ where: { id: f.novelId }, data: { title: '作者的新书名' } })
    if (scenario === 'receipt-recovery') {
      vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after lifecycle receipt'))
      await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('interrupted after lifecycle receipt')
      expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    } else expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: scenario === 'approved' ? { summary: expect.stringContaining(action === 'novel_publish' ? '发布' : '下架') } : { outcome: 'failed' } })
    const saved = await prisma.novel.findUniqueOrThrow({ where: { id: f.novelId } })
    expect(saved.status).toBe(scenario === 'approved' || scenario === 'receipt-recovery' ? action === 'novel_publish' ? 'published' : 'archived' : 'draft')
    expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(1)
  }))

  it('recovers the original attachment bytes observation after the file becomes unavailable', () => fixture(async f => {
    vi.spyOn(attachments, 'resolveManagedAttachmentPath').mockReturnValue('C:/isolated-fixture.txt')
    const bytes = vi.spyOn(attachments, 'readAuthorizedAgentAttachment').mockResolvedValueOnce(Buffer.from('Only the uploaded original text.'))
    const lease = await start(f, 'read_file', { url: '/api/agent/attachments/original.txt' }, 'plan')
    vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after file receipt'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('interrupted after file receipt')
    bytes.mockRejectedValue(Error('The file is no longer available'))
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    expect(bytes).toHaveBeenCalledTimes(1)
    const { frame } = await loadExecutionState(f.userId, f.runId)
    expect(frame.state.messages.at(-1)?.content).toContain('Only the uploaded original text.')
    const receipt = await prisma.agentEffectReceipt.findFirstOrThrow({ where: { operation: { taskRootId: f.rootId } } })
    expect(receipt.result).toMatchObject({ toolResult: { observedAttachment: { contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), offset: 0, totalChars: 32 } } })
  }))

  it.each(['FORBIDDEN', 'ATTACHMENT_SIZE_INVALID', 'ATTACHMENT_CHANGED'])('keeps an attachment %s as a failed observation without selecting another file', code => fixture(async f => {
    vi.spyOn(attachments, 'resolveManagedAttachmentPath').mockReturnValue('C:/isolated-fixture.txt')
    const bytes = vi.spyOn(attachments, 'readAuthorizedAgentAttachment').mockRejectedValue(new DataAccessError(403, code, 'fixture access denied'))
    const lease = await start(f, 'read_file', { url: '/api/agent/attachments/other.txt' }, 'plan')
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: code } })
    expect(bytes).toHaveBeenCalledTimes(1)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId, content: '原文' } })).toBe(1)
  }))
})
