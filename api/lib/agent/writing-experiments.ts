import { createHash } from 'node:crypto'

import type { Prisma, WritingExperimentKind } from '@prisma/client'
import type { AdminAgent3OperationsMetrics } from '../../../shared/contracts/index.js'

import { isAgent2FeatureEnabled } from '../agent2-feature-flags.js'
import { prisma } from '../prisma.js'

type WritingSignal = 'prototype_created' | 'quality_feedback_accepted' | 'quality_feedback_rejected' | 'quality_revision_round' | 'chapter_published' | 'first_three_published' | 'continued_after_seven_days'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

function readCounters(value: Prisma.JsonValue): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'number' && Number.isFinite(item) ? [[key, item]] : []))
}

async function analyticsEnabled(userId: string, novelId: string, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  if (!isAgent2FeatureEnabled('feedbackFlywheel', userId)) return false
  const control = await db.agentDataControl.findUnique({ where: { userId_novelId: { userId, novelId } }, select: { productAnalyticsEnabled: true } })
  return control?.productAnalyticsEnabled ?? true
}

export async function ensureWritingExperiment(input: {
  userId: string
  novelId: string
  kind: WritingExperimentKind
  subjectId: string
  arm: string
  exposure: Record<string, string | number | boolean>
}, db: Prisma.TransactionClient = prisma) {
  if (!await analyticsEnabled(input.userId, input.novelId, db)) return null
  const subjectHash = hash(`${input.kind}:${input.userId}:${input.novelId}:${input.subjectId}`)
  const existing = await db.writingExperiment.findFirst({ where: { userId: input.userId, novelId: input.novelId, kind: input.kind, subjectHash, status: 'active' } })
  if (existing) return existing
  return db.writingExperiment.create({
    data: {
      userId: input.userId,
      novelId: input.novelId,
      kind: input.kind,
      subjectHash,
      arm: input.arm,
      featureVersions: { research: 'dossier.v1', prototype: 'first-three.v1', quality: 'humanity-critic.v2-auto' },
      exposure: input.exposure as Prisma.InputJsonValue,
      outcomes: {} as Prisma.InputJsonValue,
      consentSnapshot: { productAnalyticsEnabled: true, rawTextStored: false, anonymized: true },
    },
  })
}

export async function recordWritingSignal(userId: string, novelId: string, signal: WritingSignal, amount = 1, db: Prisma.TransactionClient = prisma): Promise<void> {
  if (!await analyticsEnabled(userId, novelId, db)) return
  const experiments = await db.writingExperiment.findMany({ where: { userId, novelId, status: 'active' } })
  await Promise.all(experiments.map((experiment) => {
    const counters = readCounters(experiment.outcomes)
    if (['first_three_published', 'continued_after_seven_days'].includes(signal) && (counters[signal] ?? 0) > 0) return Promise.resolve(experiment)
    counters[signal] = (counters[signal] ?? 0) + amount
    const completes = signal === 'first_three_published'
    return db.writingExperiment.update({
      where: { id: experiment.id },
      data: { outcomes: counters as Prisma.InputJsonValue, ...(completes ? { status: 'completed' as const, completedAt: new Date() } : {}) },
    })
  }))
}

export async function recordSevenDayContinuation(userId: string, novelId: string): Promise<void> {
  const novel = await prisma.novel.findFirst({ where: { id: novelId, authorId: userId }, select: { createdAt: true } })
  if (novel && novel.createdAt <= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
    await recordWritingSignal(userId, novelId, 'continued_after_seven_days')
  }
}

export async function getAgent3OperationsMetrics(): Promise<AdminAgent3OperationsMetrics> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const [dossiers, prototypeGroups, experimentGroups, controls, shareGroups] = await Promise.all([
    prisma.researchDossier.findMany({ where: { createdAt: { gte: since } }, select: { searchCount: true, reusedCount: true, estimatedInputTokens: true, buildDurationMs: true } }),
    prisma.firstThreePrototype.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.writingExperiment.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.agentDataControl.findMany({ select: { productAnalyticsEnabled: true, publicCorpusOptIn: true } }),
    prisma.skillShareInvite.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ])
  const builds = dossiers.length
  const reuses = dossiers.reduce((sum, item) => sum + item.reusedCount, 0)
  const totalUses = builds + reuses
  const prototypeCount = prototypeGroups.reduce((sum, item) => sum + item._count._all, 0)
  const prototypeCompleted = prototypeGroups.find((item) => item.status === 'completed')?._count._all ?? 0
  const experimentCount = (status: 'active' | 'completed' | 'withdrawn') => experimentGroups.find((item) => item.status === status)?._count._all ?? 0
  const shareCount = (statuses: string[]) => shareGroups.filter((item) => statuses.includes(item.status)).reduce((sum, item) => sum + item._count._all, 0)
  return {
    windowDays: 30,
    research: {
      builds,
      reuses,
      reuseRate: totalUses === 0 ? 0 : reuses / totalUses,
      averageSearchesPerBuild: builds === 0 ? 0 : dossiers.reduce((sum, item) => sum + item.searchCount, 0) / builds,
      averageInputTokensPerBuild: builds === 0 ? 0 : dossiers.reduce((sum, item) => sum + item.estimatedInputTokens, 0) / builds,
      averageBuildDurationMs: builds === 0 ? 0 : dossiers.reduce((sum, item) => sum + item.buildDurationMs, 0) / builds,
      queryBudgetViolations: dossiers.filter((item) => item.searchCount > 3).length,
    },
    prototypes: { total: prototypeCount, completed: prototypeCompleted, completionRate: prototypeCount === 0 ? 0 : prototypeCompleted / prototypeCount },
    experiments: { active: experimentCount('active'), completed: experimentCount('completed'), withdrawn: experimentCount('withdrawn') },
    privacy: { configuredNovels: controls.length, analyticsOptOut: controls.filter((item) => !item.productAnalyticsEnabled).length, publicCorpusOptIn: controls.filter((item) => item.publicCorpusOptIn).length },
    sharing: { pending: shareCount(['pending']), accepted: shareCount(['accepted']), expiredOrDeclined: shareCount(['expired', 'declined', 'revoked']) },
  }
}
