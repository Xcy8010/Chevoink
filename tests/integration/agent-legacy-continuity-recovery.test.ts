import { hasReconciledQualityRequest } from '../../api/lib/agent/quality-format-recovery.js'
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

describe.runIf(available)('explicit returned quality request with local report failure', () => {
  it.each(['returned', 'new-revision', 'missing-proof', 'wrong-proof', 'wrong-hash', 'wrong-result', 'duplicate-call', 'wrong-args', 'wrong-target'] as const)(
    '%s resolves only request uncertainty and preserves failed report state', scenario => fixture(async f => {
      const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '原授权复检' })
      const start = new Date(Date.now() - 10000), end = new Date(start.getTime() + 1000)
      const proof = { version: 1, chapterId: scenario === 'wrong-proof' ? 'other' : f.chapterId, revision: 1,
        contentHash: scenario === 'wrong-hash' ? 'b'.repeat(64) : createHash('sha256').update('原文').digest('hex') }
      const call = { toolName: 'quality_analyze', callId: 'saved-response', args: {
        chapterId: scenario === 'wrong-args' ? 'other' : f.chapterId, compilationId: compilation.id } }
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: call, createdAt: start } })
      if (scenario === 'duplicate-call') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', payload: call, createdAt: start } })
      await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.result', createdAt: end,
        payload: { toolName: 'quality_analyze', callId: 'saved-response', ok: false,
          failureCode: scenario === 'wrong-result' ? 'UNEXPECTED_TOOL_ERROR' : 'QUALITY_REPORT_SAVE_FAILED',
          ...(scenario === 'missing-proof' ? {} : { reviewRequestFinished: proof }) } } })
      if (scenario === 'new-revision') await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 2, content: '后续正文' } })
      if (scenario === 'wrong-target') await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { chapterId: null } })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
      const pending = [{ compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName: 'quality_analyze' as const, callId: 'saved-response' }]
      expect(await prisma.$transaction(tx => readSettledQualityReviews(tx, f, pending))).toEqual(['returned', 'new-revision'].includes(scenario) ? pending : [])
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(chapter)
      expect(await prisma.chapterQualityReport.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    }))
})
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { randomUUID } from 'node:crypto'

