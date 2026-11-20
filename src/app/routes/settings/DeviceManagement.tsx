import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronRight, Layers, LogOut, MapPin, Monitor, Smartphone, Tablet } from 'lucide-react'
import type { LoginDevice, RevokeLoginDeviceResult } from '../../../../shared/contracts/api'
import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import TextInput from '@/components/ui/TextInput'
import { AccountDialog } from '@/features/account/VerificationCodeField'
import { authError, postAuth } from '@/features/account/auth-api'

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const platforms = {
  Windows: { name: 'Windows 电脑', Icon: Monitor },
  Mac: { name: 'Mac 电脑', Icon: Monitor },
  Linux: { name: 'Linux 电脑', Icon: Monitor },
  Android: { name: 'Android 设备', Icon: Smartphone },
  iPhone: { name: 'iPhone', Icon: Smartphone },
  iPad: { name: 'iPad', Icon: Tablet },
}

function describeDevice(deviceName: string) {
  const [os, ...parts] = deviceName.split(' · ')
  const platform = Object.prototype.hasOwnProperty.call(platforms, os) ? platforms[os as keyof typeof platforms] : undefined
  const last = parts.at(-1) ?? ''
  const client = /^(应用|Edge|Chrome|Safari|Firefox)$/.test(last) ? parts.pop() : undefined
  const model = parts.join(' · ')
  return {
    group: platform?.name ?? '其他设备',
    Icon: platform?.Icon ?? Layers,
    title: model ? os + ' · ' + model : platform?.name ?? deviceName,
    model, os: platform ? os : undefined, client,
  }
}

function deviceTime(iso: string) {
  return <time dateTime={iso}>{dateFormat.format(new Date(iso))}</time>
}

function CurrentDevice() {
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand)]">
    <CheckCircle2 size={14} aria-hidden />当前设备
  </span>
}

