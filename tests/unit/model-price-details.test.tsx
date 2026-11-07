// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { CreditModelOption } from '../../shared/contracts/credits'
import { formatModelPrice, modelPriceOptionText } from '../../shared/model-price-format'
import { ModelActivityBadge, ModelPriceDetails, ModelPriceSummary } from '../../src/features/studio/components/ModelPriceDetails'
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const model = { tier: 'speed' as const, label: '浮层模型', multiplier: 0.125, baseMultiplier: 1, available: true, selectedByDefault: false,
  reasoningEfforts: ['high' as const], defaultReasoningEffort: 'high' as const, visionEnabled: false }
const details = () => screen.getByRole('dialog', { name: '浮层模型模型详情' })
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
  fireEvent.mouseEnter(card()); expect(details()).toBeTruthy()
  expect(screen.getByText('1.5x').tagName).toBe('DEL')
  expect(screen.getByText('0.125x')).toBeTruthy()
  expect(screen.getAllByText(/夜间活动/).length).toBeGreaterThan(0)
  expect(screen.getByText('适合构思')).toBeTruthy()
  expect(screen.getByText('思考强度')).toBeTruthy(); expect(screen.getByText('高')).toBeTruthy()
  expect(details().textContent).not.toMatch(/基础价格|当前价格|当前计价|图片输入|百万 Token|fixture-price/)
  fireEvent.mouseLeave(card()); act(() => vi.advanceTimersByTime(160)); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull()
  act(() => screen.getByRole('button', { name: '选择模型' }).focus()); expect(details()).toBeTruthy()
  fireEvent.blur(card(), { relatedTarget: null }); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull()
  expect(select).not.toHaveBeenCalled()
})
it('keeps precise free activity and legacy free promotion labels', () => {
  const free = { ...model, label: '免费模型', multiplier: 0, baseMultiplier: 1.5,
    activity: { name: '周末免费', revision: 2, timezone: 'Asia/Shanghai' as const, asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] } }
  render(<><ModelPriceSummary model={free} /><ModelActivityBadge model={free} /></>)
  expect(screen.getByText('周末免费')).toBeTruthy(); expect(screen.getByText('1.5x').tagName).toBe('DEL'); expect(screen.getByText('0x')).toBeTruthy()
  expect(modelPriceOptionText(free)).toBe('周末免费 · 原1.5x → 免费')
  expect(modelPriceOptionText({ ...free, activity: null, freePromotion: { endsAt: '2026-11-07T00:00:00Z', afterMultiplier: 1.5 } })).toBe('限时免费')
})
it.each([
  { label: '免费', freePromotion: null },
  { label: '限时免费', freePromotion: { endsAt: '2026-11-07T00:00:00Z', afterMultiplier: 1.5 } },
])('uses the original red badge for $label', ({ label, freePromotion }) => {
  render(<ModelActivityBadge model={{ ...model, multiplier: 0, freePromotion }} />)
  expect(screen.getByText(label).classList.contains('bg-red-500/10')).toBe(true)
  expect(screen.getByText(label).classList.contains('text-[var(--color-error)]')).toBe(true)
})
it('advertises a scheduled night discount in daylight while keeping the current multiplier', () => {
  const rule = { name: '夜间折扣', enabled: true, startDate: null, endDate: '2026-11-08',
    weekdays: [0, 1, 2, 3, 4, 5, 6], allDay: false, startTime: '22:00', endTime: '08:00', multiplierBps: 9000 }
  const activity = { name: null, revision: 1, timezone: 'Asia/Shanghai' as const, asOf: '2026-11-07T04:00:00Z',
    nextSwitchAt: '2026-11-07T14:00:00Z', rules: [rule] }
  const daytime = { ...model, multiplier: 1.8, baseMultiplier: 1.8, activity }
  const row = (option: CreditModelOption) =>
    <><ModelActivityBadge model={option} /><ModelPriceSummary model={option} /></>
  const view = render(row(daytime))
  expect(screen.getByText(rule.name).getAttribute('title')).toBe('仅在设定时段生效')
  expect(screen.getByText('1.8x').tagName).toBe('SPAN')
  expect(view.container.querySelector('del')).toBeNull()

  view.rerender(row({ ...daytime, multiplier: 0.9, activity: { ...activity, name: rule.name, asOf: '2026-11-07T14:00:00Z' } }))
  expect(screen.getByText(rule.name).getAttribute('title')).toBeNull()
  expect(screen.getByText('1.8x').tagName).toBe('DEL')
  expect(screen.getByText('0.9x')).toBeTruthy()

  view.rerender(row({ ...daytime, activity: { ...activity, rules: [{ ...rule, enabled: false }] } }))
  expect(screen.queryByText(rule.name)).toBeNull()
  view.rerender(row({ ...daytime, activity: { ...activity, asOf: '2026-11-07T16:00:00Z' } }))
  expect(screen.queryByText(rule.name)).toBeNull()
})
it('shows the real original multiplier before the discounted value in the row and the detail card', () => {
  render(<ModelPriceDetails model={{ ...model, baseMultiplier: 1.8, multiplier: 0.9 }} />)
  expect(card().querySelector('del')?.textContent).toBe('1.8x')
  expect(card().textContent).toContain('0.9x')
  fireEvent.mouseEnter(card())
  expect(details().querySelector('del')?.textContent).toBe('1.8x')
  expect(details().textContent).toContain('0.9x')
})
it.each([{ baseMultiplier: undefined, multiplier: 0.9 }, { baseMultiplier: 0.9, multiplier: 0.9 }, { baseMultiplier: 0.9, multiplier: 1.8 }])(
  'does not invent an original discount for $baseMultiplier to $multiplier', values => {
    const view = render(<ModelPriceSummary model={{ ...model, ...values }} />)
    expect(view.container.querySelector('del')).toBeNull()
    expect(view.container.textContent).toBe(formatModelPrice(values.multiplier) + 'x')
  })
