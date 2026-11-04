// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import TrendLineChart from '../../src/features/admin/components/TrendLineChart'
afterEach(cleanup)
it('shows a truthful empty state and renders single zero samples without invalid geometry', () => {
  const view = render(<TrendLineChart labels={[]} values={[]} />)
  expect(screen.getByText('暂无趋势数据')).toBeTruthy()
  view.rerender(<TrendLineChart labels={['12:00']} values={[0]} label="新增用户" />)
  expect(view.container.querySelector('circle')).toBeTruthy()
  expect(view.container.innerHTML).not.toMatch(/NaN|Infinity/)
  fireEvent.focus(screen.getByRole('group', { name:'新增用户' }))
  expect(screen.getByRole('status').textContent).toContain('12:00')
  expect(screen.getByRole('status').textContent).toContain('0')
})
it('exposes precise multi-series values via keyboard without SVG text stretching', () => {
  const { container } = render(<TrendLineChart labels={['10:00','11:00','12:00']} label="用量" series={[{label:'输入',values:[0,400,200]},{label:'输出',values:[0,100,50]}]} />)
  const chart=screen.getByRole('group', {name:'用量'})
  fireEvent.focus(chart)
  fireEvent.keyDown(chart,{key:'ArrowRight'})
  expect(screen.getByRole('status').textContent).toContain('11:00')
  expect(screen.getByRole('status').textContent).toContain('400')
  expect(screen.getByRole('status').textContent).toContain('100')
  fireEvent.keyDown(chart,{key:'End'})
  expect(screen.getByRole('status').textContent).toContain('12:00')
  fireEvent.keyDown(chart,{key:'Home'})
  expect(screen.getByRole('status').textContent).toContain('10:00')
  fireEvent.keyDown(chart,{key:'Escape'})
  expect(screen.queryByRole('status')).toBeNull()
  expect(container.querySelector('svg text')).toBeNull()
})
