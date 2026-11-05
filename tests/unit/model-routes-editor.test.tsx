// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelRoutesEditor } from '../../src/features/admin/components/ModelRoutesEditor'
afterEach(cleanup)
const defaults = { provider: 'openai-compatible', modelName: 'model-a', baseUrl: 'https://example.test/v1' }
it('edits image fallback accounts without text capabilities or copying credentials', () => {
  const onChange = vi.fn()
  const route = { ...defaults, label: '备用生图', enabled: true }
  render(<ModelRoutesEditor imageGeneration routes={[route]} onChange={onChange} defaults={{ ...defaults, contextWindowTokens: '128000', reasoningEfforts: ['high'], visionEnabled: true }} />)
  expect(screen.getByText('图片生成备用线路')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '编辑线路 1' }))
  expect(screen.queryByLabelText('线路上下文窗口')).toBeNull()
  expect(screen.queryByText('线路推理强度')).toBeNull()
  expect(screen.queryByLabelText('支持 OpenAI 兼容图片输入')).toBeNull()
  expect(screen.getByLabelText('API Key')).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('button', { name: '添加供应商线路' }))
  expect(onChange).toHaveBeenLastCalledWith([route, { ...defaults, label: '线路 2', enabled: true }])
})
it('adds a separate account without copying a credential', () => {
  const onChange = vi.fn()
  render(<ModelRoutesEditor routes={[]} onChange={onChange} defaults={defaults} />)
  fireEvent.click(screen.getByRole('button', { name: '添加供应商线路' }))
  expect(onChange).toHaveBeenCalledWith([{ ...defaults, label: '线路 1', enabled: true }])
})
it('keeps existing route identity and changes only the selected setting', () => {
  const onChange = vi.fn()
  const route = { ...defaults, id: '6a18e83b-4c75-422d-8173-3e524fb64892', label: '备用账号', enabled: true }
  render(<ModelRoutesEditor routes={[route]} onChange={onChange} defaults={defaults} />)
  expect(screen.queryByLabelText('API Key')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '编辑线路 1' }))
  expect(screen.getByLabelText('API Key')).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('checkbox', { name: '启用' }))
  expect(onChange).toHaveBeenCalledWith([{ ...route, enabled: false }])
  fireEvent.click(screen.getByRole('button', { name: '移除线路' }))
  expect(onChange).toHaveBeenLastCalledWith([])
})
