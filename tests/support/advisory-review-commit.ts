import { expect } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { commitChapterBridge } from '../../api/lib/agent/story-compiler.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

/** Ordinary commit saves the owned revision. Missing/stale/failed reports stay
 * exactly as observed and cannot become a fabricated successful check. */
export async function commitWithAdvisoryReviewFacts(input: Parameters<typeof commitChapterBridge>[0]) {
  const runId = input.runId ?? (await prisma.storyCompilation.findUniqueOrThrow({ where: { id: input.compilationId } })).runId
  expect(runId).not.toBeNull()
  const subject = { userId: input.userId, novelId: input.novelId, runId: runId! }
  const read = () => prisma.$transaction(tx => readChapterReviewReadiness(tx, subject, input.compilationId))
  const before = await read()
  expect(before).not.toBeNull()
  const result = await commitChapterBridge(input)
  const after = await read()
  expect(after).toMatchObject({ terminalCommitted: true })
  for (const field of ['ready', 'quality', 'continuity', 'qualityReportId', 'continuityReportId', 'requiredTools', 'qualityErrorCount', 'mustPassPending']) {
    expect(after?.[field as keyof NonNullable<typeof after>], field).toEqual(before?.[field as keyof NonNullable<typeof before>])
  }
  return result
}
