// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentManualReviewRepair } from '../../src/features/studio/agent/components/AgentManualReviewRepair'
import type { ManualReviewRepairQuote, ManualReviewRepairStatus } from '../../shared/contracts/manual-review-repair.js'

const api = vi.hoisted(() => ({ read: vi.fn(), quote: vi.fn(), submit: vi.fn() }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({ fetchManualReviewRepair: api.read, quoteManualReviewRepair: api.quote, submitManualReviewRepair: api.submit }))
const eligible = { eligible: true, status: null, message: '旧复查未完成，可以修复。' }
const quote: ManualReviewRepairQuote = { operationId: 'stable-operation', quoteToken: 'frozen-quote', expiresAt: '2099-01-01T00:00:00Z', chapterId: 'chapter', currentRevision: 4,
  model: { modelTier: 'speed', customModelId: null, reasoningEffort: 'high', modelName: 'original-model', label: '原任务模型' }, maximumCreditMilli: 12001, maxProviderDispatches: 1 }
const status = (state: ManualReviewRepairStatus['state']): ManualReviewRepairStatus => ({ operationId: 'stable-operation', eventStartSeq: 3532, state, reportId: state === 'complete' ? 'report' : null,
  terminalCommitted: state === 'complete', needsContinuation: false, message: state === 'complete' ? '当前章节已真实提交。' : '正在修复。' })
beforeEach(() => { api.read.mockResolvedValue(eligible); api.quote.mockResolvedValue(quote); api.submit.mockResolvedValue(status('running')) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
async function openQuote() {
  fireEvent.click(await screen.findByRole('button', { name: '查看修复费用' }))
  return screen.findByRole('button', { name: '修复旧复查，额外完整检查一次' })
}

it('reads eligibility without buying or quoting a review, and hides ineligible runs', async () => {
  api.read.mockResolvedValue({ eligible: false, status: null, message: '' })
  const view = render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  await waitFor(() => expect(api.read).toHaveBeenCalledWith('run'))
  expect(view.container.textContent).toBe('')
  expect(api.quote).not.toHaveBeenCalled()
  expect(api.submit).not.toHaveBeenCalled()
})

it('shows the frozen model and conservative fee cap before explicit extra-review consent', async () => {
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  await openQuote()
  expect(screen.getByText(/原任务模型 · 最多 13 Credits/).textContent).toContain('额外完整检查一次')
  expect(api.quote).toHaveBeenCalledExactlyOnceWith('run')
  expect(api.submit).not.toHaveBeenCalled()
})

it('cancels the quote without a paid request', async () => {
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  await openQuote()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('button', { name: '修复旧复查，额外完整检查一次' })).toBeNull()
  expect(api.submit).not.toHaveBeenCalled()
})

it('refuses an expired quote without dispatch', async () => {
  api.quote.mockResolvedValue({ ...quote, expiresAt: '2000-01-01T00:00:00Z' })
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  fireEvent.click(await openQuote())
  expect(screen.getByRole('alert').textContent).toContain('已过期')
  expect(api.submit).not.toHaveBeenCalled()
})

it('deduplicates repeated explicit clicks and reports completion only from actual server status', async () => {
  let finish!: (value: ManualReviewRepairStatus) => void
  api.submit.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const changed = vi.fn()
  render(<AgentManualReviewRepair runId="run" onStatusChange={changed} />)
  const button = await openQuote()
  fireEvent.click(button)
  fireEvent.click(button)
  expect(api.submit).toHaveBeenCalledExactlyOnceWith('run', 'frozen-quote')
  expect(changed).not.toHaveBeenCalled()
  api.read.mockResolvedValue({ eligible: false, status: status('complete'), message: '' })
  await act(async () => finish(status('complete')))
  await screen.findByText('当前章节已真实提交。')
  expect(changed).toHaveBeenCalledExactlyOnceWith(status('complete'))
  expect(screen.queryByRole('button')).toBeNull()
})

it('never resends an uncertain paid request when status reads fail', async () => {
  api.submit.mockRejectedValue(new Error('response lost'))
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  const button = await openQuote()
  api.read.mockRejectedValue(new Error('status unavailable'))
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('尚未确认'))
  expect(screen.queryByRole('button')).toBeNull()
  expect(api.submit).toHaveBeenCalledOnce()
})

it('keeps a lost response fenced even when a read has no durable result yet', async () => {
  api.submit.mockRejectedValue(new Error('response lost'))
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  fireEvent.click(await openQuote())
  await screen.findByText(/提交结果尚未确认/)
  expect(screen.queryByRole('button')).toBeNull()
  expect(api.submit).toHaveBeenCalledOnce()
})

it('reconciles a lost submit from the durable operation without buying another request', async () => {
  const changed = vi.fn()
  api.submit.mockRejectedValue(new Error('response lost'))
  render(<AgentManualReviewRepair runId="run" onStatusChange={changed} />)
  const button = await openQuote()
  api.read.mockResolvedValue({ eligible: false, status: status('unknown'), message: '' })
  fireEvent.click(button)
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(status('unknown')))
  expect(api.submit).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button')).toBeNull()
})

