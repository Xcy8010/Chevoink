import { ToolDetailDisclosure } from './ToolDetailDisclosure'

import { projectAgentAuthorText } from '../../../../../shared/agent-author-view.js'
import type { AgentToolDisplayPayload } from '../../../../../shared/contracts/index.js'
import { plainChapterTitle } from '../../../../../shared/structure/chapter-title.js'
import { isOpenReviewFinding } from '../lib/chapter-review-presentation'

type ReviewBatch = Extract<AgentToolDisplayPayload, { kind: 'reviewBatch' }>
type ReviewChapter = ReviewBatch['chapters'][number]
type Finding = NonNullable<ReviewChapter['findings']>[number]
export type OpenReviewedChapter = (chapterId: string, evidence?: string) => void
type ReviewChapterView = Omit<ReviewChapter, 'orderIndex'> & { orderIndex?: number }

const textStyle = 'min-w-0 break-words text-xs leading-5 text-[var(--text-secondary)]'
const linkStyle = 'text-left underline-offset-2 hover:underline focus-visible:underline'

export function ContinuityReviewDetails({ display, status }: {
  display: Extract<AgentToolDisplayPayload, { kind: 'storyCompiler' }>
  status: ReviewChapter['status']
}) {
  const findings = display.items.filter(Boolean)
  const counts = [display.errorCount ? `${display.errorCount} 个问题` : '', display.warningCount ? `${display.warningCount} 条需核对` : ''].filter(Boolean).join(' · ')
  const details = <>
    {counts && (display.errorCount ?? 0) + (display.warningCount ?? 0) !== findings.length && <p>{counts}</p>}
    {findings.length ? <ul className="space-y-0.5">{findings.map((item, index) => <li key={index}>{projectAgentAuthorText(item)}</li>)}</ul>
      : !counts && status === 'complete' ? <p>未发现衔接问题</p> : null}
  </>
  return <section aria-label="章节衔接报告" className={textStyle}>
    {status === 'stale' ? <ToolDetailDisclosure label="修改前的记录">{details}</ToolDetailDisclosure> : <>{status === 'incomplete' && <p>检查未完成</p>}{details}</>}
  </section>
}

function chapterLabel(chapter: ReviewChapterView) {
  return [chapter.orderIndex ? `第 ${chapter.orderIndex} 章` : '', plainChapterTitle(chapter.title)].filter(Boolean).join(' · ') || '章节正文'
}

function SourceExcerpt({ chapterId, title, evidence, onOpenChapter }: {
  chapterId: string; title: string; evidence: string; onOpenChapter?: OpenReviewedChapter
}) {
  const quote = `「${evidence}」`
  return <div className="min-w-0 whitespace-pre-wrap break-words text-[var(--text-tertiary)]">
    {onOpenChapter ? <button type="button" className={linkStyle} aria-label={`${title}：${evidence}`}
      onClick={() => onOpenChapter(chapterId, evidence)}>{title === '本章原文' ? quote : `${title} · ${quote}`}</button>
      : title === '本章原文' ? quote : `${title} · ${quote}`}
  </div>
}

function Findings({ findings, chapter, onOpenChapter }: {
  findings: Finding[]; chapter: ReviewChapterView; onOpenChapter?: OpenReviewedChapter
}) {
  return <ul className="space-y-1.5">{findings.map(finding => <li key={finding.id}>
    <p className="text-[var(--text-primary)]">{projectAgentAuthorText(finding.label)}
      {finding.disposition && <span className="text-[var(--text-secondary)]">{finding.disposition === 'repaired' ? ' · 已修正' : ' · 保留原写法'}</span>}
    </p>
    {finding.explanation && <p>{projectAgentAuthorText(finding.explanation)}</p>}
    {finding.suggestion && !finding.disposition && <p>{projectAgentAuthorText(finding.suggestion)}</p>}
    {finding.evidence && <SourceExcerpt chapterId={chapter.chapterId} title={finding.related ? chapterLabel(chapter) : '本章原文'}
      evidence={finding.evidence} onOpenChapter={onOpenChapter} />}
    {finding.related?.evidence && <SourceExcerpt {...finding.related} onOpenChapter={onOpenChapter} />}
  </li>)}</ul>
}

export function ChapterReviewCard({ chapters, onOpenChapter, showChapter = true }: {
  chapters: readonly ReviewChapterView[]; onOpenChapter?: OpenReviewedChapter; showChapter?: boolean
}) {
  return <div className={textStyle}>{[...chapters].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)).map(chapter => {
    const findings = chapter.findings ?? []
    const open = chapter.status === 'complete' ? findings.filter(isOpenReviewFinding) : []
    const other = findings.filter(finding => !open.includes(finding))
    const noteType = other.every(finding => !finding.disposition && finding.severity === 'advisory') ? '建议' : '记录'
    const noteLabel = `${chapter.status === 'stale' ? '修改前 · ' : ''}${other.length} 条${noteType}`
    return <section key={chapter.chapterId} aria-label={chapterLabel(chapter)} data-review-chapter-status={chapter.status} className="min-w-0 [&+section]:mt-1.5">
      {showChapter && (onOpenChapter ? <button type="button" className={linkStyle} onClick={() => onOpenChapter(chapter.chapterId)}>{chapterLabel(chapter)}</button>
        : <p>{chapterLabel(chapter)}</p>)}
      {chapter.detail ? <p>{projectAgentAuthorText(chapter.detail)}</p> : chapter.status === 'incomplete' ? <p>检查未完成</p>
        : !findings.length ? <p>{chapter.status === 'stale' ? '修改前的记录' : '未发现问题'}</p> : null}
      {open.length > 0 && <Findings findings={open} chapter={chapter} onOpenChapter={onOpenChapter} />}
      {other.length > 0 && <ToolDetailDisclosure label={noteLabel}><Findings findings={other} chapter={chapter} onOpenChapter={onOpenChapter} /></ToolDetailDisclosure>}
    </section>
  })}</div>
}
