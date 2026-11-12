// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import AuthPage from '../../src/app/routes/AuthPage'
import AppRouter from '../../src/app/AppRouter'
import { useShellStore } from '../../src/store/useShellStore'
import type { AuthSessionPayload, User } from '../../shared/contracts'

const mocks = vi.hoisted(() => ({ requestJson: vi.fn(), hydrateReadingSync: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() }))
vi.mock('../../src/app/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/app/api-client')>(),
  requestJson: mocks.requestJson,
}))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ error: mocks.toastError, success: mocks.toastSuccess }) }))
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
      { path: '/studio/novel/:novelId', useShell: false, element: <><p>创作内容</p><Link to="/me">返回个人中心</Link></> },
      { path: '/admin', useShell: false, element: <button type="button">管理操作</button> },
      { path: '/admin/app-releases', useShell: false, element: <button type="button">管理操作</button> },
      { path: '/administrator', useShell: false, element: <p>普通页面内容</p> },
      { path: '/account/docs', useShell: false, element: <p>帮助内容</p> },
      { path: '/legal', useShell: false, element: <p>政策内容</p> },
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
  accountSetupStep: null,
} as User
const phoneOnlyUser: User = { ...legacyUser, email: null, phone: '+8613800000000', phoneVerified: true, role: 'admin' }

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

function submitEmailBinding(dialog: HTMLElement, email: string) {
  const fields = within(dialog)
  fireEvent.change(fields.getByRole('textbox', { name: '邮箱' }), { target: { value: email } })
  fireEvent.change(fields.getByRole('textbox', { name: '验证码' }), { target: { value: '123456' } })
  fireEvent.click(fields.getByRole('button', { name: '验证并绑定' }))
}

function expectNewPasswordHint(dialog: HTMLElement, label: string) {
  const fields = within(dialog)
  const password = fields.getByLabelText(label) as HTMLInputElement
  const hint = fields.getByText('密码需6位数以上')
  expect(password.getAttribute('aria-describedby')).toBe(hint.id)
  expect([password.minLength, password.maxLength]).toEqual([6, 128])
}

