// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentVoiceInputBar } from '../../src/features/studio/agent/components/AgentVoiceInputBar'
import type { VoiceInputController } from '../../src/features/studio/agent/hooks/useVoiceInput'

vi.mock('../../src/features/studio/agent/voice/speech-engine', () => ({ VOICE_MODEL_DOWNLOAD_BYTES: 252035688 }))
afterEach(cleanup)

function voice(overrides: Partial<VoiceInputController> = {}): VoiceInputController {
  return {
    state: 'idle', status: 'idle', active: false, modelReady: true, disabled: false,
    error: null, progress: 0, packProgress: null, elapsed: 0, levels: [0, 0.5, 1],
    start: vi.fn(), cancel: vi.fn(), stop: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), removeModel: vi.fn(), deleteModel: vi.fn(),
    ...overrides,
  }
}

describe('AgentVoiceInputBar', () => {
  it('keeps permission preparation in the compact recording surface without a waiting message', () => {
    render(<AgentVoiceInputBar voice={voice({ state: 'requesting-permission' })} />)
    expect(screen.queryByText(/正在等待麦克风权限/)).toBeNull()
    expect(screen.getByLabelText('麦克风准备中，尚未录音')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消语音输入' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '停止录音并转写' })).toBeNull()
  })

  it('shows real waveform and time between neutral 44px cancel/stop buttons, never a send button', () => {
    const controller = voice({ state: 'recording', elapsed: 12.7 })
    render(<AgentVoiceInputBar voice={controller} />)
    const bars = screen.getByRole('img', { name: '实时麦克风音量' }).children
    expect((bars[0] as HTMLElement).style.height).toBe('2px')
    expect((bars[1] as HTMLElement).style.height).toBe('16px')
    expect((bars[2] as HTMLElement).style.height).toBe('30px')
    expect(screen.getByText('00:12')).toBeTruthy()
    const stop = screen.getByRole('button', { name: '停止录音并转写' })
    expect(stop.getAttribute('type')).toBe('button')
    expect(stop.className).toContain('min-h-[44px]')
    expect(stop.className).toContain('rounded-full')
    fireEvent.click(stop)
    expect(controller.stop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /^发送/ })).toBeNull()
  })

  it('offers cancellation during transcription and has no record/send action', () => {
    const controller = voice({ state: 'transcribing' })
    render(<AgentVoiceInputBar voice={controller} />)
    expect(screen.getByRole('status').textContent).toBe('正在转写')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '取消语音输入' }))
    expect(controller.cancel).toHaveBeenCalledOnce()
  })

  it('explains total engine size/privacy and waits for explicit download', () => {
    const controller = voice({ state: 'needs-download', modelReady: false })
    render(<AgentVoiceInputBar voice={controller} />)
    expect(screen.getByText(/253 MB/).textContent).toContain('音频不离开设备')
    expect(controller.download).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '下载设备端语音包' }))
    expect(controller.download).toHaveBeenCalledOnce()
    expect(controller.start).not.toHaveBeenCalled()
  })

  it('renders accessible download progress and dismissible errors', () => {
    const controller = voice({ state: 'downloading', progress: 0.42, error: '连接已中断' })
    render(<AgentVoiceInputBar voice={controller} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0.42')
    expect(screen.getByText('42.0%')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('连接已中断')
    fireEvent.click(screen.getByRole('button', { name: '取消语音输入' }))
    expect(controller.cancel).toHaveBeenCalledOnce()
  })

  it('offers explicit cache deletion and honors disabled start', () => {
    const controller = voice()
    const view = render(<AgentVoiceInputBar voice={controller} />)
    fireEvent.click(screen.getByRole('button', { name: '删除设备端语音包' }))
    expect(controller.removeModel).toHaveBeenCalledOnce()
    view.rerender(<AgentVoiceInputBar voice={voice({ disabled: true })} />)
    expect((screen.getByRole('button', { name: '开始录音' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
