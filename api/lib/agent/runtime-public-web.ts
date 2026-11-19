import type { AgentOperation } from '@prisma/client'
import { z } from 'zod'
import type { AgentStreamEventBody, AgentToolDisplayPayload } from '../../../shared/contracts/index.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { DataAccessError } from '../prisma.js'
import { ToolModelConfigurationError } from '../tool-model-config.js'
import { readHumanAdmission } from './goal-activation-authority.js'
import { readEffectiveNativeTooling } from './native-tool-policy.js'
import { mayAutoVerifyWeb, publicWebAuthorityMessage, publicWebCallId, publicWebObservation, publicWebPendingNotice, publicWebReadSteps, type PublicWebStep } from './public-web-verification.js'
import { recordResearchReadOutcome } from './research-sources.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withLeaseHeartbeat } from './runtime-heartbeat.js'
import { withRunLease, withRunLeaseInTransaction, type RunLeaseToken } from './runtime-lease.js'
import { commitOperationEffectInTransaction, prepareOperationInTransaction } from './runtime-operations.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { readPublicWebStepDisposition, webReadTool, webSearchTool } from './tools/search-tools.js'
import type { ToolContext, ToolResult } from './tools/types.js'

const actions = ['public_web_search', 'public_web_read']
const inputSchema = z.object({ input: z.object({ callId: z.string(), step: z.discriminatedUnion('name', [
  z.object({ name: z.literal('web_search'), args: webSearchTool.parameters }),
  z.object({ name: z.literal('web_read'), args: z.object({ sourceId: z.string() }).strict() }),
]) }).strict() })
const receiptSchema = z.object({ toolResult: z.object({
  output: z.string(), summary: z.string(), outcome: z.literal('failed').optional(),
  failureCode: z.string().optional(), display: z.custom<AgentToolDisplayPayload>().optional(),
}) })
type State = Awaited<ReturnType<typeof readExecutionStateInTransaction>>
type Frame = State['frame']

export function isDurablePublicWebOperation(operation: Pick<AgentOperation, 'kind' | 'action'>) {
  return operation.kind === 'internal' && actions.includes(operation.action)
}

function actionFor(step: PublicWebStep) {
  return step.name === 'web_search' ? 'public_web_search' : 'public_web_read'
}

function readStep(operation: AgentOperation) {
  const value = inputSchema.safeParse(operation.inputSnapshot)
  if (!isDurablePublicWebOperation(operation) || !value.success || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || operation.action !== actionFor(value.data.input.step) || value.data.input.callId !== publicWebCallId(operation.taskRootId, value.data.input.step)) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '原平台查证操作与冻结输入不一致。')
  }
  return value.data.input
}

async function verifiedPublicScope(tx: RuntimeTx, lease: RunLeaseToken, state: State) {
  const spec = taskSpecSchema.parse(state.originalSpec)
  if (!spec.publicWebQuestion || lease.parent) return null
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
  const source = await tx.agentMessage.findFirst({ where: { id: root.sourceMessageId, role: 'user', sessionId: root.sessionId,
    run: { userId: lease.userId, novelId: root.novelId, taskRootId: root.id, session: { spawnedFromRunId: null }, goalExecution: null } },
    select: { run: { select: { startRequest: true } } } })
  if (readHumanAdmission(source?.run.startRequest)?.request.publicWebQuestion !== spec.publicWebQuestion) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '平台查证缺少原作者单独提供的公开检索词。')
  }
  return { root, spec, question: spec.publicWebQuestion }
}

function readReceipt(result: unknown) {
  const checked = receiptSchema.safeParse(result)
  if (!checked.success) return runtimeError('RUNTIME_RECEIPT_INVALID', '原平台查证回执格式不一致。')
  return checked.data.toolResult
}

/** Create from the original author option and the actual prior Search receipt.
 * Store the cursor before any network work so a new owner uses the same slot. */