it('does not apply a late quote after switching tasks', async () => {
  let finish!: (value: ManualReviewRepairQuote) => void
  api.quote.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<AgentManualReviewRepair runId="run-a" onStatusChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '查看修复费用' }))
  view.rerender(<AgentManualReviewRepair runId="run-b" onStatusChange={vi.fn()} />)
  await act(async () => finish(quote))
  expect(screen.queryByRole('button', { name: '修复旧复查，额外完整检查一次' })).toBeNull()
  expect(api.submit).not.toHaveBeenCalled()
})

it('does not project a late paid result into a new task', async () => {
  let finish!: (value: ManualReviewRepairStatus) => void
  api.submit.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const changed = vi.fn()
  const view = render(<AgentManualReviewRepair runId="run-a" onStatusChange={changed} />)
  fireEvent.click(await openQuote())
  view.rerender(<AgentManualReviewRepair runId="run-b" onStatusChange={changed} />)
  await act(async () => finish(status('complete')))
  expect(changed).not.toHaveBeenCalled()
  expect(screen.queryByText('当前章节已真实提交。')).toBeNull()
  expect(api.submit).toHaveBeenCalledOnce()
})

it('restores the existing operation after refresh without obtaining another quote', async () => {
  api.read.mockResolvedValue({ eligible: false, status: status('incomplete'), message: '' })
  const changed = vi.fn()
  render(<AgentManualReviewRepair runId="run" onStatusChange={changed} />)
  await waitFor(() => expect(changed).toHaveBeenCalledWith(status('incomplete')))
  expect(screen.queryByRole('button')).toBeNull()
  expect(api.quote).not.toHaveBeenCalled()
  expect(api.submit).not.toHaveBeenCalled()
})
it('resumes an authenticated received result only with a zero-provider zero-fee quote', async () => {
  api.read.mockResolvedValue({ eligible: false, status: { ...status('unknown'), canResume: true }, message: '' })
  api.quote.mockResolvedValue({ ...quote, recoveryOnly: true, maxProviderDispatches: 0, maximumCreditMilli: 0 })
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '继续完成修复' }))
  await waitFor(() => expect(api.submit).toHaveBeenCalledExactlyOnceWith('run', 'frozen-quote'))
  expect(screen.queryByRole('button', { name: '修复旧复查，额外完整检查一次' })).toBeNull()
})

it('never turns a local result-resume click into another paid review', async () => {
  api.read.mockResolvedValue({ eligible: false, status: { ...status('unknown'), canResume: true }, message: '' })
  api.quote.mockResolvedValue(quote)
  render(<AgentManualReviewRepair runId="run" onStatusChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '继续完成修复' }))
  await screen.findByText('原结果暂时不能复用，未提交新的检查。')
  expect(api.submit).not.toHaveBeenCalled()
})