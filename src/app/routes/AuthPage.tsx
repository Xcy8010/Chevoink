import { useRegistrationPolicies } from '@/features/site-content/public-api'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Lock, MessageSquareText, Smartphone, UserRound } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiClientError, requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import AppImage from '@/components/ui/AppImage'
import TextInput from '@/components/ui/TextInput'
import { hydrateReadingSync } from '@/features/home/reading-sync'
import { brandMeta } from '@/lib/theme/tokens'
import { cn } from '@/lib/utils'
import { useShellStore } from '@/store/useShellStore'
import { useToast } from '@/components/ui/toast-context'
import AppState from '@/components/ui/AppState'
import EmailAuthPage from './EmailAuthPage'
import type {
  AuthSessionPayload,
  LoginRequest,
  SendSmsCodeRequest,
  SmsAccountStatus,
  SmsLoginRequest,
  SmsRegisterRequest,
} from '../../../shared/contracts'

type AuthPageMode = 'login' | 'register'

type AuthPageProps = {
  mode: AuthPageMode
}

type LoginMethod = 'password' | 'sms'

type CaptchaPayload = {
  captchaId: string
  imageBase64: string
  expiresInSeconds: number
}

type SmsCodePayload = {
  ok: true
  expireInSeconds: number
  cooldownSeconds: number
  provider: 'tencentcloud'
  accountStatus: SmsAccountStatus
  normalizedPhone: string
}

const DEFAULT_CN_PHONE_PREFIX = '+86'
const CN_PHONE_LENGTH = 11

function normalizePhoneInputValue(input: string): string {
  const digits = input.replace(/\D/g, '')

  if (!digits || digits === '86' || digits === '0086') {
    return ''
  }

  if (digits.startsWith('0086')) {
    return digits.slice(4, 4 + CN_PHONE_LENGTH)
  }

  if (digits.startsWith('86') && digits.length > CN_PHONE_LENGTH) {
    return digits.slice(2, 2 + CN_PHONE_LENGTH)
  }

  return digits.slice(0, CN_PHONE_LENGTH)
}

function buildPhoneSubmitValue(input: string): string {
  const normalizedPhone = normalizePhoneInputValue(input)

  return normalizedPhone ? `${DEFAULT_CN_PHONE_PREFIX}${normalizedPhone}` : ''
}

function normalizeRedirectPath(input: string | null): string {
  if (!input || !input.startsWith('/')) {
    return '/me'
  }

  if (input.startsWith('//')) {
    return '/me'
  }

  return input
}

/**
 * 登录/注册页（未登录的「个人中心」入口）：
 * - 手机端全出血单列，顶部品牌头像 +「点击登录/注册」式问候，参考主流阅读/社交 App
 * - 平板/电脑端居中卡片（max-w 420px），同一套表单自适应
 * - 密码框带眼睛按钮切换明文，默认隐藏
 */
export default function AuthPage({ mode }: AuthPageProps) {
  const [params] = useSearchParams()
  const options = useQuery({
    queryKey: ['auth', 'options'],
    queryFn: () => requestJson<{ emailAuthEnabled: boolean }>('/api/auth/options'),
    retry: false,
    staleTime: 0,
  })
  if (options.isPending) return <AppState tone="loading" title="正在读取登录方式" />
  if (options.isError && !(options.error instanceof ApiClientError && options.error.status === 404)) {
    return <AppState tone="error" title="暂时无法读取登录方式" primaryAction={{ label: '重试', onClick: () => { void options.refetch() } }} />
  }
  if (options.data?.emailAuthEnabled) {
    const nextMode = mode === 'login' && params.get('recovery') === '1' ? 'recovery' : mode
    return <EmailAuthPage key={nextMode} mode={nextMode} />
  }
  return <LegacyAuthPage key={mode} mode={mode} />
}

