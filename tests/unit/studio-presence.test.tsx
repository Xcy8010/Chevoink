// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StudioPresence } from '@/features/studio/components/StudioPresence'
import { useStudioDismiss } from '@/features/studio/components/use-studio-presence'

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
  delete document.documentElement.dataset.studioReducedMotion
  vi.useRealTimers()
})

it('retains the last visible content during exit and reverses a close on the same element', () => {
  const menu = (name?: string) => <StudioPresence kind="menu">{name && <button>{name}</button>}</StudioPresence>
  const view = render(menu('first'))
  const button = screen.getByRole('button')
  view.rerender(menu('updated'))
  view.rerender(menu())
  expect(button.textContent).toBe('updated')
  expect(button.closest('[inert]')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(65) })
  view.rerender(menu('reopened'))
  expect(screen.getByRole('button', { name: 'reopened' })).toBe(button)
  expect(button.closest('[inert]')).toBeNull()
  act(() => { vi.advanceTimersByTime(300) })
  expect(button.isConnected).toBe(true)
  view.rerender(menu())
  act(() => { vi.advanceTimersByTime(200) })
  expect(button.isConnected).toBe(false)
})

function NativeClose({ onClose }: { onClose: () => void }) {
  const { dismiss } = useStudioDismiss(onClose)
  return <button onClick={dismiss}>Close</button>
}

it('finishes one close on the latest callback, and cancels a pending close on unmount', () => {
  const original = vi.fn(), latest = vi.fn()
  const view = render(<NativeClose onClose={original} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button'))
  view.rerender(<NativeClose onClose={latest} />)
  act(() => { vi.advanceTimersByTime(300) })
  expect(original).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledTimes(1)
  view.rerender(<NativeClose key="another" onClose={latest} />)
  fireEvent.click(screen.getByRole('button'))
  view.unmount()
  act(() => { vi.advanceTimersByTime(300) })
  expect(latest).toHaveBeenCalledTimes(1)
})

it('closes immediately with the workspace reduced motion preference', () => {
  document.documentElement.dataset.studioReducedMotion = 'true'
  const close = vi.fn()
  const view = render(<><NativeClose onClose={close} /><StudioPresence kind="dialog"><p>Dialog</p></StudioPresence></>)
  fireEvent.click(screen.getByRole('button'))
  expect(close).toHaveBeenCalledTimes(1)
  view.rerender(<><NativeClose onClose={close} /><StudioPresence kind="dialog">{null}</StudioPresence></>)
  expect(screen.queryByText('Dialog')).toBeNull()
})
