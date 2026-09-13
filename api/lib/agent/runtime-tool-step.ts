import { z } from 'zod'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { env } from '../../config/env.js'
import { requestToolApproval, pollToolApproval } from './runtime-approval.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { parseToolArgsTolerant } from './tool-argument-parser.js'
import { normalizeToolInput, validateToolInput } from './tools/input-validation.js'
import { rejectToolCursorCall } from './runtime-tool-cursor.js'
import { failedToolResultSchema, reduceExecutionReceipt } from './runtime-reducer.js'
import { readObservedBaseline } from './runtime-observed-baseline.js'
import { chapterReadTool, planReadTool, novelGetContextTool, chapterListSummariesTool, memorySearchTool } from './tools/read-tools.js'
import { chapterWriteTool, chapterAppendTool, chapterEditRangeTool, chapterCreateTool, chapterRenameTool } from './tools/chapter-tools.js'
import { executeDurableChapterRename } from './tools/durable-chapter.js'
import { planSaveTool, planRenameTool, planDeleteTool, memorySaveTool } from './tools/write-tools.js'
import { executeDurablePlanSave } from './tools/durable-plan.js'
import { executeDurableMemorySave } from './runtime-memory.js'
import { novelRenameTool, novelUpdateMetaTool, coverPromptSetTool } from './tools/novel-tools.js'
import { METADATA_ACTIONS, executeDurableMetadata } from './tools/durable-metadata.js'
import { settleProviderOperation } from './runtime-settlement.js'
import { volumeListTool, volumeCreateTool, structureOutlineTool, volumeUpdateTool, volumeMoveTool, volumeDeleteTool, chapterMoveTool, chapterMoveToVolumeTool, chapterSplitTool, chapterMergeTool } from './tools/structure-tools.js'
import { STRUCTURE_MUTATIONS, structureContentTargets } from './runtime-common.js'
import { executeDurableStructure } from './tools/durable-structure.js'
import type { AgentTool, ToolContext } from './tools/types.js'
import { taskContextListTool, taskContextReadTool, executionContextReadTool } from './tools/task-context-tools.js'
import { sessionHistorySearchTool, sessionMessageReadTool } from './tools/session-history-tools.js'
import { executeDurableRead } from './tools/durable-read.js'
import { todoWriteTool } from './tools/todo-tools.js'
import { executeDurableTodo, executeDurableDirective } from './tools/durable-todo.js'
import { storyCompilerPrepareTool, sceneTaskBuildTool, chapterBridgeGetTool, continuityValidateTool, chapterBridgeCommitTool } from './tools/story-compiler-tools.js'
import { executeDurableCompiler } from './tools/durable-compiler.js'
import { executeDurableContinuity } from './tools/durable-continuity.js'
import { readCompilerObservation } from './runtime-compiler-observation.js'
import { qualityAnalyzeTool } from './tools/humanity-quality-tools.js'
import { executeDurableQuality } from './tools/durable-quality.js'
import { askUserTool } from './tools/interact-tools.js'
import { executeDurableQuestion } from './runtime-question.js'
import { projectSearchTool, entityResolveTool, impactAnalyzeTool, structureValidateTool } from './tools/changeset-tools.js'
import { storyCharterGetTool, storyCharterSaveTool, readerPromiseSaveTool, readerPromiseUpdateTool } from './tools/story-compiler-tools.js'
import { qualityReportGetTool, characterVoiceGetTool, experienceAnchorGetTool } from './tools/humanity-quality-tools.js'
import { memoryReviewListTool, memoryEventSaveTool, memoryRelationSaveTool } from './tools/memory-tools.js'
import { directiveListTool, directiveSaveTool, directiveSupersedeTool } from './tools/directive-tools.js'
import { styleProfileGetTool, retrievalTraceReadTool, craftSearchTool, styleLeakageCheckTool } from './tools/craft-library-tools.js'
import { researchDossierGetTool, firstThreePrototypeGetTool } from './tools/research-dossier-tools.js'
import { novelImportTool } from './tools/import-tools.js'
import { executeDurableImport } from './runtime-import.js'

