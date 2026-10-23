import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ResearchDossier } from '@prisma/client'
import { researchDossierBuildSchema } from '../../../shared/contracts/index.js'
import { env } from '../../config/env.js'
import { tokenPriceSchema } from '../billing/token-price.js'
import { getToolModelRuntime } from '../tool-model-config.js'
import { assertWebSearchConfiguration, type WebSearchOutcome } from '../web-search-service.js'
import { auxiliaryRouteSchema } from './runtime-auxiliary-call.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readToolOperationSource } from './runtime-tool-cursor.js'
import { readOriginalTaskRequest } from './original-request.js'
import { dossierCacheKey, researchDossierPrompts, researchDossierSources } from './research-dossier.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hex = z.string().regex(/^[a-f0-9]{64}$/)
export const dossierForceSchema = z.object({ requestHash: hex, start: z.number().int().nonnegative(), end: z.number().int().positive(), clauseHash: hex }).strict()
const searchRouteSchema = z.object({ configured: z.object({ provider: z.string(), modelName: z.string(), baseUrl: z.string() }).strict().nullable(),
  envProvider: z.string(), envBochaConfigured: z.boolean() }).strict()
const base = { version: z.literal(1), novelId: z.string(), args: researchDossierBuildSchema,
  admittedAt: z.string().datetime(), cacheKey: hex, predecessor: z.object({ id: z.string(), version: z.number().int().positive(), hash: hex }).strict().nullable() }
export const dossierWorkSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('rejected'), code: z.string(), message: z.string() }).strict(),
  z.object({ ...base, kind: z.literal('reuse'), dossierId: z.string() }).strict(),
  z.object({ ...base, kind: z.literal('build'), dossierId: z.string().uuid(), expectedVersion: z.number().int().positive(), expiresAt: z.string().datetime(),
    novel: z.object({ title: z.string(), summary: z.string() }).strict(), force: dossierForceSchema.nullable(),
    searchTariff: z.literal('dossier_search_included_v1'), searchRoute: searchRouteSchema, route: auxiliaryRouteSchema, price: tokenPriceSchema }).strict(),
])
export type DossierWork = z.infer<typeof dossierWorkSchema>
export type DossierBuildWork = Extract<DossierWork, { kind: 'build' }>

/** Counts and observation timestamps may change without changing the dossier. */
export function dossierPredecessor(row: ResearchDossier | null) {
  if (!row) return null
  const { reusedCount: _count, updatedAt: _updated, ...content } = row
  return { id: row.id, version: row.version, hash: runtimeJson(JSON.parse(JSON.stringify(content))).hash }
}

/** Evidence comes only from the owned original human request, never triggerReason
 * or a model's plan. Coordinates retain the exact affirmative refresh clause. */
