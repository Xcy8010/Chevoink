// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { formatModelPrice, modelPriceOptionText } from '../../shared/model-price-format'
import { ModelPriceDetails, ModelPriceSummary } from '../../src/features/studio/components/ModelPriceDetails'
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const model = { tier: 'speed' as const, label: '浮层模型', multiplier: 0.125, baseMultiplier: 1, available: true, selectedByDefault: false,
  reasoningEfforts: ['high' as const], defaultReasoningEffort: 'high' as const, visionEnabled: false }
const card = () => screen.getByLabelText('浮层模型模型卡片')
it('shows precise public details on the original whole row hover and focus without an info control', () => {
  vi.useFakeTimers()
  const select = vi.fn()
  render(<ModelPriceDetails model={{ ...model, baseMultiplier: 1.5, discountRatio: 1 / 12, publicDescription: '适合构思', publicFeatures: ['长篇'],
    activity: { name: '夜间活动', revision: 1, timezone: 'Asia/Shanghai', asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] },
    reasoningEfforts: ['low', 'high'], visionEnabled: true,
    basePricing: {inputPerMillion:110,cachePerMillion:27.5,outputPerMillion:1100},
    pricing: {version:'credits-v2-itemized',rateCardId:'fixture-price',inputPerMillion:110,cachePerMillion:27.5,outputPerMillion:1100} }}><button onClick={select}>选择模型</button></ModelPriceDetails>)
  expect(card().querySelector('svg, summary')).toBeNull()
  expect(formatModelPrice(0.125)).toBe('0.125')
  fireEvent.mouseEnter(card()); expect(screen.getByRole('tooltip')).toBeTruthy()
  expect(screen.getByText('1.5x', { selector: 's' })).toBeTruthy()
  expect(screen.getByText('0.125x')).toBeTruthy()
  expect(screen.getAllByText(/夜间活动/).length).toBeGreaterThan(0)
  expect(screen.getByText('适合构思')).toBeTruthy()
  expect(screen.getByText(/思考强度：low、high/)).toBeTruthy()
  expect(screen.getByRole('tooltip').textContent).not.toMatch(/基础价格|当前价格|当前计价|图片输入|百万 Token|fixture-price/)
  fireEvent.mouseLeave(card()); act(() => vi.advanceTimersByTime(160)); expect(screen.queryByRole('tooltip')).toBeNull()
  act(() => screen.getByRole('button', { name: '选择模型' }).focus()); expect(screen.getByRole('tooltip')).toBeTruthy()
  fireEvent.blur(card(), { relatedTarget: null }); expect(screen.queryByRole('tooltip')).toBeNull()
  expect(select).not.toHaveBeenCalled()
})
it('keeps precise free activity and legacy free promotion labels', () => {
  const free = { ...model, label: '免费模型', multiplier: 0, baseMultiplier: 1.5,
    activity: { name: '周末免费', revision: 2, timezone: 'Asia/Shanghai' as const, asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] } }
  render(<ModelPriceSummary model={free} />)
  expect(screen.getByText('周末免费')).toBeTruthy(); expect(screen.getByText('1.5x', { selector: 's' })).toBeTruthy(); expect(screen.getByText('0x')).toBeTruthy()
  expect(modelPriceOptionText(free)).toBe('周末免费 · 原1.5x → 免费')
  expect(modelPriceOptionText({ ...free, activity: null, freePromotion: { endsAt: '2026-11-07T00:00:00Z', afterMultiplier: 1.5 } })).toBe('限时免费')
})
it.each([{ width: 1440, height: 1000, left: 850, top: 715, rowWidth: 226 }, { width: 390, height: 844, left: 12, top: 526.67, rowWidth: 366 }])(
  'keeps the row detail inside the viewport at $width by $height', ({ width, height, left, top, rowWidth }) => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left, right: left + rowWidth, top, bottom: top + 40, width: rowWidth, height: 40 } as DOMRect)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(318)
    render(<ModelPriceDetails model={model} />); fireEvent.mouseEnter(card())
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.parentElement).toBe(document.body); expect(tooltip.style.position).toBe('fixed')
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(tooltip.style.top) + Math.min(320, height - 16)).toBeLessThanOrEqual(height - 8)
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(tooltip.style.left) + Number.parseFloat(tooltip.style.width)).toBeLessThanOrEqual(width - 8)
    if (width === 390) expect(Number.parseFloat(tooltip.style.top) + Number.parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(top - 10)
  })
