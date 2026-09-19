// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelRoutesEditor } from '../../src/features/admin/components/ModelRoutesEditor'
afterEach(cleanup)
const defaults = { provider: 'openai-compatible', modelName: 'model-a', baseUrl: 'https://example.test/v1' }
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
  expect(screen.getByLabelText('API Key')).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('checkbox', { name: '启用' }))
  expect(onChange).toHaveBeenCalledWith([{ ...route, enabled: false }])
  fireEvent.click(screen.getByRole('button', { name: '移除线路' }))
  expect(onChange).toHaveBeenLastCalledWith([])
})
