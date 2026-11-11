import { useId, useState, type FormEvent } from 'react'

import { requestJson } from '@/app/api-client'
import Button from '@/components/ui/Button'
import ImageCropperDialog from '@/components/ui/ImageCropperDialog'
import TextInput from '@/components/ui/TextInput'
import Avatar from '@/features/community/components/Avatar'
import { getProfileImageUploadError, prepareAvatarImage, readFileAsDataUrl } from '@/lib/image-compress'
import type { User } from '../../../shared/contracts'
import { authError } from './auth-api'
import { useUpdateAccountSession } from './use-account-session'

export default function ProfileSetupForm({ user, disabled, onSaved, onSaving }: {
  user: User
  disabled: boolean
  onSaved: () => void
  onSaving: (saving: boolean) => void
}) {
  const [nickname, setNickname] = useState(user.nickname)
  const [bio, setBio] = useState(user.bio ?? '')
  const [avatar, setAvatar] = useState<string>()
  const [cover, setCover] = useState<string>()
  const [cropSource, setCropSource] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const nicknameId = useId()
  const bioId = useId()
  const updateSession = useUpdateAccountSession()
  const busy = disabled || preparing || saving

  async function prepare(file: File | undefined, kind: '头像' | '封面') {
    if (!file) return
    const validation = getProfileImageUploadError(file, kind)
    setError(validation ?? '')
    if (validation) return
    setPreparing(true)
    onSaving(true)
    try {
      if (kind === '头像') setAvatar(await prepareAvatarImage(file))
      else setCropSource(await readFileAsDataUrl(file))
    } catch {
      setError(`无法读取${kind}图片，请重新选择。`)
    } finally {
      setPreparing(false)
      onSaving(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (!nickname.trim()) { setError('请输入昵称。'); return }
    setSaving(true)
    onSaving(true)
    setError('')
    try {
      async function save(field: 'profile' | 'avatar' | 'cover', body: object) {
        const { user: next } = await requestJson<{ user: User }>(`/api/users/me/${field}`, {
          method: 'PATCH', body: JSON.stringify(body),
        })
        return updateSession(next)
      }
      if ((nickname.trim() !== user.nickname || bio.trim() !== (user.bio ?? '')) &&
        !(await save('profile', { nickname: nickname.trim(), bio: bio.trim() }))) return
      if (avatar) {
        if (!(await save('avatar', { avatarDataUrl: avatar }))) return
        setAvatar(undefined)
      }
      if (cover) {
        if (!(await save('cover', { coverDataUrl: cover }))) return
        setCover(undefined)
      }
      onSaved()
    } catch (error) {
      setError(authError(error, '暂时无法保存个人资料，请稍后重试。'))
    } finally {
      setSaving(false)
      onSaving(false)
    }
  }

  const coverSrc = cover ?? user.profileCoverUrl
  const imageAccept = 'image/png,image/jpeg,image/webp'

  return (
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-4">
        <div className="space-y-2">
          <Avatar name={nickname} src={avatar ?? user.avatarUrl} size="md" />
          <label className="block cursor-pointer text-sm font-medium text-[var(--color-brand)] focus-within:outline focus-within:outline-2">
            <span>选择头像</span>
            <input className="sr-only" type="file" accept={imageAccept} disabled={busy} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void prepare(file, '头像')
            }} />
          </label>
        </div>
        <div className="min-w-0 space-y-2">
          <div className="relative aspect-[3/1] overflow-hidden rounded-xl bg-[var(--surface-muted)]">
            {coverSrc && <img src={coverSrc} alt="个人封面预览" className="absolute inset-0 h-full w-full object-cover" />}
          </div>
          <label className="block cursor-pointer text-sm font-medium text-[var(--color-brand)] focus-within:outline focus-within:outline-2">
            <span>选择封面</span>
            <input className="sr-only" type="file" accept={imageAccept} disabled={busy} onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void prepare(file, '封面')
            }} />
          </label>
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={nicknameId} className="block text-sm font-medium">昵称</label>
        <TextInput wrapperAs="span" id={nicknameId} placeholder="请输入昵称" value={nickname} maxLength={30} required disabled={busy} onChange={event => setNickname(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={bioId} className="block text-sm font-medium">简介</label>
        <textarea id={bioId} placeholder="写一句话介绍自己" value={bio} maxLength={80} rows={3} disabled={busy} onChange={event => setBio(event.target.value)}
          className="w-full resize-y rounded-xl border border-[var(--border-strong)] bg-[var(--surface-default)] px-4 py-3 text-sm" />
      </div>
      {error && <p role="alert" className="text-sm leading-6 text-[var(--color-danger,#dc2626)]">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>{saving ? '保存中…' : '保存并完成'}</Button>
      <ImageCropperDialog open={Boolean(cropSource)} imageDataUrl={cropSource} aspect={3} submitting={false}
        onCancel={() => setCropSource(null)} onConfirm={image => { setCover(image); setCropSource(null) }} />
    </form>
  )
}
