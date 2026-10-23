import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as assignments from '../../api/lib/agent/model-assignment-context.js'
import * as storage from '../../api/lib/export-private-storage.js'
import * as operations from '../../api/lib/agent/runtime-operations.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep, getDurableToolAdapterNames } from '../../api/lib/agent/runtime-tool-step.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { novelExportTool as tool } from '../../api/lib/agent/tools/export-tools.js'
import { getDurableExport } from '../../api/lib/agent/runtime-export-download.js'
import { exportWorkSchema, exportPublicationSchema, EXPORT_TTL_MS } from '../../api/lib/agent/runtime-export-contract.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { prepareNovelExportSnapshot, readNovelExportSource, rememberExportAdvice } from '../../api/lib/export-service.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'
import { JSZip } from '../unit/novel-import-parser.fixtures.js'

const baseRuntime: NonNullable<ToolContext['modelRuntime']> = { tier: 'lite', multiplierBps: 10000, provider: 'fixture', modelName: 'advice-fixture',
  baseUrl: 'https://provider.invalid/v1', apiKey: 'isolated-export-fixture-key', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'],
  reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: 64000 }
const value = { channel: '男频' as const, mainCategory: '都市', themeTags: [], roleTags: [], plotTags: [], contentPlotTags: [], contentRoleTags: [],
  contentEmotionTags: [], contentWorldviewTags: [], protagonists: [], summary: '合成发布建议' }
const wire = (content: string, finish = 'stop', usage = true) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }],
  ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })

