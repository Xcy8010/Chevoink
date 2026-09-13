import { buildApiUrl } from '@/app/api-base'
import type { NovelImportArtifactDescriptor } from '../../../../shared/contracts/novel-import-preview.js'

export function safeImportArtifactUrl(novelId: string, jobId: string, artifact: NovelImportArtifactDescriptor): string | null {
  const prefix = `/api/novels/${encodeURIComponent(novelId)}/imports/${encodeURIComponent(jobId)}/artifacts/`
  return artifact.url === `${prefix}${encodeURIComponent(artifact.id)}` ? buildApiUrl(artifact.url) : null
}
