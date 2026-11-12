import { useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { requiresLegacyEmailBinding } from '@/features/account/account-access'
import { IdentityVerificationForm, SetupPasswordForm } from '@/features/account/AccountVerificationForms'
import ProfileSetupForm from '@/features/account/ProfileSetupForm'
import { authError, postAuth } from '@/features/account/auth-api'
import { useUpdateAccountSession } from '@/features/account/use-account-session'
import { AccountDialog } from '@/features/account/VerificationCodeField'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import type { AuthSessionPayload, User } from '../../../shared/contracts'

function LegacyEmailBindingDialog() {
  const [binding, setBinding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  async function signOut() {
    if (saving || signingOut) return
    setSigningOut(true)
    setError('')
    try {
      await postAuth('/logout', {})
      useShellStore.getState().setGuest()
      queryClient.clear()
      navigate('/login', { replace: true })
    } catch (error) {
      setError(authError(error, '暂时无法确认退出登录，请稍后重试。'))
    } finally {
      setSigningOut(false)
    }
  }

  if (!binding) {
    return (
      <AccountDialog key="notice" title="请先绑定邮箱" description="绑定的邮箱可用于登录、找回密码和接收账户通知。">
        <Button variant="primary" className="w-full" onClick={() => setBinding(true)}>前往绑定</Button>
      </AccountDialog>
    )
  }

  return (
    <AccountDialog key="binding" title="绑定邮箱" description="验证邮箱后即可继续使用当前账户。">
      <IdentityVerificationForm kind="email" submitLabel="验证并绑定" disabled={signingOut} onSaving={setSaving} onSaved={() => {
        void queryClient.invalidateQueries()
        void hydrateReadingSync().then(changed => {
          if (changed) void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
        })
      }} />
      <nav className="mt-5 flex items-center justify-between gap-3 text-sm" aria-label="账户帮助">
        <Link className="rounded text-[var(--color-brand)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2"
          to="/account/docs?doc=faq#doc-security" target="_blank" rel="noreferrer">帮助</Link>
        <button type="button" disabled={saving || signingOut} onClick={() => void signOut()}
          className="rounded text-[var(--text-secondary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 disabled:opacity-50">
          {signingOut ? '退出中…' : '退出登录'}
        </button>
      </nav>
      {error && <p role="alert" className="mt-2 text-xs text-[var(--color-danger,#dc2626)]">{error}</p>}
    </AccountDialog>
  )
}

function AccountSetupStep({ user, step }: { user: User; step: 1 | 2 | 3 }) {
  const requestPending = useRef(false)
  const [pending, setPending] = useState(false)
  const [formSaving, setFormSaving] = useState(false)
  const [error, setError] = useState('')
  const updateSession = useUpdateAccountSession()
  const toast = useToast()
  const isPhone = step === 1
  const isPassword = step === 2
  const fulfilled = isPhone ? user.phoneVerified : isPassword ? user.hasPassword ?? user.passwordConfigured : false

  async function finish(request: 'continue' | 'skip' | 'back' | { password: string }) {
    if (requestPending.current || (formSaving && (request === 'skip' || request === 'back'))) return
    requestPending.current = true
    setPending(true)
    setError('')
    const savingPassword = typeof request === 'object'
    try {
      if (savingPassword) {
        const result = await postAuth<AuthSessionPayload>('/account/setup/password', request)
        if (updateSession(result.user, result.tokens)) toast.success('登录密码已设置。')
      } else {
        const result = request === 'back'
          ? await postAuth<{ user: User }>('/account/setup/back', { step })
          : await postAuth<{ user: User }>('/account/setup', { step, skip: request === 'skip' })
        if (updateSession(result.user)) {
          if (request === 'back') toast.success('已返回上一步。')
          else if (request === 'skip') toast.success(isPhone ? '已跳过手机号验证。' : isPassword ? '已跳过密码设置。' : '已跳过个人资料设置。')
          else toast.success(isPhone ? '手机号已验证。' : isPassword ? '登录密码已设置。' : '个人资料设置已完成。')
        }
      }
    } catch (error) {
      const message = authError(error, savingPassword ? '暂时无法保存密码，请稍后重试。' : '暂时无法切换步骤，请稍后重试。')
      setError(message)
      toast.error(message)
    } finally {
      requestPending.current = false
      setPending(false)
    }
  }

  const onSaved = () => { void finish('continue') }
  return (
    <>
      <div className="min-w-0">
        {fulfilled ? <div className="space-y-4">
          {isPassword && <p className="text-sm text-[var(--text-secondary)]">已设置登录密码</p>}
          <Button variant="primary" className="w-full" disabled={pending} onClick={onSaved}>{pending ? '提交中…' : '继续'}</Button>
        </div>
          : isPhone ? <IdentityVerificationForm kind="phone" submitLabel="验证并继续" disabled={pending} notifySuccess={false} onSaving={setFormSaving} onSaved={onSaved} />
            : isPassword ? <SetupPasswordForm disabled={pending} onSave={password => { void finish({ password }) }} />
              : <ProfileSetupForm user={user} disabled={pending} onSaving={setFormSaving} onSaved={onSaved} />}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger,#dc2626)]">{error}</p>}
      </div>
      <footer className="mt-4 flex items-center justify-between gap-2 md:col-span-2 md:mt-0">
        <div role="progressbar" aria-label="账户设置进度" aria-valuemin={0} aria-valuemax={3} aria-valuenow={step}
          className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="grid w-14 grid-cols-3 gap-1 sm:w-20">
            {[1, 2, 3].map(segment => (
              <span key={segment} className={cn('h-1.5 rounded-full',
                segment <= step ? 'bg-[var(--color-brand)]' : 'bg-[var(--surface-muted)]')} />
            ))}
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--text-secondary)]">{step}/3</span>
        </div>
        <div className="-mr-2 flex shrink-0 items-center gap-1 sm:-mr-3 sm:gap-2">
          <Button variant="ghost" className="px-2 sm:px-3" disabled={pending || formSaving} onClick={() => void finish('skip')}>跳过此步</Button>
          {step > 1 && <Button variant="ghost" className="px-2 sm:px-3" disabled={pending || formSaving} onClick={() => void finish('back')}>返回上一步</Button>}
        </div>
      </footer>
    </>
  )
}