it('keeps native-dialog details in the top layer and clamps a short viewport on resize', () => {
  vi.stubGlobal('innerWidth', 320); vi.stubGlobal('innerHeight', 240)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 280, right: 312, top: 100, bottom: 132, width: 32, height: 32 } as DOMRect)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(318)
  render(<dialog open aria-label="移动模型"><ModelPriceDetails model={model} /></dialog>); fireEvent.mouseEnter(card())
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.parentElement).toBe(screen.getByRole('dialog', { name: '移动模型' }))
  expect(Number.parseFloat(tooltip.style.top) + Number.parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(232)
  fireEvent.resize(window); expect(screen.getByRole('tooltip')).toBeTruthy()
})
it('keeps hover and focus across the portal, then Escape returns focus without selecting', () => {
  vi.useFakeTimers(); const select = vi.fn()
  render(<div onClick={select}><ModelPriceDetails model={model} /></div>); fireEvent.mouseEnter(card())
  const tooltip = screen.getByRole('tooltip')
  fireEvent.mouseLeave(card(), { relatedTarget: tooltip }); fireEvent.mouseEnter(tooltip); act(() => vi.advanceTimersByTime(160))
  expect(screen.getByRole('tooltip')).toBeTruthy(); fireEvent.click(tooltip); expect(select).not.toHaveBeenCalled()
  act(() => tooltip.focus()); fireEvent.blur(card(), { relatedTarget: tooltip }); expect(screen.getByRole('tooltip')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('tooltip')).toBeNull(); expect(document.activeElement).toBe(card())
})
it('selects the row on the first real mouse click and leaves reasoning edit independent', async () => {
  const user = userEvent.setup(), selected = vi.fn(), edit = vi.fn()
  render(<dialog open><ModelPriceDetails model={model}><button onClick={selected}>选择模型</button><button onClick={edit}>编辑思考强度</button></ModelPriceDetails></dialog>)
  await user.hover(screen.getByRole('button', { name: '选择模型' })); expect(screen.getByRole('tooltip').closest('dialog')).toBe(screen.getByRole('dialog'))
  await user.click(screen.getByRole('button', { name: '选择模型' })); expect(selected).toHaveBeenCalledOnce(); expect(screen.queryByRole('tooltip')).toBeNull()
  await user.click(screen.getByRole('button', { name: '编辑思考强度' })); expect(edit).toHaveBeenCalledOnce(); expect(selected).toHaveBeenCalledOnce()
})
it('selects with one touch tap without a details icon intercepting it', async () => {
  const user = userEvent.setup(), selected = vi.fn()
  render(<dialog open><ModelPriceDetails model={model}><button onClick={selected}>选择模型</button></ModelPriceDetails></dialog>)
  const button = screen.getByRole('button', { name: '选择模型' })
  await user.pointer([{ keys: '[TouchA>]', target: button }, { keys: '[/TouchA]', target: button }])
  expect(selected).toHaveBeenCalledOnce(); expect(screen.queryByRole('tooltip')).toBeNull()
})
it('supports keyboard preview, Escape, outside dismissal and reopening by hover', async () => {
  const user = userEvent.setup()
  render(<><ModelPriceDetails model={model} /><button>外部</button></>); await user.tab()
  expect(document.activeElement).toBe(card()); expect(screen.getByRole('tooltip')).toBeTruthy()
  await user.keyboard('{Escape}'); expect(screen.queryByRole('tooltip')).toBeNull(); expect(document.activeElement).toBe(card())
  await user.hover(card()); expect(screen.getByRole('tooltip')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '外部' })); expect(screen.queryByRole('tooltip')).toBeNull()
  await user.hover(card()); expect(screen.getByRole('tooltip')).toBeTruthy()
})
