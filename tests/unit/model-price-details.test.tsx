// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { formatModelPrice, modelPriceOptionText } from '../../shared/model-price-format'
import { ModelPriceDetails, ModelPriceSummary } from '../../src/features/studio/components/ModelPriceDetails'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows precise public prices and opens independent details by hover, focus and click', () => {
  vi.useFakeTimers()
  const select = vi.fn()
  render(<div onClick={select}><ModelPriceDetails model={{ tier: 'speed', label: '轻盈', multiplier: 0.125, baseMultiplier: 1.5, discountRatio: 1 / 12, publicDescription: '适合构思', publicFeatures: ['长篇'],
    activity: { name: '夜间活动', revision: 1, timezone: 'Asia/Shanghai', asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] },
    available: true, selectedByDefault: false, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', visionEnabled: true }} /></div>)
  const summary = screen.getByLabelText('轻盈价格与能力详情'), details = summary.closest('details')!
  expect(formatModelPrice(0.125)).toBe('0.125')
  fireEvent.mouseEnter(details); expect(details.open).toBe(true)
  fireEvent.mouseLeave(details); act(() => vi.advanceTimersByTime(160)); expect(details.open).toBe(false)
  fireEvent.focus(summary); expect(details.open).toBe(true)
  fireEvent.blur(details, { relatedTarget: null }); expect(details.open).toBe(false)
  fireEvent.click(summary); expect(details.open).toBe(true)
  expect(select).not.toHaveBeenCalled()
  expect(screen.getByText('1.5x', { selector: 's' })).toBeTruthy()
  expect(screen.getByText('0.125x')).toBeTruthy()
  expect(screen.getAllByText(/夜间活动/).length).toBeGreaterThan(0)
  expect(screen.getByText('适合构思')).toBeTruthy()
  expect(screen.getByText(/思考强度：low、high/)).toBeTruthy()
})

it('keeps precise free activity and legacy free promotion labels', () => {
  const model = { tier: 'speed' as const, label: '免费模型', multiplier: 0, baseMultiplier: 1.5, available: true, selectedByDefault: false,
    reasoningEfforts: ['high' as const], defaultReasoningEffort: 'high' as const, visionEnabled: false,
    activity: { name: '周末免费', revision: 2, timezone: 'Asia/Shanghai' as const, asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] } }
  render(<ModelPriceSummary model={model} />)
  expect(screen.getByText('周末免费')).toBeTruthy()
  expect(screen.getByText('1.5x', { selector: 's' })).toBeTruthy()
  expect(screen.getByText('0x')).toBeTruthy()
  expect(modelPriceOptionText(model)).toBe('周末免费 · 原1.5x → 免费')
  expect(modelPriceOptionText({ ...model, activity: null, freePromotion: { endsAt: '2026-11-07T00:00:00Z', afterMultiplier: 1.5 } })).toBe('限时免费')
})

const floatingModel = { tier: 'speed' as const, label: '浮层模型', multiplier: 0.125, baseMultiplier: 1, available: true, selectedByDefault: false,
  reasoningEfforts: ['high' as const], defaultReasoningEffort: 'high' as const, visionEnabled: false }
it.each([{ width: 1440, height: 1000, left: 850, top: 715 }, { width: 390, height: 844, left: 346, top: 526.67 }])(
  'fits a full-height price detail above the observed bottom anchor at $width by $height', ({ width, height, left, top }) => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left, right: left + 32, top, bottom: top + 32, width: 32, height: 32 } as DOMRect)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(318)
    render(<ModelPriceDetails model={floatingModel} />)
    fireEvent.mouseEnter(screen.getByLabelText('浮层模型价格与能力详情').closest('details')!)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.style.position || getComputedStyle(tooltip).position).toBe('fixed')
    expect(tooltip.style.transform).toBe('translateY(-100%)')
    expect(Number.parseFloat(tooltip.style.top) - Number.parseFloat(tooltip.style.maxHeight)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(tooltip.style.top)).toBeLessThanOrEqual(height - 8)
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(tooltip.style.left) + Number.parseFloat(tooltip.style.width)).toBeLessThanOrEqual(width - 8)
  })
