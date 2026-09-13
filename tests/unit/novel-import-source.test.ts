import { afterEach, expect, it, vi } from 'vitest'
import { fetchImportOriginal, importSourceUrl } from '../../src/features/studio/lib/import-source-download'
import { importErrorMessage, importStatusLabel } from '../../src/features/studio/lib/import-labels'

const native = vi.hoisted(() => ({ active: false }))
vi.mock('../../src/app/api-base', () => ({ buildApiUrl: (path: string) => path }))
vi.mock('../../src/lib/auth-token', () => ({ buildAuthHeader: () => ({ Authorization: 'Bearer test-only-token' }) }))
vi.mock('../../src/lib/native-app', () => ({ isNativeApp: () => native.active }))
afterEach(() => { native.active = false; vi.unstubAllGlobals() })

it('downloads only through the owned authenticated endpoint and preserves original filename and bytes', async () => {
  const source = new TextEncoder().encode('原文末尾\n\n')
  const fetcher = vi.fn().mockResolvedValue(new Response(source, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''%E5%8E%9F%E7%A8%BF.txt" } }))
  vi.stubGlobal('fetch', fetcher)
  const result = await fetchImportOriginal('novel-a', 'job-a')
  expect(fetcher).toHaveBeenCalledWith('/api/novels/novel-a/imports/job-a/source', expect.objectContaining({ credentials: 'include', headers: { Authorization: 'Bearer test-only-token' } }))
  expect(await result.blob.text()).toBe('原文末尾\n\n')
  expect(result.filename).toBe('原稿.txt')
  expect(importSourceUrl('novel/a', 'job/a')).toBe('/api/novels/novel%2Fa/imports/job%2Fa/source')
})

it('does not save HTML errors and maps known source failures to actionable Chinese', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>private path</html>', { headers: { 'Content-Type': 'text/html' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { code: 'IMPORT_SOURCE_UNAVAILABLE', message: 'private path' } }), { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchImportOriginal('a', 'job')).rejects.toThrow('下载返回格式异常')
  await expect(fetchImportOriginal('a', 'job')).rejects.toThrow('原文件已过期')
})

it('does not pretend unsupported native blob saves succeeded', async () => {
  native.active = true
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(fetchImportOriginal('a', 'job')).rejects.toThrow('已登录的浏览器')
  expect(fetcher).not.toHaveBeenCalled()
})

it('localizes statuses/errors with a safe unknown fallback and no prototype-key lookup', () => {
  expect(importStatusLabel('needs_review')).toBe('需要核对预览')
  expect(importStatusLabel('uploaded')).toBe('文件已上传，等待解析')
  expect(importStatusLabel('constructor')).toContain('状态待核对')
  expect(importErrorMessage('IMPORT_ENCODING_AMBIGUOUS')).toContain('手动选择')
  expect(importErrorMessage('IMPORT_CHAPTER_TOO_LARGE')).toContain('光标处拆分')
  expect(importErrorMessage('UNKNOWN_PRIVATE_PATH')).not.toContain('UNKNOWN_PRIVATE_PATH')
  expect(importErrorMessage('constructor')).toContain('查询任务状态')
})