describe.runIf(available)('legacy terminal quality failure with known billing', () => {
  it.each(['known', 'no-admission', 'same-body', 'same-revision', 'wrong-audit', 'wrong-claim', 'wrong-key', 'wrong-window', 'wrong-scope',
    'third-payment', 'unknown', 'estimated', 'no-response', 'prior-unknown', 'prior-null-status', 'prior-null-source',
    'reserved', 'native-pending', 'overlap', 'unfinished', 'duplicate', 'native-run'] as const)(
    '%s never revives an old report or refunds/replays its chain', scenario => fixture(async f => {
      try {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: scenario === 'native-run' ? f.rootId : null,
          runtimeProtocolVersion: scenario === 'native-run' ? 1 : 0 } })
        const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '复检原章节' })
        const start = new Date(Date.now() + 1000), at = (offset: number) => new Date(start.getTime() + offset)
        const callId = 'failed-inline-check', reportId = randomUUID(), auditHash = 'a'.repeat(64)
        const usage = { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, targetType: 'chapter', targetId: f.chapterId,
          providerType: 'text', providerMode: 'custom', modelName: 'synthetic', requestTokens: 10, responseTokens: 5,
          billingStatus: 'settled', usageSource: 'reported', billingEvidence: { responseObserved: true }, durationMs: 1000 }
        const primary = await prisma.aiUsageLog.create({ data: { ...usage, action: 'agent3HumanityCritic', createdAt: at(1000) } })
        await prisma.aiUsageLog.create({ data: { ...usage, action: 'agent3HumanityFormatRecovery', createdAt: at(5000),
          ...(scenario === 'unknown' ? { usageSource: 'unknown', billingStatus: 'pending_usage' } : {}),
          ...(scenario === 'estimated' ? { usageSource: 'estimated' } : {}),
          ...(scenario === 'no-response' ? { billingEvidence: { responseObserved: false } } : {}),
          ...(scenario === 'reserved' ? { reservedCreditMilli: 10 } : {}) } })
        const taskId = scenario === 'native-run' ? f.rootId : f.spec.id, admissionId = 'old-author-admission'
        await prisma.chapterQualityReport.create({ data: { id: reportId, userId: f.userId, novelId: f.novelId, runId: f.runId,
          chapterId: f.chapterId, chapterRevision: 1, compilationId: compilation.id, status: 'failed', createdAt: at(3000),
          deterministicMetrics: { contentHash: createHash('sha256').update('原文').digest('hex'), independentCheck: 'unavailable', qualityContextHash: 'c'.repeat(64),
            criticResponse: { version: 1, callId: scenario === 'wrong-audit' ? 'other' : callId, contentHash: auditHash, characterCount: 40, classification: 'incomplete_json' },
            formatRecovery: { version: 1, state: 'claimed', taskId, reportId, chapterId: f.chapterId, chapterRevision: 1, compilationId: compilation.id,
              claimRunId: scenario === 'wrong-claim' ? 'other' : f.runId, admissionId, claimedAt: at(scenario === 'wrong-window' ? 8000 : 4000).toISOString(), contextHash: 'c'.repeat(64),
              key: scenario === 'wrong-key' ? 'invalid' : runtimeJson({ taskId, chapterId: f.chapterId, revision: 1, admissionId }).hash,
              evidenceHash: runtimeJson({ callId, contentHash: auditHash, usageIds: [primary.id] }).hash } } } })
        const payload = { toolName: 'quality_analyze', callId, args: { chapterId: f.chapterId, compilationId: compilation.id } }
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', createdAt: start, payload } })
        if (scenario === 'duplicate') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', createdAt: start, payload } })
        const result = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.result', createdAt: at(7000),
          payload: { toolName: 'quality_analyze', callId, ok: false, failureCode: 'UNEXPECTED_TOOL_ERROR' } } })
        const terminal = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.paused', createdAt: at(8000), payload: {} } })
        if (scenario !== 'no-admission') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'run.started', createdAt: at(9000),
          payload: { authorContinue: { eventId: terminal.id, afterSeq: 4 } } } })
        if (scenario === 'overlap' || scenario === 'unfinished') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 0,
          type: 'tool.call', createdAt: at(scenario === 'overlap' ? 100 : -1), payload: { toolName: 'chapter_write', callId: 'overlap' } } })
        if (scenario === 'third-payment' || scenario === 'prior-unknown') await prisma.aiUsageLog.create({ data: {
          ...usage, targetId: scenario === 'third-payment' ? reportId : f.chapterId, action: 'agent3HumanityEvidenceCorrection',
          createdAt: at(scenario === 'prior-unknown' ? -500 : 5500), usageSource: scenario === 'prior-unknown' ? 'unknown' : 'reported' } })
        if (scenario === 'prior-null-status' || scenario === 'prior-null-source') await prisma.aiUsageLog.create({ data: {
          ...usage, action: 'agent3HumanityCritic', createdAt: at(-500),
          ...(scenario === 'prior-null-status' ? { billingStatus: null } : { usageSource: null }) } })
        if (scenario === 'native-pending') {
          const operationId = randomUUID()
          await prisma.agentOperation.create({ data: { id: operationId, taskRootId: f.rootId, originRunId: f.runId,
            operationKey: 'unresolved-native', kind: 'provider', action: 'review', inputHash: 'a'.repeat(64) } })
          await prisma.agentProviderAttempt.create({ data: { id: randomUUID(), operationId, attemptKey: 'unknown', runId: f.runId,
            ownerEpoch: 1, provider: 'synthetic', model: 'synthetic', requestHash: 'a'.repeat(64), status: 'unknown' } })
        }
        if (scenario === 'wrong-scope') await prisma.agentRun.update({ where: { id: f.runId }, data: { taskSpec: runtimeJson({ ...JSON.parse(JSON.stringify(f.spec)),
          scope: { ...JSON.parse(JSON.stringify(f.spec.scope)), writing: { version: 1, kind: 'bounded', targets: [{ orderIndex: 99, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false } } }).value } })
        await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: scenario === 'same-revision' ? 1 : 2,
          content: scenario === 'same-body' ? '原文' : '新正文' } })
        const before = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: reportId } })
        const payments = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const pending = [{ compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName: 'quality_analyze' as const, callId }]
        const settled = await prisma.$transaction(tx => readSettledQualityReviews(tx, f, pending))
        if (scenario === 'known') expect(settled).toEqual([{ ...pending[0], reconciliation: {
          status: 'terminal_failed_billing_known', sourceRunId: f.runId, sourceResultId: result.id, sourceReportId: reportId,
          usageIds: expect.arrayContaining(payments.map(row => row.id)), admissionId: `author-continue:${terminal.id}`,
          currentRevision: 2, currentContentHash: createHash('sha256').update('新正文').digest('hex') } }])
        else expect(settled).toEqual([])
        expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: reportId } })).toEqual(before)
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(payments)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})
import { readReviewRequestRecovery } from '../../api/lib/agent/review-request-recovery.js'

