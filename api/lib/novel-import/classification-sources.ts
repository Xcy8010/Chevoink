import { getNovelImportClassificationSources, type NovelImportHuman } from '../novel-import-service.js'
import { DataAccessError } from '../prisma.js'
import { importClassificationSourcesSchema, type ImportClassificationSources } from '../../../shared/contracts/novel-import-classification.js'

/** Integration contract owned by novel-import-service. Its reader must check
 * ownership and enumerate ALL persisted leaf sources, chapters/plans/memories/
 * skipped alike. Excerpts are exact contiguous slices, never AI summaries.
 * Apply integration must re-read this snapshot and fence under the job lock;
 * classification only returns references and never edits a preview itself.
 */
export interface ImportClassificationSourceService {
  getNovelImportClassificationSources(human: NovelImportHuman, jobId: string): Promise<ImportClassificationSources>
}

export async function readImportClassificationSources(human: NovelImportHuman, jobId: string): Promise<ImportClassificationSources> {
  const parsed = importClassificationSourcesSchema.safeParse(await getNovelImportClassificationSources(human, jobId))
  if (!parsed.success) throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_SCOPE_LIMIT', '来源清单不完整或超过2000项上限，请拆分导入或手动分类。')
  return parsed.data
}
