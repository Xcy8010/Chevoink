import { afterEach, expect, it, vi } from 'vitest'
import { fetchStoryMemorySets } from '../../src/features/studio/agent/agentApi'

afterEach(() => vi.unstubAllGlobals())
const catalog = () => Response.json({ success: true, data: { sets: [] } })

it('opens the catalog and materializes recognized graph profiles with its authenticated POST', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(catalog())
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchStoryMemorySets('n')).resolves.toEqual({ sets: [] })
  expect(fetcher).toHaveBeenCalledWith('/api/agent/novels/n/memory-sets', expect.objectContaining({ credentials: 'include', method: 'POST' }))
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([404, 405])('opens the read-only catalog on an older API that lacks the materialization route (%s)', async status => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: false, error: { code: 'NOT_FOUND', message: '旧接口' } }, { status }))
    .mockResolvedValueOnce(catalog())
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchStoryMemorySets('n')).resolves.toEqual({ sets: [] })
  expect(fetcher.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['POST', 'GET'])
})

it('preserves ownership errors instead of retrying an inaccessible book', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: false, error: { code: 'NOVEL_NOT_FOUND', message: '作品不存在' } }, { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchStoryMemorySets('n')).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
