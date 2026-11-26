import type { Prisma } from '@prisma/client'
import { env } from '../../config/env.js'

/** A resumed task retains what was available when the author started it. */
export function sequentialWritingEnabled(spec?: unknown): boolean {
  return env.appEnv !== 'production' || (spec as { scope?: { sequentialWriting?: unknown } } | undefined)?.scope?.sequentialWriting === 1
}

export async function readAdmittedWritingWorkflows(userId: string, tx: Prisma.TransactionClient) {
  const availability = env.appEnv === 'production'
    ? await (await import('../app-releases.js')).readWritingWorkflowCapabilities(userId, tx)
    : { chapterReviewWorkflow: true, sequentialWriting: true }
  return {
    ...(availability.chapterReviewWorkflow ? { chapterReviewWorkflow: 1 as const } : {}),
    ...(availability.sequentialWriting ? { sequentialWriting: 1 as const } : {}),
  }
}

/** Plan folder actions live outside a writing task and use today's assignment. */
export async function chapterPlanOrderingEnabled(userId: string, tx: Prisma.TransactionClient): Promise<boolean> {
  return env.appEnv !== 'production' || (await (await import('../app-releases.js')).readWritingWorkflowCapabilities(userId, tx)).sequentialWriting
}
