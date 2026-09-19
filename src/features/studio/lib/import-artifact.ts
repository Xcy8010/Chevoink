import { buildApiUrl } from '@/app/api-base'
import type { NovelImportArtifactDescriptor } from '../../../../shared/contracts/novel-import-preview.js'

export function safeImportArtifactUrl(novelId: string, jobId: string, artifact: NovelImportArtifactDescriptor): string | null {
  const prefix = `/api/novels/${encodeURIComponent(novelId)}/imports/${encodeURIComponent(jobId)}/artifacts/`
  if (!artifact.url.startsWith(prefix)) return null
  const storageId = artifact.url.slice(prefix.length)
  // Source evidence uses a logical image ID; downloads use the persisted row UUID.
  // Older previews omit storageArtifactId but already carry the scoped UUID URL.
  if (artifact.storageArtifactId && storageId !== artifact.storageArtifactId) return null
  if (storageId !== encodeURIComponent(artifact.id) && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(storageId)) return null
  return buildApiUrl(artifact.url)
}
