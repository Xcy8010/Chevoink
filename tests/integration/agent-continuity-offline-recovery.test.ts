import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readOfflineContinuityRecovery } from '../../api/lib/agent/continuity-offline-recovery.js'
import * as offline from '../../api/lib/agent/continuity-offline-recovery.js'
import { prepareStoryCompilation, saveSceneTasks } from '../../api/lib/agent/story-compiler.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import * as review from '../../api/lib/agent/review-completion.js'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { buildContinuitySnapshot } from '../../api/lib/agent/continuity-review.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('owned returned continuity bytes on genuine legacy author continuation', () => {
  it.each(['marker-valid', 'marker-race', 'marker-hash', 'marker-admission', 'marker-revision', 'marker-validation', 'marker-complete', 'marker-foreign', 'marker-foreign-chapter', 'marker-standalone', 'marker-error', 'marker-in-args', 'recover', 'tool-recover', 'tool-race', 'tool-error', 'stale-body', 'stale-source', 'changed-source-same-revision', 'changed-title', 'changed-bridge', 'changed-scene', 'focus', 'raw-tamper', 'raw-length', 'raw-incomplete', 'wrong-parser', 'wrong-class', 'no-author', 'early-author', 'paused', 'native', 'wrong-scope', 'unknown', 'pending', 'estimated', 'reserved', 'no-response', 'extra-payment', 'duplicate', 'duplicate-result', 'wrong-code', 'current-foreign', 'current-result', 'guessed-call', 'current-usage', 'other-inflight', 'later-failure', 'prepared', 'dispatching', 'dispatched', 'provider-unknown', 'already-recovered', 'race'] as const)(
    '%s cannot reinterpret old work, dispatch a model, reset counters or alter original raw/charges', scenario => fixture(async f => {
      try {
        await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'running', startRequest: { prompt: '修改本章' } } })
        const chapter = await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 4, content: '甲'.repeat(1800) + '当前唯一引文\n含"转义"。' + '乙'.repeat(350) } })
        const previous = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: chapter.volumeId, orderIndex: 0, orderInVolume: 0,
          title: '前章', revision: 23, content: '前章唯一证据。', wordCount: 7 } })
        const { compilation } = await prepareStoryCompilation({ ...f, mode: 'balanced', intentSummary: '修改本章' })
        const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
        await saveSceneTasks({ ...f, compilationId: compilation.id, tasks: [{ purpose: '推进场景', entryState: state, goal: '找门', obstacle: '门锁', choice: '等候', cost: '时间', turn: '开门', exitState: state,
          styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
        const current = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
        const source = await readCompilerContinuitySource(prisma, f, chapter, current.bridge!.fromChapterId)
        const coverage = compilerContinuityCoverage({ chapter, bridge: current.bridge, sceneTasks: current.sceneTasks, source })
        const raw = JSON.stringify({ findings: Array.from({ length: 4 }, (_, index) => ({ signal: 'object', severity: 'error', evidence: '原判断' + index, suggestion: '原建议' + index,
          sourceEvidence: [{ source: 'previous', segmentId: 'p0', quote: '前章唯一证据' }, { source: 'current', segmentId: index === 1 ? 'c5' : 'c6', quote: '当前唯一引文\n含"转义"。' }] })) })
        const audit = inspectContinuityResponse(raw, { previous: previous.content, current: chapter.content }).audit
        expect(audit.classification).toBe('findings_invalid')
        const start = new Date(Date.now() + 1000), at = (n: number) => new Date(start.getTime() + n)
        const event = (seq: number, type: string, payload: object, n: number) => prisma.agentRunEvent.create({ data: { runId: f.runId, seq, type, payload: runtimeJson(payload).value, createdAt: at(n) } })
        const oldCall = { toolName: 'continuity_validate', callId: 'original-returned', args: { compilationId: compilation.id, chapterId: chapter.id } }
        await event(1, 'tool.call', oldCall, 0)
        if (scenario === 'duplicate') await event(2, 'tool.call', oldCall, 1)
        await event(3, 'tool.result', { toolName: 'continuity_validate', callId: oldCall.callId, ok: false, failureCode: scenario === 'wrong-code' ? 'AI_PROVIDER_UNKNOWN' : 'CONTINUITY_REPORT_INCOMPLETE' }, 1000)
        if (scenario === 'duplicate-result') await event(2, 'tool.result', { toolName: 'continuity_validate', callId: oldCall.callId, ok: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }, 999)
        const stop = await event(4, 'run.paused', { reason: 'needs_input' }, 1100)
        if (scenario !== 'no-author') await event(5, 'run.started', { authorContinue: { eventId: stop.id, afterSeq: 4 } }, scenario === 'early-author' ? 900 : 1200)
        await event(6, 'tool.call', { toolName: 'continuity_validate', callId: 'current-call', args: { compilationId: scenario === 'current-foreign' ? 'foreign' : compilation.id, chapterId: chapter.id } }, 1300)
        if (scenario === 'current-result') await event(7, 'tool.result', { toolName: 'continuity_validate', callId: 'current-call', ok: false }, 1400)
        if (scenario === 'other-inflight' || scenario === 'later-failure') {
          await event(8, 'tool.call', { ...oldCall, callId: 'another-call' }, 1150)
          if (scenario === 'later-failure') await event(9, 'tool.result', { toolName: 'continuity_validate', callId: 'another-call', ok: false, failureCode: 'CONTINUITY_REPORT_INCOMPLETE' }, 1190)
        }
        const usageData = { userId: f.userId, novelId: f.novelId, targetType: 'story_compilation', targetId: compilation.id,
          providerType: 'text' as const, providerMode: 'custom' as const, modelName: 'synthetic-no-network', action: 'agent3ContinuityCritic', requestTokens: 10, responseTokens: 8,
          billingStatus: 'settled', usageSource: 'reported', billingEvidence: { responseObserved: true }, reservedCreditMilli: 0, durationMs: 20, createdAt: at(500) }
        await prisma.aiUsageLog.create({ data: { ...usageData,
          ...(['unknown', 'pending'].includes(scenario) ? { usageSource: 'unknown', billingStatus: 'pending_usage' } : {}),
          ...(scenario === 'estimated' ? { usageSource: 'estimated' } : {}), ...(scenario === 'reserved' ? { reservedCreditMilli: 1 } : {}),
          ...(scenario === 'no-response' ? { billingEvidence: { responseObserved: false } } : {}) } })
        if (scenario === 'extra-payment' || scenario === 'current-usage') await prisma.aiUsageLog.create({ data: { ...usageData, createdAt: at(scenario === 'current-usage' ? 1350 : 600) } })
        const validation = { coverage, findings: [], checkedAt: at(900).toISOString(), checkRounds: 3, autoRepairRounds: 0, reviewFocus: '', checkedRevision: 4,
          checkedChapterId: chapter.id, independentCheck: 'unavailable', continuityCriticResponse: audit, errorCount: 0, warningCount: 0 }
        await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation,
          ...(scenario === 'already-recovered' ? { continuityFormatRecovery: { version: 1 } } : {}),
          ...(scenario.startsWith('raw-') || scenario.startsWith('wrong-p') || scenario === 'wrong-class' ? { continuityCriticResponse: { ...audit,
            ...(scenario === 'raw-tamper' ? { contentHash: 'a'.repeat(64) } : {}), ...(scenario === 'raw-length' ? { characterCount: raw.length + 1 } : {}),
            ...(scenario === 'raw-incomplete' ? { rawResponse: { ...audit.rawResponse, complete: false } } : {}),
            ...(scenario === 'wrong-parser' ? { parserVersion: 2 } : {}), ...(scenario === 'wrong-class' ? { classification: 'json_invalid' } : {}) } } : {}) }).value } })
        if (scenario === 'stale-body') await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5 } })
        if (scenario === 'changed-title') await prisma.chapter.update({ where: { id: chapter.id }, data: { title: '新标题' } })
        if (scenario === 'stale-source' || scenario === 'changed-source-same-revision') await prisma.chapter.update({ where: { id: previous.id }, data: { content: '新的前章内容', ...(scenario === 'stale-source' ? { revision: 24 } : {}) } })
        if (scenario === 'changed-bridge') await prisma.chapterBridge.update({ where: { compilationId: compilation.id }, data: { location: '新的地点' } })
        if (scenario === 'changed-scene') await prisma.sceneTask.update({ where: { id: current.sceneTasks[0].id }, data: { goal: '新的目标' } })
        if (scenario === 'paused' || scenario === 'native') await prisma.agentRun.update({ where: { id: f.runId }, data: scenario === 'paused' ? { status: 'paused' } : { taskRootId: f.rootId } })
        if (scenario === 'wrong-scope') await prisma.agentRun.update({ where: { id: f.runId }, data: { taskSpec: runtimeJson({ ...JSON.parse(JSON.stringify(f.spec)), scope: { ...JSON.parse(JSON.stringify(f.spec.scope)), writing: { version: 1, kind: 'bounded', targets: [{ chapterId: 'foreign', orderIndex: 99 }], repairAuthorized: false, titleAndBodyOnly: false } } }).value } })
        if (['prepared', 'dispatching', 'dispatched', 'provider-unknown'].includes(scenario)) {
          const operationId = randomUUID()
          await prisma.agentOperation.create({ data: { id: operationId, taskRootId: f.rootId, originRunId: f.runId, operationKey: 'unresolved', kind: 'provider', action: 'review', inputHash: 'a'.repeat(64) } })
          await prisma.agentProviderAttempt.create({ data: { id: randomUUID(), operationId, runId: f.runId, ownerEpoch: 1, attemptKey: 'unresolved', provider: 'fixture', model: 'fixture', requestHash: 'a'.repeat(64), status: scenario === 'provider-unknown' ? 'unknown' : scenario } })
        }
        const subject = { ...f, callId: scenario === 'guessed-call' ? 'guessed' : 'current-call' }, input = { compilationId: compilation.id, ...(scenario === 'focus' ? { focus: '新范围' } : {}) }
        const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } }), bodiesBefore = await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } }), usageBefore = await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })
        const model = vi.spyOn(review, 'generateReviewCompletion').mockRejectedValue(new Error('No model permitted in offline test'))
        const proof = await prisma.$transaction(tx => readOfflineContinuityRecovery(tx, subject, input))
        const readable = scenario.startsWith('marker-') || ['recover', 'tool-recover', 'tool-race', 'tool-error', 'race'].includes(scenario)
        if (readable) {
          expect(proof).not.toBeNull(); expect(proof!.findings).toHaveLength(4)
          expect(proof!.audit.sourceRelocations).toHaveLength(1)
        } else expect(proof).toBeNull()
        expect(offline).not.toHaveProperty('applyOfflineContinuityRecovery')
        expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(before)
        expect(model).not.toHaveBeenCalled()
        if (readable && scenario.startsWith('marker-')) {
          const marker = { version: 1, compilationId: compilation.id, chapterId: chapter.id, revision: 4,
            contentHash: proof!.coverage.contentHash, receiptContentHash: createHash('sha256').update(chapter.content).digest('hex'),
            admissionKey: proof!.audit.admissionKey, validationHash: proof!.validationHash, auditHash: runtimeJson(proof!.audit).hash }
          if (scenario === 'marker-hash') marker.auditHash = 'a'.repeat(64)
          if (scenario === 'marker-admission') marker.admissionKey = 'foreign-author-proof'
          if (scenario === 'marker-foreign') marker.compilationId = 'foreign'
          if (scenario === 'marker-foreign-chapter') marker.chapterId = 'foreign'
          // Former context markers are history, never model-supplied write authority.
          const normalized = continuityValidateTool.parameters.parse({ compilationId: compilation.id, offlineContinuityOnly: marker })
          expect(normalized).toHaveProperty('offlineContinuityOnly', marker)
          const snapshot = await buildContinuitySnapshot({ ...f, callId: 'read-current-scope', mode: 'build', qualityMode: 'balanced',
            creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} } as ToolContext, normalized)
          expect(snapshot).not.toHaveProperty('offlineContinuityOnly')
          expect(snapshot.chapter.id).toBe(chapter.id)
          expect(await prisma.$transaction(tx => readOfflineContinuityRecovery(tx, subject, input))).toEqual(proof)
        }
        if (['marker-race', 'marker-revision', 'tool-race'].includes(scenario)) {
          await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5, content: '作者并发保存的新正文' } })
          expect(await prisma.$transaction(tx => readOfflineContinuityRecovery(tx, subject, input))).toBeNull()
        } else if (scenario === 'race' || scenario === 'marker-validation' || scenario === 'marker-complete') {
          await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation,
            ...(scenario === 'marker-complete' ? { independentCheck: 'complete', findings: proof!.findings } : { checkRounds: 4 }) }).value } })
          const concurrent = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
          const rechecked = await prisma.$transaction(tx => readOfflineContinuityRecovery(tx, subject, input))
          if (scenario === 'marker-complete') expect(rechecked).toBeNull()
          else expect(rechecked!.validationHash).not.toBe(proof!.validationHash)
          expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(concurrent)
        } else if (scenario === 'marker-error' || scenario === 'tool-error') {
          await expect(prisma.$transaction(tx => readOfflineContinuityRecovery({ ...tx,
            storyCompilation: { ...tx.storyCompilation, findFirst: async () => { throw Error('fixture database connection failure') } } } as unknown as typeof tx,
          subject, input))).rejects.toThrow('fixture database connection failure')
        } else if (scenario === 'tool-recover') {
          const history = await prisma.agentArtifact.create({ data: { content: 'Frozen synthetic test evidence.', runId: f.runId, artifactType: 'continuityReview',
            title: 'Frozen offline report', metadata: runtimeJson(before.validation).value } })
          const currentReport = await persistCurrentContinuityReport({ ...f, compilationId: compilation.id, expectedChapterRevision: 4 })
          expect(currentReport.result).toMatchObject({ reviewCompleted: true })
          expect(currentReport.validation).toHaveProperty('continuityReport')
          expect(currentReport.validation).not.toHaveProperty('continuityFormatRecovery')
          expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history)
          await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5 } })
          const fresh = await persistCurrentContinuityReport({ ...f, compilationId: compilation.id, expectedChapterRevision: 5, focus: '新检查范围' })
          expect(fresh.validation).toMatchObject({ checkedRevision: 5, continuityReport: { revision: 5, focus: '新检查范围' } })
          expect(await prisma.agentArtifact.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history)
        }
        if (!['tool-recover', 'tool-race', 'marker-revision', 'marker-race'].includes(scenario))
          expect(await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })).toEqual(bodiesBefore)
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(usageBefore)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})
