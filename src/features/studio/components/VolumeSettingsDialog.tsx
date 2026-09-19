import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DeleteVolumeRequest, StudioPayload } from '../../../../shared/contracts/index.js'
import { deleteVolume, getStudioPayload, updateVolume } from '../api'
import ConfirmDialog from './ConfirmDialog'
import VolumeSettingsPanel, { type VolumeSettingsDraft } from './VolumeSettingsPanel'

type Props = {
  open: boolean
  novelId: string
  volumeId: string | null
  volumes: StudioPayload['volumes']
  chapters: StudioPayload['chapters']
  beforeChange: () => Promise<boolean>
  onChanged: () => Promise<void>
  onClose: () => void
  overlayClassName?: string
}

export default function VolumeSettingsDialog(props: Props) {
  const volume = props.volumes.find(item => item.id === props.volumeId)
  return props.open && volume ? <Session key={`${props.novelId}:${volume.id}`} {...props} volume={volume} /> : null
}

function Session(props: Props & { volume: StudioPayload['volumes'][number] }) {
  // Keep the edit revision bound to the draft the author actually opened.
  const [initialVolume] = useState(props.volume)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [applied, setApplied] = useState(false)
  const [confirmation, setConfirmation] = useState<{ input: DeleteVolumeRequest; description: string } | null>(null)
  const live = useRef(true)
  const locked = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const close = () => { if (live.current && !locked.current) props.onClose() }
  const ordered = [...props.volumes].sort((a, b) => a.orderIndex - b.orderIndex)
  const index = ordered.findIndex(item => item.id === initialVolume.id)
  const destination = ordered[index > 0 ? index - 1 : 1]
  const begin = () => {
    if (locked.current || !live.current) return false
    locked.current = true; setBusy(true); setError('')
    return true
  }
  const end = () => { locked.current = false; if (live.current) setBusy(false) }
  const fail = (failure: unknown) => { if (live.current) setError(failure instanceof Error ? failure.message : '操作失败，请稍后重试。') }

  async function save(draft: VolumeSettingsDraft) {
    if (!begin()) throw new Error('正在处理，请稍候。')
    try {
      if (!await props.beforeChange()) throw new Error('请先确认当前章节保存成功，再重试。')
      if (!live.current) return
      if (draft.title !== initialVolume.title || draft.summary !== (initialVolume.summary ?? '')) {
        await updateVolume(props.novelId, initialVolume.id, { ...draft, expectedRevision: initialVolume.revision })
        if (!live.current) return
        setApplied(true)
        await props.onChanged()
      }
    } catch (failure) { fail(failure); throw failure } finally { end() }
  }

  async function prepareDelete() {
    if (!begin()) return
    try {
      if (!await props.beforeChange()) throw new Error('请先确认当前章节保存成功，再重试。')
      if (!live.current) return
      // Saving the current chapter may advance its revision. Read before showing
      // the confirmation, then bind every source chapter to that exact version.
      const payload = await getStudioPayload(props.novelId)
      if (!live.current) return
      const volumes = [...payload.volumes].sort((a, b) => a.orderIndex - b.orderIndex)
      const currentIndex = volumes.findIndex(item => item.id === initialVolume.id)
      if (currentIndex < 0) { setApplied(true); await props.onChanged(); end(); close(); return }
      if (volumes.length <= 1) throw new Error('作品必须至少保留一卷，当前卷不能删除。')
      const target = volumes[currentIndex > 0 ? currentIndex - 1 : 1]
      const chapters = payload.chapters.filter(item => item.volumeId === initialVolume.id)
      setConfirmation({
        input: { expectedRevision: volumes[currentIndex].revision, moveChapters: true, targetVolumeId: target.id, expectedChapterRevisions: chapters.map(item => ({ id: item.id, revision: item.revision })) },
        description: chapters.length
          ? `删除「${volumes[currentIndex].title}」后，其中 ${chapters.length} 章将${currentIndex > 0 ? '追加到' : '移到'}「${target.title}」${currentIndex > 0 ? '末尾' : '开头'}，正文保留。剩余卷将重新编号。`
          : `确定删除空卷「${volumes[currentIndex].title}」吗？剩余卷将重新编号，章节内容不变。`,
      })
    } catch (failure) { fail(failure) } finally { end() }
  }

  async function confirmDelete() {
    if (!confirmation || !begin()) return
    try {
      await deleteVolume(props.novelId, initialVolume.id, confirmation.input)
      if (!live.current) return
      setConfirmation(null); setApplied(true)
      await props.onChanged()
      end(); close()
    } catch (failure) {
      if (live.current) setConfirmation(null)
      fail(failure)
    } finally { end() }
  }

  async function refreshApplied() {
    if (!begin()) return
    try { await props.onChanged(); end(); close() } catch (failure) { fail(failure) } finally { end() }
  }

  return createPortal(<div className="studio-workspace">
    <VolumeSettingsPanel
      volume={initialVolume}
      chapterCount={props.chapters.filter(item => item.volumeId === initialVolume.id).length}
      volumeCount={props.volumes.length}
      deleteDestinationTitle={destination?.title}
      busy={busy || applied}
      errorMessage={error}
      onSave={save}
      onRequestDelete={() => void prepareDelete()}
      onClose={close}
      overlayClassName={props.overlayClassName ?? 'z-[110]'}
    />
    <ConfirmDialog open={Boolean(confirmation)} title="删除卷" description={confirmation?.description ?? ''} confirmLabel="删除卷并保留章节" tone="danger" busy={busy} onCancel={() => { if (!locked.current) setConfirmation(null) }} onConfirm={() => void confirmDelete()} />
    <ConfirmDialog open={applied && !busy} title="操作已完成" description={error ? `目录刷新未完成：${error}` : '正在更新目录。'} confirmLabel="刷新目录" busy={busy} onCancel={close} onConfirm={() => void refreshApplied()} />
  </div>, document.body)
}