export default function DeviceManagement({ userId, hasPassword, onClose, onSetPassword, onSignedOut }: {
  userId: string
  hasPassword: boolean
  onClose: () => void
  onSetPassword: () => void
  onSignedOut: () => void
}) {
  const cache = useQueryClient()
  const queryKey = ['account', userId, 'devices']
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => requestJson<{ devices: LoginDevice[] }>('/api/auth/devices', { signal }),
    retry: false, gcTime: 0, refetchInterval: 30_000,
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)
  const devices = query.data?.devices ?? []
  const target = devices.find(device => device.id === selectedId)

  function select(id: string | null) {
    setSelectedId(id)
    setConfirming(false)
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
      const result = await postAuth<RevokeLoginDeviceResult>('/devices/' + encodeURIComponent(target.id) + '/revoke', { password })
      await cache.cancelQueries({ queryKey })
      if (result.signedOutCurrent) {
        cache.setQueryData(queryKey, { devices: [] })
        onSignedOut()
        return
      }
      cache.setQueryData<{ devices: LoginDevice[] }>(queryKey, previous => previous && ({
        devices: previous.devices.filter(device => device.id !== target.id && !(target.legacyGroup && device.legacyGroup)),
      }))
      select(null)
      setNotice(target.legacyGroup ? '这组旧版登录已退出。' : target.deviceName + ' 已退出登录。')
      if (target.legacyGroup) void cache.invalidateQueries({ queryKey })
    } catch (cause) {
      setError(authError(cause, '退出设备失败，请稍后重试。'))
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  if (target && confirming) return (
    <AccountDialog key="verify" title={target.legacyGroup ? '退出旧版登录？' : target.current ? '退出当前设备？' : '退出这台设备？'}
      description={target.legacyGroup
        ? '这组旧设备将同时退出，之后需要重新登录。请输入当前账号的登录密码确认。'
        : target.firstSeenOnly
          ? '这台设备将退出。已识别的其他设备可继续使用，尚未识别的旧设备需要重新登录。请输入账号密码确认。'
          : target.deviceName + ' 将需要重新登录。请输入当前账号的登录密码确认。'}
      onClose={() => { if (!pending.current) select(target.id) }}>
      <form onSubmit={revoke} className="space-y-4">
        <label className="block space-y-2 text-sm font-medium">
          <span>登录密码</span>
          <TextInput autoComplete="current-password" type="password" required value={password}
            disabled={submitting} onChange={event => { setPassword(event.target.value); setError('') }} />
        </label>
        {error && <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button disabled={submitting} onClick={() => select(target.id)}>取消</Button>
          <Button variant="primary" type="submit" disabled={!password || submitting}>{submitting ? '正在退出…' : '确认退出'}</Button>
        </div>
      </form>
    </AccountDialog>
  )

  if (target) {
    const { title, Icon, os, client, model } = describeDevice(target.deviceName)
    const fields = [
      ['设备型号', model || '设备未提供'],
      ['操作系统', os || '未知'],
      ['浏览器或应用', client === '应用' ? '启创墨域 App' : client || '未知'],
      ['网络所在地', target.location || '地点未知'],
      [target.firstSeenOnly || target.legacyGroup ? '首次识别' : '登录时间', deviceTime(target.createdAt)],
      ['最近活动', deviceTime(target.lastActiveAt)],
    ] as const
    return <AccountDialog key="detail" wide title="设备详情" onBack={() => select(null)} onClose={onClose}>
      <div className="flex items-center gap-4 py-3">
        <span className="grid size-14 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)]"><Icon size={27} strokeWidth={1.6} aria-hidden /></span>
        <div className="min-w-0">
          <h3 className="break-words text-xl font-semibold">{title}</h3>
          {target.current && <CurrentDevice />}
        </div>
      </div>
      <dl className="my-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-4 border-y border-[var(--border-subtle)] py-5 text-sm">
        {fields.map(([label, value]) => <div key={label} className="contents"><dt className="text-[var(--text-secondary)]">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}
      </dl>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {!hasPassword && <p className="text-sm text-[var(--text-secondary)]">退出设备前，请先设置登录密码。</p>}
        {hasPassword ? <Button className="text-[var(--color-error)]" onClick={() => setConfirming(true)}><LogOut size={16} aria-hidden />退出登录</Button>
          : <Button onClick={onSetPassword}>设置登录密码</Button>}
      </div>
    </AccountDialog>
  }

  const groups = new Map<string, LoginDevice[]>()
  for (const device of [...devices.filter(item => item.current), ...devices.filter(item => !item.current)]) {
    const { group } = describeDevice(device.deviceName)
    const rows = groups.get(group)
    if (rows) rows.push(device)
    else groups.set(group, [device])
  }

  return <AccountDialog key="list" wide title="设备管理" onClose={onClose}>
    {query.isPending && <div role="status" aria-label="正在加载设备" className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>}
    {query.isError && <div role="alert" className="flex items-center justify-between gap-2 text-sm"><p>设备列表加载失败</p><Button size="sm" onClick={() => void query.refetch()}>重试</Button></div>}
    {notice && <p role="status" className="mb-3 text-sm text-[var(--color-success)]">{notice}</p>}
    {query.isSuccess && !devices.length && <p className="text-sm text-[var(--text-secondary)]">暂时没有登录设备记录。</p>}
    {Array.from(groups, ([group, rows]) => {
      const { Icon } = describeDevice(rows[0].deviceName)
      return <section key={group} aria-label={group} className="border-t border-[var(--border-subtle)] py-3 last:pb-0">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)]"><Icon size={18} aria-hidden /></span>
          <h3 className="text-sm font-semibold">{group}</h3>
          <span className="ml-auto text-xs text-[var(--text-secondary)]">{rows.length} 个设备</span>
        </div>
        <ul className="sm:ml-8">
          {rows.map(device => {
            const { title, model, client } = describeDevice(device.deviceName)
            const name = model ? title : device.deviceName
            return <li key={device.id}><button type="button" onClick={() => select(device.id)} aria-label={'查看 ' + name}
              className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-3 text-left hover:bg-[var(--surface-muted)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="break-words font-semibold">{name}</span>{device.current && <CurrentDevice />}</div>
                <p className="mt-1 flex items-start gap-1.5 text-[13px] leading-5 text-[var(--text-secondary)]"><MapPin size={13} className="mt-1 shrink-0" aria-hidden /><span>{device.location || '地点未知'}{model && client ? ' · ' + client : ''}</span></p>
                <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">最近活动 <span className="ml-1">{deviceTime(device.lastActiveAt)}</span></p>
              </div><ChevronRight size={17} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
            </button></li>
          })}
        </ul>
      </section>
    })}
  </AccountDialog>
}
