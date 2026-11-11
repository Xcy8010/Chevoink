import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Check,
  ChevronLeft,
  Download,
  FileText,
  KeyRound,
  Lock,
  LogOut,
  Maximize,
  Moon,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sun,
  UserRound,
  UserRoundCheck,
  Users,
  X,
  Cpu,
} from 'lucide-react'

import { ApiClientError, requestJson } from '@/app/api-client'
import BottomSheet from '@/components/layout/BottomSheet'
import AppState from '@/components/ui/AppState'
import { SettingsSkeleton } from '@/components/ui/Skeleton'
import Button from '@/components/ui/Button'
import ImageCropperDialog from '@/components/ui/ImageCropperDialog'
import TextInput from '@/components/ui/TextInput'
import { useToast } from '@/components/ui/toast-context'
import Avatar from '@/features/community/components/Avatar'
import { getMe, updateMyPrivacy } from '@/features/community/api'
import ConfirmDialog from '@/features/studio/components/ConfirmDialog'
import { useShellStore } from '@/store/useShellStore'
import { getProfileImageUploadError, prepareAvatarImage, readFileAsDataUrl } from '@/lib/image-compress'
import { PROFILE_IMAGE_MAX_MB } from '../../../shared/contracts/api.js'
import { checkAppUpdate, type VersionManifest } from '@/lib/app-update'
import { getNativeAppVersion, isNativeApp, openExternalUrl } from '@/lib/native-app'
import { cn } from '@/lib/utils'
import type {
  PrivacyLevel,
  PrivacySettings,
  UpdateMyAvatarRequest,
  UpdateMyCoverRequest,
  UpdateMyPasswordRequest,
  UpdateMyProfileRequest,
  User,
} from '../../../shared/contracts'
import { ANDROID_APK_URL, CLIENT_OS_OPTIONS, DESKTOP_CLIENT_OS_OPTIONS, type ClientOsKey } from './settings/client-os'
import { isMobileClientPlatform, isWindowsDesktopApp } from '@/lib/desktop-app'
import { getWindowsDownload, WINDOWS_RELEASES_URL, type WindowsDownload } from '@/lib/windows-download'
import {
  DEFAULT_PRIVACY,
  PRIVACY_ITEMS,
  PRIVACY_LEVEL_META,
  PRIVACY_LEVEL_ORDER,
  maskPhoneNumber,
  type SettingsDialogState,
} from './settings/privacy'
import { SectionTitle, SettingsRow } from './settings/settings-row'
import CustomModelSettingsDialog from '@/features/account/CustomModelSettingsDialog'
import DesktopSettings from './settings/desktop-settings'
import EmailAccountSettings from './settings/EmailAccountSettings'

