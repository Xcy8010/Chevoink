import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { readStandalonePriorQualityJudgment } from '../../api/lib/agent/standalone-quality-history.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('standalone quality historical judgment ownership in PostgreSQL', () => {
  it('selects an actual older assessment from this task, excluding newer current, failed and unrelated-task reports', () => fixture(async f => {
    const content = '当前合成正文。', hash = createHash('sha256').update('旧合成正文。').digest('hex')
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content, revision: 5 } })
    const otherRun = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId,
      chapterId: f.chapterId, sessionId: f.sessionId, status: 'paused', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator',
      engine: 'loop', taskSpec: { ...JSON.parse(JSON.stringify(f.spec)), id: 'other-task' } } })
    const own = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId,
      chapterId: f.chapterId, runId: f.runId, chapterRevision: 5, status: 'stale', checkedAt: new Date('2026-01-01'),
      deterministicMetrics: { independentCheck: 'complete', sourceRevision: 4, contentHash: hash },
      findings: { create: { userId: f.userId, novelId: f.novelId, signal: 'explanation_echo', source: 'critic', severity: 'advisory',
        startOffset: 0, endOffset: 3, evidenceExcerpt: '旧合成', evidenceHash: createHash('sha256').update('旧合成').digest('hex'),
        explanation: '旧版表达建议。', suggestion: '保留作者声音。', disposition: 'repaired' } } } })
    for (const candidate of [{ runId: otherRun.id, chapterRevision: 4, status: 'stale' as const, complete: true },
      { runId: f.runId, chapterRevision: 5, status: 'passed' as const, complete: true },
      { runId: f.runId, chapterRevision: 4, status: 'failed' as const, complete: false }]) {
      await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId,
        runId: candidate.runId, chapterRevision: candidate.chapterRevision, status: candidate.status, checkedAt: new Date('2026-02-01'),
        deterministicMetrics: { independentCheck: candidate.complete ? 'complete' : 'unavailable', contentHash: hash } } })
    }
    const result = await readStandalonePriorQualityJudgment(prisma, f, { id: f.chapterId, revision: 5 })
    expect(result).toMatchObject({ taskId: f.rootId, reportId: own.id, reportRevision: 5, sourceRevision: 4,
      sourceContentHash: hash, sourceContentStatus: 'not_recorded', findings: [{ severity: 'advisory', disposition: 'repaired' }] })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(content)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(0)
  }))
})
