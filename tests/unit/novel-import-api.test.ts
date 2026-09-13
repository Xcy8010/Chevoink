import { beforeEach, expect, it, vi } from 'vitest'
import { novelImportApi } from '../../src/features/studio/import-api'
import { requestData } from '../../src/features/studio/api'

vi.mock('../../src/features/studio/api', () => ({ requestData: vi.fn().mockResolvedValue({}) }))
beforeEach(() => vi.clearAllMocks())

it('uses the existing authenticated response wrapper for a raw binary upload, not Base64 JSON', async () => {
  const source = new File(['正文'], '我的小说.txt', { type: 'text/plain' })
  await novelImportApi.upload('novel-a', 'job-a', source)
  expect(requestData).toHaveBeenCalledWith('/api/novels/novel-a/imports/job-a/source?filename=%E6%88%91%E7%9A%84%E5%B0%8F%E8%AF%B4.txt', {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: source, timeoutMs: 120_000,
  })
})

it('capability and persistent history queries are GET-only and do not mint intents', async () => {
  await novelImportApi.capabilities('a')
  await novelImportApi.list('a')
  expect(requestData).toHaveBeenNthCalledWith(1, '/api/novels/a/imports/capabilities')
  expect(requestData).toHaveBeenNthCalledWith(2, '/api/novels/a/imports')
})

it('passes only attachment hints to the server bridge and never fetches their URL', async () => {
  const attachment = { url: '/api/uploads/agent-attachments/u/book.txt', runId: 'run' }
  await novelImportApi.attachment('a', 'job', attachment)
  expect(requestData).toHaveBeenCalledOnce()
  expect(requestData).toHaveBeenCalledWith('/api/novels/a/imports/job/attachment', { method: 'POST', body: JSON.stringify(attachment) })
})

it('keeps errors from the existing response wrapper', async () => {
  vi.mocked(requestData).mockRejectedValueOnce(new Error('登录状态已失效'))
  await expect(novelImportApi.status('a', 'job')).rejects.toThrow('登录状态已失效')
})

it('analysis omits encoding by default and sends only explicitly selected encoding on retry', async () => {
  await novelImportApi.analyze('a', 'job')
  await novelImportApi.retry('a', 'job', 'utf-16be')
  expect(requestData).toHaveBeenNthCalledWith(1, '/api/novels/a/imports/job/analyze', { method: 'POST', body: '{}', timeoutMs: 120_000 })
  expect(requestData).toHaveBeenNthCalledWith(2, '/api/novels/a/imports/job/retry', { method: 'POST', body: '{"encoding":"utf-16be"}', timeoutMs: 120_000 })
})
