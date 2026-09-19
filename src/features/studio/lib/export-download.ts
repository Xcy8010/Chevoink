import { buildApiUrl } from '@/app/api-base'
import { buildAuthHeader } from '@/lib/auth-token'
import { openExternalUrl } from '@/lib/native-app'
import type { NovelExportOptions } from '../../../../shared/contracts/novel-export.js'

/** 一键导出选项：与后端 exportNovelSchema 对齐 */
export type NovelExportRequest = NovelExportOptions

/** 一次性下载链接（APP 壳外跳系统浏览器专用） */
export type NovelExportLink = {
  exportId: string
  downloadUrl: string
  fileName: string
  /** 发布建议因今日额度用尽未生成：导出本身成功，前端据此弹兑底提示 */
  adviceCreditsExhausted?: boolean
}

/** 从 Content-Disposition 解析下载文件名（优先 RFC5987 UTF-8 编码） */
function parseDownloadFileName(disposition: string | null): string | null {
  if (!disposition) return null

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim())
    } catch {
      return null
    }
  }

  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition)
  return plainMatch ? plainMatch[1].trim() : null
}

/** 触发浏览器保存 Blob 文件 */
export function triggerBlobDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 下载已发起后再回收 Blob URL，留 1 秒余量兼容慢盘
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 请求服务端组装 zip 并直接触发下载；返回是否因额度用尽跳过了发布建议；错误体解析后端中文文案抛出 */
export async function downloadNovelExportZip(novelId: string, options: NovelExportRequest): Promise<boolean> {
  const response = await fetch(buildApiUrl(`/api/novels/${novelId}/export`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeader(),
    },
    body: JSON.stringify(options),
  })

  if (!response.ok) {
    let message = '导出失败，请稍后重试。'

    try {
      const payload = (await response.json()) as { error?: { message?: string } }
      if (payload?.error?.message) {
        message = payload.error.message
      }
    } catch {
      // 非 JSON 错误体保持兜底文案
    }

    throw new Error(message)
  }

  const blob = await response.blob()
  const fileName = parseDownloadFileName(response.headers.get('Content-Disposition')) ?? '作品一键导出.zip'

  triggerBlobDownload(blob, fileName)
  return response.headers.get('X-Advice-Credits-Exhausted') === '1'
}

/** APP 壳专用：服务端打包并暂存后返回一次性下载链接（链接 15 分钟内有效） */
export async function requestNovelExportLink(novelId: string, options: NovelExportRequest): Promise<NovelExportLink> {
  const response = await fetch(buildApiUrl(`/api/novels/${novelId}/export-link`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeader(),
    },
    body: JSON.stringify(options),
  })

  if (!response.ok) {
    let message = '导出失败，请稍后重试。'

    try {
      const payload = (await response.json()) as { error?: { message?: string } }
      if (payload?.error?.message) {
        message = payload.error.message
      }
    } catch {
      // 非 JSON 错误体保持兜底文案
    }

    throw new Error(message)
  }

  const payload = (await response.json()) as { data?: NovelExportLink }
  if (!payload?.data?.downloadUrl) {
    throw new Error('导出失败，请稍后重试。')
  }

  return payload.data
}

/**
 * APP 壳内触发导出下载：壳内 WebView 会吞掉 blob/同源下载（下载了也找不到文件），
 * 统一外跳系统浏览器完成保存；普通浏览器直接新开标签页。
 */
export function openExportDownloadInBrowser(downloadUrl: string): void {
  const absoluteUrl = new URL(downloadUrl, window.location.href).toString()
  openExternalUrl(absoluteUrl)
}