export async function prepareDurablePublicWeb(lease: RunLeaseToken, expected: Frame) {
  return withRunLease(lease, async tx => {
    const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const scope = await verifiedPublicScope(tx, lease, state)
    if (!scope || state.frame.revision !== expected.revision || state.frame.snapshotHash !== expected.snapshotHash) return null
    const frame = state.frame
    if (frame.state.phase !== 'idle') return null
    const operations = await tx.agentOperation.findMany({ where: { taskRootId: scope.root.id, kind: 'internal', action: { in: actions } },
      include: { effectReceipt: true } })
    let step: PublicWebStep | undefined = { name: 'web_search', args: { query: scope.question, maxResults: 6 } }
    let parentOperationId: string | undefined
    if (operations.length) {
      const search = operations.find(operation => operation.action === 'public_web_search')
      if (!search?.effectReceipt || search.status !== 'succeeded' || runtimeJson(search.effectReceipt.result).hash !== search.effectReceipt.resultHash
        || runtimeJson(readStep(search).step).hash !== runtimeJson(step).hash) {
        return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '平台查证原搜索尚待核对。')
      }
      const result = readReceipt(search.effectReceipt.result)
      const done = new Set(operations.map(operation => readStep(operation).callId))
      step = result.outcome === 'failed' ? undefined
        : publicWebReadSteps(result.display).find(candidate => !done.has(publicWebCallId(scope.root.id, candidate)))
      parentOperationId = search.id
    }
    if (!step) return null
    const operation = await prepareOperationInTransaction(tx, lease, { key: `exec:${frame.state.nextOperationSequence}`,
      kind: 'internal', action: actionFor(step), parentOperationId,
      input: runtimeJson({ step, callId: publicWebCallId(scope.root.id, step) }).value })
    await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
      snapshot: { ...frame.state, phase: 'awaiting_operation', pendingOperationId: operation.id, nextOperationSequence: frame.state.nextOperationSequence + 1 } })
    return operation
  })
}

export async function executeDurablePublicWeb(lease: RunLeaseToken, operation: AgentOperation, signal: AbortSignal) {
  return withLeaseHeartbeat(lease, signal, async signal => {
    const { step, callId } = readStep(operation)
    const search = step.name === 'web_search'
    const kind = search ? 'search' as const : 'read' as const
    const readCurrent = async (tx: RuntimeTx) => {
      signal.throwIfAborted()
      const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
      const scope = await verifiedPublicScope(tx, lease, state)
      const current = await tx.agentOperation.findUnique({ where: { id: operation.id } })
      if (!scope || current?.status !== 'prepared' || current.inputHash !== operation.inputHash
        || state.frame.state.pendingOperationId !== operation.id || current.originRunId !== operation.originRunId
        || step.name === 'web_search' && step.args.query !== scope.question) {
        return runtimeError('RUNTIME_STATE_CONFLICT', '平台查证不在原任务待执行位置。')
      }
      if (step.name === 'web_read') {
        const parent = current.parentOperationId && await tx.agentOperation.findFirst({ where: {
          id: current.parentOperationId, taskRootId: scope.root.id, kind: 'internal', action: 'public_web_search', status: 'succeeded',
        }, include: { effectReceipt: true } })
        const receipt = parent && parent.effectReceipt
        if (!receipt || runtimeJson(receipt.result).hash !== receipt.resultHash
          || !publicWebReadSteps(readReceipt(receipt.result).display).some(candidate => candidate.args.sourceId === step.args.sourceId)) {
          return runtimeError('RUNTIME_RECEIPT_INVALID', '平台查证的网页不在原搜索回执的可核验结果中。')
        }
      }
      return { ...scope, state }
    }
    const permits = async (tx: RuntimeTx, current: Awaited<ReturnType<typeof readCurrent>>) => {
      if (current.spec.networkAccess === 'denied' || !search && current.spec.researchReadAccess === 'denied') return false
      const tooling = await readEffectiveNativeTooling(tx, lease, current.state.configuration, current.spec)
      return mayAutoVerifyWeb(current.state.configuration.toolAuthority.find(grant => grant.name === step.name))
        && mayAutoVerifyWeb(tooling.toolAuthority.find(grant => grant.name === step.name))
    }
    const initial = await withRunLease(lease, readCurrent)
    const owner = { userId: lease.userId, runId: operation.originRunId, novelId: initial.root.novelId, sessionId: initial.root.sessionId, callId }
    const deniedCode = 'RESEARCH_VERIFICATION_PERMISSION'
    const denied = async (tx: RuntimeTx): Promise<ToolResult> => {
      const disposition = await readPublicWebStepDisposition(owner, step, initial.question, tx)
      if (disposition === 'pending') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', publicWebPendingNotice)
      return { outcome: 'failed', failureCode: deniedCode, summary: '联网查证权限不足', output: publicWebAuthorityMessage(kind, disposition === 'settled') }
    }
    let projected: Frame | undefined
    const finish = (work: (tx: RuntimeTx) => Promise<ToolResult>, verify: boolean) => withRunLease(lease, async tx => {
      const current = await readCurrent(tx), frame = current.state.frame
      const receipt = await commitOperationEffectInTransaction(tx, lease, operation.id, operation.inputHash, async tx => {
        const result = verify && !await permits(tx, current) ? await denied(tx) : await work(tx)
        signal.throwIfAborted()
        return runtimeJson({ toolResult: { ...result, summary: result.summary ?? '联网查证' } }).value
      })
      const result = readReceipt(receipt.result)
      projected = await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
        snapshot: { ...frame.state, phase: 'idle', pendingOperationId: null,
          messages: [...frame.state.messages, { role: 'user', content: publicWebObservation(step.name, result.output, result.outcome !== 'failed') }] } })
      return result
    })
    const ctx: ToolContext = { ...owner, chapterId: null, mode: initial.state.configuration.mode, creativeFreedom: initial.state.configuration.creativeFreedom,
      qualityMode: initial.state.configuration.qualityMode, signal, emit: () => {}, platformWebVerification: true,
      publicWebSearchQuestion: initial.question,
      webAdmission: (tx, work) => withRunLeaseInTransaction(tx, lease, async tx => {
        if (!await permits(tx, await readCurrent(tx))) throw new DataAccessError(403, deniedCode, (await denied(tx)).output)
        const result = await work()
        signal.throwIfAborted()
        return result
      }),
      webProjection: work => finish(tx => work({ ...ctx, transaction: tx, webAdmission: undefined, webProjection: undefined }), true),
    }
    try {
      if (!await withRunLease(lease, async tx => permits(tx, await readCurrent(tx)))) await finish(denied, false)
      else {
        const result = step.name === 'web_search' ? await webSearchTool.execute(ctx, step.args) : await webReadTool.execute(ctx, step.args)
        if (!projected) await finish(async () => result, true)
      }
    } catch (error) {
      if (error instanceof DataAccessError && ['CREDIT_WEB_TOOL_PENDING', 'RESEARCH_REQUEST_UNCERTAIN', 'RESEARCH_REQUEST_ALREADY_RESERVED'].includes(error.code)) {
        return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', publicWebPendingNotice)
      }
      const known = error instanceof ToolModelConfigurationError || error instanceof DataAccessError
        && (/^(WEB_(SEARCH|READ)_|RESEARCH_)/u.test(error.code) || ['CREDIT_WEB_TOOL_FAILED', 'CREDITS_EXHAUSTED', 'CREDITS_RESERVED', 'CREDITS_SETTLEMENT_PENDING'].includes(error.code))
      if (!known) throw error
      await finish(async tx => {
        if (error.code === deniedCode) return denied(tx)
        if (!search) await recordResearchReadOutcome({ ...ctx, transaction: tx, webAdmission: undefined }, false)
        return { outcome: 'failed', failureCode: error.code, summary: '联网查证未取得资料',
          output: error instanceof ToolModelConfigurationError ? '当前联网工具配置不可用，本次未取得资料。' : error.message }
      }, false)
    }
    return { kind: 'context' as const, frame: projected! }
  })
}

