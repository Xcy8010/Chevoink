import type { Prisma } from '@prisma/client'
import { env } from '../../config/env.js'

/** A queued or resumed task uses its admission decision, not today's channel. */
export function chapterReviewWorkflowEnabled(spec?: unknown): boolean {
  return env.appEnv !== 'production' || (spec as { scope?: { chapterReviewWorkflow?: unknown } } | undefined)?.scope?.chapterReviewWorkflow === 1
}

export async function canAdmitChapterReviewWorkflow(userId: string, tx: Prisma.TransactionClient): Promise<boolean> {
  return env.appEnv !== 'production' || await (await import('../app-releases.js')).hasChapterReviewWorkflowCapability(userId, tx)
}
