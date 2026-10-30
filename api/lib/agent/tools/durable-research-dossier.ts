import { selectWeightedModelRuntime, resolveWeightedModelRuntime } from '../../model-weighted-routing.js'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { env } from '../../../config/env.js'
import { DataAccessError } from '../../prisma.js'
import { assertCreditAccess, getModelTierRuntime } from '../../credits.js'
import { resolveDurableTokenPrice } from '../../billing/resolve-token-price.js'
import { executeWebToolCall, findWebToolCallOutcome } from '../../billing/web-tool-calls.js'
import { searchWeb, WebSearchError, WebSearchUnknownError } from '../../web-search-service.js'
import { assignedTaskModel } from '../model-assignment-context.js'
import { auxiliaryTextModel } from '../auxiliary-text-model.js'
import { auxiliaryRouteForRuntime, callDurableAuxiliary } from '../runtime-auxiliary-call.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withManuscriptRunLease, withRunLease, withRunLeaseInTransaction } from '../runtime-lease.js'
import { lockNovelActiveScope } from '../../data/novel-write-lock.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { reduceExecutionReceipt, failedToolResultSchema } from '../runtime-reducer.js'
import { readOriginalTaskRequest } from '../original-request.js'
import { dossierCacheKey, parseResearchSynthesis, toDossierView, RESEARCH_CACHE_HOURS, RESEARCH_TTL_DAYS } from '../research-dossier.js'
import { assertDossierBuildExclusive, assertDossierForce, assertDossierPredecessor, dossierPredecessor, dossierQueryIdentity, dossierQueryRequest,
  dossierSynthesisInput, dossierWorkSchema, researchRefreshProof, resolveDossierSearchRoute, type DossierWork } from '../runtime-dossier-contract.js'
import { normalizeToolInput } from './input-validation.js'
import { researchDossierBuildTool } from './research-dossier-tools.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

