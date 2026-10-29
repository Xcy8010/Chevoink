import { expect, vi } from 'vitest'
import { currentReviewRepairResponse } from './current-review-repair-response.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { recordStoryCompilerWrite } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { readCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import * as ai from '../../api/lib/ai-service.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import * as titles from '../../api/lib/agent/session-title.js'
import { persistCurrentContinuityReport } from './current-continuity-report.js'
import { readContinuityReport } from '../../api/lib/agent/continuity-review.js'

type Subject = { userId: string; novelId: string; sessionId: string; runId: string; chapterId: string }

/** Existing PostgreSQL fixture, real registered handlers and body CAS. Only
 * provider bytes are synthetic. Historical records are supplied by the caller
 * and remain snapshots, never paid-phase authority for this execution. */
export async function continueCurrentReviewWorkflow(f: Subject, input: {
  compilationId: string; prompt: string; afterSeq: number; unknown?: boolean; missingCommit?: boolean; readFirst?: boolean; currentDecisions?: boolean; scenario?: string;
}) {
  vi.spyOn(memory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
  vi.spyOn(memory, 'syncNovelMemoryProjection').mockResolvedValue({ chapterCount: 0, jobCount: 0, entityCount: 0, relationCount: 0, reused: false })
  vi.spyOn(titles, 'autoNameSession').mockResolvedValue(undefined)
  const feature = flags.isAgent2FeatureEnabled
  if (!vi.isMockFunction(feature)) vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation((key, owner) => key === 'storyCompiler' || key !== 'memory2' && feature(key, owner))
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', provider: 'fixture', modelName: 'fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
    multiplierBps: 10000, reasoningEffort: 'high', reasoningEfforts: ['high'], reasoningParameterMode: 'native', thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 })
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live provider calls are forbidden in this fixture'))
  const original = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  // A current, author-owned saved revision contains an independently locatable
  // duplicate action. The critic must see its real source row; the repair must
  // delete that exact second paragraph through the normal quality CAS path.
  const originalSource = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: original.id, chapterRevision: original.revision }, original.content)
  const duplicated = original.content + '\n\n' + originalSource.entries.filter(entry => entry.text.trim()).at(-1)!.text
  if (!input.unknown && !input.missingCommit) {
    await prisma.chapter.update({ where: { id: original.id }, data: { content: duplicated, wordCount: duplicated.length, revision: { increment: 1 } } })
    await recordStoryCompilerWrite({ ...f, chapterOrderIndex: original.orderIndex, chapterRevision: original.revision + 1 })
  }
  if (input.missingCommit) await persistCurrentContinuityReport({ ...f, compilationId: input.compilationId })
  const account = await prisma.creditAccount.findUnique({ where: { userId: f.userId } })
    ?? await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000,
      periodStartedAt: credits.getCreditWindow().startedAt, periodEndsAt: credits.getCreditWindow().endsAt } })
  const beforeCharge = account.dailyUsedMilli
  const actions: string[] = []
  const modelFailures: unknown[] = []
  const critic = vi.spyOn(ai, 'generateTextCompletion').mockImplementation(async (_system, content, options) => {
    try {
    options.signal?.throwIfAborted()
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    actions.push(options.action)
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, agentRunId: f.runId, chapterId: f.chapterId,
      action: options.action, targetType: 'story_compilation', targetId: input.compilationId, providerType: 'text', providerMode: 'custom',
      modelName: 'fixture', modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8, usageSource: 'reported', billingStatus: 'settled',
      reservedCreditMilli: 0, creditChargeMilli: 7, durationMs: 0, billingEvidence: { responseObserved: true } } })
    await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: { increment: 7 } } })
    await prisma.creditLedgerEntry.create({ data: { userId: f.userId, kind: 'consume', sourceType: 'ai_usage', referenceId: usage.id,
      idempotencyKey: `current-recovery:${usage.id}`, deltaMilli: -7, dailyDeltaMilli: -7, modelTier: 'speed', multiplierBps: 10000, requestTokens: 12, responseTokens: 8 } })
    const trace = beginTextRequest(usage.id).record
    trace.status = 'terminal'; trace.billingKnown = true
    if (options.action === 'agent3HumanityCritic') {
      const source = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: chapter.id, chapterRevision: chapter.revision }, chapter.content)
      const repeated = chapter.content === duplicated ? source.entries.filter(entry => entry.text.trim()).at(-1) : null
      if (repeated) expect(content).toContain(repeated.id.slice(0, 13))
      const finalAdvice = input.currentDecisions && !repeated ? source.entries.filter(entry => entry.text.trim()).slice(0, 11).map((entry, index) => ({ signal: 'emotion_grounding', severity: 'advisory', sourceId: entry.id.slice(0, 13),
        explanation: `Current independent advice ${index + 1} for ${input.scenario ?? 'recovery'}.`, suggestion: 'Retain this actual passage for author judgment; no factual correction is implied.', confidence: 0.8 })) : []
      if (input.currentDecisions && !repeated) expect(finalAdvice).toHaveLength(11)
      return JSON.stringify({ findings: repeated ? [{ signal: 'explanation_echo', severity: 'warning', sourceId: repeated.id.slice(0, 13),
        explanation: 'This paragraph repeats the saved action without a new event.', suggestion: 'Remove this duplicate paragraph and retain the original action.', confidence: 0.99 }] : finalAdvice })
    }
    if (options.action === 'agent3HumanityRevision') {
      const findings = JSON.parse(content.slice(content.lastIndexOf('\n[') + 1)) as Array<{ findingId: string; evidence: string; start: number; end: number }>
      return currentReviewRepairResponse(original.content, duplicated, chapter.content, findings)
    }
    if (options.action === 'agent3ContinuityCritic') {
      if (!input.currentDecisions) return '{"findings":[]}'
      const request = JSON.parse(content), actual = request.sources.find((source: { source: string }) => source.source === 'current')
      const ids = [...actual.evidence.matchAll(/^q[a-f0-9]{12}/gm)].map(match => match[0]).slice(0, 4)
      expect(ids).toHaveLength(4)
      return JSON.stringify({ findings: ids.map((sourceId, index) => ({ signal: 'object', severity: 'error', explanation: `Current continuity opinion ${index + 1}; the author must decide its factual premise.`,
        suggestion: 'Retain the actual opinion without inventing a resolution.', evidence: [{ sourceId }] })) })
    }
    if (options.action === 'agent3ContinuityRevision' && input.currentDecisions) {
      const { findings } = JSON.parse(content) as { findings: Array<{ findingId: string }> }
      return JSON.stringify({ patches: [], retainedFindings: findings.map(finding => ({ findingId: finding.findingId,
        reason: 'The current passage remains an author decision; the model has no safe factual correction.' })) })
    }
    throw new Error('Unexpected auxiliary request: ' + options.action)
    } catch (error) { modelFailures.push(error); throw error }
  })
  const summary = input.missingCommit ? '当前任务没有提交权限，正文与历史检查原件保留，尚未完成提交。' : '已删除重复动作，最终版本已完成两项检查并实际提交。'
  const calls: string[] = []
  const main = vi.spyOn(ai, 'chatWithTools').mockImplementation(async request => {
    try {
    const last = [...request.messages].reverse().find(message => message.role === 'tool')
    let next: string | undefined
    let retainedFindings: Array<{ source: 'quality' | 'continuity'; reportId: string; findingId: string; reason: string }> | undefined
    if (input.missingCommit) return { content: summary, reasoning: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    if (!last || !calls.length) next = input.readFirst ? 'chapter_bridge_get' : 'quality_analyze'
    else if (last.toolCallId === 'current-recovery-chapter_bridge_get') next = 'quality_analyze'
    else if (last.toolCallId === 'current-recovery-quality_analyze') {
      expect(last.content).toContain('修订')
      next = 'continuity_validate'
    } else if (last.toolCallId === 'current-recovery-continuity_validate') {
      expect(last.content).toContain('报告')
      next = 'chapter_bridge_commit'
    } else {
      expect(['current-recovery-chapter_bridge_commit', 'current-recovery-retained-commit']).toContain(last.toolCallId)
      expect(last.content).toContain('提交')
      const raw = String(last.content).split('当前真实意见：')[1]
      if (raw) {
        let details: Array<{ source: 'quality' | 'continuity'; reportId: string; findingId: string }> | undefined
        for (let end = raw.indexOf(']'); end >= 0; end = raw.indexOf(']', end + 1)) {
          try { details = JSON.parse(raw.slice(0, end + 1)); break } catch { /* Read only the real returned array. */ }
        }
        expect(details?.length).toBeGreaterThan(0)
        if (input.currentDecisions) {
          const currentChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
          const quality = await prisma.chapterQualityReport.findFirstOrThrow({ where: { userId: f.userId, compilationId: input.compilationId,
            chapterId: f.chapterId, chapterRevision: currentChapter.revision }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { findings: true } })
          const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: input.compilationId } })
          const continuity = readContinuityReport(saved.validation, currentChapter)!
          expect(quality.findings.filter(finding => finding.explanation.includes('Current independent advice '))).toHaveLength(11)
          expect(continuity.findings).toHaveLength(4)
          const expected = [...quality.findings.filter(finding => finding.disposition !== 'repaired' && finding.authorFeedback !== 'rejected')
            .map(finding => `quality:${quality.id}:${finding.id}`), ...continuity.findings.map(finding => `continuity:${continuity.id}:${finding.id}`)].sort()
          const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, input.compilationId))
          // The failed commit projects mandatory references. This scenario
          // deliberately makes an explicit decision for every real opinion,
          // including the twelve nonblocking quality opinions, not just four
          // continuity errors. Read those from the complete current report.
          expect(details!.map(item => `${item.source}:${item.reportId}:${item.findingId}`).sort()).toEqual(
            readiness!.requiredDecisions!.map(item => `${item.source}:${item.reportId}:${item.findingId}`).sort())
          expect(readiness!.requiredDecisions).toHaveLength(4)
          expect(readiness!.requiredDecisions!.every(item => item.source === 'continuity')).toBe(true)
          details = readiness!.decisionDetails
          for (const finding of quality.findings.filter(item => item.disposition !== 'repaired' && item.authorFeedback !== 'rejected')) {
            expect(request.messages.some(message => message.role === 'tool' && String(message.content).includes(finding.id)
              && String(message.content).includes(finding.suggestion))).toBe(true)
          }
          expect(details!.map(item => `${item.source}:${item.reportId}:${item.findingId}`).sort()).toEqual(expected)
          expect(new Set(expected).size).toBe(expected.length)
        }
        retainedFindings = details!.map(({ source, reportId, findingId }) => ({ source, reportId, findingId,
          reason: '保留这项实际报告建议：本次只删除明确重复动作，保留其余叙事节奏，供作者继续判断；未声称该建议已修复。' }))
        next = 'chapter_bridge_commit'
      }
    }
    if (next) calls.push(next)
    return { content: next ? '' : summary, reasoning: '', toolCalls: next ? [{ id: retainedFindings ? 'current-recovery-retained-commit' : `current-recovery-${next}`, name: next,
      arguments: JSON.stringify({ compilationId: input.compilationId, ...(retainedFindings ? { retainedFindings } : {}) }) }] : [], finishReason: next ? 'tool_calls' : 'stop',
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10, promptCacheHitTokens: null, promptCacheMissTokens: null } }
    } catch (error) { modelFailures.push(error); throw error }
  })
  await executeAgentRun({ ...f, prompt: input.prompt, mode: 'build', resume: true, eventStartSeq: input.afterSeq,
    modelTier: 'speed', qualityMode: 'premium', creativeFreedom: 'balanced' })
  if (modelFailures.length) throw modelFailures[0]
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
  const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
  const compilation = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: input.compilationId }, include: { bridge: true } })
  const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId, seq: { gt: input.afterSeq } }, orderBy: { seq: 'asc' } })
  network.mockRestore()
  if (input.unknown) {
    expect(critic).not.toHaveBeenCalled(); expect(main).not.toHaveBeenCalled()
    expect(chapter).toEqual(original); expect(compilation.bridge!.committedAt).toBeNull()
    expect(run.status).toBe('paused')
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(beforeCharge)
  } else if (input.missingCommit) {
    expect(critic).not.toHaveBeenCalled(); expect(chapter).toEqual(original)
    expect(compilation.bridge!.committedAt).toBeNull(); expect(run.status).toBe('failed')
    expect(events.some(event => event.type === 'text.final' && (event.payload as { text: string }).text === summary)).toBe(true)
  } else {
    expect(chapter.revision).toBe(original.revision + 2)
    expect(chapter.content.trim()).toBe(original.content.trim())
    const repairRequests = critic.mock.calls.filter(([, , options]) => options.action === 'agent3HumanityRevision')
    expect(repairRequests.length).toBeGreaterThan(0)
    for (const [, , options] of repairRequests) expect(options).toMatchObject({ targetType: 'quality_report', targetId: expect.any(String) })
    expect(new Set(repairRequests.map(([, , options]) => options.targetId)).size).toBe(repairRequests.length)
    const applied = events.flatMap(event => {
      const payload = event.payload as { toolName?: string; display?: { appliedBodyChange?: unknown } }
      return event.type === 'tool.result' && payload.toolName === 'quality_analyze' && payload.display?.appliedBodyChange ? [payload.display.appliedBodyChange] : []
    })
    expect(applied).toEqual([expect.objectContaining({ chapterId: chapter.id, sourceRevision: original.revision + 1,
      targetRevision: chapter.revision, before: duplicated, after: chapter.content })])
    expect(run.status).toBe('completed'); expect(compilation.bridge!.committedAt).not.toBeNull()
    expect(calls.slice(0, input.readFirst ? 4 : 3)).toEqual([...(input.readFirst ? ['chapter_bridge_get'] : []), 'quality_analyze', 'continuity_validate', 'chapter_bridge_commit'])
    const readiness = await prisma.$transaction(tx => readChapterReviewReadiness(tx, f, input.compilationId))
    expect(readiness).toMatchObject({ ready: true, revision: chapter.revision, quality: 'complete', continuity: 'complete', terminalCommitted: true, decisionPending: false })
    if (input.currentDecisions) {
      const quality = await prisma.chapterQualityReport.findFirstOrThrow({ where: { compilationId: compilation.id, chapterRevision: chapter.revision },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { findings: true } })
      expect(quality.findings.filter(finding => finding.explanation.includes('Current independent advice '))).toHaveLength(11)
      expect(compilation.validation).toMatchObject({ continuityReport: { revision: chapter.revision, complete: true, findings: Array.from({ length: 4 }, () => expect.any(Object)) },
        retainedReviewDecision: { revision: chapter.revision } })
      const currentContinuity = readContinuityReport(compilation.validation, chapter)!
      const retained = (compilation.validation as unknown as { retainedReviewDecision: { findings: Array<{ source: string; reportId: string; findingId: string }> } }).retainedReviewDecision.findings
      expect(retained.map(item => `${item.source}:${item.reportId}:${item.findingId}`).sort()).toEqual([
        ...quality.findings.filter(finding => finding.disposition !== 'repaired' && finding.authorFeedback !== 'rejected').map(finding => `quality:${quality.id}:${finding.id}`),
        ...currentContinuity.findings.map(finding => `continuity:${currentContinuity.id}:${finding.id}`),
      ].sort())
    }
    expect(await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))).toMatchObject({ chapters: [{ id: chapter.id, revision: chapter.revision, content: chapter.content }] })
    expect(events.filter(event => event.type === 'tool.result' && (event.payload as { toolName: string; ok: boolean }).toolName === 'chapter_bridge_commit'
      && (event.payload as { ok: boolean }).ok)).toHaveLength(1)
    expect(events.some(event => event.type === 'text.final' && (/只输出标题和正文/u.test(input.prompt)
      ? (event.payload as { text: string }).text.includes(chapter.content.trim())
      : (event.payload as { text: string }).text === `已完成第${chapter.orderIndex}章《${chapter.title}》。\n\n${summary}`))).toBe(true)
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(beforeCharge + actions.length * 7)
  }
  return { run, chapter, compilation, events, actions, main, critic }
}
