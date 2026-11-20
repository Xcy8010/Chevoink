import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { PROFILE_IMAGE_MAX_MB } from '../../../../shared/contracts/api.js'

export const settingsRowClass = 'flex min-h-[64px] w-full items-center gap-3 px-3.5 py-3 text-left sm:px-4'

export const settingsCaptionClass = 'mt-1 block text-[13px] leading-[1.125rem] [overflow-wrap:anywhere]'
export const avatarCaption = `PNG / JPG / WebP，不超过 ${PROFILE_IMAGE_MAX_MB}MB`
export const coverCaption = `不超过 ${PROFILE_IMAGE_MAX_MB}MB，上传后可裁剪为 3:1`

export const phoneLoginCaption = '登录入口统一使用手机号'
export const updatePasswordCaption = '修改前需验证当前密码或手机验证码'
export const emailPasswordCaption = '使用已验证的邮箱或手机验证码确认身份'
export const deviceManagementCaption = '查看登录设备、地点和最近活动'

const scrollOffset = 'scroll-mt-20 md:scroll-mt-[5.25rem]'

export function SectionTitle({ children }: { children: string }) {
  return (
    <h2
      tabIndex={-1}
      className={cn(scrollOffset, 'mb-2.5 rounded-sm px-1 text-[15px] font-semibold text-[var(--text-primary)] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]')}
    >
      {children}
    </h2>
  )
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-solid)]">
      {children}
    </div>
  )
}

/** 单行设置项外壳：图标 + 标题/说明 + 右侧值区，行本身可点击 */
export interface SettingsRowProps {
  icon: ReactNode
  bareIcon?: boolean
  title: string
  searchKeywords?: string
  caption?: string
  value?: ReactNode
  actions?: ReactNode
  chevron?: 'right' | 'down' | 'up' | 'none'
  onClick?: () => void
  danger?: boolean
}

export function SettingsRow({
  icon, bareIcon, title, searchKeywords, caption, value, actions, chevron = 'none', onClick, danger,
}: SettingsRowProps) {
  const rowClass = cn(
    settingsRowClass,
    scrollOffset,
    actions && 'flex-wrap',
  )
  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
          !bareIcon && 'bg-[var(--surface-muted)]',
          danger ? 'text-[var(--color-error)]' : 'text-[var(--text-secondary)]',
        )}
      >
        {icon}
      </span>
      <span className={cn('flex-1 text-left', actions ? 'min-w-[min(35%,9rem)]' : 'min-w-0')}>
        <span
          className={cn(
            'block text-[15px] font-medium leading-5',
            danger ? 'text-[var(--color-error)]' : 'text-[var(--text-primary)]',
          )}
        >
          {title}
        </span>
        {caption ? <span className={settingsCaptionClass + ' text-[var(--text-secondary)]'}>{caption}</span> : null}
      </span>
      {actions ? <span className="ml-auto flex max-w-full shrink-0 items-center justify-end gap-1.5">{actions}</span> : null}
      {value ? <span className="max-w-[42%] shrink-0 break-words text-right text-[13px] font-medium text-[var(--text-secondary)]">{value}</span> : null}
      {chevron === 'right' ? <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" /> : null}
      {chevron === 'down' || chevron === 'up' ? (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-4 w-4 shrink-0 text-[var(--text-tertiary)] motion-safe:transition-transform',
            chevron === 'up' && 'rotate-180',
          )}
        />
      ) : null}
    </>
  )

  if (!onClick) {
    return <div tabIndex={-1} data-setting-title={title} data-setting-keywords={searchKeywords}
      className={cn(rowClass, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]')}>{content}</div>
  }

  return (
    <button
      type="button"
      data-setting-title={title}
      data-setting-keywords={searchKeywords}
      onClick={onClick}
      className={cn(
        rowClass,
        'hover:bg-[var(--surface-muted)] active:bg-[var(--color-brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)] motion-safe:transition-colors',
      )}
    >
      {content}
    </button>
  )
}
