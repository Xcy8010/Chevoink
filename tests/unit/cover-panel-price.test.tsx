// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import CoverPanel from '../../src/features/studio/components/CoverPanel'
import type { PublicImageModel } from '../../shared/contracts/image-model'

afterEach(cleanup)
it.each([0, 0.125])('shows the server image activity and struck original six Credits with current %s Credits', perCallCredits => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const price: PublicImageModel = { label: '封面绘制', available: true, publicDescription: '书封', publicFeatures: [], basePerCallCredits: 6,
    perCallCredits, baseMultiplier: 1.5, multiplier: perCallCredits === 0 ? 0 : 0.03125, discountRatio: perCallCredits / 6,
    activity: { name: '封面限时优惠', revision: 1, timezone: 'Asia/Shanghai', asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] } }
  client.setQueryData(['ai', 'public-config'], { imageModel: price })
  const generate = vi.fn()
  render(<QueryClientProvider client={client}><CoverPanel coverForm={{ novelTitle: 'Title', summary: '', genre: 'fantasy', protagonist: '', stylePreference: '', prompt: 'Cover', negativePrompt: '', size: '768x1024', count: 1 }}
    coverAssets={[]} selectedCover={null} coverKeywords={[]} coverMessage="" generatingPrompt={false} generatingImage={false} generationProgress={0} selectingCover={false}
    formatDateTime={() => ''} onChange={vi.fn()} onUploadFile={vi.fn()} onGeneratePrompt={vi.fn()} onGenerateImages={generate} onSelectAsset={vi.fn()} onApplyCover={vi.fn()}
    onApplyAsset={vi.fn()} onDownloadAsset={vi.fn()} onClose={vi.fn()} /></QueryClientProvider>)
  const summary = screen.getByText(/封面绘制/).closest('summary')!
  expect(summary.textContent).toContain('封面限时优惠')
  expect(summary.querySelector('s')?.textContent).toBe('6 Credits / 批')
  expect(summary.textContent).toContain('当前 ' + perCallCredits + ' Credits / 批')
  fireEvent.click(summary)
  expect(generate).not.toHaveBeenCalled()
})
