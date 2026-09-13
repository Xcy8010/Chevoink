import { beforeEach, expect, it, vi } from 'vitest'
import { novelImportApi } from '../../src/features/studio/import-api'
import { requestData } from '../../src/features/studio/api'
import { importPreviewApi } from '../../src/features/studio/import-preview-api'
import { importSuggestionsApi } from '../../src/features/studio/import-suggestions-api'

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
  const attachment = { url: '/api/uploads/agent-attachments/u/book.txt', runId: 'run', callId: 'call-only-for-preflight' }
  await novelImportApi.attachment('a', 'job', attachment)
  expect(requestData).toHaveBeenCalledOnce()
  expect(requestData).toHaveBeenCalledWith('/api/novels/a/imports/job/attachment', { method: 'POST', body: JSON.stringify({ url: attachment.url, runId: attachment.runId }) })
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

it('keeps restore impact GET-only and binds the separate confirmation and stable restore idempotency key', async () => {
  const hash = 'a'.repeat(64)
  await novelImportApi.restorePreview('a', 'job')
  await novelImportApi.restoreConfirm('a', 'job', hash)
  await novelImportApi.restore('a', 'job', { restoreApprovalId: 'approval', targetHash: hash })
  expect(requestData).toHaveBeenNthCalledWith(1, '/api/novels/a/imports/job/restore-preview')
  expect(requestData).toHaveBeenNthCalledWith(2, '/api/novels/a/imports/job/restore-confirm', { method: 'POST', body: JSON.stringify({ targetHash: hash }) })
  expect(requestData).toHaveBeenNthCalledWith(3, '/api/novels/a/imports/job/restore', { method: 'POST', body: JSON.stringify({ restoreApprovalId: 'approval', targetHash: hash, idempotencyKey: 'novel-import-restore:job' }) })
})

it('passes only the explicit Agent origin to preflight and reads chapter content by revision', async () => {
  await novelImportApi.preflight('a', { runId: 'run', callId: 'call' })
  await importPreviewApi.summary('a', 'job')
  await importPreviewApi.chapter('a', 'job', 4, 0, 2)
  expect(requestData).toHaveBeenNthCalledWith(1, '/api/novels/a/imports/preflight', { method: 'POST', body: JSON.stringify({ origin: { runId: 'run', callId: 'call' } }) })
  expect(requestData).toHaveBeenNthCalledWith(2, '/api/novels/a/imports/job/preview?view=summary')
  expect(requestData).toHaveBeenNthCalledWith(3, '/api/novels/a/imports/job/chapters/0/2?manifestRevision=4')
})

it('serializes reference-only structure, hash-bound source decisions and explicit suggestion consent', async () => {
  const hash = 'a'.repeat(64)
  const structure = { expectedManifestRevision: 2, manifestHash: hash, metadataSelection: {}, volumes: [{ title: '卷', chapters: [{ title: '章', segments: [{ volumeIndex: 0, chapterIndex: 1, start: 0, end: 100000 }] }] }] }
  const review = { expectedManifestRevision: 2, manifestHash: hash, reportHash: hash, decisions: [{ itemId: 'page-1', action: 'exclude' as const, reason: '广告页，不导入' }] }
  const selection = { manifestRevision: 3, manifestHash: hash, volumeIndex: 0, chapterIndex: 0 }
  await importPreviewApi.structure('a', 'job', structure)
  await importPreviewApi.review('a', 'job', review)
  await importSuggestionsApi.quote('a', 'job', selection)
  await importSuggestionsApi.request('a', 'job', selection, hash)
  await importSuggestionsApi.list('a', 'job')
  expect(requestData).toHaveBeenNthCalledWith(1, '/api/novels/a/imports/job/structure', { method: 'PATCH', body: JSON.stringify(structure) })
  expect(requestData).toHaveBeenNthCalledWith(2, '/api/novels/a/imports/job/review', { method: 'POST', body: JSON.stringify(review) })
  expect(requestData).toHaveBeenNthCalledWith(3, '/api/novels/a/imports/job/suggestions/quote', { method: 'POST', body: JSON.stringify(selection) })
  expect(requestData).toHaveBeenNthCalledWith(4, '/api/novels/a/imports/job/suggestions', { method: 'POST', body: JSON.stringify({ ...selection, fingerprint: hash, confirmed: true }), timeoutMs: 120000 })
  expect(requestData).toHaveBeenNthCalledWith(5, '/api/novels/a/imports/job/suggestions')
  expect(JSON.stringify(structure)).not.toContain('"content":')
})

it('sends the explicitly selected cover artifact ID and omits it on cancellation, never a public URL or null', async () => {
  const draft = { expectedManifestRevision: 4, manifestHash: 'a'.repeat(64), volumes: [{ title: '卷', chapters: [{ title: '章', segments: [{ volumeIndex: 0, chapterIndex: 0, start: 0, end: 20 }] }] }] }
  await importPreviewApi.structure('a', 'job', { ...draft, metadataSelection: { coverArtifactId: 'cover-a' } })
  await importPreviewApi.structure('a', 'job', { ...draft, metadataSelection: {} })
  expect(requestData).toHaveBeenNthCalledWith(1, '/api/novels/a/imports/job/structure', { method: 'PATCH', body: JSON.stringify({ ...draft, metadataSelection: { coverArtifactId: 'cover-a' } }) })
  expect(requestData).toHaveBeenNthCalledWith(2, '/api/novels/a/imports/job/structure', { method: 'PATCH', body: JSON.stringify({ ...draft, metadataSelection: {} }) })
})
