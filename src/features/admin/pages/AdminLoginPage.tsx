import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import { cn } from '@/lib/utils'
import type { AdminCaptchaPayload } from '../../../../shared/contracts/index.js'
import { adminLogin, adminSendLoginSmsCode, getAdminCaptcha } from '../api'

type LoginChannel = 'email' | 'phone'
type PhoneMethod = 'password' | 'code'

export default function AdminLoginPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [channel, setChannel] = useState<LoginChannel>('email')
  const [phoneMethod, setPhoneMethod] = useState<PhoneMethod>('password')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [captcha, setCaptcha] = useState<AdminCaptchaPayload | null>(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSendingCode, setIsSendingCode] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  const refreshCaptcha = useCallback(async () => {
    try {
      setCaptcha(await getAdminCaptcha())
    } catch {
      toast.error('人机验证获取失败，请稍后重试。')
    }
  }, [toast])

  useEffect(() => {
    void refreshCaptcha()
  }, [refreshCaptcha])

  // 发码冷却倒计时
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const requireCaptcha = (): { captchaId: string; captchaAnswer: string } | null => {
    if (!captcha || !captchaAnswer.trim()) {
      toast.error('请先完成人机验证。')
      return null
    }
    return { captchaId: captcha.captchaId, captchaAnswer: captchaAnswer.trim() }
  }

  const handleSendCode = async () => {
    if (isSendingCode || cooldown > 0) return
    if (!phone.trim()) {
      toast.error('请输入手机号。')
      return
    }
    const captchaPayload = requireCaptcha()
    if (!captchaPayload) return

    setIsSendingCode(true)
    try {
      const result = await adminSendLoginSmsCode({ phone: phone.trim(), ...captchaPayload })
      toast.success('验证码已发送，请注意查收短信。')
      setCooldown(Math.max(result.cooldownSeconds || 60, 30))
      setCode('')
      // 人机验证一次性消费：发码后刷新
      setCaptchaAnswer('')
      void refreshCaptcha()
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '验证码发送失败，请稍后重试。')
      setCaptchaAnswer('')
      void refreshCaptcha()
    } finally {
      setIsSendingCode(false)
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return

    const needsCaptcha = channel === 'email' || phoneMethod === 'password'
    const captchaPayload = needsCaptcha ? requireCaptcha() : null
    if (needsCaptcha && !captchaPayload) return

    if (channel === 'email' && !email.trim()) {
      toast.error('请输入管理员邮箱。')
      return
    }
    if (channel === 'phone' && !phone.trim()) {
      toast.error('请输入手机号。')
      return
    }
    if (channel === 'email' && !password) {
      toast.error('请输入密码。')
      return
    }
    if (channel === 'phone' && phoneMethod === 'password' && !password) {
      toast.error('请输入密码。')
      return
    }
    if (channel === 'phone' && phoneMethod === 'code' && !code.trim()) {
      toast.error('请输入短信验证码。')
      return
    }

    setIsSubmitting(true)
    try {
      await adminLogin({
        email: channel === 'email' ? email.trim() : undefined,
        phone: channel === 'phone' ? phone.trim() : undefined,
        password: phoneMethod === 'code' && channel === 'phone' ? undefined : password || undefined,
        code: channel === 'phone' && phoneMethod === 'code' ? code.trim() : undefined,
        captchaId: captchaPayload?.captchaId,
        captchaAnswer: captchaPayload?.captchaAnswer,
      })
      toast.success('登录成功')
      navigate('/admin', { replace: true })
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : '登录失败，请稍后重试。'
      toast.error(message)
      // 验证码一次性消费：无论哪种失败都需要刷新
      setCaptchaAnswer('')
      void refreshCaptcha()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="admin-workspace flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.png" alt="启创墨域 Logo" width={44} height={44} className="h-11 w-11 rounded-md object-contain" />
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-[var(--text-primary)]">启创墨域 · 管理后台</h1>
            <p className="text-sm text-[var(--text-secondary)]">仅限管理员访问，操作全程留痕</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5"
        >
          {/* 登录通道切换 */}
          <div className="grid grid-cols-2 gap-1 rounded-full bg-[var(--surface-muted)] p-1">
            {(
              [
                { key: 'email', label: '邮箱登录' },
                { key: 'phone', label: '手机号登录' },
              ] as Array<{ key: LoginChannel; label: string }>
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setChannel(item.key)}
                className={cn(
                  'rounded-full py-1.5 text-sm transition-colors',
                  channel === item.key
                    ? 'bg-[var(--surface-default)] font-medium text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)]',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {channel === 'email' ? (
            <div>
              <p className="mb-1.5 text-sm text-[var(--text-secondary)]">管理员邮箱</p>
              <TextInput
                type="email"
                autoComplete="email"
                placeholder="admin@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          ) : (
            <div>
              <p className="mb-1.5 text-sm text-[var(--text-secondary)]">管理员手机号</p>
              <TextInput
                type="tel"
                autoComplete="tel"
                placeholder="请输入绑定管理员的手机号"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          )}

          {channel === 'phone' ? (
            <div>
              <p className="mb-1.5 text-sm text-[var(--text-secondary)]">验证方式</p>
              <div className="grid grid-cols-2 gap-1 rounded-full bg-[var(--surface-muted)] p-1">
                {(
                  [
                    { key: 'password', label: '密码' },
                    { key: 'code', label: '短信验证码' },
                  ] as Array<{ key: PhoneMethod; label: string }>
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setPhoneMethod(item.key)}
                    className={cn(
                      'rounded-full py-1.5 text-sm transition-colors',
                      phoneMethod === item.key
                        ? 'bg-[var(--surface-default)] font-medium text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-secondary)]',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {channel === 'phone' && phoneMethod === 'code' ? (
            <div>
              <p className="mb-1.5 text-sm text-[var(--text-secondary)]">短信验证码</p>
              <div className="flex gap-2">
                <TextInput
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="请输入短信验证码"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
                <Button
                  type="button"
                  className="shrink-0"
                  disabled={isSendingCode || cooldown > 0}
                  onClick={() => void handleSendCode()}
                >
                  {cooldown > 0 ? `${cooldown}s 后重发` : isSendingCode ? '发送中…' : '获取验证码'}
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">获取验证码需先完成下方人机验证</p>
            </div>
          ) : (
            <div>
              <p className="mb-1.5 text-sm text-[var(--text-secondary)]">密码</p>
              <TextInput
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}

          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">人机验证</p>
            <div className="flex items-center gap-3">
              {captcha ? (
                <button type="button" title="点击刷新" onClick={() => void refreshCaptcha()} className="shrink-0">
                  <img
                    src={captcha.imageBase64}
                    alt="验证码图片"
                    className="h-[42px] w-[112px] rounded-lg border border-[var(--border-strong)] bg-white"
                  />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void refreshCaptcha()}
                  className="flex h-[42px] w-[112px] shrink-0 items-center justify-center rounded-lg border border-[var(--border-strong)] text-xs text-[var(--text-secondary)]"
                >
                  点击加载
                </button>
              )}
              <TextInput
                placeholder="图中字符"
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.target.value)}
              />
            </div>
          </div>

          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? '登录中…' : '登录管理后台'}
          </Button>

          <p className="text-center text-xs text-[var(--text-secondary)]">
            5 次失败将锁定 15 分钟 ·{' '}
            <Link to="/" className="underline hover:text-[var(--text-primary)]">
              返回主站
            </Link>
          </p>
        </form>
      </div>
    </div>
  )
}
