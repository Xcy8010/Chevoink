// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentRunPauseNotice } from '../../src/features/studio/agent/components/AgentRunPauseNotice'
afterEach(cleanup)
it.each(['检查正在等待原请求确认，正文和已完成的检查已保留。', '检查正在等待原请求的结果或用量确认。正文和已完成的检查已保留。'])(
  'makes live and restored receipt waits visible: %s', summary => {
    const view = render(<AgentRunPauseNotice phase="paused" summary={summary} />)
    expect(screen.getByRole('status').textContent).toContain('继续暂未恢复')
    view.rerender(<AgentRunPauseNotice phase="running" summary={summary} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
it('does not label author stops or successful completion as receipt waits', () => {
  const view = render(<AgentRunPauseNotice phase="paused" summary="已停止" />)
  expect(screen.queryByRole('status')).toBeNull()
  view.rerender(<AgentRunPauseNotice phase="succeeded" summary="已完成" />)
  expect(screen.queryByRole('status')).toBeNull()
})
