import { useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import Button from '@/components/ui/Button'
import { IdentityVerificationForm, SetupPasswordForm } from '@/features/account/AccountVerificationForms'
import ProfileSetupForm from '@/features/account/ProfileSetupForm'
import { authError, postAuth } from '@/features/account/auth-api'
import { useUpdateAccountSession } from '@/features/account/use-account-session'
import { AccountDialog } from '@/features/account/VerificationCodeField'
import { useShellStore } from '@/store/useShellStore'
import type { AuthSessionPayload, User } from '../../../shared/contracts'

function AccountSetupStep({ user, step }: { user: User; step: 1 | 2 | 3 }) {
  const requestPending = useRef(false)
  const [pending, setPending] = useState(false)
  const [formSaving, setFormSaving] = useState(false)
  const [error, setError] = useState('')
  const updateSession = useUpdateAccountSession()
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
        updateSession(result.user, result.tokens)
      } else {
        const result = request === 'back'
          ? await postAuth<{ user: User }>('/account/setup/back', { step })
          : await postAuth<{ user: User }>('/account/setup', { step, skip: request === 'skip' })
        updateSession(result.user)
      }
    } catch (error) {
      setError(authError(error, savingPassword ? '暂时无法保存密码，请稍后重试。' : '暂时无法切换步骤，请稍后重试。'))
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
          : isPhone ? <IdentityVerificationForm kind="phone" submitLabel="验证并继续" disabled={pending} onSaving={setFormSaving} onSaved={onSaved} />
            : isPassword ? <SetupPasswordForm disabled={pending} onSave={password => { void finish({ password }) }} />
              : <ProfileSetupForm user={user} disabled={pending} onSaving={setFormSaving} onSaved={onSaved} />}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger,#dc2626)]">{error}</p>}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 md:col-span-2 md:mt-0">
        <Button variant="ghost" className="-ml-3" disabled={pending || formSaving} onClick={() => void finish('skip')}>跳过此步</Button>
        {step > 1 && <Button variant="ghost" className="-mr-3" disabled={pending || formSaving} onClick={() => void finish('back')}>返回上一步</Button>}
      </div>
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
  const skipSetup = /^\/admin(?:\/|$)/i.test(pathname) || /^\/(?:login|register)\/?$/i.test(pathname)
    || pathname === '/account/docs' || pathname === '/legal'
    || (studioPhoneExempt && /^\/studio(?:\/|$)/i.test(pathname))
  let dialog: ReactNode = null
  if (authenticated && user) {
    if (user.emailAuthEnabled && user.accountSetupStep && !skipSetup) {
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