async function freezeWork(ctx: ToolContext, args: DossierWork['args']): Promise<DossierWork> {
  const { lease } = ctx.durableDossier!
  const initial = await withManuscriptRunLease(lease, async tx => {
    const novel = await tx.novel.findFirst({ where: { id: ctx.novelId, authorId: ctx.userId }, select: { title: true, summary: true } })
    if (!novel) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作品不存在或无权研究。')
    const latest = await tx.researchDossier.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId }, orderBy: { version: 'desc' } })
    const now = new Date(), base = { version: 1 as const, novelId: ctx.novelId, args, admittedAt: now.toISOString(), cacheKey: dossierCacheKey(args), predecessor: dossierPredecessor(latest) }
    if (latest?.status === 'ready' && latest.expiresAt > now && latest.cacheKey === base.cacheKey && !args.forceRefresh) return { work: { ...base, kind: 'reuse' as const, dossierId: latest.id } }
    if (latest && latest.createdAt.getTime() > now.getTime() - RESEARCH_CACHE_HOURS * 3600000 && !args.forceRefresh) {
      return { work: { ...base, kind: 'rejected' as const, code: 'RESEARCH_REFRESH_COOLDOWN', message: '该作品24小时内已建立研究档案，请先复用；本次未重新联网。' } }
    }
    const original = args.forceRefresh ? await readOriginalTaskRequest(tx, ctx) : null
    const force = original ? researchRefreshProof(original.prompt) : null
    if (args.forceRefresh && (!force || !['author_request', 'new_genre', 'new_arc'].includes(args.triggerReason))) {
      return { work: { ...base, kind: 'rejected' as const, code: 'RESEARCH_FORCE_NOT_JUSTIFIED', message: '原作者请求没有明确刷新研究授权；本次未重新联网。' } }
    }
    return { build: { ...base, kind: 'build' as const, dossierId: randomUUID(), expectedVersion: (latest?.version ?? 0) + 1,
      expiresAt: new Date(now.getTime() + RESEARCH_TTL_DAYS * 86400000).toISOString(), novel, force, searchTariff: 'dossier_search_included_v1' as const } }
  })
  if (initial.work) return dossierWorkSchema.parse(initial.work)
  const search = await resolveDossierSearchRoute()
  const assigned = await assignedTaskModel(ctx.userId, ctx.novelId, 'research_synthesis', ctx.modelAssignments, true)
  const selected = ctx.modelSelection
  const main = ctx.modelRuntime ?? (selected ? resolveWeightedModelRuntime(await getModelTierRuntime(selected.tier, ctx.userId, selected.customModelId, selected.reasoningEffort), selected.weightedRoute) : undefined)
  const inheritedBase = assigned ? undefined : auxiliaryTextModel(main)
  const inherited = inheritedBase ? selectWeightedModelRuntime(inheritedBase) : undefined
  const customModelId = assigned?.selection.customModelId ?? (inherited?.tier === 'custom' ? selected?.customModelId : null) ?? null
  if (inherited?.tier === 'custom' && !customModelId) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '研究综合缺少原自定义模型身份。')
  const requestedEffort = inherited && !inherited.reasoningEfforts?.includes('high') ? inherited.reasoningEffort : 'high'
  const runtime = selectWeightedModelRuntime(assigned?.runtime ?? resolveWeightedModelRuntime(await getModelTierRuntime(inherited?.tier ?? 'speed', ctx.userId, customModelId, requestedEffort), inherited?.weightedRoute))
  if (inherited && (runtime.provider !== inherited.provider || runtime.modelName !== inherited.modelName || runtime.baseUrl !== inherited.baseUrl)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原免费或自带模型路由已变化。')
  const route = auxiliaryRouteForRuntime({ ...runtime, honorAssignedReasoning: true }, { tier: runtime.tier, customModelId, reasoningEffort: runtime.reasoningEffort }, env.aiTextMaxOutputTokens)
  delete route.responseFormat
  return dossierWorkSchema.parse({ ...initial.build, searchRoute: search.route, route,
    price: await resolveDurableTokenPrice(lease, `${ctx.durableDossier!.operationKey}:dossier-price`, runtime.tier, runtime.multiplierBps) })
}

