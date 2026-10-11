import { projectAgentAuthorText } from '../../../../shared/agent-author-view.js'
import type { AgentToolDisplayPayload } from '../../../../shared/contracts/index.js'

export type ToolArgumentRow = { label: string; value: string }

const ARGUMENT_LABELS: Record<string, string> = {
  title: '名称',
  chapterId: '目标章节',
  planId: '目标计划',
  volumeId: '目标卷',
  content: '正文内容',
  newText: '替换内容',
  oldText: '原文片段',
  text: '文本',
  markdown: '计划正文',
  query: '查找内容',
  replacement: '替换为',
  reason: '修改原因',
  position: '全书位置',
  positionInVolume: '卷内位置',
  volumeOrder: '卷序',
  start: '起始位置',
  end: '结束位置',
  fields: '修改范围',
  caseSensitive: '区分大小写',
  preserveQuotedText: '保留引号内文本',
  selectedPatchIds: '选中补丁',
  changeSetId: '变更集',
  compilationId: '编译任务',
}

const LONG_TEXT_KEYS = new Set(['content', 'newText', 'oldText', 'text', 'markdown'])

// Only author-readable intent is useful here. IDs, enum keys, nested input and
// arbitrary unknown fields belong to execution records, never expanded details.
const AUTHOR_INTENT_KEYS = new Set(['title', 'reason', 'query'])

export function describeToolArguments(args: unknown): ToolArgumentRow[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  return Object.entries(args as Record<string, unknown>).flatMap(([key, value]) => {
    if (LONG_TEXT_KEYS.has(key) && typeof value === 'string') {
      return [{ label: ARGUMENT_LABELS[key], value: `${value.length} 字` }]
    }
    if (!AUTHOR_INTENT_KEYS.has(key) || typeof value !== 'string' || !value.trim()) return []
    const text = projectAgentAuthorText(value.trim())
    return text ? [{ label: ARGUMENT_LABELS[key], value: text }] : []
  })
}

export function getToolTargetTitle(display: AgentToolDisplayPayload | undefined, args: unknown): string | null {
  if (display?.kind === 'chapterDiff') return display.chapterTitle
  if (display?.kind === 'chapterRef') return display.title
  if (display?.kind === 'planFile' || display?.kind === 'planDiff' || display?.kind === 'planRename' || display?.kind === 'planDelete') return display.title
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    const title = record.title
    const hasTargetId = typeof record.chapterId === 'string' || typeof record.planId === 'string'
    if (hasTargetId && typeof title === 'string' && title.trim()) return title.trim()
  }
  return null
}
