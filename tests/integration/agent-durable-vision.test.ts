import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import * as vision from '../../api/lib/vision-service.js'
import * as attachments from '../../api/lib/agent/tools/attachment-tools.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep, getDurableToolAdapterNames } from '../../api/lib/agent/runtime-tool-step.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { readVisionExemption } from '../../api/lib/agent/runtime-vision-contract.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

const runtime: Awaited<ReturnType<typeof vision.resolveVisionRuntime>> = {
  configured: null, selected: undefined, apiKey: 'isolated-vision-fixture',
  route: { provider: 'fixture', modelName: 'vision-fixture', baseUrl: 'https://vision.invalid/v1', providerMode: 'mock', options: {} },
}
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const response = (status = 200, usage: unknown = { prompt_tokens: 20, completion_tokens: 3 }) => new Response(JSON.stringify({
  choices: status === 200 ? [{ message: { content: '图片中是一扇关闭的门。' } }] : [], usage,
}), { status })

describe.runIf(available)('durable image observation actual PG transactions', () => {
  it.each(['success', 'raw-recovery', 'receipt-recovery', 'usage-recovery', 'unknown', 'known-retry', 'unknown-retry-usage',
    'changed-pixels', 'changed-route', 'lost-lease', 'cancel-after-response', 'approved-raw-recovery', 'denied'] as const)('%s preserves original pixels, provider identity and platform-paid policy', scenario => fixture(async f => {
    expect(getDurableToolAdapterNames()).toContain('view_image')
    let lease = await claim(f)
    const tool = attachments.viewImageTool, args = { url: '/fixture-original.png', focus: '门是否打开' }
    await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
      model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
      toolAuthority: [{ name: tool.name, permission: ['approved-raw-recovery', 'denied'].includes(scenario) ? 'ask' : 'allow', dangerous: false, alwaysConfirm: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
      messages: [{ role: 'user', content: '查看图片，不改稿。' }, { role: 'assistant', content: null,
        toolCalls: [{ id: 'original-vision', name: 'view_image', arguments: JSON.stringify(args) }] }] } })
    const read = vi.spyOn(attachments, 'readViewImageInput').mockResolvedValue({ image: { buffer: bytes, mime: 'image/png' }, displayUrl: args.url, question: args.focus })
    const route = vi.spyOn(vision, 'resolveVisionRuntime').mockResolvedValue(runtime)
    if (scenario === 'changed-route') route.mockResolvedValueOnce(runtime).mockResolvedValue({ ...runtime, route: { ...runtime.route, modelName: 'other-model' } })
    const controller = new AbortController()
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'vision-fixture', max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: args.focus }, { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] }] })
      if (scenario === 'unknown') throw Error('vision response lost')
      if (scenario === 'cancel-after-response') controller.abort(Error('author stopped'))
      if (scenario === 'known-retry' && fetcher.mock.calls.length === 1) return response(429)
      return scenario === 'unknown-retry-usage' ? response(429, null) : response()
    })
    vi.stubGlobal('fetch', fetcher)
    const step = (signal = controller.signal) => executeDurableToolStep(lease, signal)
    if (scenario === 'approved-raw-recovery' || scenario === 'denied') {
      const waiting = await step()
      if (waiting.kind !== 'waiting_approval') throw Error('Expected original author approval')
      expect(read).not.toHaveBeenCalled()
      await resolveDurableApproval({ userId: f.userId, runId: lease.runId, requestId: waiting.approvalId, callId: 'original-vision', approved: scenario !== 'denied', alwaysAllow: false })
      if (scenario === 'denied') {
        expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
        expect(read).not.toHaveBeenCalled()
        expect(fetcher).not.toHaveBeenCalled()
        expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
        return
      }
    }
    if (scenario === 'raw-recovery' || scenario === 'approved-raw-recovery') vi.spyOn(operations, 'commitOperationEffect').mockRejectedValueOnce(Error('interrupted before projection'))
    if (scenario === 'receipt-recovery') vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted after receipt'))
    if (scenario === 'usage-recovery') vi.spyOn(operations, 'recordProviderUsage').mockRejectedValueOnce(Error('interrupted before usage'))
    if (scenario === 'changed-pixels' || scenario === 'lost-lease') {
      vi.spyOn(operations, 'markProviderDispatched').mockRejectedValueOnce(Error('interrupted before dispatch'))
      await expect(step()).rejects.toThrow('interrupted before dispatch')
      if (scenario === 'changed-pixels') read.mockResolvedValue({ image: { buffer: Buffer.from('changed pixels'), mime: 'image/png' }, displayUrl: args.url, question: args.focus })
      else await pauseDurableTask(f.userId, lease.runId)
      if (scenario === 'changed-pixels') await expect(step()).rejects.toMatchObject({ code: 'VISION_INPUT_CHANGED' })
      else {
        await expect(step()).rejects.toMatchObject({ code: expect.stringMatching(/^RUNTIME_(NOT_ACTIVE|LEASE_)/) })
        expect((await loadExecutionState(f.userId, lease.runId)).frame.state.phase).toBe('awaiting_operation')
      }
      expect(fetcher).not.toHaveBeenCalled()
      return
    }
    if (scenario === 'unknown') {
      await expect(step()).rejects.toThrow('vision response lost')
      await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
      expect(fetcher).toHaveBeenCalledOnce()
      expect((await readTaskBudget(lease)).unresolvedAttempts).toBe(1n)
      expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
      return
    }
    if (scenario === 'changed-route') {
      await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CONFLICT' })
      expect(fetcher).not.toHaveBeenCalled()
      return
    }
    if (['raw-recovery', 'receipt-recovery', 'usage-recovery', 'approved-raw-recovery'].includes(scenario)) {
      await expect(step()).rejects.toThrow('interrupted')
      route.mockRejectedValue(Error('today route must not be resolved'))
      read.mockRejectedValue(Error('today pixels must not replace the saved result'))
      expect(await step()).toMatchObject({ kind: scenario === 'receipt-recovery' ? 'recovered' : 'tool' })
      if (scenario === 'approved-raw-recovery') expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'approval.requested' } })).toBe(1)
    } else if (scenario === 'cancel-after-response') {
      await expect(step()).rejects.toThrow('author stopped')
      await pauseDurableTask(f.userId, lease.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
      lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'vision-resume')
      route.mockRejectedValue(Error('today route must not be resolved'))
      read.mockRejectedValue(Error('saved response does not need new pixels'))
      expect(await step(new AbortController().signal)).toMatchObject({ kind: 'tool', result: { summary: '查看 1 张图片' } })
    } else expect(await step()).toMatchObject({ kind: 'tool', result: scenario === 'unknown-retry-usage' ? { outcome: 'failed' } : { summary: '查看 1 张图片' } })
    expect(fetcher).toHaveBeenCalledTimes(scenario === 'known-retry' ? 2 : 1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    const attempts = await prisma.agentProviderAttempt.findMany({ where: { operation: { taskRootId: f.rootId } }, include: { usageReceipt: true } })
    expect(attempts).toHaveLength(scenario === 'known-retry' ? 2 : 1)
    for (const attempt of attempts) {
      expect(JSON.stringify(attempt.requestSnapshot)).not.toContain(runtime.apiKey)
      expect(JSON.stringify(attempt.requestSnapshot)).not.toContain(bytes.toString('base64'))
      expect(attempt.result).toMatchObject({ result: { httpStatus: expect.any(Number), body: expect.any(String) } })
      const exempt = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `settlement:${attempt.operationId}` } })
      expect(exempt).toMatchObject({ type: 'credit.exempt', payload: { chargedMilli: 0, policy: 'platform_vision_v1' } })
      expect(await readVisionExemption(attempt.id, exempt)).toBe(true)
      expect(attempt.usageReceipt).toMatchObject(scenario === 'unknown-retry-usage'
        ? { source: 'unknown', promptTokens: null, completionTokens: null, settlementStatus: 'pending' }
        : { source: 'reported', promptTokens: 20, completionTokens: 3, settlementStatus: 'exempt' })
    }
    expect((await readTaskBudget(lease)).unresolvedAttempts).toBe(scenario === 'unknown-retry-usage' ? 1n : 0n)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(attempts.length)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原文')
    expect((await loadExecutionState(f.userId, lease.runId)).frame.state.phase).toBe('idle')
  }))
})