export async function executeDurableDossier(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableDossier
  if (!capability || tool.name !== 'research_dossier_build' || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '研究档案缺少原任务能力。')
  const lease = { ...capability.lease }
  const normalize = (value: unknown) => researchDossierBuildTool.parameters.parse(normalizeToolInput(tool, value))
  const args = normalize(raw)
  let work = await withRunLease(lease, async tx => {
    const old = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: capability.operationKey } } })
    if (!old) return null
    if (runtimeJson(old.inputSnapshot).hash !== old.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原研究工作损坏。')
    return z.object({ input: z.object({ work: dossierWorkSchema }) }).parse(old.inputSnapshot).input.work
  })
  work ??= await freezeWork(ctx, args)
  const prepared = await withManuscriptRunLease(lease, async tx => {
    const old = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: capability.operationKey } } })
    if (!old) {
      if (work.kind !== 'rejected') await assertDossierPredecessor(tx, ctx.userId, work)
      // Serialize concurrent builders before either receives a network permit.
      if (work.kind === 'build') await assertDossierBuildExclusive(tx, ctx.userId, ctx.novelId)
    }
    return prepareToolCursorOperation(lease, capability.cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId, effectDomain: 'metadata', targetId: lease.taskRootId,
      effectiveArgs: args, normalize, operationInput: runtimeJson({ novelId: ctx.novelId, callId: ctx.callId, args, work }).value }, tx)
  })
  const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
  const frozen = dossierWorkSchema.parse(admitted.input.work)
  if (runtimeJson(frozen.args).hash !== runtimeJson(admitted.input.args).hash || frozen.novelId !== ctx.novelId) return runtimeError('RUNTIME_RECEIPT_INVALID', '原研究参数不一致。')
  const assertCurrent = async (tx: import('../runtime-common.js').RuntimeTx) => {
    const original = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId }, tx)
    if (original.operation.status !== 'prepared' || original.operation.inputHash !== prepared.operation.inputHash) return runtimeError('RUNTIME_STATE_CONFLICT', '原研究已不再等待执行。')
    await assertCurrentToolPolicy(tx, lease, original.operation)
    if (frozen.kind !== 'rejected') await assertDossierPredecessor(tx, ctx.userId, frozen)
    if (frozen.kind === 'build') {
      await assertDossierForce(tx, ctx, frozen)
      await assertDossierBuildExclusive(tx, ctx.userId, ctx.novelId, prepared.operation)
    }
    ctx.signal.throwIfAborted()
  }
  let receipt = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } }))
  if (!receipt) {
    try {
      if (frozen.kind === 'rejected') throw new DataAccessError(409, frozen.code, frozen.message)
      let synthesis: Awaited<ReturnType<typeof dossierSynthesisInput>> | null = null, resultContent = ''
      if (frozen.kind === 'build') {
        for (let ordinal = 0; ordinal < frozen.args.queries.length; ordinal++) {
          const identity = dossierQueryIdentity(ctx.userId, admitted.operation.originRunId, prepared.operation.id, ordinal)
          const request = dossierQueryRequest(prepared.operation, frozen, ordinal)
          const web: ToolContext = { ...ctx, durableDossier: undefined, runId: admitted.operation.originRunId, callId: identity.callId,
            includedDossierSearch: { parentOperationId: prepared.operation.id, parentInputHash: prepared.operation.inputHash, ordinal },
            webAdmission: async (tx, callback) => {
              await lockNovelActiveScope(tx, ctx.novelId)
              return withRunLeaseInTransaction(tx, lease, async () => {
                await assertCurrent(tx)
                const value = await callback(); ctx.signal.throwIfAborted(); return value
              })
            } }
          // Replay occurs before credit availability, current config or HTTP.
          try {
            if (await findWebToolCallOutcome(web, 'search', request)) continue
            await assertCreditAccess(ctx.userId, 'speed', false)
            const search = await resolveDossierSearchRoute()
            if (runtimeJson(search.route).hash !== runtimeJson(frozen.searchRoute).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原搜索路由已变化，未派发查询。')
            await executeWebToolCall(web, 'search', request, true,
              () => searchWeb(frozen.args.queries[ordinal], 5, ctx.signal, search.runtime, undefined, undefined, { stopOnUnknown: true }),
              outcome => outcome.results.length ? 'billable' : 'empty', undefined,
              error => error instanceof WebSearchError && !(error instanceof WebSearchUnknownError))
          } catch (error) {
            if (error instanceof WebSearchUnknownError || error instanceof DataAccessError && error.code === 'CREDIT_WEB_TOOL_PENDING') throw error
            if (error instanceof WebSearchError || error instanceof DataAccessError && error.code === 'CREDIT_WEB_TOOL_FAILED') throw new DataAccessError(502, 'RESEARCH_SEARCH_FAILED', '原研究查询未取得有效结果，失败回执保留，未自动重试。')
            throw error
          }
        }
        synthesis = await withRunLease(lease, tx => dossierSynthesisInput(tx, prepared.operation, ctx.userId, frozen))
        const response = await callDurableAuxiliary({ lease, parentOperationId: prepared.operation.id, step: 'research_dossier_synthesis', route: frozen.route, price: frozen.price,
          system: synthesis.system, content: synthesis.content, temperature: 0.25, signal: ctx.signal, assertCurrent })
        if (response.finishReason !== 'stop' || response.toolCalls.length || !response.content.trim()) throw new DataAccessError(409, 'RESEARCH_RESULT_INCOMPLETE', '综合模型没有返回完整研究结果；原响应和费用保留，未生成档案或重新请求。')
        resultContent = response.content
      }
      receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
        await assertCurrent(tx)
        if (frozen.kind === 'reuse') {
          const row = await tx.researchDossier.update({ where: { id: frozen.dossierId }, data: { reusedCount: { increment: 1 } } })
          return runtimeJson({ toolResult: presentDossier(toDossierView(row, true)) }).value
        }
        const source = await dossierSynthesisInput(tx, prepared.operation, ctx.userId, frozen)
        if (!synthesis || runtimeJson(source).hash !== runtimeJson(synthesis).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '研究来源回执已变化。')
        let fallback = false
        const value = parseResearchSynthesis(resultContent, frozen.args, source.sources.length, () => { fallback = true })
        const at = new Date(frozen.admittedAt)
        const row = await tx.researchDossier.create({ data: { ...value, id: frozen.dossierId, userId: ctx.userId, novelId: ctx.novelId,
          runId: admitted.operation.originRunId, version: frozen.expectedVersion, status: 'ready', triggerReason: frozen.args.triggerReason,
          triggerSignals: frozen.args.triggerSignals, topic: frozen.args.topic, genre: frozen.args.genre, targetAudience: frozen.args.targetAudience,
          targetPlatform: frozen.args.targetPlatform, queryPlan: frozen.args.queries, sources: runtimeJson(source.sources).value,
          sourceHash: createHash('sha256').update(JSON.stringify(source.sources.map(({ url, snippet }) => ({ url, snippet })))).digest('hex'), cacheKey: frozen.cacheKey,
          searchCount: frozen.args.queries.length, estimatedInputTokens: Math.ceil((source.system.length + source.content.length) / 3),
          buildDurationMs: Math.min(2147483647, Math.max(0, Date.now() - at.getTime())), expiresAt: new Date(frozen.expiresAt), createdAt: at } })
        await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, operationId: prepared.operation.id, runId: admitted.operation.originRunId,
          eventKey: `dossier.persisted:${prepared.operation.id}`, type: 'research.dossier.persisted', payload: { dossierId: row.id, fallback,
            queryReceipts: source.queryReceipts, synthesisContentHash: createHash('sha256').update(resultContent).digest('hex') } } })
        return runtimeJson({ toolResult: presentDossier(toDossierView(row)) }).value
      })
    } catch (error) {
      if (!(error instanceof DataAccessError) || !['RESEARCH_REFRESH_COOLDOWN', 'RESEARCH_FORCE_NOT_JUSTIFIED', 'RESEARCH_SOURCES_EMPTY', 'RESEARCH_SEARCH_FAILED', 'RESEARCH_RESULT_INCOMPLETE', 'RESEARCH_SOURCE_CHANGED'].includes(error.code)) throw error
      receipt = await recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '研究档案未完成' })
    }
  }
  if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原研究回执损坏。')
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  return failed.success ? { ...failed.data.toolResult, outcome: 'failed', failureCode: failed.data.code }
    : z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}

function presentDossier(dossier: ReturnType<typeof toDossierView>): ToolResult {
  return { output: `Research Dossier v${dossier.version}${dossier.reused ? '已复用，无需重新联网' : '已建立'}，dossierId=${dossier.id}。共${dossier.searchCount}个查询、${dossier.sources.length}个摘要来源，有效至${dossier.expiresAt}。来源只包含摘要与链接，不代表已读取或核实完整正文。\n读者承诺：${dossier.readerPromise}\n弃书风险：${dossier.abandonmentRisks.join('；')}\n差异化：${dossier.differentiation.join('；')}`,
    summary: `${dossier.reused ? '复用' : '建立'}研究档案 v${dossier.version}`,
    display: { kind: 'researchDossier', dossierId: dossier.id, title: '创作研究档案', detail: `v${dossier.version} · ${dossier.sources.length}个摘要来源`, reused: Boolean(dossier.reused), sourceCount: dossier.sources.length,
      items: [`读者承诺：${dossier.readerPromise}`, `语言风险：${dossier.languageRisks.join('；') || '无'}`] } }
}