beforeEach(() => {
  mocks.requestJson.mockReset()
  mocks.toastError.mockReset()
  mocks.toastSuccess.mockReset()
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

it.each(['login', 'register'] as const)('aligns policy consent on %s and submits only after checking the current policies', async (mode) => {
  mount(mode)
  const registering = mode === 'register'
  const checkbox = await screen.findByRole('checkbox', { name: /我已阅读并同意/ }) as HTMLInputElement
  expect(checkbox.parentElement?.classList.contains('justify-center')).toBe(!registering)
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
  expect((await screen.findByRole('alert')).textContent).toBe('暂时无法完成，请稍后重试。')
  expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('暂时无法完成，请稍后重试。')
  expect(mocks.toastSuccess).not.toHaveBeenCalled()
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
  mountApp(path, { ...phoneOnlyUser, accountSetupStep: 1 })
  const action = screen.getByRole('button', { name: '管理操作' })
  action.focus()
  expect(document.activeElement).toBe(action)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([
  { path: '/account/docs?doc=faq#doc-security', content: '帮助内容' },
  { path: '/legal?kind=terms', content: '政策内容' },
])('keeps $path available to accounts awaiting binding', ({ path, content }) => {
  mountApp(path, phoneOnlyUser)
  expect(screen.getByText(content)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['/login', '/register'])('shows the normal signed-in dialog at %s', async path => {
  mocks.requestJson.mockImplementation(async request => request === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published })
  mountApp(path, phoneOnlyUser)
  const notice = await screen.findByRole('dialog', { name: '你已经登录' })
  expect(screen.getAllByRole('dialog')).toEqual([notice])
  expect(screen.getByText('首页内容')).toBeTruthy()
  fireEvent.click(within(notice).getByRole('button', { name: '继续前往' }))
  expect(screen.getByText('个人中心内容')).toBeTruthy()
  expect(screen.getByRole('dialog', { name: '请先绑定邮箱' })).toBeTruthy()
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
      user: phoneOnlyUser,
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
  expect(screen.getAllByRole('dialog')).toEqual([screen.getByRole('dialog', { name: '请先绑定邮箱' })])
  expect(mocks.hydrateReadingSync).toHaveBeenCalledTimes(1)
})

it('keeps password recovery available before email verification', async () => {
  mocks.requestJson.mockImplementation(async path => path === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published })
  mountApp('/login?recovery=1', phoneOnlyUser)
  const recovery = await screen.findByRole('dialog', { name: '找回密码' })
  expect(screen.getAllByRole('dialog')).toEqual([recovery])
  expect(screen.getByText('首页内容')).toBeTruthy()
  expect(within(recovery).getByRole('textbox', { name: '验证码' })).toBeTruthy()
  expectNewPasswordHint(recovery, '新登录密码')
})

it('continues to require a verification code for password changes in settings', () => {
  mountApp('/settings?section=password', { ...legacyUser, emailVerified: true, passwordConfigured: true })
  const dialog = screen.getByRole('dialog', { name: '修改登录密码' })
  expect(within(dialog).getByRole('combobox', { name: '发送验证码到' })).toBeTruthy()
  expect(within(dialog).getByRole('textbox', { name: '验证码' })).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: '获取验证码' })).toBeTruthy()
  expect(within(dialog).queryByRole('progressbar')).toBeNull()
  expectNewPasswordHint(dialog, '新登录密码')
})

it.each([
  { caseName: 'no saved contact', user: { ...legacyUser, email: null, phone: null } },
  { caseName: 'a saved but unverified email', user: { ...phoneOnlyUser, email: legacyUser.email, requiresEmailBinding: true } },
  { caseName: 'email auth disabled', user: { ...phoneOnlyUser, emailAuthEnabled: false } },
])('lets a signed-in account with $caseName browse', ({ user }) => {
  mountApp('/me', user)
  expect(screen.getByText('个人中心内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '普通页面' }))
  expect(screen.getByText('普通页面内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mocks.requestJson).not.toHaveBeenCalled()
})

it('opens required binding when the existing phone-only session is restored', () => {
  mountApp('/me')
  const background = screen.getByText('个人中心内容')
  act(() => useShellStore.setState({ authStatus: 'checking' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => useShellStore.getState().syncSessionUser({ user: { ...phoneOnlyUser, role: 'user' } }))
  expect(screen.getByRole('dialog', { name: '请先绑定邮箱' })).toBeTruthy()
  expect(screen.getByText('个人中心内容')).toBe(background)
})

it('binds a signed-in phone-only administrator over the original main-site page', async () => {
  const email = 'bound@example.com'
  mocks.requestJson.mockResolvedValue({ user: { ...phoneOnlyUser, email, emailVerified: true } })
  mountApp('/me', phoneOnlyUser)
  const background = screen.getByText('个人中心内容')
  const notice = screen.getByRole('dialog', { name: '请先绑定邮箱' })
  expect(notice.hasAttribute('open')).toBe(true)
  expect(fireEvent(notice, new Event('cancel', { cancelable: true }))).toBe(false)
  fireEvent.click(within(notice).getByRole('button', { name: '前往绑定' }))

  const form = screen.getByRole('dialog', { name: '绑定邮箱', exact: true })
  expect(form.hasAttribute('open')).toBe(true)
  expect(fireEvent(form, new Event('cancel', { cancelable: true }))).toBe(false)
  const fields = within(form)
  expect(fields.queryByRole('button', { name: '关闭' })).toBeNull()
  expect(fields.queryByRole('button', { name: '跳过此步' })).toBeNull()
  expect(fields.queryByRole('link', { name: '找回密码' })).toBeNull()
  expect(fields.queryByRole('button', { name: '找回密码' })).toBeNull()
  expect(fields.getByRole('link', { name: '帮助' }).getAttribute('href')).toBe('/account/docs?doc=faq#doc-security')
  expect(fields.getByRole('button', { name: '退出登录' })).toBeTruthy()
  const emailInput = fields.getByRole('textbox', { name: '邮箱' }) as HTMLInputElement
  expect(emailInput.value).toBe('')
  expect(document.activeElement).toBe(emailInput)
  expect(screen.getByText('个人中心内容')).toBe(background)

  submitEmailBinding(form, email)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(mocks.requestJson).toHaveBeenCalledExactlyOnceWith('/api/auth/account/email', {
    method: 'POST', body: JSON.stringify({ email, code: '123456' }),
  })
  expect(window.location.pathname).toBe('/me')
  expect(screen.getByText('个人中心内容')).toBe(background)
  expect(mocks.hydrateReadingSync).toHaveBeenCalledTimes(1)
})

it('keeps the required binding prompt above the settings deep link', () => {
  mountApp('/settings?section=email', phoneOnlyUser)
  expect(screen.getByRole('heading', { name: '账号安全' })).toBeTruthy()
  expect(screen.getAllByRole('dialog')).toEqual([screen.getByRole('dialog', { name: '请先绑定邮箱' })])
})

it('requires the studio phone step after required email binding when phone proof is still needed', async () => {
  const unverified = { ...phoneOnlyUser, phoneVerified: false, studioPhoneVerificationRequired: true }
  const email = 'bound@example.com'
  mocks.requestJson.mockResolvedValue({ user: { ...unverified, email, emailVerified: true } })
  mountApp('/studio/novel/n1', unverified)
  expect(screen.queryByText('创作内容')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '前往绑定' }))
  submitEmailBinding(screen.getByRole('dialog', { name: '绑定邮箱' }), email)
  expect(await screen.findByRole('dialog', { name: '验证手机号' })).toBeTruthy()
  expect(screen.queryByText('创作内容')).toBeNull()
})

it('allows signing out from mandatory email binding', async () => {
  mocks.requestJson.mockImplementation(async path => {
    if (path === '/api/auth/logout') return { ok: true }
    return path === '/api/auth/options' ? { emailAuthEnabled: true } : { legal: published }
  })
  mountApp('/me', phoneOnlyUser)
  fireEvent.click(screen.getByRole('button', { name: '前往绑定' }))
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
  expect(await screen.findByRole('dialog', { name: '登录启创墨域' })).toBeTruthy()
  expect(mocks.requestJson).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', body: '{}' })
  expect(useShellStore.getState().authStatus).toBe('guest')
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
  fireEvent.click(screen.getByRole('button', { name: /邮箱.*待验证/ }))
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

it('shows phone verification as optional for an exempt administrator and distinguishes the reserved email', () => {
  mountApp('/settings', {
    ...legacyUser, role: 'admin', email: 'admin@chevoink.local', phone: null,
    studioPhoneVerificationRequired: false,
  })
  const phone = screen.getByRole('button', { name: /手机号.*免验证/ })
  expect(phone.textContent).toContain('超级管理员可选绑定')
  expect(screen.queryByText('创作区需要已验证的手机号')).toBeNull()
  fireEvent.click(phone)
  const binding = screen.getByRole('dialog', { name: '绑定手机号' })
  fireEvent.click(within(binding).getByRole('button', { name: '关闭' }))

  const email = screen.getByRole('button', { name: /邮箱.*系统预留地址.*待绑定/ })
  fireEvent.click(email)
  const dialog = screen.getByRole('dialog', { name: '绑定邮箱' })
  expect((within(dialog).getByRole('textbox', { name: '邮箱' }) as HTMLInputElement).value).toBe('')
  expect(useShellStore.getState().sessionUser?.emailVerified).toBe(false)
  expect(useShellStore.getState().sessionUser?.phoneVerified).toBe(false)
  expect(mocks.requestJson).not.toHaveBeenCalled()
})

it('opens studio for a server-exempt administrator without changing their phone status or onboarding', () => {
  mountApp('/studio/novel/n1', { ...legacyUser, role: 'admin', accountSetupStep: 1, studioPhoneVerificationRequired: false })
  expect(screen.getByText('创作内容')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(useShellStore.getState().sessionUser?.phoneVerified).toBe(false)
  expect(mocks.requestJson).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('link', { name: '返回个人中心' }))
  expect(screen.getByText('个人中心内容')).toBeTruthy()
  const setup = screen.getByRole('dialog', { name: '验证手机号' })
  expect(within(setup).getByRole('button', { name: '跳过此步' })).toBeTruthy()
})

it.each([
  { account: 'an ordinary admin', role: 'admin', emailAuthEnabled: true },
  { account: 'an ordinary user', role: 'user', emailAuthEnabled: true },
  { account: 'a user with email auth disabled', role: 'user', emailAuthEnabled: false },
] as const)('keeps the server-required studio phone check for $account', ({ role, emailAuthEnabled }) => {
  mountApp('/studio/novel/n1', { ...legacyUser, role, emailAuthEnabled, studioPhoneVerificationRequired: true })
  expect(screen.getByRole('dialog', { name: '验证手机号' })).toBeTruthy()
  expect(screen.queryByText('创作内容')).toBeNull()
})

it('sets the onboarding password with a matching pair and advances with the returned session', async () => {
  const user: User = { ...legacyUser, emailVerified: true, passwordConfigured: false, accountSetupStep: 2 }
  let complete!: (result: AuthSessionPayload) => void
  mocks.requestJson.mockRejectedValueOnce(new Error('synthetic failure'))
    .mockImplementationOnce(() => new Promise<AuthSessionPayload>(resolve => { complete = resolve }))
  mountApp('/me', user)
  const dialog = screen.getByRole('dialog', { name: '设置登录密码' })
  const password = within(dialog).getByLabelText('输入登录密码') as HTMLInputElement
  const confirmation = within(dialog).getByLabelText('确认登录密码') as HTMLInputElement
  expect([...dialog.querySelectorAll('input')]).toEqual([password, confirmation])
  expect([password.type, confirmation.type]).toEqual(['password', 'password'])
  expect(within(dialog).getByText('设置后可使用密码登录。')).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: '获取验证码' })).toBeNull()
  expectNewPasswordHint(dialog, '输入登录密码')

  fireEvent.change(password, { target: { value: 'synthetic-password' } })
  fireEvent.change(confirmation, { target: { value: 'different-password' } })
  const submit = within(dialog).getByRole('button', { name: '设置密码' }) as HTMLButtonElement
  fireEvent.click(submit)
  expect(within(dialog).getByRole('alert').textContent).toContain('两次输入的密码不一致')
  expect(mocks.requestJson).not.toHaveBeenCalled()

  fireEvent.change(confirmation, { target: { value: password.value } })
  const skip = within(dialog).getByRole('button', { name: '跳过此步' }) as HTMLButtonElement
  fireEvent.click(submit)
  expect((await within(dialog).findByRole('alert')).textContent).toContain('暂时无法保存密码')
  expect(submit.disabled).toBe(false)
  expect(skip.disabled).toBe(false)

  fireEvent.click(submit)
  expect(submit.disabled).toBe(true)
  expect(skip.disabled).toBe(true)
  const back = within(dialog).getByRole('button', { name: '返回上一步' }) as HTMLButtonElement
  expect(back.disabled).toBe(true)
  fireEvent.submit(submit.form!)
  fireEvent.click(skip)
  fireEvent.click(back)
  const expectedCall = ['/api/auth/account/setup/password', {
    method: 'POST', body: JSON.stringify({ password: 'synthetic-password' }),
  }]
  expect(mocks.requestJson.mock.calls).toEqual([expectedCall, expectedCall])

  const tokens = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresInSeconds: 3600 }
  const configured: User = { ...user, accountSetupStep: 3, passwordConfigured: true }
  await act(async () => complete({ user: configured, tokens }))
  expect(screen.getByRole('dialog', { name: '完善个人资料' })).toBe(dialog)
  expect(within(dialog).getByText('添加昵称、头像和封面，也可稍后在设置中完善。')).toBeTruthy()
  expect(useShellStore.getState().authTokens).toEqual(tokens)
  expect(mocks.requestJson).toHaveBeenCalledTimes(2)

  mocks.requestJson.mockResolvedValueOnce({ user: { ...configured, accountSetupStep: 2 } })
  fireEvent.click(within(dialog).getByRole('button', { name: '返回上一步' }))
  expect(await screen.findByRole('dialog', { name: '设置登录密码' })).toBe(dialog)
  expect(dialog.querySelector('[data-step-direction]')?.getAttribute('data-step-direction')).toBe('back')
  expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '设置登录密码' }))
  expect(within(dialog).getByText('已设置登录密码')).toBeTruthy()
  expect(within(dialog).queryByLabelText('输入登录密码')).toBeNull()
  expect(mocks.requestJson).toHaveBeenLastCalledWith('/api/auth/account/setup/back', {
    method: 'POST', body: JSON.stringify({ step: 3 }),
  })

  mocks.requestJson.mockResolvedValueOnce({ user: configured })
  fireEvent.click(within(dialog).getByRole('button', { name: '继续' }))
  expect(await screen.findByRole('dialog', { name: '完善个人资料' })).toBe(dialog)
  expect(dialog.querySelector('[data-step-direction]')?.getAttribute('data-step-direction')).toBe('forward')
  expect(mocks.requestJson).toHaveBeenLastCalledWith('/api/auth/account/setup', {
    method: 'POST', body: JSON.stringify({ step: 2, skip: false }),
  })
  expect(useShellStore.getState().authTokens).toEqual(tokens)
})

it('allows each setup skip and uses the legacy phone check when the server flag is missing', async () => {
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
  for (const [index, heading] of ['验证手机号', '设置登录密码', '完善个人资料'].entries()) {
    expect(await screen.findByRole('dialog', { name: heading })).toBe(setup)
    expect(screen.getByText('个人中心内容')).toBeTruthy()
    const progress = within(setup).getByRole('progressbar', { name: '账户设置进度' })
    expect(progress.getAttribute('aria-valuenow')).toBe(String(index + 1))
    expect(progress.getAttribute('aria-valuemax')).toBe('3')
    expect(progress.textContent).toBe(`${index + 1}/3`)
    expect(within(setup).queryByRole('button', { name: '退出登录' })).toBeNull()
    expect(Boolean(within(setup).queryByRole('button', { name: '返回上一步' }))).toBe(index > 0)
    const skip = within(setup).getByRole('button', { name: '跳过此步' })
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
