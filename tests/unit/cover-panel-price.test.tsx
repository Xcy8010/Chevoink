// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import CoverPanel from '../../src/features/studio/components/CoverPanel'
import type { PublicImageModel } from '../../shared/contracts/image-model'

afterEach(cleanup)
const cover = { id: 'cover', novelId: 'novel', ownerUserId: 'author', sourceType: 'ai_generated', imageUrl: '/cover.png',
  prompt: '雨中的车站', negativePrompt: null, modelName: null, width: 768, height: 1024, createdAt: '2026-11-06T12:00:00Z' } as const

function fixture(perCallCredits = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const price: PublicImageModel = { label: '封面绘制', available: true, publicDescription: '书封', publicFeatures: [], basePerCallCredits: 6,
    perCallCredits, baseMultiplier: 1.5, multiplier: perCallCredits === 0 ? 0 : 0.03125, discountRatio: perCallCredits / 6,
    activity: { name: '封面限时优惠', revision: 1, timezone: 'Asia/Shanghai', asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] } }
  client.setQueryData(['ai', 'public-config'], { imageModel: price })
  const props = { coverForm: { novelTitle: 'Title', summary: '', genre: 'fantasy', protagonist: '', stylePreference: '', prompt: 'Cover', negativePrompt: '', size: '768x1024', count: 1 },
    coverAssets: [], selectedCover: null, coverKeywords: [], coverMessage: '', generatingPrompt: false, generatingImage: false, generationProgress: 0, selectingCover: false,
    formatDateTime: () => '', onChange: vi.fn(), onUploadFile: vi.fn(), onGeneratePrompt: vi.fn(), onGenerateImages: vi.fn(),
    onSelectAsset: vi.fn(), onApplyCover: vi.fn(), onApplyAsset: vi.fn(), onDownloadAsset: vi.fn(), onClose: vi.fn() } satisfies ComponentProps<typeof CoverPanel>
  return { client, props }
}

it.each([0, 0.125])('shows the server image activity and struck original six Credits with current %s Credits', perCallCredits => {
  const { client, props } = fixture(perCallCredits)
  render(<QueryClientProvider client={client}><CoverPanel {...props} /></QueryClientProvider>)
  const summary = screen.getByText(/封面绘制/).closest('summary')!
  expect(summary.textContent).toContain('封面限时优惠')
  expect(summary.querySelector('s')?.textContent).toBe('6 Credits / 批')
  expect(summary.textContent).toContain('当前 ' + perCallCredits + ' Credits / 批')
  fireEvent.click(summary)
  expect(props.onGenerateImages).not.toHaveBeenCalled()
})

it('keeps editing, upload, generation, and candidate actions available from the workshop', () => {
  const { client, props } = fixture()
  render(<QueryClientProvider client={client}><CoverPanel {...props} coverAssets={[cover]} selectedCover={cover} /></QueryClientProvider>)

  fireEvent.click(screen.getByRole('button', { name: '智能生成提示词' }))
  expect(props.onGeneratePrompt).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '手动输入' }))
  fireEvent.change(screen.getByRole('textbox', { name: '封面提示词' }), { target: { value: '城市夜雨' } })
  expect(props.onChange).toHaveBeenCalledWith({ ...props.coverForm, prompt: '城市夜雨' })
  expect(screen.getByRole('textbox', { name: /不想要的元素/ })).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: '候选数量' }), { target: { value: '2' } })
  expect(props.onChange).toHaveBeenCalledWith({ ...props.coverForm, count: 2 })

  const file = new File(['cover'], 'cover.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择封面图片'), { target: { files: [file] } })
  expect(props.onUploadFile).toHaveBeenCalledWith(file)
  fireEvent.click(screen.getByRole('button', { name: '生成封面' }))
  expect(props.onGenerateImages).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '设为作品封面' }))
  expect(props.onApplyCover).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '取消选择' }))
  expect(props.onSelectAsset).toHaveBeenCalledWith(null)
  fireEvent.click(screen.getByRole('button', { name: '一键更换' }))
  expect(props.onApplyAsset).toHaveBeenCalledWith(cover)
  fireEvent.click(screen.getByRole('button', { name: '下载这张候选封面' }))
  expect(props.onDownloadAsset).toHaveBeenCalledWith(cover)
})

it('closes only the top image preview on Escape and restores workshop focus', () => {
  const { client, props } = fixture()
  function Workshop() {
    const [open, setOpen] = useState(false)
    return <>
      <button type="button" onClick={() => setOpen(true)}>打开封面工坊</button>
      {open ? <CoverPanel {...props} modal coverAssets={[cover]} onClose={() => setOpen(false)} /> : null}
    </>
  }
  render(<QueryClientProvider client={client}><Workshop /></QueryClientProvider>)
  const open = screen.getByRole('button', { name: '打开封面工坊' })
  open.focus()
  fireEvent.click(open)
  const dialog = screen.getByRole('dialog', { name: '封面工坊' })
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '关闭封面工坊' }))
  const preview = within(dialog).getByRole('button', { name: '放大查看这张封面' })
  preview.focus()
  fireEvent.click(preview)
  expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: '封面工坊' })).toBeNull()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: '图片预览' })).toBeNull()
  expect(screen.getByRole('dialog', { name: '封面工坊' })).toBe(dialog)
  expect(document.activeElement).toBe(preview)
  fireEvent.keyDown(preview, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: '封面工坊' })).toBeNull()
  expect(document.activeElement).toBe(open)
})
