// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import AuthPage from '../../src/app/routes/AuthPage'
import AppRouter from '../../src/app/AppRouter'
import { useShellStore } from '../../src/store/useShellStore'
import type { User } from '../../shared/contracts'

const mocks = vi.hoisted(() => ({ requestJson: vi.fn(), hydrateReadingSync: vi.fn() }))
vi.mock('../../src/app/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/app/api-client')>(),
  requestJson: mocks.requestJson,
}))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('../../src/components/layout/AppShell', () => ({ default: () => null }))
vi.mock('../../src/features/home/reading-sync', () => ({ hydrateReadingSync: mocks.hydrateReadingSync }))
vi.mock('../../src/app/route-config', async () => {
  const { Link } = await import('react-router-dom')
  const { default: EmailAccountSettings } = await import('../../src/app/routes/settings/EmailAccountSettings')
  const { useShellStore: useFixtureShellStore } = await import('../../src/store/useShellStore')
  function AccountSettings() {
    const user = useFixtureShellStore(state => state.sessionUser)
    return user && <EmailAccountSettings user={user} />
  }
  return {
    appRoutes: [
      { path: '/', useShell: false, element: <p>首页内容</p> },
      { path: '/me', useShell: false, element: <><p>个人中心内容</p><Link to="/studio/novel/n1">进入创作区</Link><Link to="/administrator">普通页面</Link><Link to="/login">登录</Link><Link to="/register">注册</Link></> },
      { path: '/settings', useShell: false, element: <AccountSettings /> },
      { path: '/studio/novel/:novelId', useShell: false, element: <p>创作内容</p> },
      { path: '/admin', useShell: false, element: <button type="button">管理操作</button> },
      { path: '/admin/app-releases', useShell: false, element: <button type="button">管理操作</button> },
      { path: '/administrator', useShell: false, element: <p>普通页面内容</p> },
    ],
  }
})

const published = { terms: { id: 'terms-1' }, privacy: { id: 'privacy-1' }, registrationAvailable: true }
const unavailable = { terms: null, privacy: null, registrationAvailable: false }
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const legacyUser = {
  id: 'viewer',
  nickname: '读者',
  email: 'reader@example.com',
  emailAuthEnabled: true,
  emailVerified: false,
  phoneVerified: false,
  requiresEmailBinding: true,
  accountSetupStep: null,
} as User