it('keeps a native-dialog tooltip inside the top layer and limits it when both sides are short', () => {
  vi.stubGlobal('innerWidth', 320); vi.stubGlobal('innerHeight', 240)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 280, right: 312, top: 100, bottom: 132, width: 32, height: 32 } as DOMRect)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(318)
  render(<dialog open aria-label="移动模型"><ModelPriceDetails model={floatingModel} /></dialog>)
  const summary = screen.getByLabelText('浮层模型价格与能力详情')
  fireEvent.click(summary)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.parentElement).toBe(screen.getByRole('dialog', { name: '移动模型' }))
  expect(Number.parseFloat(tooltip.style.top) + Number.parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(232)
  fireEvent.resize(window)
  expect(summary.closest('details')!.open).toBe(true)
})
it('keeps hover and keyboard focus across the portal without selecting its owner', () => {
  vi.useFakeTimers()
  const select = vi.fn()
  render(<div onClick={select}><ModelPriceDetails model={floatingModel} /></div>)
  const summary = screen.getByLabelText('浮层模型价格与能力详情'), details = summary.closest('details')!
  fireEvent.mouseEnter(details)
  const tooltip = screen.getByRole('tooltip')
  fireEvent.mouseLeave(details, { relatedTarget: tooltip })
  fireEvent.mouseEnter(tooltip)
  act(() => vi.advanceTimersByTime(160))
  expect(details.open).toBe(true)
  fireEvent.click(tooltip)
  expect(select).not.toHaveBeenCalled()
  fireEvent.focus(tooltip)
  fireEvent.blur(details, { relatedTarget: tooltip })
  expect(details.open).toBe(true)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(summary)
})

it('keeps the first real mouse click open after hover and focus inside a native dialog', async () => {
  const user = userEvent.setup(), selected = vi.fn()
  render(<dialog open><div onClick={selected}><ModelPriceDetails model={floatingModel} /></div></dialog>)
  const summary = screen.getByLabelText('浮层模型价格与能力详情')
  const order: string[] = []
  for (const type of ['mouseover', 'focus', 'click']) summary.addEventListener(type, () => order.push(type))
  await user.click(summary)
  expect(order).toEqual(['mouseover', 'focus', 'click'])
  expect(screen.getByRole('tooltip').closest('dialog')).toBe(screen.getByRole('dialog'))
  expect(summary.getAttribute('aria-expanded')).toBe('true')
  expect(selected).not.toHaveBeenCalled()
  await user.click(summary)
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(selected).not.toHaveBeenCalled()
})

it('opens and closes native-dialog details with real touch taps without selecting the model', async () => {
  const user = userEvent.setup(), selected = vi.fn()
  render(<dialog open><div onClick={selected}><ModelPriceDetails model={floatingModel} /></div></dialog>)
  const summary = screen.getByLabelText('浮层模型价格与能力详情')
  const tap = async () => { await user.pointer([{ keys: '[TouchA>]', target: summary }, { keys: '[/TouchA]', target: summary }]) }
  await tap()
  expect(screen.getByRole('tooltip').closest('dialog')).toBe(screen.getByRole('dialog'))
  expect(selected).not.toHaveBeenCalled()
  await tap()
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(selected).not.toHaveBeenCalled()
})
it('keeps keyboard focus preview and Escape while outside dismissal resets the next explicit click', async () => {
  const user = userEvent.setup()
  render(<><ModelPriceDetails model={floatingModel} /><button type="button">外部</button></>)
  const summary = screen.getByLabelText('浮层模型价格与能力详情')
  await user.tab()
  expect(document.activeElement).toBe(summary)
  expect(screen.getByRole('tooltip')).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(document.activeElement).toBe(summary)
  await user.click(summary)
  expect(screen.getByRole('tooltip')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '外部' }))
  expect(screen.queryByRole('tooltip')).toBeNull()
  await user.click(summary)
  expect(screen.getByRole('tooltip')).toBeTruthy()
})
