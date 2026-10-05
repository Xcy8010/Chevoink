import { describe,expect,it,vi } from 'vitest'
import { z } from 'zod'
import { runDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import * as tokenPrices from '../../api/lib/billing/resolve-token-price.js'
import * as credits from '../../api/lib/credits.js'
import { getCreditWindow } from '../../api/lib/credits.js'
import { prisma } from '../../api/lib/prisma.js'
import { available,claim,fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('durable stagnation evidence', () => {
  it.each(['repeat-read', 'changed-read', 'noop-write'] as const)('%s only resets on new evidence', async scenario => {
    await fixture(async f => {
      const lease = await claim(f)
      const tools = [chapterReadTool, chapterWriteTool]
      const window = getCreditWindow()
      await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 10000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
      const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
        model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: 'high', routeRevision: modelRouteRevision(route) },
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
        toolAuthority: tools.map(tool => ({ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '检查本章' }], successfulToolSignatures: [] } })
      vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-not-real', reasoningEffort: 'high', reasoningEfforts: ['high'], visionEnabled: false, contextWindowTokens: null })
      vi.spyOn(tokenPrices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'stagnation-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        calls++
        if (calls > 14) throw new Error('Repeated observations must not extend stagnation forever')
        if (scenario === 'changed-read' && calls === 5) await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '用户提供的新证据', revision: { increment: 1 } } })
        const delta = calls % 2 ? { tool_calls: [{ index: 0, id: `read-${calls}`, type: 'function', function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          ...(scenario === 'noop-write' ? [{ index: 1, id: `noop-${calls}`, type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content: '原文' }) } }] : [])] }
          : { content: '接下来读取正文。' }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls % 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`)
      }))
      expect(await runDurableExecution(lease, new AbortController().signal)).toMatchObject({ kind: 'needs_attention' })
      expect(calls).toBe(scenario === 'changed-read' ? 13 : 9)
      const reminders = await prisma.agentExecutionOutbox.findMany({ where: { taskRootId: f.rootId, type: 'execution.continuation' }, orderBy: { sequence: 'asc' } })
      expect(reminders.map(item => (item.payload as { reminderIndex: number }).reminderIndex)).toEqual(scenario === 'changed-read' ? [1, 2, 1, 2, 3, 4] : [1, 2, 3, 4])
      expect((await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: f.rootId } })).status).toBe('paused')
    })
  }, 30000)
})

