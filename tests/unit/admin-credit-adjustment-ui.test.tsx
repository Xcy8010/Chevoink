// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ adjust: vi.fn(), captcha: vi.fn() }))
vi.mock('../../src/features/admin/api', () => ({ adjustAdminUserBonusCredits: mocks.adjust, getAdminCaptcha: mocks.captcha }))
import AdminCreditAdjustmentDialog from '../../src/features/admin/components/AdminCreditAdjustmentDialog'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.captcha.mockResolvedValue({ captchaId: 'synthetic-captcha', imageBase64: 'data:image/png;base64,AA==', expiresInSeconds: 120 })
  mocks.adjust.mockResolvedValue({ userId: 'target', bonusBalanceMilli: 12500 })
})
afterEach(cleanup)
function mount(balance = 10) {
  const close = vi.fn(), applied = vi.fn()
  render(<AdminCreditAdjustmentDialog user={{ id: 'target', nickname: '目标作者' }} bonusBalance={balance} onClose={close} onApplied={applied} />)
  return { close, applied }
}
async function confirm() {
  await screen.findByAltText('人机验证码')
  fireEvent.change(screen.getByRole('textbox', { name: '人机验证码' }), { target: { value: 'abcd' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.change(screen.getByRole('textbox', { name: '最终确认文本' }), { target: { value: 'ADJUST_CREDITS' } })
  fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
}
it.each([['赠送 Credits', 'add', '2.501', 2501], ['减少 Credits', 'subtract', '1.001', 1001], ['覆盖余额', 'set', '0', 0]])('binds %s to the exact reward amount and user only after confirmation', async (label, mode, amount, amountMilli) => {
  const { applied } = mount()
  fireEvent.click(screen.getByRole('radio', { name: label }))
  fireEvent.change(screen.getByRole('textbox', { name: mode === 'set' ? '目标奖励余额' : '调整数量' }), { target: { value: amount } })
  fireEvent.change(screen.getByRole('textbox', { name: '调整原因' }), { target: { value: ' 活动奖励 ' } })
  fireEvent.click(screen.getByRole('button', { name: '验证并确认' }))
  expect(mocks.adjust).not.toHaveBeenCalled()
  await confirm()
  await waitFor(() => expect(mocks.adjust).toHaveBeenCalledOnce())
  expect(mocks.adjust).toHaveBeenCalledWith('target', expect.objectContaining({ mode, amountMilli, expectedBonusBalanceMilli: 10000, reason: '活动奖励', requestKey: expect.any(String), confirmation: 'ADJUST_CREDITS', captchaId: 'synthetic-captcha', captchaAnswer: 'abcd' }))
  await waitFor(() => expect(applied).toHaveBeenCalledOnce())
})
it('shows exact fractional reward balances in preview and final monetary confirmation', async () => {
  mount(0.4)
  fireEvent.change(screen.getByRole('textbox', { name: '调整数量' }), { target: { value: '0.05' } })
  fireEvent.change(screen.getByRole('textbox', { name: '调整原因' }), { target: { value: '活动奖励' } })
  expect(screen.getByText('0.4')).toBeTruthy()
  expect(screen.getByText('0.45')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '验证并确认' }))
  expect(screen.getByText(/奖励余额从 0.4 变为 0.45 Credits/)).toBeTruthy()
  await confirm()
  await waitFor(() => expect(mocks.adjust).toHaveBeenCalledWith('target', expect.objectContaining({ amountMilli: 50, expectedBonusBalanceMilli: 400 })))
})
it('rejects negative, excess precision, overflow, empty reason, zero gifts and deductions exceeding rewards', () => {
  mount()
  const amount = screen.getByRole('textbox', { name: '调整数量' })
  const next = screen.getByRole('button', { name: '验证并确认' })
  fireEvent.change(screen.getByRole('textbox', { name: '调整原因' }), { target: { value: '核对调整' } })
  for (const value of ['-1', '1.0001', '2147483.648', '0', '1e3']) {
    fireEvent.change(amount, { target: { value } })
    expect(next.hasAttribute('disabled')).toBe(true)
  }
  fireEvent.click(screen.getByRole('radio', { name: '减少 Credits' }))
  fireEvent.change(amount, { target: { value: '10.001' } })
  expect(screen.getByRole('alert').textContent).toContain('不能超过当前奖励余额')
  expect(next.hasAttribute('disabled')).toBe(true)
  fireEvent.change(amount, { target: { value: '1' } })
  fireEvent.change(screen.getByRole('textbox', { name: '调整原因' }), { target: { value: '  ' } })
  expect(next.hasAttribute('disabled')).toBe(true)
  expect(mocks.adjust).not.toHaveBeenCalled()
})
it('retains the frozen request identity and amount after an unknown response and fresh captcha', async () => {
  mocks.adjust.mockRejectedValueOnce(new Error('connection lost'))
  const { applied } = mount()
  fireEvent.change(screen.getByRole('textbox', { name: '调整数量' }), { target: { value: '2' } })
  fireEvent.change(screen.getByRole('textbox', { name: '调整原因' }), { target: { value: '活动奖励' } })
  fireEvent.click(screen.getByRole('button', { name: '验证并确认' }))
  await confirm()
  await screen.findByRole('alert')
  expect(applied).not.toHaveBeenCalled()
  await confirm()
  await waitFor(() => expect(mocks.adjust).toHaveBeenCalledTimes(2))
  expect(mocks.adjust.mock.calls[0]).toEqual(mocks.adjust.mock.calls[1])
  await waitFor(() => expect(applied).toHaveBeenCalledOnce())
})
