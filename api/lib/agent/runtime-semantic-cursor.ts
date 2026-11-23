import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { tokenPriceSchema, type TokenPrice } from '../billing/token-price.js'
import { providerRequestOutputLimit } from '../ai-responses-route.js'
import { runtimeError, runtimeJsonHash } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { prepareOperationInTransaction } from './runtime-operations.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { modelRouteRevision } from './runtime-model-cursor.js'

export const SEMANTIC_ACTION = 'agent_context_summary'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const summarySourceSchema = z.object({
  revision: z.number().int().nonnegative(), snapshotHash: hash, configurationHash: hash, planHash: hash,
}).strict()
export type SummarySource = z.infer<typeof summarySourceSchema>
export const summaryOperationKey = (source: Pick<SummarySource, 'revision' | 'snapshotHash'>) =>
  `context-summary:${source.revision}:${source.snapshotHash}`
const isolatedMessages = z.tuple([z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.string() }).strict()])

/** Recheck the exact wire envelopes for both protocols, including prepared
 * recovery. The independent call cannot inherit tools or route to another host. */
function assertSummaryRequest(request: Prisma.InputJsonValue, source: SummarySource, model: Awaited<ReturnType<typeof readExecutionStateInTransaction>>['configuration']['model']) {
  const wire = z.object({ endpoint: z.string(), body: z.record(z.string(), z.unknown()) }).parse(request)
  const responses = wire.endpoint.endsWith('/responses')
  const endpoint = responses ? wire.endpoint.slice(0, -'/responses'.length) + '/chat/completions' : wire.endpoint
  const routeRevision = modelRouteRevision({ provider: model.provider, model: model.modelName ?? '', endpoint, reasoningEffort: model.reasoningEffort,
    ...(model.toolCallingProtocol ? { toolCallingProtocol: model.toolCallingProtocol } : {}), ...(model.weightedRoute ? { weightedRoute: model.weightedRoute } : {}) })
  const pair = isolatedMessages.safeParse(responses ? wire.body.input : wire.body.messages)
  const output = providerRequestOutputLimit(wire)
  if (routeRevision !== model.routeRevision || wire.body.model !== model.modelName || wire.body.stream !== true || responses && wire.body.store !== false
    || wire.body.tools !== undefined || wire.body.tool_choice !== undefined || wire.body.previous_response_id !== undefined
    || (responses ? wire.body.messages : wire.body.input) !== undefined || typeof output !== 'number' || !Number.isInteger(output)
    || output < 1 || output > Math.min(8192, model.maxOutputTokens ?? 8192) || !pair.success
    || runtimeJsonHash({ system: pair.data[0].content, content: pair.data[1].content }) !== source.planHash) {
    return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原帧摘要与隔离材料、输出上限或模型线路不一致。')
  }
}

export function assertSummarySource(source: SummarySource, current: Awaited<ReturnType<typeof readExecutionStateInTransaction>>) {
  if (current.frame.state.phase !== 'idle' || current.frame.state.pendingOperationId || current.frame.revision !== source.revision
    || current.frame.snapshotHash !== source.snapshotHash || current.head.configurationHash !== source.configurationHash) {
    return runtimeError('RUNTIME_STATE_CONFLICT', '摘要来源的执行帧或模型配置已变化。')
  }
}

/** No main-model turn is consumed. The same frame can fund only one request,
 * even if new code, routing or personalization would build another prompt. */
export async function prepareSemanticModelOperation(lease: RunLeaseToken, source: SummarySource, input: {
  key: string; action: string; request: Prisma.InputJsonValue; price: TokenPrice; parentOperationId?: string
}) {
  source = summarySourceSchema.parse(source)
  const billing = tokenPriceSchema.parse(input.price)
  if (input.action !== SEMANTIC_ACTION || input.key !== summaryOperationKey(source) || input.parentOperationId) {
    return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '摘要请求缺少独立的原执行帧身份。')
  }
  return withRunLease(lease, async tx => {
    const current = await readExecutionStateInTransaction(tx, lease.taskRootId)
    assertSummarySource(source, current)
    assertSummaryRequest(input.request, source, current.configuration.model)
    const price = current.configuration.model.tokenPrice
    if (!price || runtimeJsonHash(price) !== runtimeJsonHash(billing) || billing.modelTier !== current.configuration.model.tier) {
      return runtimeError('RUNTIME_PRICE_INVALID', '摘要缺少原任务的冻结价目。')
    }
    return prepareOperationInTransaction(tx, lease, { key: input.key, kind: 'provider', action: SEMANTIC_ACTION,
      input: { source, billing, request: input.request } })
  })
}
