import { Skeleton } from '@/components/ui/Skeleton'
import { useShellStore } from '@/store/useShellStore'
import { SettingsFrame, settingsSearchFieldClass } from './settings-layout'
import {
  avatarCaption, coverCaption, deviceManagementCaption, emailPasswordCaption, phoneLoginCaption,
  SettingsGroup, settingsCaptionClass, settingsRowClass, updatePasswordCaption,
} from './settings-row'
import { PRIVACY_ITEMS } from './privacy'

type PlaceholderRow = {
  caption: string
  icon?: 'avatar' | 'cover'
  control?: 'button' | 'phone' | 'status'
  link?: boolean
}

const iconClasses = {
  avatar: 'size-10 rounded-full',
  cover: 'h-7 w-10',
  setting: 'size-10 rounded-[var(--radius-md)]',
}

const controlClasses = {
  button: 'h-9 w-[54px] rounded-full',
  phone: 'h-2.5 w-24',
  status: 'h-2.5 w-[39px]',
}

function LoadingGroup({ rows }: { rows: readonly PlaceholderRow[] }) {
  return (
    <section>
      <div className="mb-2.5 flex h-[22.5px] items-center px-1">
        <Skeleton className="h-3.5 w-12" />
      </div>
      <SettingsGroup>
        {rows.map(({ caption, icon, control, link }, index) => (
          <div key={index} className={settingsRowClass}>
            <Skeleton className={iconClasses[icon ?? 'setting'] + ' shrink-0'} />
            <div className="min-w-0 flex-1">
              <div className="flex h-5 items-center">
                <Skeleton className={index % 2 === 0 ? 'h-3.5 w-16 max-w-full' : 'h-3.5 w-24 max-w-full'} />
              </div>
              <div className={settingsCaptionClass + ' relative'}>
                {/* Reserve the same caption wrapping as the loaded row on narrow screens. */}
                <span className="invisible">{caption}</span>
                <Skeleton className="absolute left-0 top-1 h-2.5 w-36 max-w-full" />
              </div>
            </div>
            {control && <Skeleton className={controlClasses[control] + ' shrink-0'} />}
            {link && <Skeleton className="size-4 shrink-0" />}
          </div>
        ))}
      </SettingsGroup>
    </section>
  )
}

const profileRows = [
  { caption: avatarCaption, icon: 'avatar', control: 'button' },
  { caption: coverCaption, icon: 'cover', control: 'button' },
  { caption: '还没有填写简介', control: 'status', link: true },
] satisfies PlaceholderRow[]

const privacyRows = PRIVACY_ITEMS.map(({ caption }) => ({ caption, control: 'status', link: true } as const))

export default function SettingsSkeleton() {
  const hasEmailSettings = useShellStore(state => state.sessionUser?.emailAuthEnabled)
  const contactRows: PlaceholderRow[] = hasEmailSettings
    ? [{ caption: '可用邮箱登录和找回密码', control: 'status' }, { caption: '创作区需要已验证的手机号', control: 'status' }]
    : [{ caption: phoneLoginCaption, control: 'phone' }]

  return (
    <SettingsFrame loading heading={<>
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <Skeleton className="h-5 w-12 md:h-6 md:w-16" />
    </>} searchBox={
      <div className={settingsSearchFieldClass}>
        <Skeleton className="size-[18px] shrink-0 rounded-full" />
        <Skeleton className="h-3.5 w-16" />
      </div>
    }>
      <LoadingGroup rows={profileRows} />
      <LoadingGroup rows={[
        ...contactRows,
        { caption: hasEmailSettings ? emailPasswordCaption : updatePasswordCaption, control: 'status', link: true },
        { caption: deviceManagementCaption, link: true },
      ]} />
      <LoadingGroup rows={privacyRows} />
    </SettingsFrame>
  )
}
