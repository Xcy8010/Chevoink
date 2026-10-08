import type { ChapterReviewReadiness } from './chapter-review-guard.js'

export function reviewDispatchKey(readiness: { compilationId: string | null; chapterId: string; revision: number }, name: string): string {
  const base = `${readiness.compilationId}:${readiness.chapterId}:${readiness.revision}:${name}`
  return name === 'continuity_validate' ? `${base}:protocol6` : base
}

/** A completed assessment can still have one unspent, authorized decision.
 * This schedules a prompt, never a write, paid request or a new repair round. */
export function nextMergedReviewReminder(readiness: ChapterReviewReadiness | null,
  available: ReadonlySet<string>, attempted: ReadonlySet<string>, channelOpen: boolean): string | null {
  if (!readiness?.ready || !readiness.checksRequired || !channelOpen
    || !(readiness.continuityErrorCount > 0 || (readiness.qualityCandidateCount ?? 0) > 0)
    || !['chapter_edit_range', 'chapter_write'].some(name => available.has(name))) return null
  const key = reviewDispatchKey(readiness, 'merged')
  return attempted.has(key) ? null : key
}

/** Schedule one missing assessment, then reread the saved state. Existing
 * incomplete/unknown work is never dispatched again by this fallback. */
export function nextReviewDispatch(readiness: ChapterReviewReadiness | null,
  available: ReadonlySet<string>, attempted: ReadonlySet<string>, recovered: ReadonlySet<string> = new Set()) {
  if (!readiness || readiness.ready) return { kind: 'ready' as const }
  const tool = readiness.requiredTools[0]
  if (!tool) return { kind: 'blocked' as const, reason: '当前版本的必要检查尚未确认完成。正文已保存，不能提交为完成。' }
  const status = tool.name === 'continuity_validate' ? readiness.continuity : readiness.quality
  const key = reviewDispatchKey(readiness, tool.name)
  if ((status === 'incomplete' && !recovered.has(key)) || attempted.has(key)) {
    return { kind: 'blocked' as const, reason: '当前版本的必要检查未完成或结果尚未确认。正文与进度保留，已停止重复检查请求，未判定检查通过。' }
  }
  if (!available.has(tool.name)) return { kind: 'blocked' as const,
    reason: '原任务允许的工具中缺少必要检查，正文与进度保留；未扩大工具权限，也未判定任务完成。' }
  return { kind: 'tool' as const, tool, key }
}
