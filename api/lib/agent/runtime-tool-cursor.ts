import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { prepareOperationInTransaction, recordToolFailureInTransaction } from './runtime-operations.js'
import { parseToolArgsTolerant } from './tool-argument-parser.js'
import { coerceToolArgumentEnvelope } from './tools/argument-coercion.js'
import { normalizeToolInput, validateToolInput } from './tools/input-validation.js'
import type { AgentTool } from './tools/types.js'
import { assertToolApproval, readToolApprovalOutcome } from './runtime-approval.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { readObservedBaseline } from './runtime-observed-baseline.js'
import { STRUCTURE_MUTATIONS, structureContentTargets } from './runtime-common.js'

export type ToolExecutionCursor = { expectedRevision: number; expectedHash: string }
export const argumentNormalizationSchema = z.object({ version: z.literal(1), rawArguments: z.string(), normalizedArgsHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.number().int().nonnegative(), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

export const toolRejectionSchema = z.object({ version: z.literal(1), rawArguments: z.string(), incomplete: z.boolean(),
  code: z.enum(['TOOL_NOT_AUTHORIZED', 'TOOL_ARGUMENTS_INCOMPLETE', 'TOOL_ARGUMENTS_INVALID', 'TOOL_SCHEMA_INVALID', 'TOOL_APPROVAL_DENIED', 'TOOL_APPROVAL_EXPIRED', 'TOOL_BASELINE_REQUIRED', 'TOOL_TARGET_REQUIRED']),
  target: z.object({ kind: z.literal('plan'), id: z.string().min(1), title: z.string() }).strict().optional(),
  baseline: z.object({ kind: z.enum(['chapter', 'plan', 'structure']), id: z.string().nullable() }).strict().optional(),
  approval: z.object({ requestId: z.string(), decisionId: z.string(), decisionHash: z.string() }).strict().optional(),
  validation: z.object({ version: z.literal(1), schemaHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  sourceRevision: z.number().int().nonnegative(), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** This observes only a rejection proven from frozen input. No execution callback
 * is accepted, so an unknown effect cannot be relabeled as a harmless failure. */
export async function rejectToolCursorCall(token: RunLeaseToken, cursor: ToolExecutionCursor, callId: string, tool?: AgentTool) {
  token = { ...token }; cursor = { ...cursor }
  // Capture references before awaits; never resolve a different registry entry during replay.
  const validator = tool ? { name: tool.name, parameters: tool.parameters, coerceArgs: tool.coerceArgs } : undefined
  const schemaHash = validator ? runtimeJson(z.toJSONSchema(validator.parameters, { io: 'input' })).hash : undefined
  if (!Number.isSafeInteger(cursor.expectedRevision) || cursor.expectedRevision < 0) runtimeError('RUNTIME_STATE_INVALID', '工具拒绝位置无效。')
  return withRunLease(token, async tx => {
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    const frame = await readExecutionFrame(tx, token.taskRootId, cursor.expectedRevision)
    if (frame.snapshotHash !== cursor.expectedHash || frame.state.phase !== 'idle') runtimeError('RUNTIME_STATE_CONFLICT', '拒绝记录必须绑定原始空闲执行位置。')
    let index = frame.state.messages.length - 1
    while (index >= 0 && frame.state.messages[index].role === 'tool') index--
    const assistant = frame.state.messages[index]
    const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(item => !frame.state.messages.slice(index + 1)
      .some(message => message.role === 'tool' && message.toolCallId === item.id)) : undefined
    if (!call || call.id !== callId) return runtimeError('RUNTIME_STATE_CONFLICT', '不能拒绝其他轮次或已回答调用。')
    const grant = current.configuration.toolAuthority.find(item => item.name === call.name)
    const published = current.configuration.tools.find(tool => tool.function.name === call.name)
    let code: z.infer<typeof toolRejectionSchema>['code'] | undefined
    let validation: z.infer<typeof toolRejectionSchema>['validation']
    let validationHint = ''
    let approval: z.infer<typeof toolRejectionSchema>['approval']
    let baseline: z.infer<typeof toolRejectionSchema>['baseline']
    let explicitTarget: z.infer<typeof toolRejectionSchema>['target']
    if (!published || !grant || grant.permission === 'deny') code = 'TOOL_NOT_AUTHORIZED'
    else if (call.incomplete) code = 'TOOL_ARGUMENTS_INCOMPLETE'
    else {
      let parsed: unknown
      try { parsed = call.arguments ? parseToolArgsTolerant(call.arguments, false) : {} }
      catch { code = 'TOOL_ARGUMENTS_INVALID' }
      if (!code && validator) {
        if (validator.name !== call.name || schemaHash !== runtimeJson(published.function.parameters).hash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '字段校验器不匹配原工具合同，不能以新schema拒绝旧调用。')
        // An exception is an implementation fault, not proof of invalid user/model data.
        // Leave it for recovery instead of recording a deterministic schema rejection.
        const normalized = normalizeToolInput(validator, parsed)
        const validated = validateToolInput(validator, normalized)
        if (!validated.success) {
          code = 'TOOL_SCHEMA_INVALID'
          validation = { version: 1, schemaHash: schemaHash! }
          // Return bounded field-level feedback, not the original argument
          // payload, so the next turn can fix the error without guessing.
          validationHint = validated.error.issues.slice(0, 8)
            .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
            .join('；').slice(0, 1800)
        } else {
          const args = validated.data as Record<string, unknown>
          const scope = taskSpecSchema.parse(current.originalSpec).scope
          const chapterId = typeof args.chapterId === 'string' && args.chapterId.trim() ? args.chapterId.trim()
            : scope.selection?.chapterId ?? (scope.chapterIds?.length === 1 ? scope.chapterIds[0] : null)
          const target = ['chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_rename'].includes(call.name)
            ? { kind: 'chapter' as const, id: chapterId }
            : ['plan_save', 'plan_rename', 'plan_delete'].includes(call.name) && typeof args.planId === 'string' ? { kind: 'plan' as const, id: args.planId } : null
          if (target && (!target.id || !await readObservedBaseline(tx, token.taskRootId, frame.revision, { kind: target.kind, id: target.id }))) {
            code = 'TOOL_BASELINE_REQUIRED'
            baseline = target
          }
          if (!code && call.name === 'plan_save' && !args.planId) {
            const existing = await tx.agentArtifact.findFirst({ where: { title: String(args.title).trim(), artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true },
              run: { userId: token.userId, novelId: scope.novelId } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })
            if (existing) { code = 'TOOL_TARGET_REQUIRED'; explicitTarget = { kind: 'plan', id: existing.id, title: existing.title } }
          }
          if (!code && STRUCTURE_MUTATIONS.some(name => name === call.name)) {
            if (!await readObservedBaseline(tx, token.taskRootId, frame.revision, { kind: 'structure', id: scope.novelId })) {
              code = 'TOOL_BASELINE_REQUIRED'; baseline = { kind: 'structure', id: scope.novelId }
            } else for (const id of structureContentTargets(call.name, args)) {
              if (!await readObservedBaseline(tx, token.taskRootId, frame.revision, { kind: 'chapter', id })) {
                code = 'TOOL_BASELINE_REQUIRED'; baseline = { kind: 'chapter', id }; break
              }
            }
          }
        }
      }
    }
    if (!code && grant && (grant.permission === 'ask' || grant.alwaysConfirm)) {
      const outcome = await readToolApprovalOutcome(tx, token, frame.snapshotHash, call.id, call.name, call.arguments)
      if (outcome && (outcome.status === 'denied' || outcome.status === 'expired') && outcome.decision) {
        code = outcome.status === 'expired' ? 'TOOL_APPROVAL_EXPIRED' : 'TOOL_APPROVAL_DENIED'
        approval = { requestId: outcome.request.id, decisionId: outcome.decision.id, decisionHash: runtimeJson(outcome.decision.payload).hash }
      }
    }
    if (!code) return runtimeError('RUNTIME_STATE_CONFLICT', '未确认拒绝原因，不能跳过执行或审批。')
    const rejection = { version: 1 as const, rawArguments: call.arguments, incomplete: Boolean(call.incomplete), code, ...(explicitTarget ? { target: explicitTarget } : {}), ...(baseline ? { baseline } : {}), ...(validation ? { validation } : {}), ...(approval ? { approval } : {}),
      sourceRevision: frame.revision, sourceSnapshotHash: frame.snapshotHash }
    const operation = await prepareOperationInTransaction(tx, token, { key: `exec:${frame.state.nextOperationSequence}`, kind: 'tool', action: call.name,
      input: { callId, args: {}, rejection } })
    const pending = await saveExecutionStateInTransaction(tx, token, { ...cursor, snapshot: { ...frame.state, phase: 'awaiting_operation',
      pendingOperationId: operation.id, nextOperationSequence: frame.state.nextOperationSequence + 1 } })
    const summary = explicitTarget ? '同名计划已存在，需要明确目标' : baseline ? '需要先读取目标，未执行写入' : code === 'TOOL_APPROVAL_DENIED' ? '用户拒绝本次操作' : code === 'TOOL_APPROVAL_EXPIRED' ? '审批超时，未执行' : code === 'TOOL_NOT_AUTHORIZED' ? '当前任务未授权此工具' : code === 'TOOL_ARGUMENTS_INCOMPLETE' ? '工具参数未生成完整' : code === 'TOOL_SCHEMA_INVALID' ? '参数校验失败' : '参数解析失败'
    const output = explicitTarget ? `本次未执行。同名计划已存在，planId=${explicitTarget.id}。请先用 plan_read 读取核对，再在 plan_save 中明确传入该 planId 修订；不凭标题覆盖，也不要重复创建。`
      : baseline ? `本次未执行，原正文、结构或计划未改动。请先用 ${baseline.kind === 'structure' ? 'volume_list 或 structure_outline' : baseline.kind === 'chapter' ? 'chapter_read' : 'plan_read'} 读取${baseline.id ? `目标 ${baseline.id}` : '当前任务范围内的明确目标'}，再根据保存的读取观察重新发起写入。不能使用其他任务的历史读取代替。`
      : approval ? '本次未执行。审批已拒绝或超时；不得换工具、换窗口或重复发起相同操作绕过用户决定。说明未完成部分，等待明确的新指示。'
      : code === 'TOOL_NOT_AUTHORIZED' ? '本次未执行。只能使用当前任务授权的工具，不得从历史任务或其他窗口恢复权限。'
      : code === 'TOOL_SCHEMA_INVALID' ? `本次未执行，已有内容未改动。参数字段校验失败：${validationHint}。请按原工具结构修正这些字段后再调用，不重复发送相同参数，也不要删除必要场景来绕过校验。`
      : code === 'TOOL_ARGUMENTS_INCOMPLETE' && call.name === 'plan_save' ? '计划未写入。先plan_read核对已保存部分；长计划按完整小节分次保存，每次建议不超过2000字符且独立调用。首次保存首节，后续mode=append并携带planId及contentHash作为expectedContentHash；完成全部小节才可汇报完成。不能补括号执行残文、重复已保存内容或缩短原目标。'
      : '本次未执行。请按公布的工具参数结构重新生成完整参数，不重复发送相同损坏参数。'
    const receipt = await recordToolFailureInTransaction(tx, token, { operationId: operation.id, inputHash: operation.inputHash, code, output, summary })
    return { operation, pending, receipt }
  })
}

/** normalize is a pure server schema/default transform, not a tool execution.
 * Its exact input/output linkage is saved before any business effect. */
export async function prepareToolCursorOperation(token: RunLeaseToken, cursor: ToolExecutionCursor, input: {
  key: string; action: string; callId: string; targetId: string; operationInput: Prisma.InputJsonValue; effectiveArgs: unknown;
  requireApproval?: boolean;
  effectDomain?: 'chapter' | 'plan' | 'read' | 'structure' | 'task' | 'compiler' | 'memory' | 'metadata' | 'import';
  normalize: (parsed: unknown) => unknown
}) {
  token = { ...token }; cursor = { ...cursor }
  input = { ...input, operationInput: runtimeJson(input.operationInput).value, effectiveArgs: runtimeJson(input.effectiveArgs).value }
  if (!Number.isSafeInteger(cursor.expectedRevision) || cursor.expectedRevision < 0) runtimeError('RUNTIME_STATE_INVALID', '工具执行位置无效。')
  return withRunLease(token, async tx => {
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    const frame = await readExecutionFrame(tx, token.taskRootId, cursor.expectedRevision)
    if (frame.snapshotHash !== cursor.expectedHash || frame.state.phase !== 'idle' || input.key !== `exec:${frame.state.nextOperationSequence}`) runtimeError('RUNTIME_STATE_CONFLICT', '工具必须从原执行位置准入。')
    const grant = current.configuration.toolAuthority.find(item => item.name === input.action)
    if (input.action === 'novel_import' && input.effectDomain !== 'import') runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '导入不能通过只读或旧写入适配器执行。')
    if (input.effectDomain === 'import' && (input.action !== 'novel_import' || input.targetId !== token.taskRootId)) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '导入能力仅允许原任务的专用导入流程。')
    const plan = input.effectDomain === 'plan'
    const read = input.effectDomain === 'read'
    const metadata = input.effectDomain === 'metadata'
    if (metadata && (!['novel_rename', 'novel_update_meta', 'cover_prompt_set', 'story_charter_save', 'reader_promise_save', 'reader_promise_update'].includes(input.action) || input.targetId !== token.taskRootId)) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '作品设置能力不能用于其他动作。')
    const memory = input.effectDomain === 'memory'
    if (memory && (!['memory_save', 'memory_event_save', 'memory_relation_save'].includes(input.action) || input.targetId !== token.taskRootId)) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '记忆能力仅允许原任务保存记忆。')
    const task = input.effectDomain === 'task' && ['todo_write', 'directive_save', 'directive_supersede'].includes(input.action) && input.targetId === token.taskRootId
    if (input.effectDomain === 'task' && !task) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '任务状态能力仅允许更新原任务待办。')
    const structure = input.effectDomain === 'structure'
    const compiler = input.effectDomain === 'compiler'
    if (compiler && (!['story_compiler_prepare', 'scene_task_build', 'continuity_validate', 'chapter_bridge_commit', 'quality_analyze'].includes(input.action) || input.targetId !== token.taskRootId)) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '编译能力只允许本任务的准备、场景构建、连续性/质量检查与终态提交。')
    if ((!read && !task && !memory && (plan || (metadata && ['story_charter_save', 'reader_promise_save', 'reader_promise_update'].includes(input.action)) ? !['plan', 'build'].includes(current.configuration.mode) : current.configuration.mode !== 'build')) || !grant || grant.permission === 'deny'
      || (!plan && !read && !structure && !task && !compiler && !memory && !metadata && current.configuration.protectedChapterIds.includes(input.targetId))) runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原冻结授权不允许此次工具效果。')
    let index = frame.state.messages.length - 1
    while (index >= 0 && frame.state.messages[index].role === 'tool') index--
    const assistant = frame.state.messages[index]
    const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(item => !frame.state.messages.slice(index + 1)
      .some(message => message.role === 'tool' && message.toolCallId === item.id)) : undefined
    if (!call || call.id !== input.callId || call.name !== input.action || call.incomplete) runtimeError('RUNTIME_STATE_CONFLICT', '工具不是当前下一条完整待执行调用。')
    let normalized: unknown
    try { normalized = input.normalize(coerceToolArgumentEnvelope(call!.arguments ? parseToolArgsTolerant(call!.arguments, false) : {})) }
    catch { return runtimeError('RUNTIME_INPUT_INVALID', '原始工具参数不能安全归一化，未执行。') }
    const normalizedArgsHash = runtimeJson(normalized).hash
    if (normalizedArgsHash !== runtimeJson(input.effectiveArgs).hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '实际工具参数与原调用的归一化结果不同。')
    if (input.requireApproval || grant!.permission === 'ask' || grant!.alwaysConfirm) await assertToolApproval(tx, token, frame.snapshotHash, input.callId, input.action, call!.arguments, normalizedArgsHash)
    const base = input.operationInput
    if (!base || typeof base !== 'object' || Array.isArray(base)) return runtimeError('RUNTIME_INPUT_INVALID', '工具操作需要对象输入。')
    const envelope = base as Prisma.InputJsonObject
    if (envelope.callId !== input.callId || runtimeJson(envelope.args).hash !== normalizedArgsHash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '操作信封与归一化参数不同。')
    const normalization = { version: 1 as const, rawArguments: call!.arguments, normalizedArgsHash,
      sourceRevision: frame.revision, sourceSnapshotHash: frame.snapshotHash }
    const operation = await prepareOperationInTransaction(tx, token, { key: input.key, kind: 'tool', action: input.action, input: { ...base, normalization } })
    const pending = await saveExecutionStateInTransaction(tx, token, { ...cursor, snapshot: { ...frame.state, phase: 'awaiting_operation',
      pendingOperationId: operation.id, nextOperationSequence: frame.state.nextOperationSequence + 1 } })
    return { operation, pending }
  })
}
