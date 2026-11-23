// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MemoryGraph from '../../src/features/studio/components/MemoryGraph'
import { ApiClientError } from '../../src/app/api-client'
import { getNovelMemoryGraph } from '../../src/features/studio/api'
import { memoryGraphFixture } from '../fixtures/memory-graph'

vi.mock('../../src/features/studio/api', () => ({ getNovelMemoryGraph: vi.fn(), syncNovelMemoryGraph: vi.fn(), getMemoryGraphJob: vi.fn() }))
const renderer = vi.hoisted(() => ({ caches: new Set<object>(), fail: false }))
vi.mock('../../src/features/studio/components/MemoryGraphCanvas', () => ({
  default: ({ layoutCache }: { layoutCache: object }) => {
    if (renderer.fail) throw new Error('Canvas unavailable')
    renderer.caches.add(layoutCache)
    return <div>画布</div>
  },
}))
afterEach(() => { cleanup(); renderer.caches.clear(); renderer.fail = false; vi.restoreAllMocks(); vi.resetAllMocks() })

it('后台失败或实体描述更新仍保留同一画布与布局缓存，失去读取权限则收起', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = ['studio', memoryGraphFixture.novelId, 'memory-graph']
  vi.mocked(getNovelMemoryGraph).mockResolvedValueOnce(memoryGraphFixture)
  const refresh = async () => {
    await act(async () => { await client.refetchQueries({ queryKey: key }) })
  }
  render(<QueryClientProvider client={client}><MemoryGraph novelId={memoryGraphFixture.novelId} /></QueryClientProvider>)
  const canvas = await screen.findByText('画布')
  vi.mocked(getNovelMemoryGraph).mockRejectedValueOnce(new Error('offline'))
  await refresh()
  expect(screen.getByText('画布')).toBe(canvas)
  vi.mocked(getNovelMemoryGraph).mockResolvedValueOnce({
    ...memoryGraphFixture, nodes: memoryGraphFixture.nodes.map(node => ({ ...node, description: '新描述' })),
  })
  await refresh()
  expect(screen.getByText('画布')).toBe(canvas)
  expect(renderer.caches.size).toBe(1)
  vi.mocked(getNovelMemoryGraph).mockRejectedValueOnce(new ApiClientError('forbidden', 403))
  await refresh()
  await waitFor(() => expect(screen.queryByText('画布')).toBeNull())
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
  vi.mocked(getNovelMemoryGraph).mockRejectedValueOnce(new ApiClientError('offline', 503))
  await refresh()
  expect(client.getQueryData(key)).toBeNull()
  expect(screen.queryByText('画布')).toBeNull()
  vi.mocked(getNovelMemoryGraph).mockResolvedValueOnce(memoryGraphFixture)
  await refresh()
  expect(await screen.findByText('画布')).toBeTruthy()
  client.clear()
})

it('画布绘制异常后保留工作区，可单独重新打开画布', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const client = new QueryClient()
  vi.mocked(getNovelMemoryGraph).mockResolvedValue(memoryGraphFixture)
  renderer.fail = true
  render(<QueryClientProvider client={client}><textarea defaultValue="测试草稿" /><MemoryGraph novelId={memoryGraphFixture.novelId} /></QueryClientProvider>)
  const draft = screen.getByRole('textbox')
  const retry = await screen.findByRole('button', { name: '重新打开画布' })
  renderer.fail = false
  fireEvent.click(retry)
  expect(await screen.findByText('画布')).toBeTruthy()
  expect(screen.getByRole('textbox')).toBe(draft)
  client.clear()
})
