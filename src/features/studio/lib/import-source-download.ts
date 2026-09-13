import { buildApiUrl } from '@/app/api-base'
import { buildAuthHeader } from '@/lib/auth-token'
import { isNativeApp } from '@/lib/native-app'
import { NOVEL_IMPORT_LIMITS } from '../../../../shared/contracts/novel-import.js'
import { importErrorMessage } from './import-labels'

export function importSourceUrl(novelId: string, jobId: string) {
  return buildApiUrl(`/api/novels/${encodeURIComponent(novelId)}/imports/${encodeURIComponent(jobId)}/source`)
}

export async function fetchImportOriginal(novelId: string, jobId: string): Promise<{ blob: Blob; filename: string }> {
  if (isNativeApp()) throw new Error('当前应用暂不支持原文件保存。请在已登录的浏览器打开此作品的导入面板下载，不要复制私有文件路径。')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(importSourceUrl(novelId, jobId), { credentials: 'include', headers: buildAuthHeader(), signal: controller.signal })
    if (!response.ok) {
      let message = response.status === 401 || response.status === 403 ? '请重新登录后下载原文件。' : '原文件暂不可下载，请稍后重试。'
      try {
        const payload: unknown = await response.json()
        if (payload && typeof payload === 'object' && 'error' in payload && payload.error && typeof payload.error === 'object' && 'code' in payload.error && typeof payload.error.code === 'string') message = importErrorMessage(payload.error.code)
      } catch { /* Keep a safe fallback, never display raw HTML or server paths. */ }
      throw new Error(message)
    }
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/octet-stream')) throw new Error('下载返回格式异常，请重新登录后重试。')
    const blob = await response.blob()
    if (!blob.size || blob.size > NOVEL_IMPORT_LIMITS.sourceBytes) throw new Error('原文件大小异常，已停止保存。')
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
    let filename = /filename="([^";]+)"/i.exec(disposition)?.[1] ?? '导入原文件'
    if (encoded) { try { filename = decodeURIComponent(encoded) } catch { /* Use the safe fallback. */ } }
    return { blob, filename: filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 255) || '导入原文件' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('下载超时，请检查网络后重试。')
    throw error
  } finally { clearTimeout(timeout) }
}