it.each([{ width: 1440, height: 1000, left: 850, top: 715, rowWidth: 226 }, { width: 390, height: 844, left: 12, top: 526.67, rowWidth: 366 }])(
  'keeps the row detail inside the viewport at $width by $height', ({ width, height, left, top, rowWidth }) => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left, right: left + rowWidth, top, bottom: top + 40, width: rowWidth, height: 40 } as DOMRect)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(318)
    render(<ModelPriceDetails model={model} />); fireEvent.mouseEnter(card())
    const tooltip = details()
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
  const tooltip = details()
  expect(tooltip.parentElement).toBe(screen.getByRole('dialog', { name: '移动模型' }))
  expect(Number.parseFloat(tooltip.style.top) + Number.parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(232)
  fireEvent.resize(window); expect(details()).toBeTruthy()
})
it('keeps hover and focus across the portal, then Escape returns focus without selecting', () => {
  vi.useFakeTimers(); const select = vi.fn()
  render(<div onClick={select}><ModelPriceDetails model={model} /></div>); fireEvent.mouseEnter(card())
  const tooltip = details()
  fireEvent.mouseLeave(card(), { relatedTarget: tooltip }); fireEvent.mouseEnter(tooltip); act(() => vi.advanceTimersByTime(160))
  expect(details()).toBeTruthy(); fireEvent.click(tooltip); expect(select).not.toHaveBeenCalled()
  act(() => tooltip.focus()); fireEvent.blur(card(), { relatedTarget: tooltip }); expect(details()).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull(); expect(document.activeElement).toBe(card())
})
it('edits readable thinking inside the card without reserving a second row button or selecting the model', async () => {
  const user = userEvent.setup(), selected = vi.fn(), edit = vi.fn()
  render(<dialog open aria-label="模型设置"><ModelPriceDetails model={{ ...model, reasoningEfforts: ['low', 'high'] }} onReasoningChange={edit}><button onClick={selected}>选择模型</button></ModelPriceDetails></dialog>)
  expect(card().querySelectorAll('button')).toHaveLength(1)
  await user.hover(screen.getByRole('button', { name: '选择模型' }))
  expect(details().closest('dialog')).toBe(screen.getByRole('dialog', { name: '模型设置' }))
  await user.click(screen.getByRole('button', { name: '编辑浮层模型思考模式' }))
  expect(screen.getByRole('button', { name: '设置浮层模型思考强度为高' }).getAttribute('aria-pressed')).toBe('true')
  await user.click(screen.getByRole('button', { name: '设置浮层模型思考强度为低' }))
  expect(edit).toHaveBeenCalledExactlyOnceWith('low'); expect(selected).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '选择模型' }))
  expect(selected).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull()
})
it('selects with one touch tap without a details icon intercepting it', async () => {
  const user = userEvent.setup(), selected = vi.fn()
  render(<dialog open><ModelPriceDetails model={model}><button onClick={selected}>选择模型</button></ModelPriceDetails></dialog>)
  const button = screen.getByRole('button', { name: '选择模型' })
  await user.pointer([{ keys: '[TouchA>]', target: button }, { keys: '[/TouchA]', target: button }])
  expect(selected).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull()
})
it('supports keyboard preview, Escape, outside dismissal and reopening by hover', async () => {
  const user = userEvent.setup()
  render(<><ModelPriceDetails model={model} /><button>外部</button></>); await user.tab()
  expect(document.activeElement).toBe(card()); expect(details()).toBeTruthy()
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull(); expect(document.activeElement).toBe(card())
  await user.hover(card()); expect(details()).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '外部' })); expect(screen.queryByRole('dialog', { name: '浮层模型模型详情' })).toBeNull()
  await user.hover(card()); expect(details()).toBeTruthy()
})
it('switches rapid row hovers immediately even when the previous model still owns keyboard focus', () => {
  vi.useFakeTimers()
  render(<>{['甲', '乙', '丙'].map(label => <ModelPriceDetails key={label} model={{ ...model, label }}><button>{label}</button></ModelPriceDetails>)}</>)
  act(() => screen.getByRole('button', { name: '甲', exact: true }).focus())
  let previous = screen.getByLabelText('甲模型卡片')
  for (const label of ['乙', '丙', '甲', '丙', '乙']) {
    const next = screen.getByLabelText(label + '模型卡片')
    fireEvent.mouseLeave(previous, { relatedTarget: next })
    fireEvent.mouseEnter(next)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: label + '模型详情' })).toBeTruthy()
    previous = next
  }
  act(() => vi.advanceTimersByTime(160))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('dialog', { name: '乙模型详情' })).toBeTruthy()
})
it('releases the active popup when its model is removed and lets another catalog open normally', () => {
  const view = render(<ModelPriceDetails model={model} />)
  fireEvent.mouseEnter(card())
  view.unmount()
  expect(screen.queryByRole('dialog')).toBeNull()
  render(<ModelPriceDetails model={{ ...model, label: '另一个模型' }} />)
  fireEvent.mouseEnter(screen.getByLabelText('另一个模型模型卡片'))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('dialog', { name: '另一个模型模型详情' })).toBeTruthy()
})