describe.runIf(available)('durable export preserves original manuscript, optional advice and first publication', () => {
  it.each(['body-only', 'cache', 'plan', 'review', 'assigned', 'byok', 'source-recovery', 'model-recovery', 'zip-recovery', 'receipt-recovery', 'resume',
    'unknown', 'missing-usage', 'rejected', 'quota', 'server-error', 'rejected-usage', 'invalid-complete', 'length', 'cancel', 'ask', 'ask-resume', 'denied', 'credits-exhausted', 'current-deny', 'tamper', 'ttl'] as const)('%s', scenario => fixture(async f => {
    const parentDirectory = path.resolve(os.tmpdir()), directory = await mkdtemp(path.join(parentDirectory, 'chevoink-export-pg-'))
    if (path.dirname(directory) !== parentDirectory || !path.basename(directory).startsWith('chevoink-export-pg-')) throw Error('Unexpected export fixture cleanup target')
    vi.stubEnv('AGENT_EXPORT_DIR', directory)
    try {
      expect(getDurableToolAdapterNames()).toContain('novel_export')
      const body = `  合成原文\r\n${'原稿'.repeat(scenario === 'body-only' ? 400000 : 800)}\n末尾  `
      await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: body, wordCount: body.length } })
      let lease = await claim(f)
      const args = { includePlans: false, includeMemories: false, includeCatalog: true, includeChapters: true, includeInfo: scenario !== 'body-only' }
      const mode = scenario === 'plan' ? 'plan' : scenario === 'review' ? 'review' : 'build'
      await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
        model: { tier: 'speed', provider: 'main-fixture', modelName: 'unrelated-main', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
        toolAuthority: [{ name: tool.name, permission: ['ask', 'ask-resume', 'denied'].includes(scenario) ? 'ask' : 'allow', dangerous: false, alwaysConfirm: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
          messages: [{ role: 'user', content: '一键导出当前作品。' }, { role: 'assistant', content: null, toolCalls: [{ id: 'original-export', name: tool.name, arguments: JSON.stringify(args) }] }] } })
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running' } })
      const period = credits.getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: period.startedAt, periodEndsAt: period.endsAt } })
      const runtime = { ...baseRuntime, tier: scenario === 'byok' ? 'custom' as const : scenario === 'assigned' ? 'standard' as const : 'lite' as const,
        multiplierBps: scenario === 'byok' ? 0 : 10000 }
      vi.spyOn(credits, 'getModelTierRuntime').mockImplementation(async (_tier, _user, _custom, effort) => ({ ...runtime, reasoningEffort: effort ?? runtime.reasoningEffort }))
      vi.spyOn(credits, 'assertCreditAccess').mockImplementation(async () => { if (scenario === 'credits-exhausted') throw new DataAccessError(409, 'CREDITS_EXHAUSTED', 'synthetic exhausted') })
      const select = vi.spyOn(credits, 'resolveAuxiliaryModelSelection').mockResolvedValue({ runtime, selection: { tier: runtime.tier, customModelId: scenario === 'byok' ? 'original-owned-custom' : null, reasoningEffort: runtime.reasoningEffort } })
      const assignment = vi.spyOn(assignments, 'assignedTaskModel').mockResolvedValue(scenario === 'assigned'
        ? { runtime, selection: { modelTier: 'standard', reasoningEffort: 'high' } } : undefined)
      vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue(scenario === 'byok' ? { version: 'credits-v1-exact', modelTier: 'custom', multiplierBps: 0 }
        : { version: 'credits-v2-itemized', modelTier: scenario === 'assigned' ? 'standard' : 'lite', multiplierBps: 10000, rateCardId: 'export-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      if (scenario === 'cache') {
        const source = await prepareNovelExportSnapshot(await readNovelExportSource(f.userId, f.novelId, args))
        rememberExportAdvice(f.novelId, source.advice!.fingerprint, value)
      }
      const controller = new AbortController()
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body))
        expect(request.model).toBe('advice-fixture'); expect(request.messages).toHaveLength(2)
        expect(request.messages[1].content).toContain(body.slice(0, 1500))
        expect(request.messages[1].content).not.toContain('unrelated-main')
        expect(request.response_format).toBeUndefined(); expect(request.tools).toBeUndefined()
        if (request.temperature !== undefined) expect(request.temperature).toBe(0.3)
        if (scenario === 'unknown') throw Error('provider outcome unknown')
        if (scenario === 'cancel') controller.abort(Error('author cancelled export'))
        if (['rejected', 'quota', 'server-error', 'rejected-usage'].includes(scenario)) return new Response(JSON.stringify({ error: { message: scenario === 'quota' ? 'insufficient_quota' : 'invalid field',
          ...(scenario === 'quota' ? { code: 'insufficient_quota' } : {}) }, ...(scenario === 'rejected-usage' ? { usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } } : {}) }),
        { status: scenario === 'server-error' ? 500 : scenario === 'quota' ? 429 : 400, headers: { 'content-type': 'application/json' } })
        return wire(scenario === 'invalid-complete' ? 'known invalid JSON' : JSON.stringify(value), scenario === 'length' ? 'length' : 'stop', scenario !== 'missing-usage')
      }); vi.stubGlobal('fetch', fetch)
      const step = () => executeDurableToolStep(lease, controller.signal)
      if (['ask', 'ask-resume', 'denied'].includes(scenario)) {
        const waiting = await step()
        if (waiting.kind !== 'waiting_approval') throw Error('Expected original export approval')
        expect(fetch).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled()
        await resolveDurableApproval({ userId: f.userId, runId: lease.runId, requestId: waiting.approvalId, callId: 'original-export', approved: scenario !== 'denied', alwaysAllow: false })
        if (scenario === 'denied') { expect(await step()).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } }); expect(fetch).not.toHaveBeenCalled(); return }
      }
      if (scenario === 'source-recovery') vi.spyOn(storage, 'prepareExportStorage').mockRejectedValueOnce(Error('interrupted original source'))
      const originalStore = storage.storeExportFile
      if (['model-recovery', 'resume', 'ask-resume', 'current-deny'].includes(scenario)) vi.spyOn(storage, 'storeExportFile').mockImplementationOnce(async (...input) => {
        // First call writes the original source; fail only the later ZIP write.
        return originalStore(...input)
      }).mockImplementationOnce(async () => { throw Error('interrupted before ZIP') })
      if (scenario === 'zip-recovery') vi.spyOn(operations, 'commitOperationEffect').mockRejectedValueOnce(Error('interrupted after ZIP'))
      if (scenario === 'receipt-recovery') vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('interrupted receipt'))
      const held = ['unknown', 'missing-usage', 'quota', 'server-error', 'rejected-usage', 'cancel'].includes(scenario)
      if (held) {
        await expect(step()).rejects.toThrow()
        if (scenario !== 'cancel') await expect(step()).rejects.toThrow()
        expect(fetch).toHaveBeenCalledOnce()
        expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'export.published' } })).toBe(0)
        expect(await prisma.agentEffectReceipt.count({ where: { operation: { taskRootId: f.rootId, action: 'novel_export' } } })).toBe(0)
        expect((await loadExecutionState(f.userId, lease.runId)).frame.state.phase).toBe('awaiting_operation')
        return
      }
      if (scenario.endsWith('recovery') || scenario === 'resume' || scenario === 'ask-resume' || scenario === 'current-deny') {
        await expect(step()).rejects.toThrow('interrupted')
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '后来的稿件，不属于原快照' } })
        await prisma.novel.update({ where: { id: f.novelId }, data: { title: '后来的作品名' } })
        if (scenario !== 'source-recovery') { select.mockRejectedValue(Error('must not resolve current advice config')); assignment.mockRejectedValue(Error('must not resolve current assignment')) }
        if (scenario === 'current-deny') {
          const other = await prisma.novel.create({ data: { authorId: f.userId, title: '切换后的合成作品', slug: crypto.randomUUID(), summary: '' } })
          await prisma.agentSession.update({ where: { id: f.sessionId }, data: { novelId: other.id } })
          await expect(step()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
          expect(fetch).toHaveBeenCalledOnce(); expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'export.published' } })).toBe(0); return
        }
        if (scenario === 'resume' || scenario === 'ask-resume') {
          await pauseDurableTask(f.userId, lease.runId)
          const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
          const resumed = await resumeDurableTask({ userId: f.userId, runId: lease.runId, pauseEventId: pause.id })
          lease = await claim({ userId: f.userId, runId: resumed.run.id })
        }
      }
      const result = await step()
      expect(result.kind).toBe(scenario === 'receipt-recovery' ? 'recovered' : 'tool')
      const event = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'export.published' } })
      const publication = exportPublicationSchema.parse(event.payload)
      const parent = await prisma.agentOperation.findUniqueOrThrow({ where: { id: event.operationId! } })
      const work = exportWorkSchema.parse(z.object({ input: z.object({ work: z.unknown() }) }).parse(parent.inputSnapshot).input.work)
      expect(Date.parse(publication.expiresAt) - Date.parse(publication.publishedAt)).toBe(EXPORT_TTL_MS)
      expect(work.source.bodyBytes).toBeGreaterThan(scenario === 'body-only' ? 2 * 1024 * 1024 : 0)
      expect(Buffer.byteLength(JSON.stringify(parent.inputSnapshot))).toBeLessThan(2 * 1024 * 1024)
      expect(fetch).toHaveBeenCalledTimes(['body-only', 'cache', 'credits-exhausted'].includes(scenario) ? 0 : 1)
      if (scenario === 'body-only' || scenario === 'cache') { expect(select).not.toHaveBeenCalled(); expect(assignment).not.toHaveBeenCalled() }
      if (scenario === 'assigned') { expect(select).not.toHaveBeenCalled(); expect(work.advice).toMatchObject({ kind: 'generate', route: { tier: 'standard', reasoningEffort: 'high' } }) }
      if (scenario === 'byok') expect(work.advice).toMatchObject({ kind: 'generate', route: { tier: 'custom', customModelId: 'original-owned-custom', reasoningEffort: 'low' } })
      if (scenario === 'plan' || scenario === 'review') expect(work.advice).toMatchObject({ kind: 'generate', route: { tier: 'lite', reasoningEffort: 'low' } })
      if (scenario === 'tamper') {
        await writeFile(path.join(directory, publication.zip.key), 'corrupt original ZIP')
        await expect(getDurableExport(publication.exportId, f.userId)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' }); return
      }
      const download = await getDurableExport(publication.exportId, f.userId)
      expect(download).not.toBeNull(); expect(download!.fileName).toBe('持久执行测试-一键导出.zip')
      expect(await getDurableExport(publication.exportId, 'another-user')).toBeNull()
      const anonymous = await getDurableExport(publication.exportId)
      expect(anonymous!.buffer.equals(download!.buffer)).toBe(true)
      const zip = await JSZip.loadAsync(download!.buffer)
      const chapterFile = Object.values(zip.files).find(file => !file.dir && file.name.includes('/正文/'))!
      expect(await chapterFile.async('string')).toBe(`原章\n\n${body}`)
      const adviceFile = Object.values(zip.files).find(file => !file.dir && file.name.endsWith('/发布建议.txt'))
      if (['invalid-complete', 'length', 'rejected', 'credits-exhausted'].includes(scenario)) expect(await adviceFile!.async('string')).toContain('本次未生成')
      if (scenario === 'body-only') expect(adviceFile).toBeUndefined()
      if (scenario === 'rejected') expect((await readTaskBudget(lease)).unresolvedAttempts).toBeGreaterThan(0n)
      if (scenario.endsWith('recovery') || scenario === 'resume' || scenario === 'ask-resume') {
        const children = await prisma.agentOperation.findMany({ where: { parentOperationId: parent.id, action: 'publish_advice' }, include: { attempts: { include: { usageReceipt: true } } } })
        expect(children).toHaveLength(1); expect(children[0].originRunId).toBe(f.runId)
        expect(children[0].attempts).toHaveLength(1)
        expect(children[0].attempts[0]).toMatchObject({ runId: f.runId, status: 'succeeded', usageReceipt: { source: 'reported', settlementStatus: 'settled', promptTokens: 10, completionTokens: 5 } })
        expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, idempotencyKey: `operation:${children[0].id}` } })).toBe(1)
      }
      if (scenario === 'zip-recovery') {
        await unlink(path.join(directory, publication.zip.key))
        const rebuilt = await getDurableExport(publication.exportId)
        expect(rebuilt!.buffer.equals(download!.buffer)).toBe(true)
      }
      if (scenario === 'ttl') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(publication.expiresAt))
        expect(await getDurableExport(publication.exportId, f.userId)).toBeNull()
        expect(await getDurableExport(publication.exportId)).toBeNull()
      }
      expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId, type: 'export.published' } })).toBe(1)
      expect(JSON.stringify(await prisma.agentOperation.findMany({ where: { taskRootId: f.rootId } }))).not.toContain('isolated-export-fixture-key')
      expect(runtimeJson(publication).hash).toBe(runtimeJson(exportPublicationSchema.parse((await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { id: event.id } })).payload)).hash)
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) }
  }, undefined, '一键导出当前作品，保留原文。'))
})
