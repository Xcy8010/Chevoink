import { useId, useState, type FormEvent } from 'react'
import { Mail, Smartphone } from 'lucide-react'

import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import type { AuthSessionPayload, User } from '../../../shared/contracts'
import { authError, emailAddress, mainlandPhone, postAuth } from './auth-api'
import { useUpdateAccountSession } from './use-account-session'
import VerificationCodeField from './VerificationCodeField'

type FormCallbacks = {
  onSaved: () => void
  onSaving?: (saving: boolean) => void
  disabled?: boolean
}

export function IdentityVerificationForm({ kind, submitLabel, initialValue = '', onSaved, onSaving, disabled, notifySuccess = true }: FormCallbacks & {
  kind: 'email' | 'phone'
  submitLabel: string
  initialValue?: string
  notifySuccess?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inputId = useId()
  const updateSession = useUpdateAccountSession()
  const toast = useToast()
  const isEmail = kind === 'email'
  const target = isEmail ? emailAddress(value) : mainlandPhone(value)
  const label = isEmail ? '邮箱' : '手机号'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || disabled) return
    if (!target) {
      const message = `请输入有效的${label}。`
      setError(message)
      toast.error(message)
      return
    }
    setError('')
    setSaving(true)
    onSaving?.(true)
    try {
      const payload = isEmail ? { email: target, code } : { phone: target, code }
      const result = await postAuth<{ user: User }>(`/account/${kind}`, payload)
      if (updateSession(result.user)) {
        if (notifySuccess) toast.success(`${label}已验证。`)
        onSaved()
      }
    } catch (error) {
      const message = authError(error, '暂时无法完成验证，请稍后重试。')
      setError(message)
      toast.error(message)
    } finally {
      setSaving(false)
      onSaving?.(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={inputId}>{label}</label>
        <TextInput
          wrapperAs="span"
          id={inputId}
          type={isEmail ? 'email' : 'tel'}
          autoComplete={isEmail ? 'email' : 'tel'}
          placeholder={isEmail ? 'name@example.com' : '请输入您的手机号'}
          leading={isEmail ? <Mail aria-hidden="true" className="size-4 shrink-0" /> : <Smartphone aria-hidden="true" className="size-4 shrink-0" />}
          value={value}
          onChange={event => { setValue(event.target.value); setCode(''); setError('') }}
          maxLength={isEmail ? 254 : 25}
          disabled={saving || disabled}
          required
        />
      </div>
      <VerificationCodeField
        key={target}
        value={code}
        onChange={setCode}
        canSend={Boolean(target)}
        disabled={saving || disabled}
        onSend={captcha => isEmail
          ? postAuth('/email/send-code', { email: target, purpose: 'bind', ...captcha })
          : postAuth('/account/phone/send-code', { phone: target, ...captcha })}
      />
      {error && <p role="alert" className="text-sm leading-6 text-[var(--color-danger,#dc2626)]">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={saving || disabled}>{saving ? '验证中…' : submitLabel}</Button>
    </form>
  )
}

export function SetupPasswordForm({ disabled, onSave }: { disabled: boolean; onSave: (password: string) => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const toast = useToast()
  const passwordId = useId()
  const confirmationId = useId()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    if (password !== confirmation) {
      setError('两次输入的密码不一致。')
      toast.error('两次输入的密码不一致。')
      return
    }
    const normalizedPassword = password.trim()
    if (normalizedPassword.length < 6 || normalizedPassword.length > 128) {
      setError('请输入 6 至 128 个字符的登录密码。')
      toast.error('请输入 6 至 128 个字符的登录密码。')
      return
    }
    setError('')
    onSave(normalizedPassword)
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={passwordId}>输入登录密码</label>
        <TextInput wrapperAs="span" id={passwordId} type="password" autoComplete="new-password" minLength={6} maxLength={128}
          value={password} onChange={event => { setPassword(event.target.value); setError('') }} disabled={disabled} required />
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={confirmationId}>确认登录密码</label>
        <TextInput wrapperAs="span" id={confirmationId} type="password" autoComplete="new-password" minLength={6} maxLength={128}
          value={confirmation} onChange={event => { setConfirmation(event.target.value); setError('') }} disabled={disabled} required />
      </div>
      {error && <p role="alert" className="text-sm leading-6 text-[var(--color-danger,#dc2626)]">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={disabled}>{disabled ? '保存中…' : '设置密码'}</Button>
    </form>
  )
}

export function PasswordVerificationForm({ user, onSaved, onSaving, disabled }: FormCallbacks & { user: User }) {
  const canEmail = Boolean(user.email && user.emailVerified)
  const canSms = Boolean(user.phone && user.phoneVerified)
  const [channel, setChannel] = useState<'email' | 'sms'>(canEmail ? 'email' : 'sms')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const updateSession = useUpdateAccountSession()
  const modeId = useId()
  const passwordId = useId()
  const confirmationId = useId()
  const canVerify = channel === 'email' ? canEmail : canSms
  const buttonLabel = user.passwordConfigured || user.hasPassword ? '更新密码' : '设置密码'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || disabled || !canVerify) return
    if (password !== confirmation) {
      setError('两次输入的密码不一致。')
      return
    }
    setError('')
    setSaving(true)
    onSaving?.(true)
    try {
      const result = await postAuth<AuthSessionPayload>('/account/password', { channel, code, password })
      if (updateSession(result.user, result.tokens)) onSaved()
    } catch (error) {
      setError(authError(error, '暂时无法保存密码，请稍后重试。'))
    } finally {
      setSaving(false)
      onSaving?.(false)
    }
  }

  if (!canEmail && !canSms) {
    return <p className="text-sm leading-6 text-[var(--text-secondary)]">请先验证邮箱或手机号，再设置登录密码。</p>
  }

  return (
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={modeId}>发送验证码到</label>
        <select
          id={modeId}
          className="h-11 w-full rounded-[var(--radius-pill)] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 text-sm text-[var(--text-primary)]"
          value={channel}
          disabled={saving || disabled}
          onChange={event => { setChannel(event.target.value === 'email' ? 'email' : 'sms'); setCode(''); setError('') }}
        >
          {canEmail && <option value="email">已验证邮箱</option>}
          {canSms && <option value="sms">已验证手机号</option>}
        </select>
      </div>
      <VerificationCodeField
        key={channel}
        value={code}
        onChange={setCode}
        canSend={canVerify}
        disabled={saving || disabled}
        onSend={captcha => postAuth('/account/password/send-code', { channel, ...captcha })}
      />
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={passwordId}>新登录密码</label>
        <TextInput wrapperAs="span" id={passwordId} type="password" autoComplete="new-password" minLength={6} maxLength={128}
          placeholder="请输入新密码"
          value={password} onChange={event => setPassword(event.target.value)} disabled={saving || disabled} required />
      </div>
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={confirmationId}>再次输入新密码</label>
        <TextInput wrapperAs="span" id={confirmationId} type="password" autoComplete="new-password" minLength={6} maxLength={128}
          placeholder="请再次输入新密码"
          value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={saving || disabled} required />
      </div>
      {error && <p role="alert" className="text-sm leading-6 text-[var(--color-danger,#dc2626)]">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={saving || disabled}>{saving ? '保存中…' : buttonLabel}</Button>
    </form>
  )
}
