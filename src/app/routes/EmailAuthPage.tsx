import { useId, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Lock, Mail, Smartphone } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import { authError, authRedirectPath, emailAddress, mainlandPhone, postAuth, type CaptchaAnswer, type CodeReceipt } from '@/features/account/auth-api'
import VerificationCodeField, { AccountDialog } from '@/features/account/VerificationCodeField'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { useRegistrationPolicies } from '@/features/site-content/public-api'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import type { AuthSessionPayload } from '../../../shared/contracts'

type AuthMode = 'login' | 'register' | 'recovery'
type LoginMethod = 'password' | 'code'

export default function EmailAuthPage({ mode, onClose }: { mode: AuthMode; onClose: () => void }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const setAuthenticated = useShellStore(state => state.setAuthenticated)
  const setGuest = useShellStore(state => state.setGuest)
  const isAuthenticated = useShellStore(state => state.authStatus === 'authenticated')
  const [method, setMethod] = useState<LoginMethod>('password')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [acceptedPolicy, setAcceptedPolicy] = useState('')
  const [codeHelpOpen, setCodeHelpOpen] = useState(false)
  const identityId = useId()
  const passwordId = useId()
  const isRegister = mode === 'register'
  const isRecovery = mode === 'recovery'
  const usesCode = mode !== 'login' || method === 'code'
  const usesPassword = isRecovery || !usesCode
  const email = emailAddress(identifier)
  const phone = isRegister ? '' : mainlandPhone(identifier)
  const showPhoneIcon = !isRegister && /^\+?[\d -]+$/.test(identifier.trim())
  const target = email || phone
  const policyQuery = useRegistrationPolicies()
  const policy = policyQuery.data?.legal
  const consentKey = policy?.terms && policy.privacy ? policy.terms.id + ':' + policy.privacy.id : ''
  const legalConsent = consentKey && acceptedPolicy === consentKey && policy?.registrationAvailable && policy.terms && policy.privacy
    ? { termsVersionId: policy.terms.id, privacyVersionId: policy.privacy.id }
    : undefined
  const redirect = authRedirectPath(searchParams.get('redirect'))
  const referralCode = searchParams.get('ref')?.trim().toUpperCase()
  const authQuery = new URLSearchParams({ redirect })
  if (referralCode) authQuery.set('ref', referralCode)
  const loginPath = '/login?' + authQuery.toString()
  const registerPath = '/register?' + authQuery.toString()

  function switchMethod(nextMethod: LoginMethod) {
    setMethod(nextMethod)
    setCode('')
    setError('')
  }

  async function sendCode(captcha: CaptchaAnswer): Promise<CodeReceipt> {
    if (isRecovery) return postAuth('/reset/send-code', { identifier: target, ...captcha })
    if (email) return postAuth('/email/send-code', { email, purpose: isRegister ? 'register' : 'login', ...captcha })
    return postAuth('/sms/send-code', { phone, purpose: 'login', ...captcha })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || (isRegister && !legalConsent)) return
    if (!target) {
      const message = isRegister ? '请输入有效的邮箱地址。' : '请输入有效的邮箱地址或手机号。'
      setError(message)
      toast.error(message)
      return
    }
    if (isRecovery && password !== passwordConfirm) {
      setError('两次输入的密码不一致。')
      toast.error('两次输入的密码不一致。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      if (isRecovery) {
        await postAuth('/reset', { identifier: target, code, password })
        if (isAuthenticated) {
          setGuest()
          queryClient.clear()
        }
        toast.success('登录密码已重置。')
        navigate(loginPath, { replace: true })
        return
      }
      let result: AuthSessionPayload
      if (isRegister) result = await postAuth('/email/register', { email, code, legalConsent, referralCode })
      else if (!usesCode) result = await postAuth('/login', { identifier: target, password })
      else if (email) result = await postAuth('/email/login', { email, code })
      else result = await postAuth('/sms/login', { phone, code })
      setAuthenticated({ user: result.user, tokens: result.tokens })
      toast.success(isRegister ? '注册成功。' : '登录成功。')
      void queryClient.invalidateQueries()
      void hydrateReadingSync().then(changed => {
        if (changed) void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
      })
      navigate(redirect, { replace: true })
    } catch (error) {
      const message = authError(error, '暂时无法完成，请稍后重试。')
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  if (isAuthenticated && !isRecovery) {
    return (
      <AccountDialog title="你已经登录" onClose={onClose}>
        <Button variant="primary" className="w-full" onClick={() => navigate(redirect, { replace: true })}>继续前往</Button>
      </AccountDialog>
    )
  }

  return (
    <AccountDialog brand title={isRegister ? '创建账户' : isRecovery ? '找回密码' : '登录启创墨域'} onClose={() => { if (!submitting) onClose() }}>
      {mode === 'login' && <div className="mb-6 flex gap-5 border-b border-[var(--border-subtle)]" aria-label="登录方式">
        {(['password', 'code'] as const).map(item => (
          <button key={item} type="button" aria-pressed={item === method} disabled={submitting}
            className={cn('border-b-2 px-1 pb-2.5 text-sm focus-visible:outline focus-visible:outline-2', item === method ? 'border-[var(--color-brand)] font-semibold' : 'border-transparent text-[var(--text-secondary)]')}
            onClick={() => switchMethod(item)}>
            {item === 'password' ? '密码登录' : '验证码登录'}
          </button>
        ))}
      </div>}
      <form className="space-y-4" onSubmit={event => void submit(event)}>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor={identityId}>{isRegister ? '邮箱' : '邮箱或手机号'}</label>
          <TextInput
            wrapperAs="span"
            id={identityId}
            type={isRegister ? 'email' : 'text'}
            autoComplete={isRegister ? 'email' : 'username'}
            placeholder={isRegister ? 'name@example.com' : '请输入您的邮箱或手机号'}
            leading={
              <span aria-hidden="true" className={cn(
                'relative block size-4 shrink-0',
                !isRegister && !identifier.trim() && 'account-identifier-cycle',
              )}>
                <Mail className={cn('absolute inset-0 size-4 motion-safe:transition-opacity', showPhoneIcon && 'opacity-0')} />
                {!isRegister && <Smartphone className={cn('absolute inset-0 size-4 motion-safe:transition-opacity', !showPhoneIcon && 'opacity-0')} />}
              </span>
            }
            value={identifier}
            onChange={event => { setIdentifier(event.target.value); setCode(''); setError('') }}
            required
            disabled={submitting}
            maxLength={254}
          />
        </div>
        {usesCode && <VerificationCodeField key={mode + ':' + method + ':' + target} value={code} onChange={setCode} canSend={Boolean(target) && (!isRegister || policy?.registrationAvailable === true)} disabled={submitting} onSend={sendCode} />}
        {usesPassword && <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor={passwordId}>{isRecovery ? '新登录密码' : '登录密码'}</label>
          <TextInput
            wrapperAs="span"
            id={passwordId}
            type={passwordVisible ? 'text' : 'password'}
            autoComplete={isRecovery ? 'new-password' : 'current-password'}
            placeholder={isRecovery ? '请输入新密码' : '请输入您的密码'}
            leading={<Lock aria-hidden="true" className="h-4 w-4 shrink-0" />}
            trailing={<button type="button" aria-label={passwordVisible ? '隐藏密码' : '显示密码'} onClick={() => setPasswordVisible(value => !value)} className="rounded p-1 focus-visible:outline focus-visible:outline-2">
              {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>}
            value={password}
            onChange={event => setPassword(event.target.value)}
            required
            disabled={submitting}
            minLength={isRecovery ? 6 : undefined}
            maxLength={isRecovery ? 128 : 1024}
          />
        </div>}
        {isRecovery && <label className="block space-y-1.5 text-sm font-medium">
          <span>再次输入新密码</span>
          <TextInput wrapperAs="span" type="password" autoComplete="new-password" placeholder="请再次输入新密码" value={passwordConfirm} onChange={event => setPasswordConfirm(event.target.value)} required disabled={submitting} minLength={6} maxLength={128} />
        </label>}
        {isRegister && (policy?.registrationAvailable && consentKey ? (
          <div className="flex items-start gap-2.5 text-left text-sm leading-6">
            <input type="checkbox" id="email-auth-policy" className="mt-1 size-4 shrink-0" checked={Boolean(legalConsent)}
              onChange={event => setAcceptedPolicy(event.target.checked ? consentKey : '')} aria-labelledby="email-auth-policy-label" />
            <span id="email-auth-policy-label"><label htmlFor="email-auth-policy">我已阅读并同意</label>{' '}
              <Link className="underline underline-offset-2" to="/legal?kind=terms" target="_blank">服务条款</Link> 与{' '}
              <Link className="underline underline-offset-2" to="/legal?kind=privacy" target="_blank">隐私政策</Link>
            </span>
          </div>
        ) : <p role="status" className="text-sm leading-6 text-[var(--text-secondary)]">
          {policyQuery.isLoading ? '正在读取注册政策…' : '正式服务条款与隐私政策尚未生效，暂时无法注册。'}
        </p>)}
        {error && <p role="alert" className="text-sm leading-6 text-[var(--color-danger,#dc2626)]">{error}</p>}
        <Button type="submit" variant="primary" disabled={submitting || (isRegister && !legalConsent)} className="w-full" size="lg">
          {submitting ? '提交中…' : isRegister ? '注册' : isRecovery ? '重置密码' : '登录'}
        </Button>
      </form>
      <nav className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--color-brand)]" aria-label="账户操作">
        {isRegister && <button type="button" onClick={() => setCodeHelpOpen(true)}
          className="rounded text-blue-600 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 dark:text-blue-400">收不到验证码</button>}
        <Link to={mode === 'login' ? registerPath : loginPath}>{mode === 'login' ? '还没有账户？点击创建！' : '返回登录'}</Link>
        {mode === 'login' && <Link to={loginPath + '&recovery=1'}>找回密码</Link>}
      </nav>
      {codeHelpOpen && <AccountDialog title="收不到验证码" onClose={() => setCodeHelpOpen(false)}>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-[var(--text-secondary)]">
          <li>核对邮箱拼写和后缀，确认收件箱能够接收新邮件。</li>
          <li>检查垃圾邮件、广告邮件和企业邮箱隔离区。发件人为 <span className="whitespace-nowrap font-medium text-[var(--text-primary)]">chevoink@chevolink.com</span>，主题为「【启创墨域】邮箱验证码」。</li>
          <li>等待片刻，倒计时结束后再发送一次。企业或学校邮箱可能有拦截规则，可以联系邮箱管理员。</li>
        </ol>
        <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">可使用有效的常见邮箱地址，例如 QQ 邮箱、网易邮箱、Outlook 或 Gmail。邮件能否送达取决于邮箱服务商及所在组织的过滤规则。</p>
        <Button variant="primary" className="mt-5 w-full" onClick={() => setCodeHelpOpen(false)}>知道了</Button>
      </AccountDialog>}
    </AccountDialog>
  )
}
