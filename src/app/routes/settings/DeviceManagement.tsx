import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Monitor, Smartphone } from 'lucide-react'
import type { LoginDevice } from '../../../../shared/contracts/api'

import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import TextInput from '@/components/ui/TextInput'
import { AccountDialog } from '@/features/account/VerificationCodeField'
import { authError, postAuth } from '@/features/account/auth-api'

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
function deviceTime(iso: string) {
  return <time dateTime={iso}>{dateFormat.format(new Date(iso))}</time>
}

export default function DeviceManagement({ userId, hasPassword, onClose, onSetPassword }: {
  userId: string
  hasPassword: boolean
  onClose: () => void
  onSetPassword: () => void
}) {
  const client = useQueryClient()
  const queryKey = ['account', userId, 'devices']
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => requestJson<{ devices: LoginDevice[] }>('/api/auth/devices', { signal }),
    retry: false,
    gcTime: 0,
    refetchInterval: 30_000,
  })
  const [target, setTarget] = useState<LoginDevice | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)

  function selectDevice(device: LoginDevice | null) {
    setTarget(device)
    setPassword('')
    setError('')
    setNotice('')
  }

  async function revoke(event: FormEvent) {
    event.preventDefault()
    if (!target || !password || pending.current) return
    pending.current = true
    setSubmitting(true)
    setError('')
    try {
      await postAuth('/devices/' + encodeURIComponent(target.id) + '/revoke', { password })
      await client.cancelQueries({ queryKey })
      client.setQueryData<{ devices: LoginDevice[] }>(queryKey, previous => previous && ({
        devices: previous.devices.filter(device => device.id !== target.id && !(target.legacyGroup && device.legacyGroup)),
      }))
      selectDevice(null)
      setNotice(target.legacyGroup ? '这组旧版登录已退出。' : target.deviceName + ' 已退出登录。')
      if (target.legacyGroup) void client.invalidateQueries({ queryKey })
    } catch (cause) {
      setError(authError(cause, '退出设备失败，请稍后重试。'))
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  if (target) return (
    <AccountDialog key="verify" title={target.legacyGroup ? '退出旧版登录？' : '退出这台设备？'}
      description={target.legacyGroup
        ? '这组旧设备将同时退出，之后需要重新登录。请输入当前账号的登录密码确认。'
        : target.firstSeenOnly
          ? '这台设备将退出。已识别的其他设备可继续使用，尚未识别的旧设备需要重新登录。请输入账号密码确认。'
          : target.deviceName + ' 将需要重新登录。请输入当前账号的登录密码确认。'}
      onClose={() => { if (!pending.current) selectDevice(null) }}>
      <form onSubmit={revoke} className="space-y-4">
        <label className="block space-y-2 text-sm font-medium">
          <span>登录密码</span>
          <TextInput autoComplete="current-password" type="password" required value={password}
            disabled={submitting} onChange={event => { setPassword(event.target.value); setError('') }} />
        </label>
        {error && <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button disabled={submitting} onClick={() => selectDevice(null)}>取消</Button>
          <Button variant="primary" type="submit" disabled={!password || submitting}>{submitting ? '正在退出…' : '确认退出'}</Button>
        </div>
      </form>
    </AccountDialog>
  )

  const devices = query.data?.devices ?? []
  return (
    <AccountDialog key="list" title="设备管理" onClose={onClose}>
      {query.isPending && <div role="status" aria-label="正在加载设备" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>}
      {query.isError && <div role="alert" className="flex items-center justify-between gap-2 text-sm"><p>设备列表加载失败</p><Button size="sm" onClick={() => void query.refetch()}>重试</Button></div>}
      {notice && <p role="status" className="text-sm text-[var(--color-success)]">{notice}</p>}
      {query.isSuccess && !devices.length && <p className="text-sm text-[var(--text-secondary)]">暂时没有登录设备记录。</p>}
      <ul aria-label="登录设备" className="divide-y divide-[var(--border-subtle)]">
        {[...devices.filter(device => device.current), ...devices.filter(device => !device.current)].map(device => {
          const Icon = /android|ios|iphone|ipad|手机|平板/i.test(device.deviceName) ? Smartphone : Monitor
          return <li key={device.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-3 py-5 first:pt-1 last:pb-0">
            <Icon size={22} strokeWidth={1.65} aria-hidden className="mt-0.5 text-[var(--text-secondary)]" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="break-words text-base font-semibold leading-6">{device.deviceName}</h3>
                {device.current && <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                  <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-success)]" />当前设备
                </span>}
              </div>
              <p className="mt-1 flex items-start gap-1.5 text-sm text-[var(--text-secondary)]">
                <MapPin size={14} aria-hidden className="mt-1 shrink-0" />{device.location || '地点未知'}
              </p>
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
                <dt className="text-[var(--text-secondary)]">{device.firstSeenOnly || device.legacyGroup ? '首次识别' : '登录时间'}</dt>
                <dd>{deviceTime(device.createdAt)}</dd>
                <dt className="text-[var(--text-secondary)]">最近活动</dt>
                <dd>{deviceTime(device.lastActiveAt)}</dd>
              </dl>
            </div>
            {!device.current && hasPassword && <Button variant="ghost" size="sm"
              className="col-span-2 mt-1.5 justify-self-end text-[var(--color-error)] hover:text-[var(--color-error)]"
              aria-label={'退出 ' + device.deviceName} onClick={() => selectDevice(device)}>退出登录</Button>}
          </li>
        })}
      </ul>
      {!hasPassword && devices.some(device => !device.current) && <div className="space-y-2 text-sm"><p>退出其他设备前，请先设置登录密码。</p><Button size="sm" onClick={onSetPassword}>设置登录密码</Button></div>}
    </AccountDialog>
  )
}
