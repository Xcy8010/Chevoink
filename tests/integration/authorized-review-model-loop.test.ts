import { describe, expect, it, vi } from 'vitest'
import { fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { prepareStoryCompilation, saveSceneTasks, recordStoryCompilerWrite } from '../../api/lib/agent/story-compiler.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { readCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'

const prompt = '修复第一章有证据的现金连续性错误和重复解释，按原权限自动局部修订，复查当前版本后提交，并自然总结实际完成的修改。'
const redundant = '他用力攥紧信封，这说明他心里很紧张。'
const initial = `他清点口袋，随身只有390元。
家里抽屉留着97元。
他攥紧信封。
${redundant}
到了柜台，他说口袋里有487元。`
const finalText = '现金已按正文证据修正为随身390元，家中97元保留；删去了重复解释。最终版本已完成两项检查并提交。'

// Required PostgreSQL scenario: provider bytes alone are mocked. Registered
// handlers, reports, original authority, body CAS and terminal commit are real.
describe('authorized current-report workflow through the real model loop', () => {
  it.each(['fresh', 'legacy-phase-checkpoint', 'final-advisory'] as const)('%s lets observations drive quality repair, continuity repair, final rechecks and one actual commit', async scenario => fixture(async f => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live provider calls are forbidden in this fixture'))
    vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue(undefined)
    vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
    const feature = flags.isAgent2FeatureEnabled
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((name, owner) => name === 'storyCompiler' || name !== 'memory2' && feature(name, owner))
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', taskRootId: null, runtimeProtocolVersion: 0, startRequest: { prompt } } })
    const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: initial, wordCount: initial.length, revision: 5, updatedAt: new Date(Date.now() - 2000) } })
    const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: prompt })
    await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '核对柜台现金', entryState: { objects: ['随身390元，家中97元'] },
      goal: '核实现金', obstacle: '混淆两处现金', choice: '清点口袋', cost: '时间', turn: '报出随身现金', exitState: { objects: ['随身390元'] },
      styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' } }] })
    await recordStoryCompilerWrite({ ...f, chapterOrderIndex: 1, chapterRevision: chapter.revision })
    const runtime = { tier: 'speed' as const, multiplierBps: 10000, provider: 'fixture', modelName: 'fixture-model', baseUrl: 'https://provider.invalid/v1',
      apiKey: null, reasoningEffort: 'high' as const, reasoningEfforts: ['high' as const], visionEnabled: false, contextWindowTokens: 128000 }
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ provider: 'fixture', modelName: 'fixture-model', inputPerMillion: 1,
      outputPerMillion: 1, cacheReadPerMillion: 1, cacheWritePerMillion: 1, source: 'fixture', revision: 'fixture' } as Awaited<ReturnType<typeof prices.resolveTokenPrice>>)
    const actions: string[] = []
    const summary = scenario === 'final-advisory' ? finalText + '最终报告另有一条节奏建议，已引用实际报告明确保留；该建议没有冒充已修复。' : finalText
    vi.spyOn(ai, 'generateTextCompletion').mockImplementation(async (_system, content, options) => {
      options.signal?.throwIfAborted()
      const current = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const table = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: current.id, chapterRevision: current.revision }, current.content)
      const source = (text: string) => {
        const entry = table.entries.find(item => item.text === text)
        expect(entry, `real source entry for ${text}`).toBeDefined()
        const visible = content.includes(entry!.id) ? entry!.id : entry!.id.slice(0, 13)
        expect(content).toContain(visible)
        expect(table.entries.filter(item => item.id.startsWith(visible))).toHaveLength(1)
        return visible
      }
      actions.push(options.action)
      const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: current.id,
        action: options.action, targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom',
        modelName: 'fixture-model', modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8,
        usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, creditChargeMilli: 7, durationMs: 0, billingEvidence: { responseObserved: true } } })
      const record = beginTextRequest(usage.id).record
      record.status = 'terminal'; record.billingKnown = true
      await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: usage.id,
        idempotencyKey: `review-walk:${usage.id}`, deltaMilli: -7, dailyDeltaMilli: -7, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } })
      if (options.action === 'agent3HumanityCritic') return JSON.stringify({ findings: current.content.includes(redundant) ? [{ signal: 'explanation_echo', severity: 'warning',
        sourceId: source(redundant), explanation: '前句攥紧信封已传达紧张，后句重述且无新增信息。', suggestion: '删除本句重复解释。', confidence: 0.95 }] : scenario === 'final-advisory' ? [{ signal: 'explanation_echo', severity: 'advisory',
        sourceId: source('他攥紧信封。'), explanation: '信封动作可进一步压缩，但当前节奏仍可成立。', suggestion: '考虑压缩这处动作；若保留，说明当前表达的必要性。', confidence: 0.6 }] : [] })
      if (options.action === 'agent3HumanityRevision') {
        const evidence = JSON.parse(content.slice(content.lastIndexOf('\n[') + 1)) as Array<{ findingId: string; evidence: string }>
        const selected = evidence.find(item => item.evidence === redundant)
        expect(selected).toBeDefined()
        return JSON.stringify({ patches: [{ findingId: selected!.findingId, replacement: '' }] })
      }
      if (options.action === 'agent3ContinuityCritic') return JSON.stringify({ findings: current.content.includes('487元') ? [{ signal: 'object', severity: 'error',
        explanation: '随身390元与家中97元不能合并为柜台可用的487元。', suggestion: '仅把柜台报出的随身现金修正为390元，保留家中97元。',
        evidence: [{ sourceId: source('到了柜台，他说口袋里有487元。') }, { sourceId: source('他清点口袋，随身只有390元。') }] }] : [] })
      if (options.action === 'agent3ContinuityRevision') {
        const input = JSON.parse(content) as { findings: Array<{ findingId: string; original: string }> }
        expect(input.findings).toHaveLength(1)
        expect(input.findings[0].original).toContain('487元')
        return JSON.stringify({ patches: [{ findingId: input.findings[0].findingId, replacement: input.findings[0].original.replace('487元', '390元') }] })
      }
      throw new Error(`Unexpected auxiliary action ${options.action}`)
    })
    let resume: { resume?: boolean; eventStartSeq?: number; authorContinue?: { eventId: string; afterSeq: number } } = {}
    let originalHistory: unknown[] = []
    let originalUsage: unknown = null
    let originalLedger: unknown = null
    if (scenario === 'legacy-phase-checkpoint') {
      const startedAt = Date.now() - 10000
      const pending = { toolName: 'continuity_validate', callId: 'old-third-r5', compilationId: compilation.id, chapterId: f.chapterId, revision: 5 }
      const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: startedAt,
        activeExecutionMs: 100, stagnantBatches: 0, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
        writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [],
        reviewAttempts: [`settled-continuity:${compilation.id}:${f.chapterId}:4:continuity_validate:protocol8`], pendingReviews: [pending],
        toolRestrictions: [{ action: 'continuity_validate', target: compilation.id, code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED', reason: '旧r4平台阶段凭据已用完，不能重试。' }] }
      await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'paused', startedAt: new Date(startedAt), currentTurn: 20,
        usage: { promptTokens: 21, completionTokens: 7, totalTokens: 28, checkpoint } } })
      await prisma.agentRunEvent.createMany({ data: [{ runId: f.runId, seq: 1, type: 'run.started', payload: {}, createdAt: new Date(startedAt) },
        { runId: f.runId, seq: 4830, type: 'tool.call', payload: { toolName: pending.toolName, callId: pending.callId, args: { compilationId: compilation.id } }, createdAt: new Date(Date.now() - 1000) },
        { runId: f.runId, seq: 4831, type: 'tool.result', payload: { toolName: pending.toolName, callId: pending.callId, ok: false, failureCode: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' }, createdAt: new Date(Date.now() - 900) }] })
      const pause = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4834, type: 'run.paused', payload: { reason: 'review_receipt_pending' }, createdAt: new Date(Date.now() - 800) } })
      await prisma.agentMessage.create({ data: { runId: f.runId, sessionId: f.sessionId, role: 'assistant', parts: [{ type: 'text', text: '旧检查失败：阶段次数用完，本次检查未执行，不能重试。' }] } })
      originalUsage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
        action: 'agent3ContinuityCritic', targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'fixture-model',
        modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled',
        reservedCreditMilli: 0, creditChargeMilli: 7, durationMs: 0, createdAt: new Date(Date.now() - 1500) } })
      originalLedger = await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: (originalUsage as { id: string }).id,
        idempotencyKey: `review-walk:historical:${f.runId}`, deltaMilli: -7, dailyDeltaMilli: -7, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } })
      await prisma.creditAccount.update({ where: { id: account.id }, data: { dailyUsedMilli: { increment: 7 } } })
      originalHistory = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
      resume = { resume: true, eventStartSeq: 4834, authorContinue: { eventId: pause.id, afterSeq: 4834 } }
    }
    const calls: Array<{ name: string; args: unknown }> = []
    const chat = vi.spyOn(ai, 'chatWithTools').mockImplementation(async request => {
      const observations = request.messages.filter(item => item.role === 'tool')
      const last = observations.at(-1)
      let next: { name: string; args: { chapterId?: string; compilationId?: string; retainedFindings?: Array<{ source: 'quality'; reportId: string; findingId: string; reason: string }> } } | undefined
      if (!last || last.toolCallId === 'old-third-r5') {
        if (scenario === 'legacy-phase-checkpoint') expect(request.messages.some(item => typeof item.content === 'string' && item.content.includes('系统·当前检查合同') && item.content.includes('不是永久撤销原作者授权'))).toBe(true)
        expect(JSON.stringify(request.tools)).toContain('quality_analyze')
        next = { name: 'quality_analyze', args: { chapterId: f.chapterId } }
      } else if (last.toolCallId === 'walk-quality_analyze') {
        const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        expect((saved.usage as { checkpoint?: { pendingReviews?: unknown[] } } | null)?.checkpoint?.pendingReviews ?? []).toEqual([])
        expect(last.content).toContain('需')
        expect(last.content).toContain('修订')
        next = { name: 'continuity_validate', args: { chapterId: f.chapterId } }
      } else if (last.toolCallId === 'walk-continuity_validate') {
        const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        expect((saved.usage as { checkpoint?: { pendingReviews?: unknown[] } } | null)?.checkpoint?.pendingReviews ?? []).toEqual([])
        expect(last.content).toContain('正文已变化')
        expect(last.content).toContain('复查')
        next = { name: 'chapter_bridge_commit', args: { compilationId: compilation.id } }
      } else if (scenario === 'final-advisory' && last.toolCallId === 'walk-chapter_bridge_commit') {
        const state = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
        expect(state).toMatchObject({ ready: true, decisionPending: true, terminalCommitted: false })
        const raw = String(last.content).split('当前真实意见：')[1]
        expect(raw, 'failed commit must expose current real finding references').toBeDefined()
        let details: Array<{ source: 'quality'; reportId: string; findingId: string; evidence: string; suggestion: string }> | undefined
        for (let end = raw.indexOf(']'); end >= 0; end = raw.indexOf(']', end + 1)) {
          try { details = JSON.parse(raw.slice(0, end + 1)); break } catch { /* Continue only within this actual observed JSON array. */ }
        }
        expect(details).toHaveLength(1)
        expect(details![0]).toMatchObject({ source: 'quality', evidence: '他攥紧信封。', suggestion: expect.stringContaining('压缩') })
        next = { name: 'chapter_bridge_commit', args: { compilationId: compilation.id, retainedFindings: details!.map(({ source, reportId, findingId }) => ({
          source, reportId, findingId, reason: '这处攥紧信封的动作保留紧张的身体反应；已经删去后句解释，当前一句不重复事实，继续压缩会失去人物的动作节奏。' })) } }
      } else {
        expect(last.toolCallId).toBe(scenario === 'final-advisory' ? 'walk-retained-commit' : 'walk-chapter_bridge_commit')
        expect(last.content).toContain('提交')
      }
      if (next) calls.push(next)
      return { content: next ? '' : summary, reasoning: '', toolCalls: next ? [{ id: next.args.retainedFindings ? 'walk-retained-commit' : `walk-${next.name}`, name: next.name, arguments: JSON.stringify(next.args) }] : [],
        finishReason: next ? 'tool_calls' : 'stop', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    })
    await executeAgentRun({ ...f, chapterId: f.chapterId, mode: 'build', prompt, modelTier: 'speed', creativeFreedom: 'balanced', qualityMode: 'premium', ...resume })
    const current = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    expect(current.revision).toBe(7)
    expect(current.content).toContain('家里抽屉留着97元')
    expect(current.content).toContain('到了柜台，他说口袋里有390元')
    expect(current.content).not.toContain(redundant)
    const ready = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, compilation.id))
    expect(ready).toMatchObject({ ready: true, revision: current.revision, continuity: 'complete', quality: 'complete', terminalCommitted: true, decisionPending: false })
    const delivery = await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))
    expect(delivery).toMatchObject({ chapters: [{ id: f.chapterId, revision: current.revision, content: current.content }] })
    expect(calls.map(item => item.name)).toEqual(['quality_analyze', 'continuity_validate', 'chapter_bridge_commit', ...(scenario === 'final-advisory' ? ['chapter_bridge_commit'] : [])])
    expect(calls.filter(item => !(item.args as { retainedFindings?: unknown }).retainedFindings).every(item => Object.keys(item.args as object).length === 1)).toBe(true)
    expect(actions.filter(action => action === 'agent3HumanityRevision')).toHaveLength(1)
    expect(actions.filter(action => action === 'agent3ContinuityRevision')).toHaveLength(1)
    const history = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
    expect(history.filter(event => event.type === 'tool.call' && (event.payload as { toolName?: string }).toolName === 'chapter_bridge_commit')).toHaveLength(scenario === 'final-advisory' ? 2 : 1)
    if (scenario === 'final-advisory') {
      expect(history.filter(event => event.type === 'tool.result' && (event.payload as { toolName?: string }).toolName === 'chapter_bridge_commit').map(event => (event.payload as { ok: boolean }).ok)).toEqual([false, true])
      expect(ready?.retainedDecisions).toHaveLength(1)
      expect(ready?.decisionDetails?.some(item => item.source === 'quality' && item.evidence === '他攥紧信封。')).toBe(true)
    }
    expect(history.at(-1)?.payload).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(chat).toHaveBeenCalledTimes(scenario === 'final-advisory' ? 5 : 4)
    if (scenario === 'legacy-phase-checkpoint') expect(history.filter(event => event.seq <= 4834)).toEqual(originalHistory)
    const reports = await prisma.chapterQualityReport.findMany({ where: { runId: f.runId } })
    expect(reports.some(report => report.chapterRevision === current.revision)).toBe(true)
    const usage = await prisma.aiUsageLog.findMany({ where: { agentRunId: f.runId } })
    const ledger = await prisma.creditLedgerEntry.findMany({ where: { userId: f.userId, kind: 'consume' } })
    expect(usage.every(row => row.billingStatus === 'settled')).toBe(true)
    if (scenario === 'legacy-phase-checkpoint') {
      expect(usage.find(row => row.id === (originalUsage as { id: string }).id)).toEqual(originalUsage)
      expect(ledger.find(row => row.id === (originalLedger as { id: string }).id)).toEqual(originalLedger)
    }
    expect(ledger.reduce((total, row) => total - row.deltaMilli, 0)).toBe(usage.length * 7)
    const messages = await prisma.agentMessage.findMany({ where: { runId: f.runId, role: 'assistant' } })
    expect(messages.some(message => JSON.stringify(message.parts).includes(summary))).toBe(true)
  }, undefined, prompt, { freezeWriting: true, continuityReportProtocol: 5 }))
})
