// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AgentMobileModelSheet } from '../../src/features/studio/agent/components/AgentMobileModelSheet'

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeEach(() => {
  vi.stubGlobal('innerWidth', 320)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShow)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

function setup() {
  const callbacks = { onTier: vi.fn(), onCustom: vi.fn(), onReasoning: vi.fn(), onSettings: vi.fn(), onClose: vi.fn() }
  const view = render(<AgentMobileModelSheet {...callbacks} modelOptions={[
    { tier: 'speed', label: '极速', available: true, multiplier: 1, selectedByDefault: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', visionEnabled: true },
    { tier: 'standard', label: '标准', available: true, multiplier: 2, selectedByDefault: false, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', visionEnabled: false },
    { tier: 'basic', label: '不可用', available: false, multiplier: 0, selectedByDefault: false, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', visionEnabled: false },
  ]} customModels={[]} customModelId={null} modelTier="speed" activeModelLabel="极速" activeReasoningEffort="high" activeReasoningEfforts={['low', 'high']} />)
  return { ...callbacks, ...view }
}

it('exposes selected model/effort and real callbacks with a single modal surface', () => {
  const view = setup()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('button', { name: /极速\s*1x/ }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByText('不可用')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /标准\s*2x/ }))
  expect(view.onTier).toHaveBeenCalledWith('standard')
  fireEvent.change(screen.getByRole('slider', { name: '调整当前模型推理强度' }), { target: { value: '0' } })
  expect(view.onReasoning).toHaveBeenCalledWith('low')
  fireEvent.click(screen.getByRole('button', { name: '完成' }))
  expect(view.onClose).toHaveBeenCalledOnce()
})

it('locks background scrolling and restores it and focus when closed', () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const view = setup()
  expect(document.body.style.overflow).toBe('hidden')
  expect(screen.getByRole('dialog').style.maxHeight).toBe(`${window.innerHeight - 16}px`)
  view.unmount()
  expect(document.body.style.overflow).toBe('')
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

it('shows whole-card details at narrow width and selects with one touch tap without intercepting thinking', async () => {
  const user = userEvent.setup()
  const onTier = vi.fn(), onReasoning = vi.fn()
  render(<AgentMobileModelSheet modelOptions={[{ tier: 'speed', label: '极速', available: true, multiplier: 0.125, baseMultiplier: 1.5,
    selectedByDefault: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', visionEnabled: true,
    activity: { name: '晚间优惠', revision: 1, timezone: 'Asia/Shanghai', asOf: '2026-11-06T12:00:00Z', nextSwitchAt: null, rules: [] } }]}
    customModels={[{ id: 'mine', displayName: '我的模型', enabled: true, provider: 'owned', modelName: 'owned-model', baseUrl: 'https://owned.invalid/v1', apiKeyConfigured: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', visionEnabled: false, contextWindowTokens: null, createdAt: '', updatedAt: '' }]} customModelId={null} modelTier="speed" activeModelLabel="极速"
    activeReasoningEffort="high" activeReasoningEfforts={['low', 'high']} onTier={onTier} onCustom={vi.fn()} onReasoning={onReasoning} onSettings={vi.fn()} onClose={vi.fn()} />)
  const row = screen.getByRole('button', { name: /极速.*晚间优惠.*0.125x/ })
  expect(row.querySelector('s')).toBeNull()
  expect(screen.queryByLabelText('极速价格与能力详情')).toBeNull()
  await user.hover(row)
  expect(screen.getByRole('dialog', { name: '极速模型详情' }).closest('dialog')).toBe(screen.getByRole('dialog', { name: '模型与思考设置' }))
  expect(screen.getByRole('dialog', { name: '极速模型详情' }).textContent).toMatch(/思考强度\s*高/)
  expect(screen.getByRole('dialog', { name: '极速模型详情' }).textContent).not.toContain('图片输入')
  expect(screen.getByRole('dialog', { name: '极速模型详情' }).textContent).not.toContain('基础价格')
  expect(screen.getByRole('dialog', { name: '极速模型详情' }).textContent).not.toContain('当前价格')
  expect(screen.getByRole('dialog', { name: '极速模型详情' }).textContent).not.toContain('当前计价')
  expect(onTier).not.toHaveBeenCalled()
  expect(onReasoning).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /我的模型.*自有密钥/ })).toBeTruthy()
  fireEvent.change(screen.getByRole('slider', { name: '调整当前模型推理强度' }), { target: { value: '0' } })
  expect(onReasoning).toHaveBeenCalledWith('low')
  await user.pointer([{ keys: '[TouchA>]', target: row }, { keys: '[/TouchA]', target: row }])
  expect(onTier).toHaveBeenCalledExactlyOnceWith('speed')
  expect(onReasoning).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog', { name: '极速模型详情' })).toBeNull()
})