function LegacyAuthPage({ mode }: AuthPageProps) {
  const legalQuery = useRegistrationPolicies()
  const [acceptedPolicies, setAcceptedPolicies] = useState('')
  const legal = legalQuery.data?.legal
  const legalKey = legal?.terms && legal.privacy ? `${legal.terms.id}:${legal.privacy.id}` : ''
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const setAuthenticated = useShellStore((state) => state.setAuthenticated)
  const isAuthenticated = useShellStore((state) => state.authStatus === 'authenticated' && !!state.sessionUser)
  const toast = useToast()

  const redirectPath = useMemo(() => normalizeRedirectPath(searchParams.get('redirect')), [searchParams])
  const referralCode = useMemo(() => searchParams.get('ref')?.trim().toUpperCase() || undefined, [searchParams])
  const isRegisterPage = mode === 'register'

  const [loginMethod, setLoginMethod] = useState<LoginMethod>(isRegisterPage ? 'sms' : 'password')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [captchaId, setCaptchaId] = useState('')
  const [captchaImageBase64, setCaptchaImageBase64] = useState('')
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [captchaDialogVisible, setCaptchaDialogVisible] = useState(false)
  const [smsAccountStatus, setSmsAccountStatus] = useState<SmsAccountStatus | null>(isRegisterPage ? 'new' : null)
  const [submitting, setSubmitting] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [loadingCaptcha, setLoadingCaptcha] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [errorMessage, setErrorMessage] = useState('')
  const [hintMessage, setHintMessage] = useState('')

  const isSmsFlow = isRegisterPage || loginMethod === 'sms'
  const shouldCollectProfile = isRegisterPage || smsAccountStatus === 'new'
  const requiresPolicyConsent = isSmsFlow ? shouldCollectProfile : Boolean(legal?.registrationAvailable)
  const hasPolicyConsent = Boolean(legal?.registrationAvailable && legalKey && acceptedPolicies === legalKey)
  const policyConsentPending = (!isSmsFlow && legalQuery.isLoading) || (requiresPolicyConsent && !hasPolicyConsent)

  const refreshCaptcha = useCallback(async () => {
    setLoadingCaptcha(true)

    try {
      const payload = await requestJson<CaptchaPayload>('/api/auth/captcha')
      setCaptchaId(payload.captchaId)
      setCaptchaImageBase64(payload.imageBase64)
      setCaptchaAnswer('')
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : '人机验证获取失败，请稍后重试。'
      setErrorMessage(message)
      toast.error(message)
    } finally {
      setLoadingCaptcha(false)
    }
  }, [toast])

  useEffect(() => {
    if (!isSmsFlow || !captchaDialogVisible) {
      return
    }

    void refreshCaptcha()
  }, [isSmsFlow, captchaDialogVisible, refreshCaptcha])

  useEffect(() => {
    if (!cooldownUntil || cooldownUntil <= Date.now()) {
      return
    }

    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [cooldownUntil])

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  function openCaptchaDialog() {
    const trimmedPhone = phone.trim()

    if (!trimmedPhone) {
      setErrorMessage('请先输入手机号。')
      return
    }

    setErrorMessage('')
    setHintMessage('')
    setCaptchaDialogVisible(true)
  }

  async function handleSendCode() {
    setSendingCode(true)
    setErrorMessage('')
    setHintMessage('')

    try {
      const payload = await requestJson<SmsCodePayload>('/api/auth/sms/send-code', {
        method: 'POST',
        body: JSON.stringify({
          phone: buildPhoneSubmitValue(phone),
          purpose: 'auth',
          captchaId,
          captchaAnswer: captchaAnswer.trim(),
        } satisfies SendSmsCodeRequest),
      })

      setPhone(normalizePhoneInputValue(payload.normalizedPhone))
      setSmsAccountStatus(payload.accountStatus)
      setCooldownUntil(Date.now() + payload.cooldownSeconds * 1000)
      setNow(Date.now())
      setHintMessage(
        payload.accountStatus === 'existing'
          ? `验证码已发送，该手机号已有账号，验证后将直接登录。`
          : '验证码已发送，该手机号尚未注册，验证后会直接完成注册。',
      )
      setCaptchaDialogVisible(false)
      setCaptchaAnswer('')
      toast.success('验证码已发送，请注意查收短信。')
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : '验证码发送失败，请稍后再试。'
      setSmsAccountStatus(isRegisterPage ? 'new' : null)
      setErrorMessage(message)
      toast.error(message)

      // 仅人机验证答案错误保留弹窗换新图重试；其它失败（频控/日限/过期等）自动关弹窗，错误回落到页面主体展示
      if (error instanceof ApiClientError && error.code === 'AUTH_CAPTCHA_INVALID') {
        await refreshCaptcha()
      } else {
        setCaptchaDialogVisible(false)
        setCaptchaAnswer('')
      }
    } finally {
      setSendingCode(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (policyConsentPending) return
    setSubmitting(true)
    setErrorMessage('')
    setHintMessage('')

    try {
      const payload = !isSmsFlow
        ? await requestJson<AuthSessionPayload>('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({
              phone: buildPhoneSubmitValue(account),
              password,
            } satisfies LoginRequest),
          })
        : shouldCollectProfile
          ? await requestJson<AuthSessionPayload>('/api/auth/sms/register', {
              method: 'POST',
              body: JSON.stringify({
                phone: buildPhoneSubmitValue(phone),
                code: code.trim(),
                referralCode,
                legalConsent: acceptedPolicies && acceptedPolicies === legalKey && legal?.terms && legal.privacy ? {termsVersionId:legal.terms.id, privacyVersionId:legal.privacy.id} : undefined,
              } satisfies SmsRegisterRequest),
            })
          : await requestJson<AuthSessionPayload>('/api/auth/sms/login', {
              method: 'POST',
              body: JSON.stringify({
                phone: buildPhoneSubmitValue(phone),
                code: code.trim(),
              } satisfies SmsLoginRequest),
            })

      setAuthenticated({
        user: payload.user,
        tokens: payload.tokens,
        unreadMessageCount: payload.user.unreadMessageCount,
        unreadNotificationCount: payload.user.unreadNotificationCount,
      })

      // 重新登录后：游客期的 /me 等缓存全部作废，并立即水合云端书架/阅读进度，
      // 避免个人中心的书架短暂为空（启动时的水合在游客态下已静默失败过）
      void queryClient.invalidateQueries()
      void hydrateReadingSync().then((changed) => {
        if (changed) {
          void queryClient.invalidateQueries({ queryKey: ['community', 'me'] })
        }
      })

      if (isSmsFlow && shouldCollectProfile) {
        navigate('/me', {
          replace: true,
          state: {
            showPostRegisterPrompt: true,
          },
        })
        return
      }

      navigate(redirectPath, { replace: true })
    } catch (error) {
      setErrorMessage(error instanceof ApiClientError ? error.message : '暂时无法完成提交，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  if (isAuthenticated) {
    return (
      <section className="mx-auto flex w-full max-w-[420px] flex-col items-center px-4 pt-10 text-center md:pt-16">
        <span className="inline-flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-default)]">
          <AppImage src="/favicon.png" alt={`${brandMeta.productName} Logo`} className="h-full w-full" priority />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-[var(--text-primary)]">你已经登录</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          可以直接回到个人中心，继续查看书架、草稿和互动记录。
        </p>
        <div className="mt-6 w-full space-y-3">
          <Button variant="primary" className="h-11 w-full" onClick={() => navigate(redirectPath, { replace: true })}>
            继续前往
          </Button>
          <Button variant="secondary" className="h-11 w-full" onClick={() => navigate('/settings')}>
            打开设置
          </Button>
        </div>
      </section>
    )
  }

  const segTabClass = (active: boolean) =>
    cn(
      'press-feedback relative flex-1 pb-2.5 text-center text-sm font-medium transition-colors',
      active ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
    )

  return (
    <div className="flex justify-center">
      {/* 手机端全出血；md 起收成一张居中卡片，宽度对手机/平板/电脑分别自适应 */}
      <section className="w-full max-w-[420px] px-1 pt-6 md:rounded-[28px] md:border md:border-[var(--border-subtle)] md:bg-[var(--surface-default)] md:px-8 md:py-9 md:shadow-[var(--shadow-card)]">
        {/* 品牌问候区：头像 + 点击登录/注册（参考主流阅读 App 未登录个人中心） */}
        <div className="flex items-center gap-4">
          <span className="relative inline-flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
            <AppImage src="/favicon.png" alt={`${brandMeta.productName} Logo`} className="h-full w-full" priority />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              {isRegisterPage ? '创建账户' : '点击登录/注册'}
            </h1>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">
              {isRegisterPage
                ? '注册后即可收藏作品、发布内容和创作小说'
                : '登录后书架、草稿和互动记录都会同步保留'}
            </p>
          </div>
        </div>

        {/* 登录方式切换：X 风格文字 Tab + 下划线，注册页固定验证码流程 */}
        {!isRegisterPage ? (
          <div className="mt-7 flex border-b border-[var(--border-subtle)]">
            <button
              type="button"
              className={segTabClass(loginMethod === 'password')}
              onClick={() => {
                setLoginMethod('password')
                setErrorMessage('')
                setHintMessage('')
              }}
            >
              密码登录
              {loginMethod === 'password' ? (
                <span className="absolute inset-x-0 bottom-0 mx-auto h-1 w-10 rounded-full bg-[var(--color-brand)]" />
              ) : null}
            </button>
            <button
              type="button"
              className={segTabClass(loginMethod === 'sms')}
              onClick={() => {
                setLoginMethod('sms')
                setErrorMessage('')
                setHintMessage('')
              }}
            >
              验证码登录
              {loginMethod === 'sms' ? (
                <span className="absolute inset-x-0 bottom-0 mx-auto h-1 w-10 rounded-full bg-[var(--color-brand)]" />
              ) : null}
            </button>
          </div>
        ) : null}

        <form className={cn('space-y-4', isRegisterPage ? 'mt-7' : 'mt-6')} onSubmit={handleSubmit}>
          {!isSmsFlow ? (
            <>
              <TextInput
                id="account"
                value={account}
                onChange={(event) => setAccount(normalizePhoneInputValue(event.target.value))}
                placeholder="手机号"
                autoComplete="tel"
                inputMode="tel"
                required
                className="h-12 md:h-12"
                leading={<Smartphone className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />}
              />
              <TextInput
                id="password"
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="密码"
                autoComplete="current-password"
                required
                className="h-12 md:h-12"
                leading={<Lock className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />}
                trailing={
                  <button
                    type="button"
                    onClick={() => setPasswordVisible((visible) => !visible)}
                    aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                    className="press-feedback -mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                }
              />
            </>
          ) : (
            <>
              <TextInput
                id="phone"
                value={phone}
                onChange={(event) => setPhone(normalizePhoneInputValue(event.target.value))}
                placeholder="手机号"
                autoComplete="tel"
                inputMode="tel"
                required
                className="h-12 md:h-12"
                leading={<Smartphone className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />}
              />
              <TextInput
                id="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="6 位验证码"
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                className="h-12 md:h-12"
                leading={<MessageSquareText className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />}
                trailing={
                  <button
                    type="button"
                    disabled={sendingCode || cooldownSeconds > 0}
                    onClick={openCaptchaDialog}
                    className="press-feedback shrink-0 whitespace-nowrap text-sm font-medium text-[var(--color-brand)] transition-opacity disabled:opacity-50"
                  >
                    {sendingCode ? '发送中…' : cooldownSeconds > 0 ? `${cooldownSeconds}s 后重发` : '获取验证码'}
                  </button>
                }
              />
            </>
          )}

          {requiresPolicyConsent && (legal?.registrationAvailable ? (
            <div className="flex items-center justify-center gap-2 text-sm leading-6">
              <input
                id="auth-policy-consent"
                type="checkbox"
                className="shrink-0"
                aria-labelledby="auth-policy-text"
                checked={hasPolicyConsent}
                onChange={(event) => setAcceptedPolicies(event.target.checked ? legalKey : '')}
              />
              <span id="auth-policy-text">
                <label htmlFor="auth-policy-consent">我已阅读并同意</label>{' '}
                <Link className="underline" to="/legal?kind=terms" target="_blank">服务条款</Link> 与{' '}
                <Link className="underline" to="/legal?kind=privacy" target="_blank">隐私政策</Link>
              </span>
            </div>
          ) : (
            <p className="text-center text-sm leading-6">
              {legalQuery.isLoading ? '正在读取注册政策…' : '正式服务条款与隐私政策尚未生效，暂时无法注册。'}
            </p>
          ))}
          {hintMessage ? (
            <p className="rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
              {hintMessage}
            </p>
          ) : null}

          {errorMessage ? (
            <p className="rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" variant="primary" disabled={submitting || policyConsentPending} className="h-12 w-full text-base">
            {submitting ? '提交中…' : !isSmsFlow ? '登录' : shouldCollectProfile ? '完成注册' : '验证后直接登录'}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--text-secondary)]">
          {isRegisterPage ? '已经有账户？' : '还没有账户？'}{' '}
          <Link
            to={isRegisterPage ? `/login?redirect=${encodeURIComponent(redirectPath)}` : `/register?redirect=${encodeURIComponent(redirectPath)}`}
            className="font-semibold text-[var(--color-brand)]"
          >
            {isRegisterPage ? '去登录' : '创建账户'}
          </Link>
        </p>

        {/* 次要入口：先逛逛 / 未登录也能调整基础设置 */}
        <div className="mt-4 flex items-center justify-center gap-4 text-sm text-[var(--text-tertiary)]">
          <button type="button" className="transition-colors hover:text-[var(--text-primary)]" onClick={() => navigate('/')}>
            先逛逛首页
          </button>
          <span className="h-3 w-px bg-[var(--border-subtle)]" />
          <button type="button" className="transition-colors hover:text-[var(--text-primary)]" onClick={() => navigate('/settings')}>
            前往设置
          </button>
        </div>

        <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-[var(--text-tertiary)]">
          <UserRound className="h-3.5 w-3.5" />
          {brandMeta.productName} · 阅读与创作，从这里开始
        </p>
      </section>

      {captchaDialogVisible ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-[440px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-5 shadow-xl">
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">完成人机验证</h3>
              <p className="text-sm leading-6 text-[var(--text-secondary)]">请输入图片中的数字和字母，验证通过后才会发送短信验证码。</p>
            </div>

            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3">
                {loadingCaptcha ? (
                  <span className="inline-flex h-[64px] min-w-[168px] items-center text-sm text-[var(--text-secondary)]">加载中…</span>
                ) : captchaImageBase64 ? (
                  <img src={captchaImageBase64} alt="图形验证码" className="h-[64px] w-[168px] object-contain" />
                ) : (
                  <span className="inline-flex h-[64px] min-w-[168px] items-center text-sm text-[var(--text-secondary)]">请刷新验证码</span>
                )}
                <Button type="button" variant="secondary" onClick={() => void refreshCaptcha()} disabled={loadingCaptcha}>
                  刷新验证码
                </Button>
              </div>

              <TextInput
                id="captchaAnswer"
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.target.value)}
                placeholder="请输入图片中的数字和字母"
                autoComplete="off"
                maxLength={4}
                required
              />

              {errorMessage ? (
                <p className="rounded-[var(--radius-md)] bg-[var(--surface-muted)] px-3 py-2 text-sm leading-6 text-[var(--color-danger,#dc2626)]">
                  {errorMessage}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex gap-3">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setCaptchaDialogVisible(false)
                  setCaptchaAnswer('')
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="primary"
                className="flex-1"
                disabled={sendingCode || !captchaId || !captchaAnswer.trim()}
                onClick={handleSendCode}
              >
                {sendingCode ? '发送中…' : '确认并发送'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