const HISTORY_READ_ACTIONS = ['task_context_list', 'task_context_read', 'session_history_search', 'session_message_read'] as const
const DOMAIN_READ_ACTIONS = ['craft_search', 'style_leakage_check', 'research_dossier_get', 'first_three_prototype_get', 'style_profile_get', 'retrieval_trace_read', 'memory_review_list', 'character_voice_get', 'experience_anchor_get', 'directive_list', 'project_search', 'entity_resolve', 'impact_analyze', 'structure_validate', 'story_charter_get', 'quality_report_get'] as const

function checkedAdapter<T>(tool: AgentTool<T>): AgentTool {
  return { ...tool, execute: (ctx, args) => tool.execute(ctx, tool.parameters.parse(args)) }
}
const adapters: ReadonlyMap<string, AgentTool> = new Map<string, AgentTool>([
  checkedAdapter(novelImportTool),
  checkedAdapter(projectSearchTool), checkedAdapter(entityResolveTool), checkedAdapter(impactAnalyzeTool), checkedAdapter(structureValidateTool),
  checkedAdapter(storyCharterGetTool), checkedAdapter(storyCharterSaveTool), checkedAdapter(readerPromiseSaveTool), checkedAdapter(readerPromiseUpdateTool), checkedAdapter(qualityReportGetTool),
  checkedAdapter(executionContextReadTool),
  checkedAdapter(memorySaveTool),
  checkedAdapter(memoryEventSaveTool), checkedAdapter(memoryRelationSaveTool),
  checkedAdapter(directiveListTool), checkedAdapter(directiveSaveTool), checkedAdapter(directiveSupersedeTool),
  checkedAdapter(styleProfileGetTool), checkedAdapter(retrievalTraceReadTool),
  checkedAdapter(craftSearchTool), checkedAdapter(styleLeakageCheckTool),
  checkedAdapter(researchDossierGetTool), checkedAdapter(firstThreePrototypeGetTool),
  checkedAdapter(memoryReviewListTool), checkedAdapter(characterVoiceGetTool), checkedAdapter(experienceAnchorGetTool),
  checkedAdapter(planRenameTool), checkedAdapter(planDeleteTool),
  checkedAdapter(askUserTool),
  checkedAdapter(chapterRenameTool),
  checkedAdapter(novelRenameTool), checkedAdapter(novelUpdateMetaTool), checkedAdapter(coverPromptSetTool),
  checkedAdapter(qualityAnalyzeTool),
  checkedAdapter(storyCompilerPrepareTool), checkedAdapter(sceneTaskBuildTool), checkedAdapter(chapterBridgeGetTool), checkedAdapter(continuityValidateTool), checkedAdapter(chapterBridgeCommitTool),
  checkedAdapter(todoWriteTool),
  checkedAdapter(taskContextListTool), checkedAdapter(taskContextReadTool), checkedAdapter(sessionHistorySearchTool), checkedAdapter(sessionMessageReadTool),
  checkedAdapter(structureOutlineTool),
  checkedAdapter(volumeUpdateTool), checkedAdapter(volumeMoveTool), checkedAdapter(volumeDeleteTool), checkedAdapter(chapterMoveTool), checkedAdapter(chapterMoveToVolumeTool), checkedAdapter(chapterSplitTool), checkedAdapter(chapterMergeTool),
  checkedAdapter(chapterReadTool), checkedAdapter(planReadTool), checkedAdapter(novelGetContextTool), checkedAdapter(chapterListSummariesTool), checkedAdapter(memorySearchTool), checkedAdapter(volumeListTool), checkedAdapter(volumeCreateTool), checkedAdapter(chapterCreateTool), checkedAdapter(chapterWriteTool), checkedAdapter(chapterAppendTool), checkedAdapter(chapterEditRangeTool), checkedAdapter(planSaveTool),
].map(tool => [tool.name, tool]))

/** One real tool step, selected exclusively from saved execution state.
 * Not yet the full scheduler: unadapted tools must not fall back to legacy effects. */
