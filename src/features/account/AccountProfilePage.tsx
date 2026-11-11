import { ChevronRight, Copy, Check, KeyRound, Phone, CalendarDays, Settings2, LogOut } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { ApiClientError, requestJson } from '@/app/api-client'
import Avatar from '@/features/community/components/Avatar'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast-context'
import { useShellStore } from '@/store/useShellStore'
import { getProfileImageUploadError, readFileAsDataUrl } from '@/lib/image-compress'
import type { UpdateMyAvatarRequest, UpdateMyProfileRequest, User } from '../../../shared/contracts'
import AccountLayout from './AccountLayout'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-[#efefec] px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between dark:border-[var(--border-subtle)]">
      <span className="w-20 shrink-0 text-sm text-[var(--text-secondary)]">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-start gap-2 sm:justify-end">{children}</div>
    </div>
  )
}

function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone
}

export default function AccountProfilePage() {
  const user = useShellStore((state) => state.sessionUser)
  const syncSessionUser = useShellStore((state) => state.syncSessionUser)
  const setGuest = useShellStore((state) => state.setGuest)
  const toast = useToast()
  const navigate = useNavigate()

  const [nickname, setNickname] = useState('')
  const [bio, setBio] = useState('')
  const [saving, setSaving] = useState(false)
  const [avatarSubmitting, setAvatarSubmitting] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [emailCopied, setEmailCopied] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setNickname(user?.nickname ?? '')
    setBio(user?.bio ?? '')
  }, [user?.nickname, user?.bio])

  const dirty = Boolean(user) && (nickname.trim() !== (user?.nickname ?? '') || bio.trim() !== (user?.bio ?? ''))
  const joined = user?.createdAt
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(user.createdAt))
    : '—'

  function syncUser(next: User) {
    const state = useShellStore.getState()
    syncSessionUser({ user: next, unreadMessageCount: state.unreadMessageCount, unreadNotificationCount: state.unreadNotificationCount })
  }

  async function saveProfile() {
    if (!nickname.trim()) {
      toast.error('昵称不能为空。')
      return
    }
    setSaving(true)
    try {
      const payload = await requestJson<{ user: User }>('/api/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ nickname: nickname.trim(), bio: bio.trim() } satisfies UpdateMyProfileRequest),
      })
      syncUser(payload.user)
      toast.success('资料已保存。')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '保存失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const validationError = getProfileImageUploadError(file, '头像')
    if (validationError) {
      toast.error(validationError)
      return
    }
    setAvatarSubmitting(true)
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const payload = await requestJson<{ user: User }>('/api/users/me/avatar', {
        method: 'PATCH',
        body: JSON.stringify({ avatarDataUrl: dataUrl } satisfies UpdateMyAvatarRequest),
      })
      syncUser(payload.user)
      toast.success('头像已更新。')
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '头像上传失败，请稍后重试。')
    } finally {
      setAvatarSubmitting(false)
    }
  }

  async function copyEmail() {
    if (!user?.email || !navigator.clipboard) return
    await navigator.clipboard.writeText(user.email)
    setEmailCopied(true)
    window.setTimeout(() => setEmailCopied(false), 1600)
  }

  async function handleLogout() {
    try {
      await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } catch {
      toast.error('暂时无法确认退出登录，请稍后重试。')
      return
    }
    setGuest()
    navigate('/login', { replace: true })
  }

  return (
    <AccountLayout active="profile">
      <div className="px-5 py-9 sm:px-8 lg:px-12 lg:py-11">
        <div className="max-w-[1040px]">
          <h1 className="text-2xl font-semibold tracking-[-.02em]">个人信息</h1>
          <section className="mt-7 overflow-hidden rounded-[16px] border border-[#e9e9e6] bg-white dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
            <Row label="头像">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarSubmitting}
                className="group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-success)]"
                aria-label="更换头像"
              >
                <Avatar name={user?.nickname ?? '创作者'} src={user?.avatarUrl} size="md" className="h-12 w-12" />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {avatarSubmitting ? '上传中' : '更换'}
                </span>
              </button>
              <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void handleAvatarChange(event)} />
            </Row>
            <Row label="名称">
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={24}
                className="h-9 w-full rounded-[9px] border border-[#e4e4e1] bg-white px-3 text-sm outline-none transition-colors focus:border-[var(--text-tertiary)] sm:w-[320px] dark:border-[var(--border-subtle)] dark:bg-[var(--surface-muted)]"
              />
            </Row>
            <Row label="简介">
              <input
                value={bio}
                onChange={(event) => setBio(event.target.value)}
                maxLength={80}
                placeholder="用一句话介绍自己"
                className="h-9 w-full rounded-[9px] border border-[#e4e4e1] bg-white px-3 text-sm outline-none transition-colors focus:border-[var(--text-tertiary)] sm:w-[320px] dark:border-[var(--border-subtle)] dark:bg-[var(--surface-muted)]"
              />
            </Row>
            <Row label="邮箱">
              <span className="truncate text-sm">{user?.email ?? '未绑定'}</span>
              {user?.email ? (
                <button type="button" onClick={() => void copyEmail()} className="rounded-[7px] p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[#f4f4f2] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]" aria-label="复制邮箱">
                  {emailCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              ) : null}
              {user?.emailAuthEnabled && !user.emailVerified && <Link to="/settings?section=email" className="shrink-0 text-xs text-[var(--color-brand)]">
                绑定
              </Link>}
            </Row>
            {dirty ? (
              <div className="flex items-center justify-end gap-3 border-t border-[#efefec] bg-[#fafaf8] px-5 py-3 dark:border-[var(--border-subtle)] dark:bg-[var(--surface-muted)]">
                <button type="button" onClick={() => { setNickname(user?.nickname ?? ''); setBio(user?.bio ?? '') }} className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                  放弃修改
                </button>
                <Button variant="primary" onClick={() => void saveProfile()} disabled={saving} className="h-8 px-3 text-xs">
                  {saving ? '保存中…' : '保存修改'}
                </Button>
              </div>
            ) : null}
          </section>

          <h2 className="mt-10 text-xl font-semibold tracking-[-.02em]">账户安全</h2>
          <section className="mt-5 overflow-hidden rounded-[16px] border border-[#e9e9e6] bg-white dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
            <Row label="登录密码">
              <span className="text-sm">{user?.passwordConfigured ? '已设置登录密码' : '建议设置登录密码'}</span>
              <Link to={user?.emailAuthEnabled ? '/settings?section=password' : '/settings'} className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[#f4f4f2] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]">
                <KeyRound className="h-3.5 w-3.5" />
                {user?.passwordConfigured ? '修改' : '去设置'}
              </Link>
            </Row>
            <Row label="绑定手机">
              <span className="text-sm">{user?.phone ? maskPhone(user.phone) : '未绑定'}</span>
              {(!user?.emailAuthEnabled || !user.phoneVerified) && <Link to={user?.emailAuthEnabled ? '/settings?section=phone' : '/settings'} className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[#f4f4f2] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]">
                <Phone className="h-3.5 w-3.5" />
                {user?.emailAuthEnabled ? '验证' : '管理'}
              </Link>}
            </Row>
            <Row label="加入时间">
              <span className="inline-flex items-center gap-1.5 text-sm">
                <CalendarDays className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
                {joined}
              </span>
            </Row>
          </section>

          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="mt-10 flex items-center gap-1.5 text-xl font-semibold tracking-[-.02em] transition-colors hover:text-[var(--text-secondary)]"
          >
            高级账号设置
            <ChevronRight className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
          </button>
          {advancedOpen ? (
            <section className="mt-5 overflow-hidden rounded-[16px] border border-[#e9e9e6] bg-white dark:border-[var(--border-subtle)] dark:bg-[var(--surface-default)]">
              <Row label="全站偏好">
                <span className="text-sm text-[var(--text-tertiary)]">主题、阅读与沉浸全屏等偏好</span>
                <Link to="/settings" className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[#f4f4f2] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-muted)]">
                  <Settings2 className="h-3.5 w-3.5" />
                  前往设置
                </Link>
              </Row>
              <Row label="退出登录">
                <span className="text-sm text-[var(--text-tertiary)]">退出当前浏览器上的登录状态</span>
                <button type="button" onClick={() => void handleLogout()} className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-xs text-[var(--color-error)] transition-colors hover:bg-red-500/10">
                  <LogOut className="h-3.5 w-3.5" />
                  退出
                </button>
              </Row>
            </section>
          ) : null}
        </div>
      </div>
    </AccountLayout>
  )
}
