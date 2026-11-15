// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StudioMobileSheet from '@/features/studio/components/StudioMobileSheet'
import { mockNativeDialog } from '../helpers/test-native-dialog'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('mobile action sheet dismissal', () => {
  it('keeps its native modal open through the exit animation, then performs navigation once', ({ onTestFinished }) => {
    const restore = mockNativeDialog()
    onTestFinished(restore)
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const close = vi.fn(), navigate = vi.fn()
    const view = render(<StudioMobileSheet title="作品操作" closeLabel="关闭作品操作" trigger={document.body} onClose={close}>{dismiss => <button onClick={() => dismiss(navigate)}>查看全部对话</button>}</StudioMobileSheet>)
    fireEvent.click(screen.getByRole('button', { name: '查看全部对话' }))
    const dialog = screen.getByRole('dialog', { name: '作品操作' })
    expect(dialog.getAttribute('data-state')).toBe('closing')
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(close).not.toHaveBeenCalled()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    act(() => vi.advanceTimersByTime(200))
    expect(close).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0])
    view.unmount()
  })

  it('respects reduced motion and restores focus to the invoking control', ({ onTestFinished }) => {
    const restore = mockNativeDialog()
    onTestFinished(restore)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const close = vi.fn()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const view = render(<StudioMobileSheet title="对话操作" closeLabel="关闭对话操作" trigger={trigger} onClose={close}>{() => <p>对话</p>}</StudioMobileSheet>)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '对话操作' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭对话操作' }))
    expect(close).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('blocks dismissal while saving and cancels delayed navigation if the sheet unmounts', ({ onTestFinished }) => {
    const restore = mockNativeDialog()
    onTestFinished(restore)
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const close = vi.fn()
    const props = { title: '对话操作', closeLabel: '关闭对话操作', trigger: document.body, onClose: close }
    const view = render(<StudioMobileSheet {...props} busy>{() => <p>对话</p>}</StudioMobileSheet>)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.getByRole('button', { name: '关闭对话操作' }).hasAttribute('disabled')).toBe(true)
    expect(close).not.toHaveBeenCalled()
    view.rerender(<StudioMobileSheet {...props}>{() => <p>对话</p>}</StudioMobileSheet>)
    fireEvent.click(screen.getByRole('button', { name: '关闭对话操作' }))
    view.unmount()
    act(() => vi.advanceTimersByTime(200))
    expect(close).not.toHaveBeenCalled()
  })
})
