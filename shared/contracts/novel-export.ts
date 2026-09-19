import { z } from 'zod'

/** Omitted memory selection preserves exports from older clients. */
export const novelExportSchema = z.object({
  includePlans: z.boolean().optional(),
  includeMemories: z.boolean().optional(),
  includeCatalog: z.boolean().optional(),
  includeInfo: z.boolean().optional(),
  includeChapters: z.boolean().optional(),
  chapterIds: z.array(z.string().min(1)).optional(),
})

export type NovelExportOptions = z.infer<typeof novelExportSchema>
