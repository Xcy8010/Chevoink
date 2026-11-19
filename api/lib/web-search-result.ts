import { z } from 'zod'

export const WEB_SEARCH_SNIPPET_CHARS = 200
export const WEB_SEARCH_SUMMARY_CHARS = 800

export const searchRerankScoreSchema = z.number().min(0).max(3)
export const searchAuthoritySchema = z.number().int().min(-1).max(4)
export const searchPublicationDateSchema = z.iso.datetime({ offset: true })

export const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string(),
  summary: z.string().max(WEB_SEARCH_SUMMARY_CHARS).optional(),
  rerankScore: searchRerankScoreSchema.optional(),
  authority: searchAuthoritySchema.optional(),
  publishedAt: searchPublicationDateSchema.optional(),
})

export type WebSearchResult = z.infer<typeof webSearchResultSchema>