describe.runIf(available)('returned review provider request recovery', () => {
  it.each(['continuity', 'quality', 'typed', 'unknown', 'estimated', 'null-billing', 'no-author', 'early-author', 'duplicate', 'overlap', 'wrong-target', 'wrong-proof', 'extra-payment', 'inherited-unknown'] as const)(
    '%s needs complete billing and fresh author admission without changing the manuscript', scenario => fixture(async f => {
      try {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0 } })
        const { compilation } = await prepareStoryCompilation({ ...f, mode: 'premium', intentSummary: '检查本章' })
        const start = new Date(Date.now() + 1000), at = (n: number) => new Date(start.getTime() + n)
        if (scenario === 'inherited-unknown') {
          const earlier = new Date(start.getTime() - 100000)
          await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId,
            sessionId: f.sessionId, chapterId: f.chapterId, status: 'paused', mode: 'act', action: 'workspaceAgent',
            agentType: 'writingOrchestrator', engine: 'loop', runtimeProtocolVersion: 0, createdAt: earlier,
            taskSpec: JSON.parse(JSON.stringify(f.spec)), startRequest: { prompt: '修改本章' } } })
          await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
            targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'custom', modelName: 'synthetic',
            action: 'agent3ContinuityCritic', usageSource: 'unknown', billingStatus: 'pending_usage', durationMs: 10,
            createdAt: new Date(earlier.getTime() + 1000) } })
        }
        const toolName = scenario === 'quality' ? 'quality_analyze' as const : 'continuity_validate' as const
        const action = scenario === 'quality' ? 'agent3HumanityCritic' : 'agent3ContinuityCritic'
        const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
          targetType: 'story_compilation', targetId: compilation.id, providerType: 'text', providerMode: 'custom', modelName: 'synthetic',
          action, requestTokens: 10, responseTokens: 10, usageSource: scenario === 'unknown' ? 'unknown' : scenario === 'estimated' ? 'estimated' : 'reported',
          billingStatus: scenario === 'null-billing' ? null : 'settled', durationMs: 10, createdAt: at(100) } })
        const payload = { toolName, callId: 'provider-review', args: { chapterId: scenario === 'wrong-target' ? 'other' : f.chapterId, compilationId: compilation.id } }
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload, createdAt: start } })
        if (scenario === 'duplicate') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', payload, createdAt: start } })
        const failedReport = scenario === 'quality' ? await prisma.chapterQualityReport.create({ data: {
          userId: f.userId, novelId: f.novelId, runId: f.runId, chapterId: f.chapterId, chapterRevision: 1,
          compilationId: compilation.id, status: 'failed', createdAt: at(500),
          deterministicMetrics: { criticResponse: { callId: 'provider-review' }, formatRecovery: { state: 'claimed' } },
        } }) : null
        const typed = ['typed', 'wrong-proof', 'extra-payment'].includes(scenario)
        await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 3, type: 'tool.result', createdAt: at(1000), payload: {
          toolName, callId: 'provider-review', ok: false, failureCode: typed ? 'UNEXPECTED_TOOL_ERROR' : 'AI_PROVIDER_EMPTY_RESPONSE',
          ...(typed ? { reviewRequestFinished: { version: 1, chapterId: f.chapterId, revision: 1,
            contentHash: scenario === 'wrong-proof' ? 'a'.repeat(64) : createHash('sha256').update('原文').digest('hex'), usageIds: [usage.id] } } : {}) } } })
        const terminal = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 4, type: 'run.paused', createdAt: at(1100), payload: {} } })
        if (scenario !== 'no-author') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 5, type: 'run.started', createdAt: at(scenario === 'early-author' ? 900 : 1200),
          payload: { authorContinue: { eventId: terminal.id, afterSeq: 4 } } } })
        if (scenario === 'overlap') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.call', createdAt: at(50), payload: { toolName: 'quality_analyze', callId: 'other' } } })
        if (scenario === 'extra-payment') await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
          targetType: 'chapter', targetId: f.chapterId, providerType: 'text', providerMode: 'custom', modelName: 'synthetic', action,
          requestTokens: 2, responseTokens: 1, usageSource: 'reported', billingStatus: 'settled', durationMs: 10, createdAt: at(200) } })
        const pending = [{ compilationId: compilation.id, chapterId: f.chapterId, revision: 1, toolName, callId: 'provider-review' }]
        const before = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
        const recovered = await prisma.$transaction(tx => readReviewRequestRecovery(tx, f, scenario === 'typed' ? [] : pending))
        expect(recovered).toHaveLength(['continuity', 'quality', 'typed'].includes(scenario) ? 1 : 0)
        if (recovered.length) expect(recovered[0].reconciliation).toMatchObject({ status: 'terminal_failed_billing_known', usageIds: [usage.id],
          admissionId: `author-continue:${terminal.id}`, currentRevision: 1, sourceReportId: failedReport?.id ?? null })
        if (failedReport) {
          expect(await prisma.$transaction(tx => hasReconciledQualityRequest(tx, f, failedReport))).toBe(false)
          await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 6, type: 'review.reconciled', createdAt: at(1300),
            payload: runtimeJson({ ...pending[0], receipt: recovered[0].reconciliation }).value } })
          expect(await prisma.$transaction(tx => hasReconciledQualityRequest(tx, f, failedReport))).toBe(true)
          expect(await prisma.$transaction(tx => hasReconciledQualityRequest(tx, f, { ...failedReport, id: 'wrong-report' }))).toBe(false)
          expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: failedReport.id } })).toEqual(failedReport)
        }
        expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toEqual(before)
        expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toEqual(usage)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})
