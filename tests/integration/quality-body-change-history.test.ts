import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { AgentMessagePart } from '../../shared/contracts/index.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { listLoopSessionMessages } from '../../api/lib/agent/session-messages.js'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

describe.runIf(available)('owned historical automatic prose repair projection in PostgreSQL', () => {
  it.each(['all', 'paged'] as const)('projects %s history from the exact receipt while preserving current prose and original records', mode => fixture(async f => {
    const before = 'The old switch.', after = 'The replacement switch.', today = 'A later author revision.'
    await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null, status: 'paused' } })
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: today, wordCount: today.length, revision: 50 } })
    const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId, chapterId: f.chapterId,
      chapterRevision: 15, repairRound: 1, status: 'repaired', deterministicMetrics: { sourceRevision: 14, contentHash: hash(before), repairedContentHash: hash(after) },
      findings: { create: { userId: f.userId, novelId: f.novelId, signal: 'explanation_echo', source: 'critic', severity: 'advisory', startOffset: 4, endOffset: 7,
        evidenceExcerpt: 'old', evidenceHash: hash('old'), explanation: 'Synthetic fixture.', suggestion: 'Synthetic fixture.', disposition: 'repaired' } } }, include: { findings: true } })
    await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'rewriteSelection', title: 'Synthetic repair', content: JSON.stringify([{ findingId: report.findings[0].id, replacement: 'replacement' }]),
      metadata: { phase: 'humanity_revision_auto', reportId: report.id, findingIds: [report.findings[0].id], sourceRevision: 14, targetRevision: 15 } } })
    const part: Extract<AgentMessagePart, { type: 'tool-call' }> = { type: 'tool-call', callId: 'historical-repair', toolName: 'quality_analyze', title: 'Quality', args: {}, status: 'success',
      display: { kind: 'qualityReport', reportId: report.id, chapterId: f.chapterId, chapterRevision: 15, repairRound: 1, status: 'repaired', findings: [] },
      snapshot: { target: 'chapter', targetId: f.chapterId, field: 'content', previousValue: before } }
    const saved = await prisma.agentMessage.create({ data: { runId: f.runId, sessionId: f.sessionId, role: 'assistant', parts: [part] as unknown as Prisma.InputJsonValue } })
    const result = await listLoopSessionMessages(f.userId, f.sessionId, mode === 'paged' ? { runLimit: 1 } : {})
    expect(result.messages.find(message => message.id === saved.id)?.parts).toMatchObject([{ type: 'tool-call', display: { kind: 'qualityReport',
      appliedBodyChange: { chapterId: f.chapterId, before, after, sourceRevision: 14, targetRevision: 15 } } }])
    expect(JSON.parse(JSON.stringify(result.messages.find(message => message.id === saved.id)?.parts[0]))).not.toHaveProperty('snapshot')
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: saved.id } })).parts).toEqual(saved.parts)
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe(today)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: f.runId } })).toBe(0)
    await expect(listLoopSessionMessages('another-owner', f.sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }))
})
