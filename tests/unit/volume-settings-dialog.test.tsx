// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioPayload } from '../../shared/contracts/index.js'
import VolumeSettingsDialog from '../../src/features/studio/components/VolumeSettingsDialog'

const api = vi.hoisted(() => ({ getStudioPayload: vi.fn(), deleteVolume: vi.fn(), updateVolume: vi.fn() }))
vi.mock('../../src/features/studio/api', () => api)
afterEach(cleanup)
beforeEach(() => { vi.resetAllMocks(); api.deleteVolume.mockResolvedValue(undefined); api.updateVolume.mockResolvedValue(undefined) })

function propsFor(novelId = 'n'): ComponentProps<typeof VolumeSettingsDialog> {
  const volumes = [1, 2].map(number => ({ id: `v${number}`, novelId, title: `卷${number}`, summary: null, revision: 2, orderIndex: number, chapterCount: 1, wordCount: 10 }))
  const chapters = [{ id: 'c', novelId, volumeId: 'v1', revision: 3 }] as StudioPayload['chapters']
  return { open: true, novelId, volumeId: 'v1', volumes, chapters, beforeChange: vi.fn(async () => true), onChanged: vi.fn(async () => undefined), onClose: vi.fn() }
}
function payload(props: ReturnType<typeof propsFor>) { return { volumes: props.volumes, chapters: props.chapters } }
async function openConfirmation() {
  fireEvent.click(screen.getByRole('button', { name: '删除卷' }))
  return within(await screen.findByRole('dialog', { name: '删除卷' }))
}

describe('volume settings confirmation and operation ownership', () => {
  it('blocks the sole remaining volume but allows the last volume when another exists', () => {
    const props = propsFor()
    const view = render(<VolumeSettingsDialog {...props} volumes={[props.volumes[0]]} />)
    expect(screen.getByText('作品仅剩一卷，不能删除最后一卷。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除卷' })).toBeNull()
    view.rerender(<VolumeSettingsDialog {...props} volumeId="v2" />)
    expect((screen.getByRole('button', { name: '删除卷' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('retains edited volume title and the open panel when saving fails', async () => {
    const props = propsFor()
    api.updateVolume.mockRejectedValueOnce(new Error('卷已被其他窗口修改'))
    render(<VolumeSettingsDialog {...props} />)
    const title = screen.getByPlaceholderText('例如：第一卷 初入江湖')
    fireEvent.change(title, { target: { value: '保留的输入' } })
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await screen.findByText('卷已被其他窗口修改')
    expect((title as HTMLInputElement).value).toBe('保留的输入')
    expect(props.onClose).not.toHaveBeenCalled()
    expect(api.updateVolume).toHaveBeenCalledWith('n', 'v1', { title: '保留的输入', summary: '', expectedRevision: 2 })
  })
  it('reads fresh revisions before confirmation and only moves chapters after explicit confirmation', async () => {
    const props = propsFor()
    api.getStudioPayload.mockResolvedValue({ ...payload(props), chapters: [{ ...props.chapters[0], revision: 7 }] })
    render(<VolumeSettingsDialog {...props} />)
    const confirmation = await openConfirmation()
    expect(props.beforeChange).toHaveBeenCalledOnce()
    expect(api.deleteVolume).not.toHaveBeenCalled()
    expect(confirmation.getByText(/开头.*正文保留/)).toBeTruthy()
    fireEvent.click(confirmation.getByRole('button', { name: '删除卷并保留章节' }))
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce())
    expect(api.deleteVolume).toHaveBeenCalledExactlyOnceWith('n', 'v1', { expectedRevision: 2, moveChapters: true, targetVolumeId: 'v2', expectedChapterRevisions: [{ id: 'c', revision: 7 }] })
    expect(props.onChanged).toHaveBeenCalledOnce()
  })
  it('cancel and failed save guard do not write a deletion', async () => {
    const props = propsFor()
    api.getStudioPayload.mockResolvedValue(payload(props))
    render(<VolumeSettingsDialog {...props} />)
    const confirmation = await openConfirmation()
    fireEvent.click(confirmation.getByRole('button', { name: '取消' }))
    expect(api.deleteVolume).not.toHaveBeenCalled()
    vi.mocked(props.beforeChange).mockResolvedValue(false)
    fireEvent.click(screen.getByRole('button', { name: '删除卷' }))
    await screen.findByText('请先确认当前章节保存成功，再重试。')
    expect(api.getStudioPayload).toHaveBeenCalledOnce()
    expect(api.deleteVolume).not.toHaveBeenCalled()
  })
  it('shows server conflicts and requires a fresh confirmation for retry', async () => {
    const props = propsFor()
    api.getStudioPayload.mockResolvedValue(payload(props))
    api.deleteVolume.mockRejectedValueOnce(new Error('卷内章节已变化'))
    render(<VolumeSettingsDialog {...props} />)
    const confirmation = await openConfirmation()
    fireEvent.click(confirmation.getByRole('button', { name: '删除卷并保留章节' }))
    await screen.findByText('卷内章节已变化')
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除卷' })).toBeNull()
    await openConfirmation()
    expect(api.getStudioPayload).toHaveBeenCalledTimes(2)
    expect(api.deleteVolume).toHaveBeenCalledOnce()
  })
  it('retries only refresh after a confirmed deletion succeeded', async () => {
    const props = propsFor()
    api.getStudioPayload.mockResolvedValue(payload(props))
    vi.mocked(props.onChanged).mockRejectedValueOnce(new Error('网络暂时不可用')).mockResolvedValue(undefined)
    render(<VolumeSettingsDialog {...props} />)
    const confirmation = await openConfirmation()
    fireEvent.click(confirmation.getByRole('button', { name: '删除卷并保留章节' }))
    fireEvent.click(await screen.findByRole('button', { name: '刷新目录' }))
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce())
    expect(api.deleteVolume).toHaveBeenCalledOnce()
    expect(props.onChanged).toHaveBeenCalledTimes(2)
  })
  it('discards a late preview after switching work', async () => {
    const props = propsFor()
    let resolve!: (value: unknown) => void
    api.getStudioPayload.mockImplementation(() => new Promise(done => { resolve = done }))
    const view = render(<VolumeSettingsDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '删除卷' }))
    await waitFor(() => expect(api.getStudioPayload).toHaveBeenCalledOnce())
    view.rerender(<VolumeSettingsDialog {...propsFor('other')} />)
    await act(async () => resolve(payload(props)))
    expect(screen.queryByRole('dialog', { name: '删除卷' })).toBeNull()
    expect(api.deleteVolume).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
  })
})
