import type { AgentMessagePart } from './contracts/agent-events.js'

type ToolCall = Extract<AgentMessagePart, { type: 'tool-call' }>

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function activityReviewVersion(part: ToolCall) {
  if (part.reviewedChapter) return part.reviewedChapter
  if ((part.toolName === 'quality_analyze' || part.toolName === 'quality_apply') && part.display?.kind === 'qualityReport') {
    return { chapterId: part.display.chapterId, revision: part.display.chapterRevision }
  }
}

/** Uses the complete bound input. In particular, a chapter or card ID alone
 * cannot identify a particular edit, section, reading window or review. */
export function activityAttemptKey(part: ToolCall) {
  if (part.activityRetryId) return JSON.stringify(['replay', part.toolName, part.activityRetryId])
  const args = object(part.args)
  if (!args || !Object.keys(args).length) return undefined
  if (part.toolName === 'chapter_edit_range' && typeof args.oldText !== 'string'
    && !(Number.isInteger(args.start) && Number.isInteger(args.end)) && !Array.isArray(args.patches)) return undefined
  const display = part.display
  const chapterId = activityReviewVersion(part)?.chapterId ?? (display && 'chapterId' in display ? display.chapterId : args.chapterId ?? args.chapter_id)
  const artifactId = display && 'artifactId' in display ? display.artifactId : args.planId
  const memoryId = display?.kind === 'memoryCard' ? display.memoryId : args.memoryId
  const target = [chapterId, artifactId, memoryId, args.compilationId, args.volumeId, args.novelId, args.sourceId, args.url, args.query, args.contentRef]
  if (!target.some(id => typeof id === 'string' && id.trim())) return undefined
  return JSON.stringify([part.toolName, target, args], (_key, value: unknown) => {
    const record = object(value)
    return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])) : value
  })
}
