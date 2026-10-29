import { z } from 'zod'
import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'
import { retainedFindingSchema } from './tools/chapter-arguments.js'
import { durableChatResultSchema, runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readExecutionFrame } from './runtime-state.js'
import { toOpenAIToolPresentation } from './tool-schema.js'

export type NativeToolView = { type: 'function'; function: { name: string; strict?: boolean; description: string; parameters: Record<string, unknown> } }
const simplified = new Set(['chapter_write', 'chapter_append', 'chapter_edit_range', 'continuity_validate', 'chapter_bridge_commit'])
const retiredFields: Record<string, readonly string[]> = {
  chapter_write: ['writing'], chapter_append: ['writing'], chapter_edit_range: ['writing'],
  continuity_validate: ['terminalState', 'inheritedProofs', 'terminalPatch'],
  chapter_bridge_commit: ['decisionOnly', 'terminalState', 'exitState', 'lastUnfinishedAction', 'openingStructure', 'endingStructure', 'hookDecision', 'delayedHookReason'],
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const properties = (value: Record<string, unknown>) => object(value.properties)


// Exact 941 built-in field. Genuine custom descriptions, item constraints or
// narrower array limits remain part of the original source view.
const retiredRetentionField = z.toJSONSchema(z.array(retainedFindingSchema).max(40).optional().describe('不能安全改动的当前意见逐项留置：continuity 的 reportId 使用工具给出的检查绑定，findingId 为从0开始的索引；quality 使用当前报告ID与意见ID。必须写明具体安全原因，留置不表示问题已修复'), { io: 'input' }) as Record<string, unknown>
delete retiredRetentionField.$schema

/** Presentation only. The verified original configuration remains immutable.
 * Extra user fields and actual input constraints survive; retired platform
 * coordination fields are the only fields removed from these built-ins. */
export function projectNativeToolViews(frozen: readonly NativeToolView[], current: readonly AgentTool[], scope: TaskSpec['scope']): NativeToolView[] {
  const byName = new Map(current.map(tool => [tool.name, tool]))
  return frozen.map(originalDefinition => {
    // A new model request may clarify the old Chat default, without changing
    // the frozen configuration or an already prepared request. Explicit
    // provider/custom strict choices remain authoritative.
    const definition = originalDefinition.function.strict === undefined
      ? { ...originalDefinition, function: { ...originalDefinition.function, strict: false } } : originalDefinition
    const tool = byName.get(definition.function.name)
    if (!tool || !simplified.has(tool.name)) return definition
    const next = toOpenAIToolPresentation(tool, scope), original = definition.function.parameters
    const old = properties(original), present = properties(next.parameters), removed = new Set(retiredFields[tool.name])
    const custom = Object.fromEntries(Object.entries(old).filter(([key]) => !(key in present) && !removed.has(key)))
    const fields = Object.fromEntries(Object.entries(present).map(([key, value]) => {
      const retiredPlatformLimit = key === 'retainedFindings' && old[key] && runtimeJson(old[key]).hash === runtimeJson(retiredRetentionField).hash
      return [key, old[key] && !retiredPlatformLimit && runtimeJson(old[key]).hash !== runtimeJson(value).hash
        ? { allOf: [value, old[key]] } : value]
    }))
    const legacySummary = tool.name === 'chapter_bridge_commit'
      && Object.keys(old).some(key => removed.has(key))
      && runtimeJson(old.chapterSummary ?? null).hash === runtimeJson({ type: 'string', minLength: 1, maxLength: 2000 }).hash
    const required = [...new Set([...(Array.isArray(next.parameters.required) ? next.parameters.required as string[] : []),
      ...(Array.isArray(original.required) ? original.required.filter((key): key is string => typeof key === 'string' && (key in custom || key in present) && !(legacySummary && key === 'chapterSummary')) : [])])]
    const parameters: Record<string, unknown> = { ...original, ...next.parameters, ...(original.additionalProperties === false ? { additionalProperties: false } : {}), properties: { ...fields, ...custom } }
    delete parameters.required
    if (required.length) parameters.required = required
    return { ...definition, function: { ...definition.function, description: next.description, parameters } }
  })
}

export function usesCurrentNativeView(action: string): boolean { return simplified.has(action) }

export function toolWithNativeView<T extends Pick<AgentTool, 'name' | 'parameters'>>(tool: T, definition: NativeToolView): T {
  if (tool.name !== definition.function.name) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '工具名称与实际模型视图不同。')
  return { ...tool, parameters: z.intersection(tool.parameters, z.fromJSONSchema(definition.function.parameters)) }
}

export async function currentNativeToolViews(frozen: readonly NativeToolView[], scope: TaskSpec['scope']) {
  const { getToolByName } = await import('./tools/registry.js')
  return projectNativeToolViews(frozen, frozen.flatMap(definition => {
    const tool = getToolByName(definition.function.name)
    return tool ? [tool] : []
  }), scope)
}

/** The exact previous Chat presentation: only this release's newly explicit
 * non-strict default is removed. Original explicit choices stay significant. */
export function previousImplicitStrictToolViews(frozen: readonly NativeToolView[], current: readonly NativeToolView[]): NativeToolView[] {
  return current.map((definition, index) => {
    if (frozen[index].function.strict !== undefined || definition.function.strict !== false) return definition
    const { strict: _strict, ...fn } = definition.function
    return { ...definition, function: fn }
  })
}

export async function needsNativeToolProjection(frozen: readonly NativeToolView[], scope: TaskSpec['scope'], action: string): Promise<boolean> {
  if (!usesCurrentNativeView(action)) return false
  const original = frozen.find(tool => tool.function.name === action)
  const current = previousImplicitStrictToolViews(frozen, await currentNativeToolViews(frozen, scope)).find(tool => tool.function.name === action)
  return !!original && !!current && runtimeJson(original).hash !== runtimeJson(current).hash
}