export function researchRefreshProof(prompt: string | null) {
  if (!prompt) return null
  // Do not discard a question mark, later prohibition or a quoted-example
  // correction before classifying the earlier clause as authorization.
  if (/[?？“”「」"`]|(?:不要|无需|不用|不必|禁止|不得|不能|勿|莫|别|只读|do not|don't|must not|never\b|示例|举例|假设|如果|引用)/iu.test(prompt)) return null
  const clauses = [...prompt.matchAll(/[^。.！？!?；;\n]+/gu)].filter(match => match[0].trim())
  // Without an existing structured research-refresh interpretation, only a
  // standalone unambiguous command can waive the original cooldown. Do not
  // infer precedence among a long request's later corrections or conditions.
  if (clauses.length !== 1) return null
  for (const match of clauses) {
    const clause = match[0]
    if (/(?:不要|无需|不用|不必|禁止|不得|不能|勿|莫|别|仅|只读|do not|don't|must not|never\b|how\b|why\b|what\b|如何|怎么|解释|请问|示例|举例|假设|如果|引用|[“”「」"`])/iu.test(clause)) continue
    // Match a complete affirmative command, not an imperative-looking prefix
    // of a negated statement, a question or a discussion of the UI wording.
    const command = /^\s*(?:(?:请你?|帮我|麻烦你?|现在|直接)\s*)*(?:(?:(?:重新|强制|刷新|重建|更新|建立|做|进行|生成|开展|创建|联网|一下|一次)\s*)+(?:研究|调研)(?:档案|资料|报告)?|(?:把|将)(?:当前|这份|这个|现有)?(?:研究档案|调研档案|联网研究)(?:重新|强制)?(?:刷新|重建|更新|建立))(?:一下|一次|吧)?\s*$|^\s*(?:please\s+)?(?:refresh|rebuild|redo|update)\s+(?:(?:the|current|existing)\s+)?(?:research(?:\s+(?:dossier|report))?|dossier)(?:\s+now)?\s*$/iu
    if (!command.test(clause)) continue
    if (!/(?:重新|强制|刷新|重建|更新|重新做|refresh|rebuild|redo|update)/iu.test(clause)
      || !/(?:研究|调研|联网|research|dossier)/iu.test(clause)) continue
    return { requestHash: hash(prompt), start: match.index!, end: match.index! + clause.length, clauseHash: hash(clause) }
  }
  return null
}

/** An abandoned, never-dispatched preparation is not an eternal book lock.
 * Any saved external call stays blocking, including unknown/complete results
 * whose original parent effect has not committed. A resumed old zero-I/O
 * preparation must yield to a newer live preparation before its first permit. */
export async function assertDossierBuildExclusive(tx: RuntimeTx, userId: string, novelId: string, current?: { id: string; createdAt: Date }) {
  const others = await tx.agentOperation.findMany({ where: { action: 'research_dossier_build', kind: 'tool', status: 'prepared',
    ...(current ? { id: { not: current.id } } : {}), taskRoot: { userId, novelId } }, include: { taskRoot: { select: { status: true } } } })
  for (const other of others) {
    const ids = [0, 1, 2].map(ordinal => dossierQueryIdentity(userId, other.originRunId, other.id, ordinal).id)
    const external = await tx.webToolCall.count({ where: { id: { in: ids } } })
      || await tx.agentProviderAttempt.count({ where: { operation: { parentOperationId: other.id }, dispatchedAt: { not: null } } })
    const live = other.taskRoot.status === 'active' && await tx.agentRun.count({ where: { taskRootId: other.taskRootId, status: { in: ['queued', 'running', 'awaiting_approval'] } } })
    const newer = current && (other.createdAt > current.createdAt || other.createdAt.getTime() === current.createdAt.getTime() && other.id > current.id)
    if (external || live && (!current || newer)) return runtimeError('RESEARCH_BUILD_PENDING', '该作品已有未完成的研究请求，未并发重新联网。')
  }
}

export async function resolveDossierSearchRoute() {
  const runtime = await getToolModelRuntime('tool:web-search')
  assertWebSearchConfiguration(runtime)
  if (runtime) {
    const url = new URL(runtime.baseUrl)
    if (url.username || url.password || url.search || url.hash) return runtimeError('RUNTIME_INPUT_INVALID', '搜索路由含不能持久化的认证参数。')
  }
  return { runtime, route: searchRouteSchema.parse({ configured: runtime ? { provider: runtime.provider, modelName: runtime.modelName, baseUrl: runtime.baseUrl } : null,
    envProvider: env.webSearchProvider, envBochaConfigured: env.webSearchBochaApiKeyConfigured }) }
}

export async function assertDossierPredecessor(tx: RuntimeTx, userId: string, work: DossierWork) {
  if (!await tx.novel.findFirst({ where: { id: work.novelId, authorId: userId } })) return runtimeError('RUNTIME_SCOPE_MISMATCH', '原研究作品不可用。')
  const latest = await tx.researchDossier.findFirst({ where: { userId, novelId: work.novelId }, orderBy: { version: 'desc' } })
  if (runtimeJson({ predecessor: dossierPredecessor(latest) }).hash !== runtimeJson({ predecessor: work.predecessor }).hash) return runtimeError('RESEARCH_SOURCE_CHANGED', '研究档案已变化，原请求和费用保留，未自动重新研究。')
  if (dossierCacheKey(work.args) !== work.cacheKey) return runtimeError('RUNTIME_RECEIPT_INVALID', '原研究缓存身份不一致。')
  return latest
}

export async function assertDossierForce(tx: RuntimeTx, subject: { userId: string; novelId: string; runId: string }, work: DossierBuildWork) {
  if (!work.args.forceRefresh) {
    if (work.force !== null) return runtimeError('RUNTIME_RECEIPT_INVALID', '非刷新请求不能携带刷新证明。')
    return
  }
  const original = await readOriginalTaskRequest(tx, subject)
  const proof = researchRefreshProof(original.prompt)
  if (!proof || !work.force || runtimeJson(proof).hash !== runtimeJson(work.force).hash
    || !['author_request', 'new_genre', 'new_arc'].includes(work.args.triggerReason)) return runtimeError('RESEARCH_FORCE_NOT_JUSTIFIED', '原作者请求没有明确刷新研究授权；未重新联网。')
}

export const dossierQueryIdentity = (userId: string, runId: string, parentId: string, ordinal: number) => {
  const callId = `dossier:${parentId}:query:${ordinal}`
  return { callId, id: hash([userId, runId, callId, 'search']) }
}
export const dossierQueryRequest = (parent: { id: string; inputHash: string }, work: DossierBuildWork, ordinal: number) => ({
  parentOperationId: parent.id, parentInputHash: parent.inputHash, ordinal, query: work.args.queries[ordinal], count: 5,
  tariff: work.searchTariff, route: work.searchRoute,
})

/** Historical ownership only, also usable for a late result after cancellation.
 * Current execution authority remains the caller's same-TX webAdmission fence. */
export async function readIncludedDossierSearch(tx: RuntimeTx, ctx: { userId: string; novelId: string; sessionId: string; runId: string; callId: string;
  includedDossierSearch?: { parentOperationId: string; parentInputHash: string; ordinal: number } }, request: unknown) {
  const proof = ctx.includedDossierSearch
  if (!proof) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '研究搜索缺少原服务来源。')
  const parent = await tx.agentOperation.findUnique({ where: { id: proof.parentOperationId }, include: { taskRoot: true } })
  const origin = parent && await tx.agentRun.findUnique({ where: { id: parent.originRunId } })
  if (!parent || parent.action !== 'research_dossier_build' || parent.inputHash !== proof.parentInputHash || parent.taskRoot.userId !== ctx.userId
    || parent.taskRoot.novelId !== ctx.novelId || parent.originRunId !== ctx.runId || !origin || origin.sessionId !== ctx.sessionId
    || origin.userId !== ctx.userId || origin.novelId !== ctx.novelId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '研究搜索不属于原操作。')
  const original = await readToolOperationSource(tx, parent)
  const work = dossierWorkSchema.parse(original.input.work)
  if (work.kind !== 'build' || work.novelId !== ctx.novelId || runtimeJson(work.args).hash !== runtimeJson(original.input.args).hash
    || !Number.isInteger(proof.ordinal) || proof.ordinal < 0 || proof.ordinal >= work.args.queries.length
    || dossierQueryIdentity(ctx.userId, ctx.runId, parent.id, proof.ordinal).callId !== ctx.callId
    || runtimeJson(dossierQueryRequest(parent, work, proof.ordinal)).hash !== runtimeJson(request).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '研究查询与原工作不一致。')
  return { parent, work }
}

export async function dossierSynthesisInput(tx: RuntimeTx, parent: { id: string; inputHash: string; originRunId: string }, userId: string, work: DossierBuildWork) {
  const outcomes: WebSearchOutcome[] = [], queryReceipts: Array<{ id: string; hash: string }> = []
  for (let ordinal = 0; ordinal < work.args.queries.length; ordinal++) {
    const { id } = dossierQueryIdentity(userId, parent.originRunId, parent.id, ordinal)
    const row = await tx.webToolCall.findUnique({ where: { id } })
    if (!row || row.runId !== parent.originRunId || row.kind !== 'search' || row.status !== 'completed' || !row.outcome
      || row.amountMilli !== 0 || row.multiplierBps !== 0 || row.requestHash !== hash(dossierQueryRequest(parent, work, ordinal))) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原研究查询尚无完整回执，未生成档案。')
    const outcome = z.object({ provider: z.enum(['bocha', 'deepseek', 'sogou', 'bing']), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), source: z.string() })) }).passthrough().parse(row.outcome)
    outcomes.push(outcome as WebSearchOutcome); queryReceipts.push({ id, hash: runtimeJson(row.outcome).hash })
  }
  const sources = researchDossierSources(outcomes, work.admittedAt)
  if (!sources.length) return runtimeError('RESEARCH_SOURCES_EMPTY', '联网研究未获得可核验来源，本次不生成研究档案。')
  return { sources, queryReceipts, ...researchDossierPrompts(work.novel, work.args, sources) }
}