/** Live and historical author activity share the immutable frame/receipt. */
export function projectDurablePublicWeb(operation: AgentOperation, previous: Frame, current: Frame, receipt?: { result: unknown; createdAt: Date }): AgentStreamEventBody[] {
  const { step, callId } = readStep(operation)
  const messageId = `web-${runtimeJson(operation.taskRootId).hash.slice(0, 40)}`
  if (current.state.pendingOperationId === operation.id) return [
    ...(step.name === 'web_search' ? [
      { type: 'message.start' as const, messageId, role: 'assistant' as const },
      { type: 'text.final' as const, messageId, text: '我先查找公开资料，再核对关键内容。', asReasoning: false },
    ] : []),
    { type: 'tool.call', messageId, callId, toolName: step.name, title: step.name === 'web_search' ? webSearchTool.title : webReadTool.title, args: step.args },
  ]
  if (!receipt) return runtimeError('RUNTIME_RECEIPT_INVALID', '平台查证事件缺少原回执。')
  const observed = readReceipt(receipt.result), ok = observed.outcome !== 'failed'
  const expected = { ...previous.state, phase: 'idle', pendingOperationId: null, messages: [...previous.state.messages,
    { role: 'user', content: publicWebObservation(step.name, observed.output, ok) }] }
  if (runtimeJson(expected).hash !== current.snapshotHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '平台查证结果与原执行帧不一致。')
  return [{ type: 'tool.result', messageId, callId, toolName: step.name, summary: observed.summary, ok,
    durationMs: Math.max(0, receipt.createdAt.getTime() - operation.createdAt.getTime()),
    ...(observed.failureCode ? { failureCode: observed.failureCode } : {}), ...(observed.display ? { display: observed.display } : {}) }]
}
