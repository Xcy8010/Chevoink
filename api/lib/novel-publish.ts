import {
  getMissingNovelPublishFields,
  NOVEL_PUBLISH_METADATA_REQUIRED,
  novelPublishMetadataMessage,
} from '../../shared/contracts/novel-publish.js'
import { DataAccessError } from './prisma.js'

export function requireNovelPublishMetadata(novel: {
  coverAssetId: string | null
  summary: string
  tagNames: string[]
}): void {
  const missing = getMissingNovelPublishFields({ ...novel, tags: novel.tagNames })
  if (missing.length) {
    const message = novelPublishMetadataMessage(missing)
    throw new DataAccessError(
      400,
      NOVEL_PUBLISH_METADATA_REQUIRED,
      message,
      Object.fromEntries(missing.map((field) => [field, message])),
    )
  }
}
