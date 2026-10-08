import { createHash } from 'node:crypto'
import { readSettledQualityReviews } from '../../api/lib/agent/quality-review-admission.js'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { readContinuedContinuityRecovery, readLegacyContinuityRecovery } from '../../api/lib/agent/legacy-continuity-recovery.js'
import { prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import type { ToolRestriction } from '../../api/lib/agent/tool-local-failure.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('authenticated legacy continuity recovery', () => {
  it.each(['cap', 'conflicting-alias', 'missing-result', 'wrong-code', 'cap-with-paid-call', 'settled-locator', 'unknown-locator', 'overlapping-call'] as const)(
    '%s preserves receipts and only recovers a proven obsolete local limit or settled locator response', async scenario => fixture(async f => {
      try {
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '修改本章' })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
      const coverage = compilerContinuityCoverage({ chapter, bridge: current.bridge, sceneTasks: current.sceneTasks, source: null })
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: {
        validation: { coverage: { ...coverage, protocolVersion: 5 }, checkedChapterId: f.chapterId, checkedRevision: 1, checkRounds: 3, independentCheck: 'unavailable', unlocatedEvidenceCount: 1 },
      } })
      const locator = scenario.endsWith('locator')
      const code = locator ? 'CONTINUITY_EVIDENCE_UNLOCATED' : scenario === 'wrong-code' ? 'AI_CREDITS_EXHAUSTED' : 'CONTINUITY_CHECK_LIMIT'
      const start = new Date('2026-10-08T00:00:00Z'), end = new Date(start.getTime() + 10000)
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: start,
        payload: { toolName: 'continuity_validate', callId: 'legacy-check', args: { compilationId: compilation.id,
          chapterId: scenario === 'conflicting-alias' ? 'other-chapter' : f.chapterId } } } })
      if (scenario === 'overlapping-call') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', createdAt: new Date(start.getTime() + 1000),
        payload: { toolName: 'chapter_write', callId: 'unfinished-write', args: { chapterId: f.chapterId } } } })
      if (scenario !== 'missing-result') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.result', createdAt: end,
        payload: { toolName: 'continuity_validate', callId: 'legacy-check', ok: false, failureCode: code } } })
      if (locator || scenario === 'cap-with-paid-call') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId,
        targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic-no-network',
        action: 'agent3ContinuityCritic', requestTokens: scenario === 'unknown-locator' ? null : 10,
        responseTokens: scenario === 'unknown-locator' ? null : 2, billingStatus: scenario === 'unknown-locator' ? 'pending_usage' : 'settled',
        usageSource: scenario === 'unknown-locator' ? 'unknown' : 'reported', durationMs: 20, createdAt: new Date(start.getTime() + 5000) } })
      const restrictions: ToolRestriction[] = [
        { action: 'continuity_validate', target: compilation.id, code: 'CONTINUITY_CHECK_LIMIT', reason: 'old cap' },
        { action: 'continuity_validate', target: f.chapterId, code: 'CONTINUITY_CHECK_LIMIT', reason: 'old cap' },
        { action: 'chapter_bridge_commit', target: compilation.id, code: 'REVIEW_DEPENDENCY_UNAVAILABLE', reason: '正文已保存；连续性自动检查次数已用完，最终版本尚未复核。继续其余可执行工作，交付时必须保留此限制。' },
        { action: 'quality_analyze', target: compilation.id, code: 'QUALITY_REPORT_INCOMPLETE', reason: 'separate failure' },
        { action: 'chapter_bridge_commit', target: compilation.id, code: 'REVIEW_DEPENDENCY_UNAVAILABLE', reason: 'another dependency' },
        { action: 'continuity_validate', target: compilation.id, code: 'AI_CREDITS_EXHAUSTED', reason: 'real credit rejection' },
      ]
      const pending = [{ compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName: 'continuity_validate' as const, callId: 'legacy-check' }]
      const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
      const usageBefore = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
      const result = await prisma.$transaction(tx => readLegacyContinuityRecovery(tx, f, restrictions, pending))
      if (scenario === 'cap' || scenario === 'settled-locator') {
        expect(result.recovered).toEqual([`${compilation.id}:${f.chapterId}:1:continuity_validate:protocol6`])
        expect(result.settled).toEqual(pending)
        expect(result.markers).toHaveLength(1)
        expect(result.removed).toEqual(scenario === 'cap' ? restrictions.slice(0, 3) : [])
      } else expect(result).toEqual({ removed: [], settled: [], recovered: [], markers: [], chapterIds: [] })
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(before)
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })).toEqual(usageBefore)
      expect(restrictions).toHaveLength(6)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})