/** 等待指定毫秒（检测更新动画至少展示 1.5 秒，哪怕请求提前返回） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const toast = useToast()
  const theme = useShellStore((state) => state.theme)
  const setTheme = useShellStore((state) => state.setTheme)
  const fullscreenEnabled = useShellStore((state) => state.fullscreenEnabled)
  const setFullscreenEnabled = useShellStore((state) => state.setFullscreenEnabled)
  const authStatus = useShellStore((state) => state.authStatus)
  const sessionUser = useShellStore((state) => state.sessionUser)
  const setGuest = useShellStore((state) => state.setGuest)
  const syncSessionUser = useShellStore((state) => state.syncSessionUser)
  const unreadMessageCount = useShellStore((state) => state.unreadMessageCount)
  const unreadNotificationCount = useShellStore((state) => state.unreadNotificationCount)

  /** 当前打开的设置弹窗：昵称简介 / 登录密码 / 某个隐私维度 / 新版本提示 */
  const [openDialog, setOpenDialog] = useState<SettingsDialogState>(null)
  const [nickname, setNickname] = useState('')
  const [bio, setBio] = useState('')
  const [profileSubmitting, setProfileSubmitting] = useState(false)
  const [avatarSubmitting, setAvatarSubmitting] = useState(false)
  const [coverSubmitting, setCoverSubmitting] = useState(false)
  const [coverDraft, setCoverDraft] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [passwordMode, setPasswordMode] = useState<'old' | 'sms'>('old')
  const [smsSending, setSmsSending] = useState(false)
  const [smsCooldown, setSmsCooldown] = useState(0)
  const [privacy, setPrivacy] = useState<PrivacySettings>(DEFAULT_PRIVACY)
  const [privacySubmittingKey, setPrivacySubmittingKey] = useState<keyof PrivacySettings | null>(null)
  /** 检测更新：仅 APP 壳内使用 */
  const [updateChecking, setUpdateChecking] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<VersionManifest | null>(null)
  /** 下载平台不依赖窗口宽度；Windows 包就绪前不开放桌面入口。 */
  const mobileClient = isMobileClientPlatform()
  const clientOptions = mobileClient ? CLIENT_OS_OPTIONS : DESKTOP_CLIENT_OS_OPTIONS
  const [windowsDownload, setWindowsDownload] = useState<WindowsDownload | null>(null)
  const [clientDownloading, setClientDownloading] = useState(false)
  const [clientDialogOpen, setClientDialogOpen] = useState(false)
  const [selectedClientOs, setSelectedClientOs] = useState<ClientOsKey | null>(null)
  const clientDialogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!clientDialogOpen) return
    const previousFocus = document.activeElement
    setSelectedClientOs(null)
    clientDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [clientDialogOpen, mobileClient])
  /** 退出登录二次确认弹窗 */
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [logoutSubmitting, setLogoutSubmitting] = useState(false)
  const [customModelsOpen, setCustomModelsOpen] = useState(() => searchParams.get('section') === 'models')

  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const coverInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (mobileClient || isNativeApp() || isWindowsDesktopApp()) return
    const controller = new AbortController()
    void getWindowsDownload(controller.signal).then((download) => {
      if (!controller.signal.aborted) setWindowsDownload(download)
    }).catch(() => { /* No verified download manifest: do not advertise a broken download. */ })
    return () => controller.abort()
  }, [mobileClient])

  useEffect(() => {
    setNickname(sessionUser?.nickname ?? '')
    setBio(sessionUser?.bio ?? '')
  }, [sessionUser?.nickname, sessionUser?.bio])

  // 隐私设置从 /users/me 拉取（登录响应里不带），失败时保持默认公开
  useEffect(() => {
    if (authStatus !== 'authenticated') {
      return
    }

    let cancelled = false
    getMe()
      .then((payload) => {
        if (!cancelled && payload.user?.privacy) {
          setPrivacy({ ...DEFAULT_PRIVACY, ...payload.user.privacy })
        }
      })
      .catch((): undefined => undefined)

    return () => {
      cancelled = true
    }
  }, [authStatus])

  // 验证码发送后的倒计时
  useEffect(() => {
    if (smsCooldown <= 0) {
      return
    }

    const timer = window.setInterval(() => {
      setSmsCooldown((value) => (value > 1 ? value - 1 : 0))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [smsCooldown])

  function syncUser(user: User) {
    syncSessionUser({
      user,
      unreadMessageCount,
      unreadNotificationCount,
    })
  }


  /** 手动检测 APP 更新：已是最新给 toast，有新版本弹窗展示。
   * 「检测中…」动画至少持续 1.5 秒：请求提前返回时也等满时长，避免一闪而过 */
  async function handleCheckUpdate() {
    if (updateChecking) return
    setUpdateChecking(true)

    try {
      const [result] = await Promise.all([checkAppUpdate(), delay(1500)])

      if (result.status === 'update') {
        setAvailableUpdate(result.manifest)
        setOpenDialog({ kind: 'update' })
      } else {
        setAvailableUpdate(null)
        toast.success('当前已是最新版本')
      }
    } catch {
      toast.error('检测更新失败，请检查网络后重试')
    } finally {
      setUpdateChecking(false)
    }
  }

  /** 确认下载客户端：安卓直接前往下载 APK，苹果/鸿蒙暂未开发 */
  async function handleClientDownload(os: ClientOsKey) {
    if (!clientOptions.some((option) => option.key === os) || clientDownloading) return
    if (os === 'windows') {
      setClientDownloading(true)
      try {
        const download = await getWindowsDownload()
        setWindowsDownload(download)
        window.location.assign(download.url)
        setClientDialogOpen(false)
      } catch {
        toast.error('Windows 下载暂不可用，请稍后重试或查看发布页')
      } finally {
        setClientDownloading(false)
      }
      return
    }
    if (os === 'android') {
      openExternalUrl(ANDROID_APK_URL)
      setClientDialogOpen(false)
      return
    }
    toast.info('暂未开发，敬请期待！')
  }

  async function handleLogout() {
    setLogoutSubmitting(true)

    try {
      await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } catch {
      toast.error('暂时无法确认退出登录，请稍后重试。')
      return
    } finally {
      setLogoutSubmitting(false)
    }
    setLogoutConfirmOpen(false)
    setGuest()
    navigate('/login', { replace: true })
  }

  async function handleUpdateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!nickname.trim()) {
      toast.error('请输入昵称。')
      return
    }

    setProfileSubmitting(true)

    try {
      const payload = await requestJson<{ user: User }>('/api/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          nickname: nickname.trim(),
          bio: bio.trim(),
        } satisfies UpdateMyProfileRequest),
      })

      syncUser(payload.user)
      setOpenDialog(null)
      toast.success('个人信息已保存')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法保存个人信息，请稍后再试。')
    } finally {
      setProfileSubmitting(false)
    }
  }

  async function uploadAvatar(avatarDataUrl: string | null) {
    const payload = await requestJson<{ user: User }>('/api/users/me/avatar', {
      method: 'PATCH',
      body: JSON.stringify({
        avatarDataUrl,
      } satisfies UpdateMyAvatarRequest),
    })

    syncUser(payload.user)
  }

  async function uploadCover(coverDataUrl: string | null) {
    const payload = await requestJson<{ user: User }>('/api/users/me/cover', {
      method: 'PATCH',
      body: JSON.stringify({
        coverDataUrl,
      } satisfies UpdateMyCoverRequest),
    })

    syncUser(payload.user)
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    const validationError = getProfileImageUploadError(file, '头像')
    if (validationError) {
      toast.error(validationError)
      event.target.value = ''
      return
    }

    setAvatarSubmitting(true)

    try {
      await uploadAvatar(await prepareAvatarImage(file))
      toast.success('头像已更新')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法上传头像，请稍后再试。')
    } finally {
      setAvatarSubmitting(false)
      event.target.value = ''
    }
  }

  // 选中封面文件后先进入裁剪弹窗，确认后才上传
  async function handleCoverChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    try {
      const validationError = getProfileImageUploadError(file, '封面')
      if (validationError) {
        toast.error(validationError)
        return
      }
      setCoverDraft(await readFileAsDataUrl(file))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '封面文件无效。')
    } finally {
      event.target.value = ''
    }
  }

  async function handleCoverCropConfirm(croppedDataUrl: string) {
    setCoverSubmitting(true)

    try {
      await uploadCover(croppedDataUrl)
      setCoverDraft(null)
      toast.success('个人封面已更新')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法上传封面，请稍后再试。')
    } finally {
      setCoverSubmitting(false)
    }
  }

  async function handleResetAvatar() {
    setAvatarSubmitting(true)

    try {
      await uploadAvatar(null)
      toast.success('已恢复默认头像')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法恢复默认头像，请稍后再试。')
    } finally {
      setAvatarSubmitting(false)
    }
  }

  async function handleResetCover() {
    setCoverSubmitting(true)

    try {
      await uploadCover(null)
      toast.success('已移除个人封面')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法移除封面，请稍后再试。')
    } finally {
      setCoverSubmitting(false)
    }
  }

  async function handlePrivacyChange(key: keyof PrivacySettings, level: PrivacyLevel) {
    if (privacy[key] === level || privacySubmittingKey) {
      return
    }

    const previous = privacy
    setPrivacy((current) => ({ ...current, [key]: level }))
    setPrivacySubmittingKey(key)

    try {
      const latest = await updateMyPrivacy({ [key]: level })
      setPrivacy({ ...DEFAULT_PRIVACY, ...latest })
    } catch (error) {
      setPrivacy(previous)
      toast.error(error instanceof Error ? error.message : '暂时无法更新隐私设置，请稍后再试。')
    } finally {
      setPrivacySubmittingKey(null)
      setOpenDialog(null)
    }
  }

  async function handleSendPasswordResetCode() {
    if (smsSending || smsCooldown > 0) {
      return
    }

    setSmsSending(true)

    try {
      const payload = await requestJson<{ ok: boolean; cooldownSeconds: number }>('/api/users/me/password/sms-code', {
        method: 'POST',
      })

      setSmsCooldown(payload.cooldownSeconds > 0 ? payload.cooldownSeconds : 60)
      toast.success('验证码已发送至绑定手机号，请查收')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法发送验证码，请稍后再试。')
    } finally {
      setSmsSending(false)
    }
  }

  async function handleSetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (password.trim().length < 6) {
      toast.error('登录密码至少需要 6 位。')
      return
    }

    if (password !== passwordConfirm) {
      toast.error('两次输入的密码不一致，请重新确认。')
      return
    }

    const passwordConfigured = Boolean(sessionUser?.passwordConfigured)

    if (passwordConfigured && passwordMode === 'old' && !oldPassword.trim()) {
      toast.error('请输入当前密码。')
      return
    }

    if (passwordConfigured && passwordMode === 'sms' && !smsCode.trim()) {
      toast.error('请输入手机验证码。')
      return
    }

    setPasswordSubmitting(true)

    try {
      const payload = await requestJson<{ user: User }>('/api/users/me/password', {
        method: 'PATCH',
        body: JSON.stringify({
          password: password.trim(),
          ...(passwordConfigured && passwordMode === 'old' ? { oldPassword: oldPassword.trim() } : {}),
          ...(passwordConfigured && passwordMode === 'sms' ? { code: smsCode.trim() } : {}),
        } satisfies UpdateMyPasswordRequest),
      })

      syncUser(payload.user)
      setPassword('')
      setPasswordConfirm('')
      setOldPassword('')
      setSmsCode('')
      setPasswordMode('old')
      setOpenDialog(null)
      toast.success(
        passwordConfigured ? '登录密码已更新，下次登录请使用新密码' : '登录密码已设置成功，之后可以直接使用手机号和密码登录',
      )
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '暂时无法设置登录密码，请稍后再试。')
    } finally {
      setPasswordSubmitting(false)
    }
  }

  // 页内返回按钮（与帖子详情同款样式）：壳层大标题已隐藏，优先回上一页，无历史则回个人中心
  const backButton = (
    <button
      type="button"
      onClick={() => {
        if (window.history.length > 1) {
          navigate(-1)
        } else {
          navigate('/me')
        }
      }}
      className="press-feedback -ml-1 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-1 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
    >
      <ChevronLeft className="h-4 w-4" />
      返回
    </button>
  )

  // 会话校验中：先给骨架，避免闪现登录引导
  if (authStatus === 'checking') {
    return <SettingsSkeleton />
  }

  // 显示偏好行（主题 + 全屏）：登录与未登录均可使用，保存在本机
  const appearanceRows = (
    <div className="divide-y divide-[var(--border-subtle)]">
      <div className="flex items-center gap-3.5 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]">
          {theme === 'dark' ? <Moon className="h-[18px] w-[18px]" /> : <Sun className="h-[18px] w-[18px]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-[var(--text-primary)]">主题模式</span>
          <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">深浅色跟随此处设置，保存在本机</span>
        </span>
        <div className="flex shrink-0 rounded-[var(--radius-pill)] bg-[var(--surface-muted)] p-1">
          {(
            [
              { value: 'light', label: '浅色', icon: Sun },
              { value: 'dark', label: '深色', icon: Moon },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTheme(option.value)}
              className={cn(
                'press-feedback flex items-center gap-1.5 rounded-[var(--radius-pill)] px-3 py-1.5 text-[13px] transition-colors',
                theme === option.value
                  ? 'bg-[var(--surface-default)] font-medium text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
              )}
            >
              <option.icon className="h-3.5 w-3.5" />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* 全屏模式：仅网页版提供；APP 壳内天生全屏，隐藏此项 */}
      {!isNativeApp() && (
        <div className="flex items-center gap-3.5 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--text-secondary)]">
            <Maximize className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-[var(--text-primary)]">全屏模式</span>
            <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">开启后点击页面任意位置自动进入沉浸全屏</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={fullscreenEnabled}
            aria-label="全屏模式开关"
            onClick={() => setFullscreenEnabled(!fullscreenEnabled)}
            className={cn(
              'relative h-7 w-12 shrink-0 rounded-full border transition-colors',
              fullscreenEnabled
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)]'
                : 'border-[var(--border-strong)] bg-[var(--surface-muted)]',
            )}
          >
            <span
              className={cn(
                'absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-[left] duration-200',
                fullscreenEnabled ? 'left-[calc(100%-24px)]' : 'left-1',
              )}
            />
          </button>
        </div>
      )}
    </div>
  )

  /** 关于分组：仅 APP 壳内展示，提供手动检测更新入口；登录/未登录都可用。
   * 发现新版本不再在行下方内联展开，而是弹出版本弹窗（openDialog.kind === 'update'） */
  const aboutSection = isWindowsDesktopApp() ? <DesktopSettings /> : isNativeApp() ? (
    <section>
      <SectionTitle>关于</SectionTitle>
      <div className="divide-y divide-[var(--border-subtle)]">
        <SettingsRow
          icon={<RefreshCw className={cn('h-[18px] w-[18px]', updateChecking && 'animate-spin')} />}
          title="检测更新"
          caption={`当前版本 ${getNativeAppVersion() ?? '未知'}`}
          value={
            updateChecking
              ? '检测更新中…'
              : availableUpdate
                ? `发现新版本 ${availableUpdate.latestVersionName}`
                : undefined
          }
          chevron={availableUpdate && !updateChecking ? 'right' : 'none'}
          onClick={() => {
            if (updateChecking) return
            if (availableUpdate) {
              setOpenDialog({ kind: 'update' })
              return
            }
            void handleCheckUpdate()
          }}
        />
      </div>
    </section>
  ) : null

  /** 两个平台共用原下载容器；原生壳不重复下载自己。 */
  const clientSection =
    !isNativeApp() && !isWindowsDesktopApp() && (mobileClient || windowsDownload) ? (
      <section>
        <SectionTitle>客户端</SectionTitle>
        <div className="divide-y divide-[var(--border-subtle)]">
          <SettingsRow
            icon={<Download className="h-[18px] w-[18px]" />}
            title={mobileClient ? '安装启创墨域客户端' : '下载客户端'}
            caption={mobileClient ? '安装 APP 获得更流畅的阅读与创作体验' : `Windows x64 · ${windowsDownload?.version}`}
            chevron="right"
            onClick={() => {
              setSelectedClientOs(null)
              setClientDialogOpen(true)
            }}
          />
        </div>
      </section>
    ) : null

  /** 客户端下载弹窗：选中系统后出现「立即下载 xx 端」按钮 */
  const clientDialog =
    clientDialogOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[120] flex items-end justify-center bg-[rgba(15,23,42,0.28)] backdrop-blur-[2px] sm:items-center sm:px-4 sm:py-8"
            onClick={() => setClientDialogOpen(false)}
          >
            <div
              role="dialog"
              ref={clientDialogRef}
              aria-modal="true"
              aria-label="安装启创墨域客户端"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setClientDialogOpen(false)
                } else if (event.key === 'Tab') {
                  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'))
                  const first = controls[0]
                  const last = controls[controls.length - 1]
                  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
                  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
                }
              }}
              className="w-full rounded-t-[28px] border border-[var(--border-subtle)] bg-[var(--surface-default)] p-6 pb-[calc(24px+var(--safe-bottom))] shadow-[0_24px_64px_rgba(15,23,42,0.18)] sm:max-w-[400px] sm:rounded-[28px] sm:pb-6"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold text-[var(--text-primary)]">安装启创墨域客户端</h3>
                  <p className="text-sm leading-6 text-[var(--text-secondary)]">{mobileClient ? '请选择你要下载的版本' : '适用于 Windows x64'}</p>
                  {!mobileClient && windowsDownload?.channel === 'preview' ? (
                    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">未签名测试版，暂不支持自动更新。Windows 可能提示未知发布者；请核对官网来源，不要关闭系统安全防护。</p>
                  ) : null}
                </div>
                <Button
                  onClick={() => setClientDialogOpen(false)}
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 shrink-0 px-0"
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className={cn('mt-6 grid gap-3', mobileClient ? 'grid-cols-3' : 'grid-cols-1')}>
                {clientOptions.map((os) => {
                  const selected = selectedClientOs === os.key

                  return (
                    <button
                      key={os.key}
                      type="button"
                      onClick={() => setSelectedClientOs(os.key)}
                      className={cn(
                        'press-feedback flex flex-col items-center gap-2 rounded-[var(--radius-md)] border py-4 transition-colors',
                        selected
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
                          : 'border-[var(--border-subtle)] bg-[var(--surface-muted)] hover:bg-[var(--surface-default)]',
                      )}
                    >
                      <os.icon className={cn('h-7 w-7', os.iconClassName)} />
                      <span
                        className={cn(
                          'text-[13px] font-medium',
                          selected ? 'text-[var(--color-brand)]' : 'text-[var(--text-primary)]',
                        )}
                      >
                        {os.label}
                      </span>
                    </button>
                  )
                })}
              </div>

              {selectedClientOs ? (
                <Button
                  variant="primary"
                  className="mt-6 h-11 w-full"
                  disabled={clientDownloading}
                  onClick={() => void handleClientDownload(selectedClientOs)}
                >
                  {clientDownloading ? '正在获取下载地址…' : selectedClientOs === 'windows' ? '下载 Windows 客户端' : `立即下载${clientOptions.find((os) => os.key === selectedClientOs)?.label}端`}
                </Button>
              ) : null}
              {!mobileClient ? <a className="mt-3 block text-center text-sm text-[var(--text-secondary)]" href={WINDOWS_RELEASES_URL} target="_blank" rel="noopener noreferrer">查看发布说明与备用下载</a> : null}
            </div>
          </div>,
          document.body,
        )
      : null

  const legalSection = (
    <section>
      <SectionTitle>协议与政策</SectionTitle>
      <div className="divide-y divide-[var(--border-subtle)]">
        <SettingsRow icon={<FileText className="h-[18px] w-[18px]" />} title="用户协议" chevron="right" onClick={() => navigate('/legal?kind=terms')} />
        <SettingsRow icon={<ShieldCheck className="h-[18px] w-[18px]" />} title="隐私政策" chevron="right" onClick={() => navigate('/legal?kind=privacy')} />
      </div>
    </section>
  )

  if (authStatus === 'unavailable') {
    return (
      <AppState
        tone="error"
        title="暂时无法打开账户设置"
        description="账户状态还没有准备好，请稍后再试，或先回到首页继续浏览。"
        primaryAction={{ label: '返回首页', href: '/' }}
        secondaryAction={{ label: '重新加载', onClick: () => window.location.reload() }}
      />
    )
  }

  if (authStatus !== 'authenticated' || !sessionUser) {
    return (
      <div className="mx-auto max-w-[640px] space-y-8">
        {backButton}

        <section>
          <SectionTitle>显示</SectionTitle>
          {appearanceRows}
        </section>

        {aboutSection}

        {legalSection}

        <AppState
          title="登录后可管理完整的账户设置"
          description="头像、昵称、个人封面、隐私与账号安全等设置，需要登录后才能使用。"
          primaryAction={{ label: '去登录', href: '/login?redirect=%2Fsettings' }}
          secondaryAction={{ label: '创建账户', href: '/register?redirect=%2Fsettings' }}
        />

        {clientSection}

        {clientDialog}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[640px] space-y-8 pb-8">
      {backButton}

      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleAvatarChange}
      />
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleCoverChange}
      />

      {/* 分组一：账户 */}
      <section>
        <SectionTitle>账户</SectionTitle>
        <div className="divide-y divide-[var(--border-subtle)]">
          {/* 头像行：点击即选择文件 */}
          <div className="flex items-center gap-3.5 py-3.5">
            <Avatar name={sessionUser.nickname} src={sessionUser.avatarUrl} size="md" className="h-9 w-9 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium text-[var(--text-primary)]">头像</span>
              <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">PNG / JPG / WebP，不超过 {PROFILE_IMAGE_MAX_MB}MB</span>
            </span>
            {sessionUser.avatarUrl ? (
              <button
                type="button"
                onClick={handleResetAvatar}
                disabled={avatarSubmitting}
                className="press-feedback shrink-0 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
              >
                恢复默认
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarSubmitting}
              className="press-feedback shrink-0 rounded-[var(--radius-pill)] border border-[var(--border-strong)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-60"
            >
              {avatarSubmitting ? '上传中…' : '更新'}
            </button>
          </div>

          {/* 封面行：选择文件后进入裁剪弹窗 */}
          <div className="flex items-center gap-3.5 py-3.5">
            <span className="relative h-9 w-[68px] shrink-0 overflow-hidden rounded-[8px] bg-[linear-gradient(135deg,#28435f_0%,#16233a_58%,#1f2f47_100%)]">
              {sessionUser.profileCoverUrl ? (
                <img src={sessionUser.profileCoverUrl} alt="个人封面" className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium text-[var(--text-primary)]">个人主页封面</span>
              <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">不超过 {PROFILE_IMAGE_MAX_MB}MB，上传后可裁剪为 3:1</span>
            </span>
            {sessionUser.profileCoverUrl ? (
              <button
                type="button"
                onClick={handleResetCover}
                disabled={coverSubmitting}
                className="press-feedback shrink-0 text-sm text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
              >
                移除
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              disabled={coverSubmitting}
              className="press-feedback shrink-0 rounded-[var(--radius-pill)] border border-[var(--border-strong)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-60"
            >
              {coverSubmitting ? '上传中…' : sessionUser.profileCoverUrl ? '更换' : '设置'}
            </button>
          </div>

          {/* 昵称与简介：点开弹出编辑弹窗，不在行下方展开 */}
          <SettingsRow
            icon={<UserRound className="h-[18px] w-[18px]" />}
            title="昵称与简介"
            caption={sessionUser.bio || '还没有填写简介'}
            value={sessionUser.nickname}
            chevron="right"
            onClick={() => setOpenDialog({ kind: 'profile' })}
          />
        </div>
      </section>

      {/* 分组二：隐私 */}
      <section>
        <SectionTitle>隐私</SectionTitle>
        <div className="divide-y divide-[var(--border-subtle)]">
          {/* 隐私维度：点开弹出选项弹窗，不在行下方展开 */}
          {PRIVACY_ITEMS.map((item) => (
            <SettingsRow
              key={item.key}
              icon={
                privacy[item.key] === 'public' ? (
                  <Users className="h-[18px] w-[18px]" />
                ) : privacy[item.key] === 'mutual' ? (
                  <UserRoundCheck className="h-[18px] w-[18px]" />
                ) : (
                  <Lock className="h-[18px] w-[18px]" />
                )
              }
              title={item.label}
              caption={item.caption}
              value={PRIVACY_LEVEL_META[privacy[item.key]].label}
              chevron="right"
              onClick={() => setOpenDialog({ kind: 'privacy', key: item.key })}
            />
          ))}
        </div>
      </section>

      {/* 分组三：显示 */}
      <section>
        <SectionTitle>AI 与模型</SectionTitle>
        <div className="divide-y divide-[var(--border-subtle)]">
          <SettingsRow
            icon={<Cpu className="h-[18px] w-[18px]" />}
            title="自定义模型"
            caption="配置自己的 OpenAI 兼容模型与 API Key"
            value="管理"
            chevron="right"
            onClick={() => setCustomModelsOpen(true)}
          />
        </div>
      </section>

      {/* 分组三：显示 */}
      <section>
        <SectionTitle>显示</SectionTitle>
        {appearanceRows}
      </section>

      {/* 分组四：账号安全 */}
      {sessionUser.emailAuthEnabled ? <EmailAccountSettings user={sessionUser} /> : <section>
        <SectionTitle>账号安全</SectionTitle>
        <div className="divide-y divide-[var(--border-subtle)]">
          <SettingsRow
            icon={<Smartphone className="h-[18px] w-[18px]" />}
            title="手机号"
            caption="登录入口统一使用手机号"
            value={maskPhoneNumber(sessionUser.phone)}
          />

          {/* 登录密码：点开弹出设置弹窗，不在行下方展开 */}
          <SettingsRow
            icon={<KeyRound className="h-[18px] w-[18px]" />}
            title="登录密码"
            caption={sessionUser.passwordConfigured ? '修改前需验证当前密码或手机验证码' : '设置后可使用手机号和密码登录'}
            value={sessionUser.passwordConfigured ? '已设置' : '未设置'}
            chevron="right"
            onClick={() => setOpenDialog({ kind: 'password' })}
          />
        </div>
      </section>}

      {/* 分组五：会话 */}
      <section>
        <SectionTitle>会话</SectionTitle>
        <div className="divide-y divide-[var(--border-subtle)]">
          <SettingsRow
            icon={<LogOut className="h-[18px] w-[18px]" />}
            title="退出登录"
            caption="退出后可随时重新登录，继续管理你的书架和草稿"
            onClick={() => setLogoutConfirmOpen(true)}
            danger
          />
        </div>
      </section>

      {/* 分组六：关于（仅 APP 壳内） */}
      {aboutSection}

      {legalSection}

      {/* 分组七：客户端安装（仅手机浏览器） */}
      {clientSection}

      {clientDialog}

      <CustomModelSettingsDialog open={customModelsOpen} onClose={() => setCustomModelsOpen(false)} />

      {/* 退出登录二次确认弹窗 */}
      <ConfirmDialog
        open={logoutConfirmOpen}
        title="确认要退出登录吗？"
        description="退出后可随时重新登录，继续管理你的书架和草稿。"
        confirmLabel="退出登录"
        tone="danger"
        busy={logoutSubmitting}
        onConfirm={() => void handleLogout()}
        onCancel={() => setLogoutConfirmOpen(false)}
      />

      {/* 封面裁剪弹窗：选完文件后进入，确认才真正上传 */}
      <ImageCropperDialog
        open={Boolean(coverDraft)}
        imageDataUrl={coverDraft}
        aspect={3}
        submitting={coverSubmitting}
        onCancel={() => setCoverDraft(null)}
        onConfirm={(dataUrl) => void handleCoverCropConfirm(dataUrl)}
      />

      {/* 设置弹窗统一出口：点开设定项不再在行下方展开，而是弹出自定义弹窗。
          弹窗挂在 body 上且遮罩独占一层，点弹窗内按钮不会误触到下方页面内容 */}
      {typeof document !== 'undefined' && openDialog?.kind === 'profile'
        ? createPortal(
            <BottomSheet open onClose={() => setOpenDialog(null)} title="昵称与简介">
              <form className="space-y-4 px-4 pb-[calc(20px+var(--safe-bottom))] pt-4 md:px-5" onSubmit={handleUpdateProfile}>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="settings-nickname">
                    昵称
                  </label>
                  <TextInput
                    id="settings-nickname"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    placeholder="请输入昵称"
                    autoComplete="nickname"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="settings-bio">
                    个人简介
                  </label>
                  <textarea
                    id="settings-bio"
                    value={bio}
                    onChange={(event) => setBio(event.target.value)}
                    placeholder="简单介绍一下你自己"
                    rows={3}
                    className="w-full resize-none rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm leading-7 text-[var(--text-primary)] outline-none transition focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--focus-ring)]"
                  />
                </div>
                <Button type="submit" variant="primary" className="h-11 w-full" disabled={profileSubmitting}>
                  {profileSubmitting ? '保存中…' : '保存'}
                </Button>
              </form>
            </BottomSheet>,
            document.body,
          )
        : null}

      {typeof document !== 'undefined' && openDialog?.kind === 'privacy'
        ? createPortal(
            <BottomSheet
              open
              onClose={() => setOpenDialog(null)}
              title={PRIVACY_ITEMS.find((item) => item.key === openDialog.key)?.label ?? '隐私设置'}
            >
              <p className="px-4 pb-1 pt-3 text-xs text-[var(--text-tertiary)] md:px-5">
                {PRIVACY_ITEMS.find((item) => item.key === openDialog.key)?.caption}
              </p>
              <div className="space-y-1 px-2 pb-[calc(20px+var(--safe-bottom))] md:px-3">
                {PRIVACY_LEVEL_ORDER.map((level) => {
                  const selected = privacy[openDialog.key] === level

                  return (
                    <button
                      key={level}
                      type="button"
                      disabled={privacySubmittingKey === openDialog.key}
                      onClick={() => void handlePrivacyChange(openDialog.key, level)}
                      className={cn(
                        'press-feedback flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-3 text-left transition-colors',
                        selected ? 'bg-[var(--color-brand-soft)]' : 'hover:bg-[var(--surface-muted)]',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block text-sm font-medium',
                            selected ? 'text-[var(--color-brand)]' : 'text-[var(--text-primary)]',
                          )}
                        >
                          {PRIVACY_LEVEL_META[level].label}
                        </span>
                        <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">
                          {PRIVACY_LEVEL_META[level].caption}
                        </span>
                      </span>
                      {selected ? <Check className="h-4 w-4 shrink-0 text-[var(--color-brand)]" /> : null}
                    </button>
                  )
                })}
              </div>
            </BottomSheet>,
            document.body,
          )
        : null}

      {typeof document !== 'undefined' && openDialog?.kind === 'password'
        ? createPortal(
            <BottomSheet open onClose={() => setOpenDialog(null)} title="登录密码">
              <form className="space-y-4 px-4 pb-[calc(20px+var(--safe-bottom))] pt-4 md:px-5" onSubmit={handleSetPassword}>
                {sessionUser.passwordConfigured ? (
                  passwordMode === 'old' ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="settings-old-password">
                          当前密码
                        </label>
                        <button
                          type="button"
                          className="text-sm text-[var(--color-brand)] transition-opacity hover:opacity-80"
                          onClick={() => setPasswordMode('sms')}
                        >
                          忘记密码？使用验证码重置
                        </button>
                      </div>
                      <TextInput
                        id="settings-old-password"
                        type="password"
                        value={oldPassword}
                        onChange={(event) => setOldPassword(event.target.value)}
                        placeholder="请输入当前登录密码"
                        autoComplete="current-password"
                        required
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="settings-sms-code">
                          手机验证码（发送至 {maskPhoneNumber(sessionUser.phone)}）
                        </label>
                        <button
                          type="button"
                          className="text-sm text-[var(--color-brand)] transition-opacity hover:opacity-80"
                          onClick={() => setPasswordMode('old')}
                        >
                          改用当前密码验证
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        <TextInput
                          id="settings-sms-code"
                          value={smsCode}
                          onChange={(event) => setSmsCode(event.target.value)}
                          placeholder="请输入短信验证码"
                          autoComplete="one-time-code"
                          inputMode="numeric"
                          required
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          className="shrink-0"
                          onClick={handleSendPasswordResetCode}
                          disabled={smsSending || smsCooldown > 0}
                        >
                          {smsCooldown > 0 ? `${smsCooldown}s 后重发` : smsSending ? '发送中…' : '发送验证码'}
                        </Button>
                      </div>
                    </div>
                  )
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="settings-new-password">
                      {sessionUser.passwordConfigured ? '新登录密码' : '登录密码'}
                    </label>
                    <TextInput
                      id="settings-new-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="请输入至少 6 位密码"
                      autoComplete="new-password"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-[var(--text-primary)]" htmlFor="settings-new-password-confirm">
                      确认密码
                    </label>
                    <TextInput
                      id="settings-new-password-confirm"
                      type="password"
                      value={passwordConfirm}
                      onChange={(event) => setPasswordConfirm(event.target.value)}
                      placeholder="请再次输入密码"
                      autoComplete="new-password"
                      required
                    />
                  </div>
                </div>

                <Button type="submit" variant="primary" className="h-11 w-full" disabled={passwordSubmitting}>
                  {passwordSubmitting ? '保存中…' : sessionUser.passwordConfigured ? '更新密码' : '设置密码'}
                </Button>
              </form>
            </BottomSheet>,
            document.body,
          )
        : null}

      {typeof document !== 'undefined' && openDialog?.kind === 'update' && availableUpdate
        ? createPortal(
            <BottomSheet open onClose={() => setOpenDialog(null)} title="发现新版本">
              <div className="space-y-4 px-4 pb-[calc(20px+var(--safe-bottom))] pt-4 md:px-5">
                <p className="text-[15px] font-medium text-[var(--text-primary)]">
                  新版本 {availableUpdate.latestVersionName} 已发布
                </p>
                <p className="text-sm leading-6 text-[var(--text-secondary)]">
                  {availableUpdate.notes?.trim() || '点击更新以获取最新功能与修复'}
                </p>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11 flex-1"
                    onClick={() => setOpenDialog(null)}
                  >
                    稍后再说
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    className="h-11 flex-1"
                    onClick={() => {
                      if (availableUpdate.url) openExternalUrl(availableUpdate.url)
                    }}
                  >
                    立即更新
                  </Button>
                </div>
              </div>
            </BottomSheet>,
            document.body,
          )
        : null}
    </div>
  )
}
