import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readOfflineContinuityRecovery, applyOfflineContinuityRecovery } from '../../api/lib/agent/continuity-offline-recovery.js'
import * as offline from '../../api/lib/agent/continuity-offline-recovery.js'
import { prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as review from '../../api/lib/agent/review-completion.js'
import * as compiler from '../../api/lib/agent/story-compiler.js'
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
        const source = await readCompilerContinuitySource(prisma, f, chapter, current.bridge.fromChapterId)
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
          providerType: 'text', providerMode: 'custom', modelName: 'synthetic-no-network', action: 'agent3ContinuityCritic', requestTokens: 10, responseTokens: 8,
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
        const reserve = vi.spyOn(compiler, 'reserveContinuityCheck')
        const proof = await prisma.$transaction(tx => readOfflineContinuityRecovery(tx, subject, input))
        if (['marker-valid', 'marker-race', 'marker-hash', 'marker-admission', 'marker-revision', 'marker-validation', 'marker-complete', 'marker-foreign', 'marker-foreign-chapter', 'marker-standalone', 'marker-error', 'marker-in-args', 'recover', 'tool-recover', 'tool-race', 'tool-error', 'race'].includes(scenario) || scenario.startsWith('marker-')) {
          expect(proof).not.toBeNull()
          expect(proof!.findings).toHaveLength(4)
          expect(proof!.audit.sourceRelocations).toHaveLength(1)
          if (scenario.startsWith('marker-')) {
            const marker: NonNullable<ToolContext['offlineContinuityOnly']> = { version: 1, compilationId: compilation.id, chapterId: chapter.id, revision: 4,
              contentHash: proof!.coverage.contentHash, receiptContentHash: createHash('sha256').update(chapter.content).digest('hex'),
              admissionKey: proof!.audit.admissionKey, validationHash: proof!.validationHash, auditHash: runtimeJson(proof!.audit).hash }
            if (scenario === 'marker-revision') await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5 } })
            if (scenario === 'marker-validation') await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation, checkRounds: 4 }).value } })
            if (scenario === 'marker-complete') await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation, independentCheck: 'complete', findings: proof!.findings }).value } })
            if (scenario === 'marker-hash') marker.auditHash = 'a'.repeat(64)
            if (scenario === 'marker-admission') marker.admissionKey = 'foreign-author-proof'
            const targetInput = scenario === 'marker-foreign' ? { compilationId: 'foreign', chapterId: chapter.id }
              : scenario === 'marker-foreign-chapter' ? { ...input, chapterId: 'foreign' } : scenario === 'marker-standalone' ? { chapterId: chapter.id } : input
            const ctx: ToolContext = { ...subject, chapterId: f.chapterId, mode: 'build', qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {},
              ...(scenario === 'marker-in-args' ? {} : { offlineContinuityOnly: marker }) }
            const beforeTool = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
            let beforeBodies = await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })
            if (scenario === 'marker-race') {
              const originalApply = offline.applyOfflineContinuityRecovery
              vi.spyOn(offline, 'applyOfflineContinuityRecovery').mockImplementationOnce(async (...args) => {
                await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5, content: '作者在 marker 复核后保存的新正文' } })
                beforeBodies = await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })
                return originalApply(...args)
              })
            }
            if (scenario === 'marker-in-args') {
              // A model can mention the field, but tool schema strips it and
              // no server context marker is minted from it.
              const normalized = continuityValidateTool.parameters.parse({ ...targetInput, offlineContinuityOnly: marker })
              expect(normalized).not.toHaveProperty('offlineContinuityOnly')
              expect(await continuityValidateTool.execute(ctx, normalized)).toMatchObject({ summary: expect.stringContaining('离线复用') })
              expect(ctx.offlineContinuityOnly).toBeUndefined()
            } else if (scenario === 'marker-error') {
              vi.spyOn(offline, 'readOfflineContinuityRecovery').mockRejectedValueOnce(new Error('fixture ordinary database error'))
              await expect(continuityValidateTool.execute(ctx, targetInput)).rejects.toThrow('fixture ordinary database error')
              expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(beforeTool)
            } else {
              const result = await continuityValidateTool.execute(ctx, targetInput)
              if (scenario === 'marker-valid') {
                expect(result).toMatchObject({ summary: expect.stringContaining('离线复用'), display: { errorCount: 4 } })
                expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toMatchObject({ checkedAt: validation.checkedAt, checkRounds: 3,
                  autoRepairRounds: 0, continuityCriticResponse: audit, independentCheck: 'complete', findings: proof!.findings })
              } else {
                expect(result).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_INPUT_STALE',
                  reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: 4, contentHash: marker.receiptContentHash } })
                expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(beforeTool)
              }
            }
            expect(await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })).toEqual(beforeBodies)
          } else if (scenario === 'tool-race' || scenario === 'tool-error') {
            const originalApply = offline.applyOfflineContinuityRecovery
            let concurrentBodies = bodiesBefore
            vi.spyOn(offline, 'applyOfflineContinuityRecovery').mockImplementationOnce(async (...args) => {
              if (scenario === 'tool-error') throw new Error('fixture database connection failure')
              await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '作者并发保存的新正文', revision: 5 } })
              concurrentBodies = await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })
              return originalApply(...args)
            })
            const ctx: ToolContext = { ...subject, chapterId: f.chapterId, mode: 'build', qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} }
            if (scenario === 'tool-error') await expect(continuityValidateTool.execute(ctx, input)).rejects.toThrow('fixture database connection failure')
            else expect(await continuityValidateTool.execute(ctx, input)).toMatchObject({ outcome: 'failed', failureCode: 'CONTINUITY_INPUT_STALE',
              summary: '本章在离线恢复前发生变化', reviewRequestFinished: { version: 1, chapterId: chapter.id, revision: 4, contentHash: createHash('sha256').update(chapter.content).digest('hex') } })
            expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(before)
            expect(await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })).toEqual(concurrentBodies)
          } else if (scenario === 'race') {
            await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: runtimeJson({ ...validation, checkRounds: 4 }).value } })
            await expect(prisma.$transaction(tx => applyOfflineContinuityRecovery(tx, subject, input, proof!))).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
            expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).validation).toMatchObject({ independentCheck: 'unavailable', checkRounds: 4 })
          } else {
            if (scenario === 'tool-recover') {
              const ctx: ToolContext = { ...subject, chapterId: f.chapterId, mode: 'build', qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} }
              expect(await continuityValidateTool.execute(ctx, input)).toMatchObject({ summary: expect.stringContaining('离线复用'), display: { errorCount: 4 } })
            } else expect(await prisma.$transaction(tx => applyOfflineContinuityRecovery(tx, subject, input, proof!))).toMatchObject({ independentCheck: 'complete', errorCount: 4 })
            const after = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
            expect(after.validation).toMatchObject({ checkedAt: validation.checkedAt, checkRounds: 3, autoRepairRounds: 0, continuityCriticResponse: audit,
              independentCheck: 'complete', findings: expect.arrayContaining(proof!.findings), continuityFormatRecovery: { parserVersion: 4, originalParserVersion: 3, sourceCallId: oldCall.callId } })
            expect(await prisma.$transaction(tx => readOfflineContinuityRecovery(tx, subject, input))).toBeNull()
            if (scenario === 'tool-recover') {
              const ctx: ToolContext = { ...subject, chapterId: f.chapterId, mode: 'build', qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} }
              expect(await continuityValidateTool.execute(ctx, input)).toMatchObject({ summary: expect.stringContaining('复用') })
              const cached = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
              expect(cached.validation).toEqual(after.validation)
              expect(await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })).toEqual(bodiesBefore)
              // A genuinely new revision/focus is a new report; recovery audit
              // cannot travel with old bytes into a different reviewed input.
              await prisma.chapter.update({ where: { id: chapter.id }, data: { revision: 5 } })
              await validateStoryContinuity({ ...f, compilationId: compilation.id, findings: proof!.findings, independentCheck: 'complete', expectedChapterRevision: 5, focus: '新检查范围' })
              const fresh = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })
              expect(fresh.validation).not.toHaveProperty('continuityFormatRecovery')
              expect(fresh.validation).not.toHaveProperty('continuityCriticResponse')
              expect(fresh.validation).toMatchObject({ checkRounds: 3, autoRepairRounds: 0, checkedRevision: 5 })
            }
          }
        } else { expect(proof).toBeNull(); expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).toEqual(before) }
        expect(model).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled()
        if (!['tool-recover', 'tool-race', 'marker-revision', 'marker-race'].includes(scenario)) expect(await prisma.chapter.findMany({ where: { authorId: f.userId }, orderBy: { id: 'asc' } })).toEqual(bodiesBefore)
        expect(await prisma.aiUsageLog.findMany({ where: { userId: f.userId }, orderBy: { id: 'asc' } })).toEqual(usageBefore)
      } finally { await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } }) }
    }))
})