export function hasRetiredNativeArguments(action: string, args: unknown): boolean {
  return (retiredFields[action] ?? []).some(key => Object.prototype.hasOwnProperty.call(object(args), key))
}

const toolViews = z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string(), strict: z.boolean().optional(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }).strict() }).strict())
const successful = z.object({ outcome: z.literal('succeeded'), result: durableChatResultSchema }).strict()

export function readFrozenModelToolViews(snapshot: unknown): NativeToolView[] {
  const parsed = z.object({ input: z.object({ request: z.object({ body: z.record(z.string(), z.unknown()) }) }) }).safeParse(snapshot)
  if (!parsed.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '原主模型请求快照缺少实际请求体。')
  const tools = toolViews.safeParse(parsed.data.input.request.body.tools ?? [])
  if (!tools.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '原主模型工具视图损坏。')
  return tools.data
}

/** Follow the actual assistant boundary, never a 'latest request' lookup.
 * Source frames, operation/request/result hashes and the result event all
 * authenticate the exact tool list that produced this assistant turn. */
export async function readAssistantToolViews(tx: RuntimeTx, taskRootId: string, frame: Awaited<ReturnType<typeof readExecutionFrame>>): Promise<NativeToolView[]> {
  let index = frame.state.messages.length - 1
  while (index >= 0 && frame.state.messages[index].role === 'tool') index--
  const assistant = frame.state.messages[index]
  if (assistant?.role !== 'assistant') return runtimeError('RUNTIME_SOURCE_REQUIRED', '当前工具缺少真实助手调用来源。')
  const prefix = runtimeJson(frame.state.messages.slice(0, index + 1)).hash
  let boundary = frame
  while (boundary.revision > 0) {
    const before = await readExecutionFrame(tx, taskRootId, boundary.revision - 1)
    if (before.state.messages.length > index && runtimeJson(before.state.messages.slice(0, index + 1)).hash === prefix) {
      boundary = before; continue
    }
    if (before.state.phase !== 'awaiting_operation' || !before.state.pendingOperationId
      || before.state.messages.length !== index || runtimeJson(before.state.messages).hash !== runtimeJson(frame.state.messages.slice(0, index)).hash
      || boundary.state.phase !== 'idle' || boundary.state.messages.length !== index + 1) return runtimeError('RUNTIME_SOURCE_REQUIRED', '助手调用未绑定原模型回执帧。')
    const operation = await tx.agentOperation.findFirst({ where: { id: before.state.pendingOperationId, taskRootId, kind: 'provider', parentOperationId: null } })
    if (!operation || operation.operationKey !== `exec:${before.state.nextOperationSequence - 1}` || operation.status !== 'succeeded' || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原助手模型操作缺失或损坏。')
    const attempts = await tx.agentProviderAttempt.findMany({ where: { operationId: operation.id, status: 'succeeded', dispatchedAt: { not: null } }, take: 2 })
    if (attempts.length !== 1) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原助手模型结果不唯一。')
    const attempt = attempts[0], parsed = successful.safeParse(attempt.result)
    if (!parsed.success || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash
      || !attempt.requestSnapshot || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原助手模型请求或结果损坏。')
    const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
    if (!event || event.taskRootId !== taskRootId || event.operationId !== operation.id || event.type !== 'provider.result.recorded'
      || runtimeJson(event.payload).hash !== runtimeJson({ attemptId: attempt.id, status: 'succeeded', resultHash: attempt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原助手模型结果缺少对应持久事件。')
    const result = parsed.data.result
    const projected = { role: 'assistant', content: result.content || null, reasoning: result.reasoning,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) }
    const legacyProjected = { ...projected } as Record<string, unknown>
    if (result.reasoning === '') delete legacyProjected.reasoning
    if (runtimeJson(projected).hash !== runtimeJson(assistant).hash
      && (result.reasoning !== '' || runtimeJson(legacyProjected).hash !== runtimeJson(assistant).hash)) return runtimeError('RUNTIME_RECEIPT_INVALID', '当前助手调用不是原模型结果。')
    const request = object(object(attempt.requestSnapshot).request)
    if (runtimeJson(request).hash !== runtimeJson(object(object(operation.inputSnapshot).input).request).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原助手请求不属于对应模型操作。')
    return toolViews.parse(object(request.body).tools ?? [])
  }
  return runtimeError('RUNTIME_SOURCE_REQUIRED', '没有产生当前助手调用的模型请求。')
}

/** The source view must be an exact authenticated historical/current view;
 * provider evidence cannot add tool authority. */
export async function verifiedAssistantToolViews(tx: RuntimeTx, taskRootId: string, frame: Awaited<ReturnType<typeof readExecutionFrame>>,
  frozen: readonly NativeToolView[], scope: TaskSpec['scope']): Promise<NativeToolView[]> {
  const source = await readAssistantToolViews(tx, taskRootId, frame)
  const hash = runtimeJson(source).hash
  if (hash === runtimeJson(frozen).hash) return source
  const current = await currentNativeToolViews(frozen, scope)
  if (hash === runtimeJson(current).hash) return source
  // Previous releases projected the same built-in fields but left Chat's
  // non-strict default implicit. Authenticate that exact view as well when
  // consuming an already paid assistant result. Never strip an explicit
  // original strict choice or normalize any source request in place.
  const previous = previousImplicitStrictToolViews(frozen, current)
  if (hash !== runtimeJson(previous).hash) {
    return runtimeError('RUNTIME_IDENTITY_CONFLICT', '实际模型工具视图不属于原配置或当前投影。')
  }
  return source
}
