// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PublicReports from '../../src/features/governance/Reports'
import ReportAction from '../../src/features/governance/ReportAction'
import { formatReportReasons } from '../../shared/contracts/governance-cases'
import { useShellStore } from '../../src/store/useShellStore'
import { requestJson } from '../../src/app/api-client'

vi.mock('../../src/app/api-client', () => ({ requestJson: vi.fn() }))
afterEach(() => {
  cleanup()
  useShellStore.getState().setGuest()
  vi.clearAllMocks()
})

it('retains every selection, requires evidence when one reason needs it and clears invalid choices on target change', async () => {
  vi.mocked(requestJson).mockResolvedValue({
    id: 'synthetic',
    receipt: 'secret',
    status: 'pending',
    message: '已收到',
  })
  render(
    <MemoryRouter>
      <PublicReports />
    </MemoryRouter>,
  )
  const submit = screen.getByRole('button', { name: '提交举报与投诉' })
  expect(submit.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('举报对象'), { target: { value: 'post' } })
  fireEvent.click(screen.getByLabelText('侵权抄袭'))
  expect(screen.getByLabelText('权利依据与最小必要证明').hasAttribute('required')).toBe(true)
  fireEvent.change(screen.getByLabelText('举报对象'), { target: { value: 'platform' } })
  expect(submit.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByLabelText('隐私泄露'))
  fireEvent.click(screen.getByLabelText('其他'))
  const statement = screen.getByLabelText('补充说明')
  expect(statement.hasAttribute('required')).toBe(true)
  fireEvent.change(statement, { target: { value: '合成补充说明' } })
  fireEvent.click(submit)
  await screen.findByText('案件编号 synthetic')
  const body = JSON.parse(String(vi.mocked(requestJson).mock.calls[0][1]?.body))
  expect(body.categories).toEqual(['privacy', 'other'])
  expect(formatReportReasons('privacy')).toBe('隐私泄露')
  expect(formatReportReasons(',harassment,privacy,')).toBe('骚扰辱骂、隐私泄露')
})
it('hides the report action on owned content and on a conversation with no incoming message', () => {
  useShellStore.setState({
    sessionUser: { id: 'synthetic-owner' } as NonNullable<
      ReturnType<typeof useShellStore.getState>['sessionUser']
    >,
    authStatus: 'authenticated',
  })
  const view = render(<ReportAction ownerId="synthetic-owner" target={{ kind: 'novel', id: 'book' }} />)
  expect(screen.queryByRole('button')).toBeNull()
  view.rerender(<ReportAction ownerId="another-author" target={{ kind: 'novel', id: 'book' }} />)
  expect(screen.getByRole('button', { name: '举报与投诉' })).toBeTruthy()
  view.rerender(
    <ReportAction menu target={{ kind: 'message', id: '', messagesFor: 'synthetic-owner', messages: [] }} />,
  )
  expect(screen.queryByText('举报与投诉')).toBeNull()
  expect(screen.queryByLabelText('更多操作')).toBeNull()
  const messages = [{ id: 'incoming', label: '合成私信' }]
  view.rerender(
    <ReportAction menu target={{ kind: 'message', id: '', messagesFor: 'previous-viewer', messages }} />,
  )
  expect(screen.queryByLabelText('更多操作')).toBeNull()
  view.rerender(
    <ReportAction menu target={{ kind: 'message', id: '', messagesFor: 'synthetic-owner', messages }} />,
  )
  expect(screen.getByLabelText('更多操作')).toBeTruthy()
})
