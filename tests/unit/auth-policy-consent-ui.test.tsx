// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import AuthPage from '../../src/app/routes/AuthPage'
import AccountAccessGate from '../../src/app/routes/AccountAccessGate'
import { useShellStore } from '../../src/store/useShellStore'
import type { User } from '../../shared/contracts'

const mocks = vi.hoisted(() => ({ requestJson: vi.fn() }))
vi.mock('../../src/app/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/app/api-client')>(),
  requestJson: mocks.requestJson,
}))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))

const published = { terms: { id: 'terms-1' }, privacy: { id: 'privacy-1' }, registrationAvailable: true }
const unavailable = { terms: null, privacy: null, registrationAvailable: false }
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

function mount(mode: 'login' | 'register', legal: typeof published | typeof unavailable = published) {
  mocks.requestJson.mockImplementation(async (path) => {
    if (path === '/api/auth/options') return { emailAuthEnabled: false }
    if (path === '/api/auth/legal-policies') return { legal }
    throw new Error('synthetic form submission')
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><AuthPage mode={mode} /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  mocks.requestJson.mockReset()
  useShellStore.getState().setGuest()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterEach(() => {
  cleanup()
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

it.each(['login', 'register'] as const)('centers policy consent on %s and submits only after checking the current policies', async (mode) => {
  mount(mode)
  const registering = mode === 'register'
  const checkbox = await screen.findByRole('checkbox', { name: /我已阅读并同意/ }) as HTMLInputElement
  expect(checkbox.parentElement?.classList.contains('justify-center')).toBe(true)
  expect(checkbox.parentElement?.classList.contains('items-center')).toBe(true)
  expect(screen.getByRole('link', { name: '服务条款' }).getAttribute('href')).toBe('/legal?kind=terms')
  expect(screen.getByRole('link', { name: '隐私政策' }).getAttribute('href')).toBe('/legal?kind=privacy')

  const submit = screen.getByRole('button', { name: registering ? '完成注册' : '登录', exact: true }) as HTMLButtonElement
  const form = submit.closest('form')!
  fireEvent.change(screen.getByPlaceholderText('手机号'), { target: { value: '13800000000' } })
  fireEvent.change(screen.getByPlaceholderText(registering ? '6 位验证码' : '密码'), { target: { value: '123456' } })
  expect(checkbox.checked).toBe(false)
  expect(submit.disabled).toBe(true)
  fireEvent.submit(form)
  expect(mocks.requestJson.mock.calls.every(([, init]) => !init?.method)).toBe(true)

  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(true)
  expect(submit.disabled).toBe(false)
  fireEvent.submit(form)
  const expected = registering
    ? { phone: '+8613800000000', code: '123456', legalConsent: { termsVersionId: 'terms-1', privacyVersionId: 'privacy-1' } }
    : { phone: '+8613800000000', password: '123456' }
  await waitFor(() => expect(mocks.requestJson).toHaveBeenLastCalledWith(
    registering ? '/api/auth/sms/register' : '/api/auth/login',
    { method: 'POST', body: JSON.stringify(expected) },
  ))
})

it('keeps existing account password login available when policies are unpublished', async () => {
  mount('login', unavailable)
  await waitFor(() => expect((screen.getByRole('button', { name: '登录', exact: true }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('registers by email with the current legal versions and preserves the referral', async () => {
  mocks.requestJson.mockImplementation(async (path) => {
    if (path === '/api/auth/options') return { emailAuthEnabled: true }
    if (path === '/api/auth/legal-policies') return { legal: published }
    throw new Error('synthetic registration')
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/register?ref=abc']}>
    <AuthPage mode="register" />
  </MemoryRouter></QueryClientProvider>)
  const submit = await screen.findByRole('button', { name: '注册', exact: true }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  expect(screen.queryByRole('textbox', { name: /手机号/ })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '邮箱' }), { target: { value: 'reader@example.com' } })
  fireEvent.change(screen.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
  fireEvent.click(await screen.findByRole('checkbox', { name: /我已阅读并同意/ }))
  fireEvent.submit(submit.closest('form')!)
  await waitFor(() => expect(mocks.requestJson).toHaveBeenLastCalledWith('/api/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'reader@example.com', code: '123456', legalConsent: { termsVersionId: 'terms-1', privacyVersionId: 'privacy-1' }, referralCode: 'ABC' }),
  }))
})

it('opens the signup code help without requesting a verification code', async () => {
  mocks.requestJson.mockImplementation(async path => path === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter><AuthPage mode="register" /></MemoryRouter></QueryClientProvider>)
  const trigger = await screen.findByRole('button', { name: '收不到验证码' })
  trigger.focus()
  fireEvent.click(trigger)
  const help = screen.getByRole('dialog', { name: '收不到验证码' })
  expect(within(help).getByText('chevoink@chevolink.com')).toBeTruthy()
  expect(mocks.requestJson.mock.calls.every(([path]) => !path.includes('send-code'))).toBe(true)
  fireEvent.click(within(help).getByRole('button', { name: '知道了' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('prioritizes mandatory binding, allows each setup skip, and gates only studio for unverified phone', async () => {
  const user = {
    id: 'viewer',
    nickname: '读者',
    email: 'reader@example.com',
    emailAuthEnabled: true,
    emailVerified: false,
    phoneVerified: false,
    requiresEmailBinding: true,
    accountSetupStep: 1,
  } as User
  useShellStore.setState({ authStatus: 'authenticated', sessionUser: user })
  const verified: User = { ...user, emailVerified: true, requiresEmailBinding: false }
  const steps = [2, 3, null] as const
  mocks.requestJson.mockImplementation(async (path, init) => {
    if (path !== '/api/auth/account/setup') throw new Error('unexpected auth operation')
    const { step, skip } = JSON.parse(init.body) as { step: number; skip: boolean }
    expect(skip).toBe(true)
    return { user: { ...verified, accountSetupStep: steps[step - 1] } }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const studio = <AccountAccessGate><p>创作内容</p></AccountAccessGate>
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/studio/novel/n1']}>{studio}</MemoryRouter></QueryClientProvider>)
  const notice = screen.getByRole('dialog', { name: '请先绑定邮箱' })
  expect(within(notice).getAllByRole('button')).toHaveLength(1)
  expect(fireEvent(notice, new Event('cancel', { cancelable: true }))).toBe(false)
  expect(screen.queryByRole('textbox', { name: '邮箱' })).toBeNull()
  fireEvent.click(within(notice).getByRole('button', { name: '前往绑定' }))
  expect(screen.getByRole('heading', { name: '绑定邮箱' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '帮助' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '跳过此步' })).toBeNull()
  act(() => { useShellStore.setState({ sessionUser: verified }) })
  for (const heading of ['验证手机号', '设置登录密码', '完善个人资料']) {
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy()
    const skip = screen.getByRole('button', { name: '跳过此步' })
    expect(skip.nextElementSibling?.textContent).toContain('退出登录')
    fireEvent.click(skip)
  }
  expect(await screen.findByRole('heading', { name: '进入创作区前验证手机' })).toBeTruthy()
  expect(screen.queryByText('创作内容')).toBeNull()
  view.unmount()
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/me']}>
    <AccountAccessGate><p>个人中心内容</p></AccountAccessGate>
  </MemoryRouter></QueryClientProvider>)
  expect(screen.getByText('个人中心内容')).toBeTruthy()
})