export async function executeDurableToolStep(token: RunLeaseToken, signal: AbortSignal) {
  const lease = { ...token }
  signal.throwIfAborted()
  const selected = await withRunLease(lease, async tx => {
    const current = await readExecutionStateInTransaction(tx, lease.taskRootId)
    let frame = current.frame
    if (frame.state.phase === 'awaiting_operation') {
      const pending = await tx.agentOperation.findUniqueOrThrow({ where: { id: frame.state.pendingOperationId! } })
      if (pending.kind === 'tool' && ['succeeded', 'failed'].includes(pending.status)) return { recover: { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, operationId: pending.id } }
      if (pending.kind === 'provider' && pending.status === 'succeeded') {
        const attempts = await tx.agentProviderAttempt.findMany({ where: { operationId: pending.id, status: 'succeeded', dispatchedAt: { not: null } }, take: 2 })
        if (attempts.length !== 1) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原模型成功回执不唯一，不能恢复下一步骤。')
        return { recover: { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, operationId: pending.id },
          settlement: { userId: lease.userId, attemptId: attempts[0].id, requestHash: attempts[0].requestHash } }
      }
      if (pending.kind !== 'tool' || pending.status !== 'prepared') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原操作尚待恢复或核对，不能选择下一工具。')
      const source = await readExecutionFrame(tx, lease.taskRootId, frame.revision - 1)
      if (source.state.phase !== 'idle' || pending.operationKey !== `exec:${source.state.nextOperationSequence}`
        || frame.state.nextOperationSequence !== source.state.nextOperationSequence + 1 || frame.state.turn !== source.state.turn
        || runtimeJson(frame.state.messages).hash !== runtimeJson(source.state.messages).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '工具准备状态缺少原准入位置。')
      frame = source
    }
    if (frame.state.phase !== 'idle') return { idle: true as const }
    let index = frame.state.messages.length - 1
    while (index >= 0 && frame.state.messages[index].role === 'tool') index--
    const assistant = frame.state.messages[index]
    const call = assistant?.role === 'assistant' ? assistant.toolCalls?.find(item => !frame.state.messages.slice(index + 1).some(message => message.role === 'tool' && message.toolCallId === item.id)) : undefined
    if (!call) return { idle: true as const }
    const cursor = { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }
    const grant = current.configuration.toolAuthority.find(item => item.name === call.name)
    const definition = current.configuration.tools.find(item => item.function.name === call.name)
    const tool = adapters.get(call.name)
    if (!grant || grant.permission === 'deny' || !definition || call.incomplete) return { reject: { cursor, callId: call.id } }
    if (!tool) return runtimeError('RUNTIME_TOOL_ADAPTER_REQUIRED', '此工具的持久适配尚未接入，不能执行旧效果路径。')
    if (runtimeJson(z.toJSONSchema(tool.parameters, { io: 'input' })).hash !== runtimeJson(definition.function.parameters).hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '工具 schema 与原任务不一致。')
    let raw: unknown
    try { raw = call.arguments ? parseToolArgsTolerant(call.arguments, false) : {} }
    catch { return { reject: { cursor, callId: call.id } } }
    const validated = validateToolInput(tool, normalizeToolInput(tool, raw))
    if (!validated.success) return { reject: { cursor, callId: call.id, tool } }
    const args = Object.fromEntries(Object.entries(validated.data as Record<string, unknown>).filter(([, value]) => value !== undefined))
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    const originalScope = taskSpecSchema.parse(root.specSnapshot).scope
    const originalChapterId = originalScope.selection?.chapterId ?? (originalScope.chapterIds?.length === 1 ? originalScope.chapterIds[0] : null)
    const ctx: ToolContext = { userId: lease.userId, runId: lease.runId, novelId: root.novelId, sessionId: root.sessionId,
      chapterId: originalChapterId, callId: call.id, mode: current.configuration.mode, creativeFreedom: current.configuration.creativeFreedom,
      qualityMode: current.configuration.qualityMode, protectedChapterIds: new Set(current.configuration.protectedChapterIds),
      toolAuthority: new Map(current.configuration.toolAuthority.map(item => [item.name, item])), signal, emit: () => {} }
    const capability = { lease, cursor, operationKey: `exec:${frame.state.nextOperationSequence}` }
    if (['execution_context_read', 'chapter_read', 'plan_read', 'novel_get_context', 'chapter_list_summaries', 'memory_search', 'volume_list', 'structure_outline', ...HISTORY_READ_ACTIONS, ...DOMAIN_READ_ACTIONS].includes(call.name)) ctx.durableRead = capability
    else if (call.name === 'ask_user') { /* Persistent question step below; no legacy waiter. */ }
    else if (call.name === 'novel_import') ctx.durableImport = capability
    else if ((METADATA_ACTIONS as readonly string[]).includes(call.name)) ctx.durableMetadata = capability
    else if (['memory_save', 'memory_event_save', 'memory_relation_save'].includes(call.name)) ctx.durableMemory = capability
    else if (['todo_write', 'directive_save', 'directive_supersede'].includes(call.name)) ctx.durableTask = capability
    else if (['story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'continuity_validate', 'chapter_bridge_commit', 'quality_analyze'].includes(call.name)) ctx.durableCompiler = { ...capability,
      baseline: ['scene_task_build', 'continuity_validate', 'chapter_bridge_commit', 'quality_analyze'].includes(call.name) ? await readCompilerObservation(tx, root.id, frame.revision, typeof args.compilationId === 'string' ? args.compilationId : undefined) : null }
    else if (call.name === 'chapter_create' || call.name === 'volume_create') ctx.durableCreate = capability
    else if (STRUCTURE_MUTATIONS.some(name => name === call.name)) {
      const baseline = await readObservedBaseline(tx, root.id, frame.revision, { kind: 'structure', id: root.novelId })
      if (baseline?.kind !== 'structure') return { reject: { cursor, callId: call.id, tool } }
      for (const id of structureContentTargets(call.name, args)) {
        if (!await readObservedBaseline(tx, root.id, frame.revision, { kind: 'chapter', id })) return { reject: { cursor, callId: call.id, tool } }
      }
      ctx.durableStructure = { ...capability, expectedHash: baseline.hash }
    }
    else if (['plan_save', 'plan_rename', 'plan_delete'].includes(call.name)) {
      const target = typeof args.planId === 'string' ? args.planId : null
      const baseline = target ? await readObservedBaseline(tx, root.id, frame.revision, { kind: 'plan', id: target }) : null
      if (target && baseline?.kind !== 'plan') return { reject: { cursor, callId: call.id, tool } }
      // An existing same-title plan must first be explicitly read, never silently overwritten.
      if (!target && await tx.agentArtifact.findFirst({ where: { title: String(args.title).trim(), artifactType: 'chapterPlan', metadata: { path: ['savedAsPlan'], equals: true }, run: { userId: lease.userId, novelId: root.novelId } } })) return { reject: { cursor, callId: call.id, tool } }
      ctx.durablePlan = { ...capability, expected: baseline?.kind === 'plan' ? { id: baseline.id, hash: baseline.hash } : { id: null, hash: null } }
    } else {
      const target = typeof args.chapterId === 'string' && args.chapterId.trim() ? args.chapterId.trim() : originalChapterId
      if (!target) return { reject: { cursor, callId: call.id, tool } }
      const baseline = await readObservedBaseline(tx, root.id, frame.revision, { kind: 'chapter', id: target })
      if (baseline?.kind !== 'chapter') return { reject: { cursor, callId: call.id, tool } }
      ctx.durableContent = { ...capability, chapterId: target, expectedRevision: baseline.revision }
    }
    return { tool, args, ctx, cursor, needsApproval: grant.permission === 'ask' || grant.alwaysConfirm }
  })
  if ('recover' in selected) {
    // Results can arrive after the worker dies between recording and reduction.
    // Recover the original bill/result without reconstructing or redispatching HTTP.
    const billing = 'settlement' in selected && selected.settlement ? await settleProviderOperation(selected.settlement) : undefined
    signal.throwIfAborted()
    return { kind: 'recovered' as const, frame: await reduceExecutionReceipt(lease, selected.recover!), ...(billing ? { billing } : {}) }
  }
  if ('reject' in selected) {
    const refusal = selected.reject!
    const rejected = await rejectToolCursorCall(lease, refusal.cursor, refusal.callId, refusal.tool)
    await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
    return { kind: 'tool' as const, result: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
  }
  if ('idle' in selected) return { kind: 'idle' as const }
  signal.throwIfAborted()
  if (selected.needsApproval) {
    const normalize = (raw: unknown) => {
      const parsed = selected.tool.parameters.parse(normalizeToolInput(selected.tool, raw)) as Record<string, unknown>
      return Object.fromEntries(Object.entries({ ...parsed,
        ...(selected.ctx.durableContent ? { chapterId: selected.ctx.durableContent.chapterId } : {}),
        ...(selected.ctx.durableCreate ? { title: String(parsed.title).trim() } : {}),
      }).filter(([, value]) => value !== undefined))
    }
    await requestToolApproval(lease, { ...selected.cursor, callId: selected.ctx.callId, timeoutMs: env.agentApprovalTimeoutMs, normalize })
    const approval = await pollToolApproval(lease, { ...selected.cursor, callId: selected.ctx.callId })
    if (approval.status === 'pending') return { kind: 'waiting_approval' as const, approvalId: approval.sourceEventId }
    if (approval.status === 'denied' || approval.status === 'expired') {
      // Record the decision before resolving model credentials/rates or reading
      // mutable business input inside a paid auxiliary-tool adapter.
      const rejected = await rejectToolCursorCall(lease, selected.cursor, selected.ctx.callId)
      await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
      return { kind: 'tool' as const, result: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
    }
    // Actual adapter checks the saved decision again at effect admission.
  }
  const historyAction = [...HISTORY_READ_ACTIONS, ...DOMAIN_READ_ACTIONS].find(name => name === selected.tool.name)
  if (selected.tool.name === 'ask_user') return executeDurableQuestion(lease, selected.cursor, selected.ctx, selected.tool, selected.args)
  if (selected.tool.name === 'novel_import') return executeDurableImport(selected.ctx, selected.tool, selected.args)
  if (historyAction) {
    const normalize = (raw: unknown) => Object.fromEntries(Object.entries(selected.tool.parameters.parse(normalizeToolInput(selected.tool, raw)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
    return { kind: 'tool' as const, result: await executeDurableRead(selected.ctx, historyAction, selected.args, normalize,
      tx => selected.tool.execute({ ...selected.ctx, durableRead: undefined, transaction: tx }, selected.args)) }
  }
  if (selected.ctx.durableTask) return { kind: 'tool' as const, result: selected.tool.name === 'todo_write'
    ? await executeDurableTodo(selected.ctx, selected.args) : await executeDurableDirective(selected.ctx, selected.tool, selected.args) }
  if (selected.ctx.durablePlan && (selected.tool.name === 'plan_rename' || selected.tool.name === 'plan_delete')) {
    const normalize = (raw: unknown) => selected.tool.parameters.parse(normalizeToolInput(selected.tool, raw))
    return { kind: 'tool' as const, result: await executeDurablePlanSave(selected.ctx, selected.args, normalize,
      tx => selected.tool.execute({ ...selected.ctx, durablePlan: undefined, transaction: tx }, selected.args), selected.tool.name) }
  }
  if (selected.ctx.durableMemory) return { kind: 'tool' as const, result: await executeDurableMemorySave(selected.ctx, selected.tool, selected.args) }
  if (selected.ctx.durableMetadata) return { kind: 'tool' as const, result: await executeDurableMetadata(selected.ctx, selected.tool, selected.args) }
  if (selected.tool.name === 'chapter_rename') return { kind: 'tool' as const, result: await executeDurableChapterRename(selected.ctx, selected.tool, selected.args) }
  if (selected.tool.name === 'continuity_validate') return { kind: 'tool' as const, result: await executeDurableContinuity(selected.ctx, selected.tool, selected.args) }
  if (selected.tool.name === 'quality_analyze') return { kind: 'tool' as const, result: await executeDurableQuality(selected.ctx, selected.tool, selected.args) }
  if (selected.ctx.durableCompiler) return { kind: 'tool' as const, result: await executeDurableCompiler(selected.ctx, selected.tool, selected.args) }
  return { kind: 'tool' as const, result: selected.ctx.durableStructure
    ? await executeDurableStructure(selected.ctx, selected.tool, selected.args)
    : await selected.tool.execute(selected.ctx, selected.args) }
}
