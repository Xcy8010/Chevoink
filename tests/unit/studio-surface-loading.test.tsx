// @vitest-environment jsdom
import { StrictMode, Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { loadStudioSurface } from '../../src/features/studio/components/load-studio-surface'

afterEach(cleanup)

it('keeps a shared cold import, its failure, and a retry inside the panel', async () => {
  const loaded = { default: ({ title }: { title: string }) => <div>{title}</div> }
  const load = vi.fn<() => Promise<typeof loaded>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(loaded)
  const Pane = loadStudioSurface(load, '章节')
  const view = render(<StrictMode><Suspense fallback="整个工作区"><input /><Pane title="甲" /><Pane title="乙" /></Suspense></StrictMode>)
  const input = screen.getByRole('textbox')
  expect(await screen.findAllByRole('alert')).toHaveLength(2)
  expect(load).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0])
  await screen.findByText('乙')
  expect(screen.getByText('甲')).toBeTruthy()
  expect(screen.getByRole('textbox')).toBe(input)
  expect(screen.queryByText('整个工作区')).toBeNull()
  view.unmount()
  render(<Pane title="丙" />)
  expect(screen.getByText('丙')).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(2)
})

it('restores focus when dismissed before download and respects the latest open state', async () => {
  type Props = { open: boolean; onClose: () => void }
  const loaded = { default: ({ open }: Props) => open ? <div>已打开设置</div> : null }
  let finish!: (value: typeof loaded) => void
  const Dialog = loadStudioSurface(() => new Promise<typeof loaded>(resolve => { finish = resolve }), '设置', props => props)
  const close = vi.fn()
  const tree = (open: boolean) => <><button>设置入口</button><Dialog open={open} onClose={close} /></>
  const view = render(tree(false))
  const trigger = screen.getByRole('button')
  trigger.focus()
  view.rerender(tree(true))
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  view.rerender(tree(false))
  expect(document.activeElement).toBe(trigger)
  await act(async () => { finish(loaded) })
  expect(screen.queryByText('已打开设置')).toBeNull()
  view.rerender(tree(true))
  expect(screen.getByText('已打开设置')).toBeTruthy()
})
