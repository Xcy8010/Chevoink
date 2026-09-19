import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentActivityBar } from '../../src/features/studio/agent/components/AgentActivityBar'
const baseProps = {
  activities: [{ callId: 'call-1', toolName: 'chapter_write', label: '第二章', chapterId: 'c2', deltaChars: 2, before: '', after: '正文', status: 'done' as const }],
  activitiesVersion: 0,
  todos: [{ content: '完成第二章', status: 'completed' as const }],
  todosVersion: 0, runActive: false, pendingReviewCount: 1, reviewBusy: false,
}
describe('Agent activity presentation', () => {
  it('keeps centered capsules only above the composer without auto-opening details', () => {
    const markup = renderToStaticMarkup(createElement(AgentActivityBar, { ...baseProps, appearance: 'inline' }))
    expect(markup).toContain('data-agent-activity-capsules')
    expect(markup).toContain('flex-wrap items-center justify-center gap-2')
    expect(markup).toContain('1 个工作区变更')
    expect(markup).toContain('1/1')
    expect(markup).toContain('全部完成')
    expect(markup).toContain('新增 2 字')
    expect(markup).not.toContain('接受全部')
    expect(markup).not.toContain('拒绝全部')
    expect(markup).not.toContain('role="dialog"')
    expect(markup).not.toContain('aria-expanded="true"')
  })
  it('restores expanded vertical lists in the right status card without capsules or portals', () => {
    const markup = renderToStaticMarkup(createElement(AgentActivityBar, { ...baseProps, appearance: 'dock' }))
    expect(markup).toContain('data-agent-activity-dock')
    expect(markup).not.toContain('data-agent-activity-capsules')
    expect(markup).not.toContain('role="dialog"')
    expect(markup.match(/aria-expanded="true"/g)).toHaveLength(2)
    expect(markup).toContain('1/1 已完成')
    expect(markup).toContain('完成第二章')
    expect(markup).toContain('line-through')
    expect(markup).toContain('第二章')
    expect(markup).toContain('接受全部')
    expect(markup).toContain('拒绝全部')
  })

  it('keeps cancelled todos out of completed counts and shows a running item as active', () => {
    const todos = [
      { id: 'todo-done', content: '完成第二章', status: 'completed' as const },
      { id: 'todo-cancelled', content: '整理第三章', status: 'cancelled' as const, reason: 'author_ended' },
      { id: 'todo-running', content: '检查第四章', status: 'in_progress' as const },
    ] as unknown as typeof baseProps.todos
    const markup = renderToStaticMarkup(createElement(AgentActivityBar, { ...baseProps, todos, runActive: true, appearance: 'dock' }))
    expect(markup).toContain('1/2 已完成 · 1 项已取消')
    expect(markup).toContain('已取消 1 项')
    expect(markup).toContain('整理第三章')
    expect(markup).toContain('执行中')
    expect(markup).toContain('animate-spin')
  })
})
