// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import AuthPage from '../../src/app/routes/AuthPage'

const mocks = vi.hoisted(() => ({ requestJson: vi.fn() }))
vi.mock('../../src/app/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/app/api-client')>(),
  requestJson: mocks.requestJson,
}))
vi.mock('../../src/components/ui/toast-context', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))

const published = { terms: { id: 'terms-1' }, privacy: { id: 'privacy-1' }, registrationAvailable: true }
const unavailable = { terms: null, privacy: null, registrationAvailable: false }

function mount(mode: 'login' | 'register', legal: typeof published | typeof unavailable = published) {
  mocks.requestJson.mockImplementation(async (path) => {
    if (path === '/api/auth/legal-policies') return { legal }
    throw new Error('synthetic form submission')
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><AuthPage mode={mode} /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => { mocks.requestJson.mockReset() })
afterEach(cleanup)

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
  expect(mocks.requestJson).toHaveBeenCalledTimes(1)

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
