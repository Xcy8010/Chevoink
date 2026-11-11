import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import Button from '@/components/ui/Button'
import { IdentityVerificationForm, PasswordVerificationForm } from '@/features/account/AccountVerificationForms'
import ProfileSetupForm from '@/features/account/ProfileSetupForm'
import { authError, postAuth } from '@/features/account/auth-api'
import { useUpdateAccountSession } from '@/features/account/use-account-session'
import { AccountDialog } from '@/features/account/VerificationCodeField'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { useShellStore } from '@/store/useShellStore'
import type { User } from '../../../shared/contracts'

function AccountScreen({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), [title])
  return (
    <main className="min-h-dvh bg-[var(--app-bg)] px-5 pb-10 pt-[max(2rem,var(--safe-top,0px))] text-[var(--text-primary)] sm:px-8 sm:pt-16">
      <section className="mx-auto w-full max-w-[430px] sm:rounded-3xl sm:border sm:border-[var(--border-subtle)] sm:bg-[var(--surface-default)] sm:p-8">
        <header className="mb-6 space-y-2">
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">{title}</h1>
          {description && <p className="text-sm leading-6 text-[var(--text-secondary)]">{description}</p>}
        </header>
        {children}
      </section>
    </main>
  )
}

function SignOutLink() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  async function signOut() {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await postAuth('/logout', {})
      useShellStore.getState().setGuest()
      queryClient.clear()
      navigate('/login', { replace: true })
    } catch (error) {
      setError(authError(error, '暂时无法确认退出登录，请稍后重试。'))
    } finally {
      setPending(false)
    }
  }

  return <div className="space-y-1">
    <button type="button" disabled={pending} onClick={() => void signOut()} className="rounded text-sm text-[var(--text-secondary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2">
      {pending ? '退出中…' : '退出登录'}
    </button>
    {error && <p role="alert" className="text-xs text-[var(--color-danger,#dc2626)]">{error}</p>}
  </div>
}

function BindRequired({ returnPath }: { returnPath: string }) {
  const queryClient = useQueryClient()
  const [binding, setBinding] = useState(false)
  if (!binding) {
    return (
      <main className="min-h-dvh bg-[var(--app-bg)]">
        <AccountDialog title="请先绑定邮箱">
          <p className="text-sm leading-6 text-[var(--text-secondary)]">绑定的邮箱可用于登录、找回密码和接收账户通知。</p>
          <Button variant="primary" className="mt-5 w-full" onClick={() => setBinding(true)}>前往绑定</Button>
        </AccountDialog>
      </main>
    )
  }
  return (
    <AccountScreen title="绑定邮箱" description="验证邮箱后即可继续使用当前账户。">
      <IdentityVerificationForm kind="email" submitLabel="验证并绑定" onSaved={() => {
        void queryClient.invalidateQueries()
        void hydrateReadingSync().then(changed => {
          if (changed) void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
        })
      }} />
      <nav className="mt-5 flex flex-wrap items-start justify-between gap-x-5 gap-y-3 text-sm" aria-label="账户帮助">
        <Link className="text-[var(--color-brand)]" to="/account/docs" target="_blank" rel="noreferrer">帮助</Link>
        <Link className="text-[var(--color-brand)]" to={`/login?recovery=1&redirect=${encodeURIComponent(returnPath)}`}>找回密码</Link>
        <SignOutLink />
      </nav>
    </AccountScreen>
  )
}

function AccountSetupStep({ user, step }: { user: User; step: 1 | 2 | 3 }) {
  const [pending, setPending] = useState(false)
  const [formSaving, setFormSaving] = useState(false)
  const [error, setError] = useState('')
  const updateSession = useUpdateAccountSession()
  const isPhone = step === 1
  const isPassword = step === 2
  const fulfilled = isPhone ? user.phoneVerified : isPassword ? user.hasPassword ?? user.passwordConfigured : false

  async function finish(skip: boolean) {
    if (pending || (skip && formSaving)) return
    setPending(true)
    setError('')
    try {
      const result = await postAuth<{ user: User }>('/account/setup', { step, skip })
      updateSession(result.user)
    } catch (error) {
      setError(authError(error, '暂时无法继续，请稍后重试。'))
    } finally {
      setPending(false)
    }
  }

  const onSaved = () => { void finish(false) }
  return (
    <>
      <div className="min-w-0">
        {fulfilled ? <Button variant="primary" className="w-full" disabled={pending} onClick={onSaved}>{pending ? '提交中…' : '继续'}</Button>
          : isPhone ? <IdentityVerificationForm kind="phone" submitLabel="验证并继续" disabled={pending} onSaving={setFormSaving} onSaved={onSaved} />
            : isPassword ? <PasswordVerificationForm user={user} disabled={pending} onSaving={setFormSaving} onSaved={onSaved} />
              : <ProfileSetupForm user={user} disabled={pending} onSaving={setFormSaving} onSaved={onSaved} />}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger,#dc2626)]">{error}</p>}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 md:col-span-2 md:mt-0">
        <Button variant="ghost" className="-ml-3" disabled={pending || formSaving} onClick={() => void finish(true)}>跳过此步</Button>
        <SignOutLink />
      </div>
    </>
  )
}

export default function AccountAccessGate({ children, studioPhoneRequired, closeStudioGate }: {
  children: ReactNode
  studioPhoneRequired: boolean
  closeStudioGate: () => void
}) {
  const { pathname, search } = useLocation()
  const user = useShellStore(state => state.sessionUser)
  const authenticated = useShellStore(state => state.authStatus === 'authenticated')
  if (!authenticated || !user?.emailAuthEnabled) return <>{children}</>

  const recovery = pathname === '/login' && new URLSearchParams(search).get('recovery') === '1'
  if (pathname === '/account/docs' || pathname === '/legal' || recovery) return <>{children}</>
  if (user.requiresEmailBinding) return <BindRequired key={user.id} returnPath={pathname + search} />
  if (user.accountSetupStep && !/^\/(?:login|register)\/?$/i.test(pathname)) {
    const step = user.accountSetupStep
    const title = step === 1 ? '验证手机号' : step === 2 ? '设置登录密码' : '完善个人资料'
    return (
      <>
        {children}
        <AccountDialog key={user.id} title={title} step={step} description={step === 1 ? '创作区需要已验证的手机号。' : undefined}>
          <AccountSetupStep user={user} step={step} />
        </AccountDialog>
      </>
    )
  }
  if (studioPhoneRequired) {
    return (
      <>
        {children}
        <AccountDialog title="验证手机号" description="验证后会继续打开创作区。" onClose={closeStudioGate}>
          <IdentityVerificationForm key={user.id} kind="phone" submitLabel="验证并进入" onSaved={() => {}} />
        </AccountDialog>
      </>
    )
  }
  return <>{children}</>
}