describe.runIf(available)('received quality report and local repair failure recovery', () => {
  it.each(['settled', 'unknown', 'missing-result', 'wrong-code', 'wrong-revision', 'incomplete', 'wrong-chapter', 'wrong-audit', 'overlap', 'prior-unfinished'] as const)('%s preserves reports and accounting', scenario => fixture(async f => {
    try {
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '原授权复检' })
      const start = new Date(Date.now() - 10000), end = new Date(start.getTime() + 5000)
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: start,
        payload: { toolName: 'quality_analyze', callId: 'returned-quality', args: { compilationId: compilation.id, chapterId: scenario === 'wrong-chapter' ? 'other' : f.chapterId } } } })
      if (scenario !== 'missing-result') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.result', createdAt: end,
        payload: { toolName: 'quality_analyze', callId: 'returned-quality', ok: false, failureCode: scenario === 'wrong-code' ? 'AI_PROVIDER_TIMEOUT' : 'REVIEW_MERGED_REVISION_REQUIRED' } } })
      const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId, compilationId: compilation.id,
        chapterId: f.chapterId, chapterRevision: scenario === 'wrong-revision' ? 2 : 1, status: scenario === 'incomplete' ? 'failed' : 'passed',
        deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update('原文').digest('hex'), autoRepairAttempted: true, criticResponse: { callId: scenario === 'wrong-audit' ? 'other' : 'returned-quality' } },
        createdAt: new Date(start.getTime() + 1000) } })
      await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'quality_report', targetId: report.id,
        providerType: 'text', providerMode: 'custom', modelName: 'fixture', action: 'agent3HumanityRevision',
        requestTokens: scenario === 'unknown' ? null : 10, responseTokens: scenario === 'unknown' ? null : 2,
        billingStatus: scenario === 'unknown' ? 'pending_usage' : 'settled', usageSource: scenario === 'unknown' ? 'unknown' : 'reported', durationMs: 20,
        createdAt: new Date(start.getTime() + 2000) } })
      if (scenario === 'prior-unfinished') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 0, type: 'tool.call', createdAt: new Date(start.getTime() - 1000),
        payload: { toolName: 'chapter_write', callId: 'unfinished-write' } } })
      if (scenario === 'overlap') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', createdAt: new Date(start.getTime() + 1500),
        payload: { toolName: 'chapter_write', callId: 'overlapping-write' } } })
      const before = await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })
      const pending = [{ compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName: 'quality_analyze' as const, callId: 'returned-quality' }]
      expect(await prisma.$transaction(tx => readSettledQualityReviews(tx, f, pending))).toEqual(scenario === 'settled' ? pending : [])
      expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId } })).toEqual(before)
      expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: report.id } })).toEqual(report)
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
})

describe.runIf(available)('author continuation after current continuity failure', () => {
  it.each(['settled', 'format', 'no-author', 'early-author', 'unknown', 'changed-body', 'complete', 'wrong-window', 'unfinished', 'no-response', 'duplicate-call', 'standalone-unknown', 'completed-overlap'] as const)('%s requires new author intent and the exact returned check', scenario => fixture(async f => {
    try {
      await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '修改本章' })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const start = new Date(Date.now() - 15000), end = new Date(start.getTime() + 5000)
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: {
        independentCheck: scenario === 'complete' ? 'complete' : 'unavailable', checkedRevision: chapter.revision,
        checkedChapterId: chapter.id, checkedAt: new Date(end.getTime() + (scenario === 'wrong-window' ? 2000 : -1)).toISOString(),
        coverage: { version: 1, protocolVersion: 6, contentHash: createHash('sha256').update(JSON.stringify({ content: chapter.content })).digest('hex') },
      } } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: start, payload: { toolName: 'continuity_validate', callId: 'returned-check', args: { compilationId: compilation.id, chapterId: chapter.id } } } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', createdAt: end, payload: { toolName: 'continuity_validate', callId: 'returned-check', ok: false, failureCode: scenario === 'format' ? 'CONTINUITY_REPORT_INCOMPLETE' : 'CONTINUITY_EVIDENCE_UNLOCATED' } } })
      const terminal = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'run.paused', createdAt: end, payload: {} } })
      if (scenario !== 'no-author') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.started', createdAt: new Date(end.getTime() + (scenario === 'early-author' ? -1 : 2000)), payload: { authorContinue: { eventId: terminal.id, afterSeq: 3 } } } })
      if (scenario === 'unfinished') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'tool.call', payload: { toolName: 'chapter_write', callId: 'unconfirmed-write', args: { chapterId: chapter.id } } } })
      if (scenario === 'duplicate-call') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 6, type: 'tool.call', payload: { toolName: 'continuity_validate', callId: 'returned-check', args: { chapterId: chapter.id } } } })
      if (scenario === 'standalone-unknown') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: chapter.id, targetType: 'chapter', targetId: chapter.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', action: 'agent3ContinuityCritic', usageSource: 'unknown', billingStatus: 'pending_usage', durationMs: 10 } })
      if (scenario === 'completed-overlap') {
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 0, type: 'tool.call', createdAt: new Date(start.getTime() - 1000), payload: { toolName: 'chapter_write', callId: 'overlapping-write', args: { chapterId: chapter.id } } } })
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 7, type: 'tool.result', createdAt: new Date(end.getTime() + 500), payload: { toolName: 'chapter_write', callId: 'overlapping-write', ok: true } } })
      }
      if (scenario === 'changed-body') await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '已变化正文' } })
      await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'story_compilation', targetId: compilation.id,
        providerType: 'text', providerMode: 'custom', modelName: 'synthetic', action: 'agent3ContinuityCritic', requestTokens: 10, responseTokens: 2,
        usageSource: scenario === 'unknown' ? 'unknown' : 'reported', billingStatus: scenario === 'unknown' ? 'pending_usage' : 'settled', billingEvidence: { responseObserved: scenario !== 'no-response' }, durationMs: 20, createdAt: new Date(start.getTime() + 1000) } })
      const result = await prisma.$transaction(tx => readContinuedContinuityRecovery(tx, f))
      expect(result).toHaveLength(['settled', 'format'].includes(scenario) ? 1 : 0)
      expect(await prisma.$transaction(tx => readContinuedContinuityRecovery(tx, f))).toEqual(result)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toMatchObject({ checkedRevision: chapter.revision })
    } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
  }))
})
