import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { RotateCw, X } from 'lucide-react'

import { ApiClientError, requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import TextInput from '@/components/ui/TextInput'
import { authError, type CaptchaAnswer, type CodeReceipt } from './auth-api'

type Captcha = { captchaId: string; imageBase64: string }

export function AccountDialog({ title, children, onClose }: {
  title: string
  children: React.ReactNode
  onClose?: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    dialog?.querySelector<HTMLElement>('input:not([type="file"])')?.focus()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose?.() }}
      className="animate-fade-in-up motion-reduce:!animate-none fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-[420px] overflow-hidden rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-0 text-[var(--text-primary)] shadow-xl backdrop:bg-black/50"
    >
      <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
        <header className="mb-5 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
          {onClose && <Button variant="ghost" size="sm" className="w-9 shrink-0 px-0" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>}
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  )
}

function CaptchaPrompt({ onSend, onDone, onClose }: {
  onSend: (answer: CaptchaAnswer) => Promise<CodeReceipt>
  onDone: (receipt: CodeReceipt) => void
  onClose: () => void
}) {
  const [captcha, setCaptcha] = useState<Captcha>()
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const answerId = useId()

  async function refresh() {
    setLoading(true)
    setAnswer('')
    try {
      setCaptcha(await requestJson<Captcha>('/api/auth/captcha'))
    } catch (error) {
      setCaptcha(undefined)
      setError(authError(error, '暂时无法获取图形验证码，请重试。'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (sending || !captcha || !answer.trim()) return
    setSending(true)
    setError('')
    try {
      onDone(await onSend({ captchaId: captcha.captchaId, captchaAnswer: answer.trim() }))
    } catch (error) {
      setError(authError(error, '暂时无法发送验证码，请重试。'))
      if (error instanceof ApiClientError && error.code === 'AUTH_CAPTCHA_INVALID') await refresh()
    } finally {
      setSending(false)
    }
  }

  return (
    <AccountDialog title="完成人机验证" onClose={() => { if (!sending) onClose() }}>
      <form className="space-y-4" onSubmit={event => void submit(event)}>
        <div className="flex items-center gap-3">
          {loading ? <span className="flex h-14 w-36 items-center text-sm text-[var(--text-secondary)]">加载中…</span>
            : captcha ? <img className="h-14 w-36 object-contain" src={captcha.imageBase64} alt="图形验证码" />
              : <span className="flex h-14 w-36 items-center text-sm text-[var(--text-secondary)]">请刷新验证码</span>}
          <Button size="sm" variant="ghost" disabled={loading || sending} onClick={() => { setError(''); void refresh() }}>
            <RotateCw aria-hidden="true" className="h-3.5 w-3.5" /> 刷新
          </Button>
        </div>
        <label htmlFor={answerId} className="block text-sm font-medium">图中的数字和字母</label>
        <TextInput wrapperAs="span" id={answerId} autoComplete="off" required maxLength={4} value={answer} onChange={event => setAnswer(event.target.value)} />
        {error && <p role="alert" className="text-sm text-[var(--color-danger,#dc2626)]">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={!captcha || !answer.trim() || loading || sending}>
          {sending ? '发送中…' : '确认并发送'}
        </Button>
      </form>
    </AccountDialog>
  )
}

export default function VerificationCodeField({ value, onChange, canSend, disabled, onSend }: {
  value: string
  onChange: (value: string) => void
  canSend: boolean
  disabled?: boolean
  onSend: (answer: CaptchaAnswer) => Promise<CodeReceipt>
}) {
  const inputId = useId()
  const [captchaOpen, setCaptchaOpen] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [sent, setSent] = useState(false)
  const cooldownUntil = useRef(0)
  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown(Math.max(0, Math.ceil((cooldownUntil.current - Date.now()) / 1_000))), 1_000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium">验证码</label>
      <TextInput
        wrapperAs="span"
        id={inputId}
        value={value}
        onChange={event => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        autoComplete="one-time-code"
        inputMode="numeric"
        placeholder="6 位验证码"
        minLength={6}
        maxLength={6}
        required
        disabled={disabled}
        trailing={<button type="button" disabled={disabled || !canSend || countdown > 0} className="shrink-0 whitespace-nowrap rounded px-1 py-2 text-sm font-medium text-[var(--color-brand)] focus-visible:outline focus-visible:outline-2 disabled:opacity-50" onClick={() => setCaptchaOpen(true)}>
          {countdown ? `${countdown}s 后重发` : '获取验证码'}
        </button>}
      />
      {sent && <p role="status" className="text-xs text-[var(--text-secondary)]">请求已提交，请查看收件箱或短信。</p>}
      {captchaOpen && <CaptchaPrompt onSend={onSend} onClose={() => setCaptchaOpen(false)} onDone={receipt => {
        cooldownUntil.current = Date.now() + receipt.cooldownSeconds * 1_000
        setCountdown(Math.max(0, receipt.cooldownSeconds))
        setSent(true)
        setCaptchaOpen(false)
        requestAnimationFrame(() => document.getElementById(inputId)?.focus())
      }} />}
    </div>
  )
}
