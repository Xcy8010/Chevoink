import { useState } from 'react'
import { KeyRound, Mail, Smartphone } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'

import { useToast } from '@/components/ui/toast-context'
import { requiresLegacyEmailBinding } from '@/features/account/account-access'
import { IdentityVerificationForm, PasswordVerificationForm } from '@/features/account/AccountVerificationForms'
import { AccountDialog } from '@/features/account/VerificationCodeField'
import type { User } from '../../../../shared/contracts'
import { maskPhoneNumber } from './privacy'
import { SectionTitle, SettingsRow } from './settings-row'

type AccountDialogKind = 'email' | 'phone' | 'password'

export default function EmailAccountSettings({ user }: { user: User }) {
  const [params, setParams] = useSearchParams()
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const section = params.get('section')
  const allowedSection = (section === 'email' && !user.emailVerified) || (section === 'phone' && !user.phoneVerified) || section === 'password'
  const dialog = allowedSection && !requiresLegacyEmailBinding(user) ? section : null
  const hasPassword = user.hasPassword ?? user.passwordConfigured

  function open(next: AccountDialogKind | null) {
    setParams(current => {
      const params = new URLSearchParams(current)
      if (next) params.set('section', next)
      else params.delete('section')
      return params
    }, { replace: true })
  }

  const initialEmail = user.email?.trim()
  const title = dialog === 'email' ? (initialEmail ? '验证邮箱' : '绑定邮箱')
    : dialog === 'phone' ? '验证手机号'
      : hasPassword ? '修改登录密码' : '设置登录密码'

  return (
    <section id="account-security">
      <SectionTitle>账号安全</SectionTitle>
      <div className="divide-y divide-[var(--border-subtle)]">
        <SettingsRow icon={<Mail className="h-[18px] w-[18px]" />} title="邮箱"
          caption={user.email ?? '可用邮箱登录和找回密码'}
          value={user.emailVerified ? '已验证' : '未验证'}
          chevron={user.emailVerified ? 'none' : 'right'} onClick={user.emailVerified ? undefined : () => open('email')} />
        <SettingsRow icon={<Smartphone className="h-[18px] w-[18px]" />} title="手机号"
          caption={user.phone ? maskPhoneNumber(user.phone) : '创作区需要已验证的手机号'}
          value={user.phoneVerified ? '已验证' : '未验证'}
          chevron={user.phoneVerified ? 'none' : 'right'} onClick={user.phoneVerified ? undefined : () => open('phone')} />
        <SettingsRow icon={<KeyRound className="h-[18px] w-[18px]" />} title="登录密码"
          caption="使用已验证的邮箱或手机验证码确认身份"
          value={hasPassword ? '已设置' : '未设置'}
          chevron="right" onClick={() => open('password')} />
      </div>
      {dialog && <AccountDialog key={dialog} title={title} onClose={() => { if (!saving) open(null) }}>
        {dialog === 'password'
          ? <PasswordVerificationForm user={user} onSaved={() => { open(null); toast.success('登录密码已保存') }} onSaving={setSaving} />
          : <IdentityVerificationForm kind={dialog} initialValue={dialog === 'email' ? initialEmail : undefined}
              submitLabel="验证并保存" onSaved={() => open(null)} onSaving={setSaving} />}
        {dialog === 'email' && <Link className="mt-4 inline-block rounded text-sm text-[var(--color-brand)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2"
          to="/account/docs?doc=faq#doc-security" target="_blank" rel="noreferrer">帮助</Link>}
      </AccountDialog>}
    </section>
  )
}