function mount(mode: 'login' | 'register', legal: typeof published | typeof unavailable = published) {
  mocks.requestJson.mockImplementation(async (path) => {
    if (path === '/api/auth/options') return { emailAuthEnabled: false }
    if (path === '/api/auth/legal-policies') return { legal }
    throw new Error('synthetic form submission')
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><AuthPage mode={mode} onClose={vi.fn()} /></MemoryRouter></QueryClientProvider>)
}

function mountApp(path: string, user?: User) {
  if (user) useShellStore.setState({ authStatus: 'authenticated', sessionUser: user })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  window.history.replaceState(null, '', path)
  render(<QueryClientProvider client={client}><AppRouter /></QueryClientProvider>)
}

beforeEach(() => {
  mocks.requestJson.mockReset()
  mocks.hydrateReadingSync.mockReset().mockResolvedValue(false)
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
  window.history.replaceState(null, '', '/')
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
    <AuthPage mode="register" onClose={vi.fn()} />
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
  render(<QueryClientProvider client={client}><MemoryRouter><AuthPage mode="register" onClose={vi.fn()} /></MemoryRouter></QueryClientProvider>)
  const trigger = await screen.findByRole('button', { name: '收不到验证码' })
  const registration = screen.getByRole('dialog', { name: '创建账户' })
  trigger.focus()
  fireEvent.click(trigger)
  const help = screen.getByRole('dialog', { name: '收不到验证码' })
  expect(within(help).getByText('chevoink@chevolink.com')).toBeTruthy()
  expect(mocks.requestJson.mock.calls.every(([path]) => !path.includes('send-code'))).toBe(true)
  fireEvent.click(within(help).getByRole('button', { name: '知道了' }))
  expect(screen.queryByRole('dialog', { name: '收不到验证码' })).toBeNull()
  expect(screen.getByRole('dialog', { name: '创建账户' })).toBe(registration)
  expect(document.activeElement).toBe(trigger)
})

it.each(['/admin', '/admin/', '/AdMiN/app-releases'])('leaves administrative controls available at %s', path => {
  mountApp(path, { ...legacyUser, accountSetupStep: 1 })
  const action = screen.getByRole('button', { name: '管理操作' })
  action.focus()
  expect(document.activeElement).toBe(action)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['/login', '/register'])('shows the normal signed-in dialog at %s', async path => {
  mocks.requestJson.mockImplementation(async request => request === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published })
  mountApp(path, legacyUser)
  const notice = await screen.findByRole('dialog', { name: '你已经登录' })
  expect(screen.getAllByRole('dialog')).toEqual([notice])
  expect(screen.getByText('首页内容')).toBeTruthy()
  fireEvent.click(within(notice).getByRole('button', { name: '继续前往' }))
  expect(screen.getByText('个人中心内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([['登录', '登录启创墨域'], ['注册', '创建账户']])('opens %s over the page that launched it', async (linkName, title) => {
  mocks.requestJson.mockImplementation(async request => request === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published })
  mountApp('/me')
  const background = screen.getByText('个人中心内容')
  fireEvent.click(screen.getByRole('link', { name: linkName }))
  const dialog = await screen.findByRole('dialog', { name: title })
  expect(screen.getByText('个人中心内容')).toBe(background)
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  expect(window.location.pathname).toBe('/me')
  expect(screen.getByText('个人中心内容')).toBe(background)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('restores reading progress after an existing user without email logs in', async () => {
  mocks.requestJson.mockImplementation(async request => {
    if (request === '/api/auth/options') return { emailAuthEnabled: true }
    if (request === '/api/auth/legal-policies') return { legal: published }
    if (request === '/api/auth/login') return {
      user: { ...legacyUser, email: null },
      tokens: { accessToken: 'access', refreshToken: 'refresh', expiresInSeconds: 3600 },
    }
    throw new Error('unexpected auth operation')
  })
  mountApp('/login')
  const login = await screen.findByRole('dialog', { name: '登录启创墨域' })
  expect(within(login).getByRole('link', { name: '找回密码' })).toBeTruthy()
  fireEvent.change(within(login).getByPlaceholderText('请输入您的邮箱或手机号'), { target: { value: '13800000000' } })
  fireEvent.change(within(login).getByPlaceholderText('请输入您的密码'), { target: { value: '123456' } })
  fireEvent.click(within(login).getByRole('button', { name: '登录', exact: true }))
  expect(await screen.findByText('个人中心内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mocks.hydrateReadingSync).toHaveBeenCalledTimes(1)
})

it('keeps password recovery available before email verification', async () => {
  mocks.requestJson.mockImplementation(async path => path === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published })
  mountApp('/login?recovery=1', legacyUser)
  const recovery = await screen.findByRole('dialog', { name: '找回密码' })
  expect(screen.getAllByRole('dialog')).toEqual([recovery])
  expect(screen.getByText('首页内容')).toBeTruthy()
})

it.each([null, 'reader@example.com'])('lets a signed-in user browse with email %s', email => {
  mountApp('/me', { ...legacyUser, email })
  expect(screen.getByText('个人中心内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '普通页面' }))
  expect(screen.getByText('普通页面内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mocks.requestJson).not.toHaveBeenCalled()
})

it('verifies a stored email on request from account settings', async () => {
  const verified = { ...legacyUser, emailVerified: true }
  mocks.requestJson.mockImplementation(async path => {
    if (path === '/api/auth/captcha') return { captchaId: 'captcha-1', imageBase64: 'data:image/png;base64,AA==' }
    if (path === '/api/auth/email/send-code') return { ok: true, expireInSeconds: 300, cooldownSeconds: 60 }
    if (path === '/api/auth/account/email') return { user: verified }
    throw new Error('unexpected auth operation')
  })
  mountApp('/settings', legacyUser)
  const background = screen.getByRole('heading', { name: '账号安全' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /邮箱.*未验证/ }))
  const dialog = screen.getByRole('dialog', { name: '验证邮箱', exact: true })
  expect(dialog.hasAttribute('open')).toBe(true)
  expect(screen.getByRole('heading', { name: '账号安全' })).toBe(background)
  const help = within(dialog).getByRole('link', { name: '帮助' })
  expect(help.getAttribute('href')).toBe('/account/docs?doc=faq#doc-security')
  expect(help.getAttribute('target')).toBe('_blank')
  expect(within(dialog).queryByRole('link', { name: '找回密码' })).toBeNull()
  expect(within(dialog).queryByRole('button', { name: '找回密码' })).toBeNull()
  const email = within(dialog).getByRole('textbox', { name: '邮箱' }) as HTMLInputElement
  expect(email.value).toBe(legacyUser.email)
  expect(document.activeElement).toBe(email)
  fireEvent.change(email, { target: { value: 'updated@example.com' } })
  expect(email.value).toBe('updated@example.com')
  fireEvent.change(email, { target: { value: legacyUser.email } })

  const send = within(dialog).getByRole('button', { name: '获取验证码' })
  send.focus()
  fireEvent.click(send)
  const captcha = screen.getByRole('dialog', { name: '完成人机验证' })
  const answer = within(captcha).getByRole('textbox', { name: '图中的数字和字母' })
  expect(document.activeElement).toBe(answer)
  fireEvent(captcha, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog', { name: '完成人机验证' })).toBeNull()
  expect(document.activeElement).toBe(send)
  expect(screen.getByRole('dialog', { name: '验证邮箱', exact: true })).toBe(dialog)

  fireEvent.click(send)
  const reopened = screen.getByRole('dialog', { name: '完成人机验证' })
  await within(reopened).findByRole('img', { name: '图形验证码' })
  fireEvent.change(within(reopened).getByRole('textbox', { name: '图中的数字和字母' }), { target: { value: 'AB12' } })
  fireEvent.click(within(reopened).getByRole('button', { name: '确认并发送' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '完成人机验证' })).toBeNull())
  expect(mocks.requestJson).toHaveBeenCalledWith('/api/auth/email/send-code', {
    method: 'POST', body: JSON.stringify({ email: legacyUser.email, purpose: 'bind', captchaId: 'captcha-1', captchaAnswer: 'AB12' }),
  })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '验证并保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(mocks.requestJson).toHaveBeenCalledWith('/api/auth/account/email', {
    method: 'POST', body: JSON.stringify({ email: legacyUser.email, code: '123456' }),
  })
  expect(screen.getByRole('heading', { name: '账号安全' })).toBe(background)
})

it('allows each setup skip and requires only phone verification to enter studio', async () => {
  const user: User = { ...legacyUser, email: null, accountSetupStep: 1 }
  const steps = [2, 3, null] as const
  mocks.requestJson.mockImplementation(async (path, init) => {
    if (path === '/api/auth/account/phone') return { user: { ...user, accountSetupStep: null, phoneVerified: true } }
    if (path !== '/api/auth/account/setup') throw new Error('unexpected auth operation')
    const { step, skip } = JSON.parse(init.body) as { step: number; skip: boolean }
    expect(skip).toBe(true)
    return { user: { ...user, accountSetupStep: steps[step - 1] } }
  })
  mountApp('/me', user)
  const setup = await screen.findByRole('dialog', { name: '验证手机号' })
  for (const heading of ['验证手机号', '设置登录密码', '完善个人资料']) {
    expect(await screen.findByRole('dialog', { name: heading })).toBe(setup)
    expect(screen.getByText('个人中心内容')).toBeTruthy()
    const skip = within(setup).getByRole('button', { name: '跳过此步' })
    expect(skip.nextElementSibling?.textContent).toContain('退出登录')
    fireEvent.click(skip)
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('link', { name: '进入创作区' }))
  const phoneGate = await screen.findByRole('dialog', { name: '验证手机号' })
  expect(screen.getByText('个人中心内容')).toBeTruthy()
  expect(screen.queryByText('创作内容')).toBeNull()
  fireEvent.click(within(phoneGate).getByRole('button', { name: '关闭' }))
  expect(window.location.pathname).toBe('/me')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '进入创作区' }))
  const verification = await screen.findByRole('dialog', { name: '验证手机号' })
  fireEvent.change(within(verification).getByRole('textbox', { name: '手机号' }), { target: { value: '13800000000' } })
  fireEvent.change(within(verification).getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
  fireEvent.click(within(verification).getByRole('button', { name: '验证并进入' }))
  expect(await screen.findByText('创作内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mocks.requestJson).toHaveBeenCalledWith('/api/auth/account/phone', {
    method: 'POST', body: JSON.stringify({ phone: '+8613800000000', code: '123456' }),
  })
})
