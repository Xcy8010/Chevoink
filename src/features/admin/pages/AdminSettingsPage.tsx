import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import Button from '@/components/ui/Button'
import TextInput from '../components/AdminTextInput'
import { useToast } from '@/components/ui/toast-context'
import { ApiClientError } from '@/app/api-client'
import type { AdminCaptchaPayload } from '../../../../shared/contracts/index.js'
import { adminBindPhone, adminChangeMyPassword, adminLogout, adminSendBindSmsCode, getAdminCaptcha } from '../api'
import { AdminCard, AdminPageHeader } from '../AdminLayout'
import { useAdminSession } from '../admin-shared'

export default function AdminSettingsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { admin } = useAdminSession()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  /* ---- 绑定手机号 ---- */
  const [bindPhone, setBindPhone] = useState('')
  const [bindCode, setBindCode] = useState('')
  const [captcha, setCaptcha] = useState<AdminCaptchaPayload | null>(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
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

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const handleSendBindCode = async () => {
    if (isSendingCode || cooldown > 0) return
    if (!bindPhone.trim()) {
      toast.error('请输入要绑定的手机号。')
      return
    }
    if (!captcha || !captchaAnswer.trim()) {
      toast.error('请先完成人机验证。')
      return
    }

    setIsSendingCode(true)
    try {
      const result = await adminSendBindSmsCode({
        phone: bindPhone.trim(),
        captchaId: captcha.captchaId,
        captchaAnswer: captchaAnswer.trim(),
      })
      toast.success('验证码已发送，请注意查收短信。')
      setCooldown(Math.max(result.cooldownSeconds || 60, 30))
      setBindCode('')
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

  const bindMutation = useMutation({
    mutationFn: () => adminBindPhone({ phone: bindPhone.trim(), code: bindCode.trim() }),
    onSuccess: () => {
      toast.success('手机号绑定成功，可使用手机号登录管理后台')
      setBindPhone('')
      setBindCode('')
      void queryClient.invalidateQueries({ queryKey: ['admin', 'me'] })
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '绑定失败'),
  })

  const mutation = useMutation({
    mutationFn: () => adminChangeMyPassword(oldPassword, newPassword),
    onSuccess: async () => {
      toast.success('密码已修改，请使用新密码重新登录')
      // 改密后旧会话 token 仍有效（无状态会话），登出强制重新登录
      await adminLogout().catch(() => {})
      navigate('/admin/login', { replace: true })
    },
    onError: (error) => toast.error(error instanceof ApiClientError ? error.message : '修改失败'),
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (mutation.isPending) return

    if (!oldPassword || !newPassword) {
      toast.error('请输入旧密码和新密码。')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致。')
      return
    }
    if (newPassword.length < 12) {
      toast.error('新密码至少 12 位。')
      return
    }
    if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      toast.error('新密码需包含大写字母、小写字母、数字和特殊符号。')
      return
    }

    mutation.mutate()
  }

  return (
    <div>
      <AdminPageHeader title="管理员安全" description="管理你的登录凭证" />

      <div className="grid min-w-0 grid-cols-1 items-start gap-5 md:grid-cols-2">
      <AdminCard className="min-w-0">
        <h2 className="mb-1 text-sm font-semibold">修改登录密码</h2>
        <p className="mb-4 text-xs text-[var(--text-secondary)]">
          修改成功后当前会话将退出，需使用新密码重新登录。
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">当前密码</p>
            <TextInput
              type="password"
              aria-label="当前密码"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
            />
          </div>

          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">新密码</p>
            <TextInput
              type="password"
              aria-label="新密码"
              autoComplete="new-password"
              placeholder="至少 12 位，含大小写、数字与符号"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>

          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">确认新密码</p>
            <TextInput
              type="password" aria-label="确认新密码"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>

          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? '提交中…' : '修改密码'}
          </Button>
        </form>
      </AdminCard>

      <AdminCard className="min-w-0">
        <h2 className="mb-1 text-sm font-semibold">绑定手机号</h2>
        <p className="mb-4 text-xs text-[var(--text-secondary)]">
          当前绑定：{admin?.phone ?? '未绑定'}。绑定后可在登录页使用手机号 + 密码或短信验证码登录。
        </p>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">手机号</p>
            <TextInput
              type="tel"
              autoComplete="tel"
              placeholder="请输入要绑定的手机号"
              value={bindPhone}
              onChange={(event) => setBindPhone(event.target.value)}
            />
          </div>

          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">人机验证</p>
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
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
                className="min-w-0"
                placeholder="图中字符"
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.target.value)}
              />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm text-[var(--text-secondary)]">短信验证码</p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <TextInput
                className="min-w-0 flex-[1_1_10rem]"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="请输入短信验证码"
                value={bindCode}
                onChange={(event) => setBindCode(event.target.value)}
              />
              <Button
                type="button"
                className="shrink-0"
                disabled={isSendingCode || cooldown > 0}
                onClick={() => void handleSendBindCode()}
              >
                {cooldown > 0 ? `${cooldown}s 后重发` : isSendingCode ? '发送中…' : '获取验证码'}
              </Button>
            </div>
          </div>

          <Button
            type="button"
            variant="primary"
            disabled={bindMutation.isPending || !bindPhone.trim() || !bindCode.trim()}
            onClick={() => bindMutation.mutate()}
          >
            {bindMutation.isPending ? '绑定中…' : '绑定手机号'}
          </Button>
        </div>
      </AdminCard>
      </div>
    </div>
  )
}