export default function AccountAccessGate({ children, studioPhoneRequired, closeStudioGate }: {
  children: ReactNode
  studioPhoneRequired: boolean
  closeStudioGate: () => void
}) {
  const { pathname } = useLocation()
  const user = useShellStore(state => state.sessionUser)
  const authenticated = useShellStore(state => state.authStatus === 'authenticated')
  const studioPhoneExempt = user?.studioPhoneVerificationRequired === false && !user.phoneVerified
  const skipAccountDialogs = /^\/admin(?:\/|$)/i.test(pathname) || /^\/(?:login|register|account\/docs|legal)\/?$/i.test(pathname)
  const skipSetup = skipAccountDialogs || (studioPhoneExempt && /^\/studio(?:\/|$)/i.test(pathname))
  let dialog: ReactNode = null
  if (authenticated && user) {
    if (!skipAccountDialogs && requiresLegacyEmailBinding(user)) {
      dialog = <LegacyEmailBindingDialog key={user.id} />
    } else if (user.emailAuthEnabled && user.accountSetupStep && !skipSetup) {
      const step = user.accountSetupStep
      const title = step === 1 ? '验证手机号' : step === 2 ? '设置登录密码' : '完善个人资料'
      const description = step === 1 ? (studioPhoneExempt ? undefined : '创作区需要已验证的手机号。')
        : step === 2 ? '设置后可使用密码登录。' : '添加昵称、头像和封面，也可稍后在设置中完善。'
      dialog = (
        <AccountDialog key={user.id} title={title} step={step} description={description}>
          <AccountSetupStep user={user} step={step} />
        </AccountDialog>
      )
    } else if (studioPhoneRequired) {
      dialog = (
        <AccountDialog title="验证手机号" description="验证后会继续打开创作区。" onClose={closeStudioGate}>
          <IdentityVerificationForm key={user.id} kind="phone" submitLabel="验证并进入" onSaved={() => {}} />
        </AccountDialog>
      )
    }
  }
  return <>{children}{dialog}</>
}
