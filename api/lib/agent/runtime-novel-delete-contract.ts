import { z } from 'zod'

const id = z.string().min(1).max(64)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nullableId = id.nullable()

/** Small server-frozen identity only. Actual deletion authority remains the
 * original tool source, explicit approval, current manuscript owner and lease. */
export const novelDeleteWorkSchema = z.object({ version: z.literal(1), userId: id, taskRootId: id, originRunId: id, sessionId: id, novelId: id,
  title: z.string(), displayTitle: z.string().nullable(), confirmTitle: z.string(),
  approval: z.object({ requestId: id, requestHash: hash, decisionId: id, decisionHash: hash }).strict() }).strict()
export type NovelDeleteWork = z.infer<typeof novelDeleteWorkSchema>

const run = z.object({ kind: z.literal('run'), id, userId: id, novelId: id, sessionId: id, taskRootId: nullableId, taskKey: nullableId,
  taskSpecHash: hash, status: z.string().min(1).max(32), lastSequence: z.number().int().nonnegative().max(2147483647) }).strict()
const usage = z.object({ kind: z.literal('usage'), id, userId: id, novelId: nullableId, chapterId: nullableId, agentRunId: nullableId,
  providerType: z.string(), providerMode: z.string(), modelName: z.string().nullable(), action: z.string(), targetType: z.string(), targetId: nullableId,
  creditChargeMilli: integer, requestTokens: integer.nullable(), responseTokens: integer.nullable(),
  promptCacheHitTokens: integer.nullable(), promptCacheMissTokens: integer.nullable(), multiplierBps: integer,
  billingSnapshotHash: hash, billingEvidenceHash: hash, createdAt: z.string().datetime() }).strict()
const web = z.object({ kind: z.literal('web'), id, runId: id, requestHash: hash, toolKind: z.enum(['search', 'fetch']),
  amountMilli: integer, multiplierBps: integer, status: z.string().min(1).max(32), outcomeHash: hash,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict()
const goal = z.object({ kind: z.literal('goal'), id, userId: id, novelId: id, runId: id, sourceKey: z.string().min(1).max(160),
  creditsMicros: z.string().regex(/^\d+$/), originalLedgerId: id }).strict()

/** Only accounting identity and hashes of retained evidence. No manuscript,
 * provider body, search snippet, source URL, prompt or child brief is copied. */
export const novelDeleteArchiveRowSchema = z.discriminatedUnion('kind', [run, usage, web, goal])
export type NovelDeleteArchiveRow = z.infer<typeof novelDeleteArchiveRowSchema>
export const novelDeleteArchivePageSchema = z.object({ version: z.literal(1), operationId: id, inputHash: hash,
  index: integer, rows: z.array(novelDeleteArchiveRowSchema).min(1).max(200) }).strict()
export const novelDeleteArchiveRefSchema = z.object({ index: integer, eventKey: z.string().min(1).max(160), hash, count: integer }).strict()
export const novelDeleteArchiveManifestSchema = z.object({ version: z.literal(1), refs: z.array(novelDeleteArchiveRefSchema), count: integer }).strict()

const cursor = z.object({ revision: z.number().int().nonnegative().max(2147483647), hash }).strict()
const tokenUsage = z.object({ promptTokens: integer, completionTokens: integer, totalTokens: integer }).strict()
  .refine(value => value.totalTokens === value.promptTokens + value.completionTokens)
const terminalFacts = { usage: tokenUsage, durationMs: integer }
export const novelDeleteEffectSchema = z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).strict(),
  deleted: z.object({ version: z.literal(1), userId: id, taskRootId: id, runId: id, novelId: id, workHash: hash,
    source: cursor, archive: novelDeleteArchiveManifestSchema, chapterCount: integer, runCount: integer, ...terminalFacts }).strict() }).strict()
export const novelDeletionRunIndexSchema = z.object({ version: z.literal(1), userId: id, runId: id, operationId: id, inputHash: hash, deletionHash: hash }).strict()
export const novelDeletionSchema = z.object({ version: z.literal(1), userId: id, taskRootId: id, operationId: id, inputHash: hash,
  runId: id, novelId: id, sessionId: id, workHash: hash, receiptHash: hash, source: cursor, terminal: cursor,
  archive: novelDeleteArchiveManifestSchema, chapterCount: integer, runCount: integer,
  messageId: id, callId: id, output: z.string(), summary: z.string(), committedAt: z.string().datetime(), ...terminalFacts }).strict()
export type NovelDeletion = z.infer<typeof novelDeletionSchema>
