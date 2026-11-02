import type { AgentRun, Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { taskSpecSchema } from '../../../shared/contracts/index.js'
import { hasAuthorEnded, isContinuationRequest } from './completion-guard.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import type { LegacyContinuationRetirement } from '../../../shared/contracts/agent-events.js'
export type { LegacyContinuationRetirement } from '../../../shared/contracts/agent-events.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function isLegacyContinuationRun(run: AgentRun): boolean {
  const request = object(run.startRequest)
  return typeof request.prompt === 'string' && isContinuationRequest(request.prompt)
    && !request.selection && (!Array.isArray(request.attachments) || request.attachments.length === 0)
}

export async function readLegacyContinuationTarget(tx: Prisma.TransactionClient, selected: AgentRun): Promise<AgentRun | null> {
  return (await readLegacyContinuationResolution(tx, selected))?.source ?? null
}

/** Old clients admitted a bare Continue as a new legacy task. Resolve only the
 * contiguous, read-only continuation suffix back to its actual original task.
 * This reader never rewrites either contract, checkpoint, usage or billing row. */
export async function readLegacyContinuationResolution(tx: Prisma.TransactionClient, selected: AgentRun): Promise<{ source: AgentRun; retirements: LegacyContinuationRetirement[] } | null> {
  const latest = await tx.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId: selected.sessionId }, orderBy: { createdAt: 'desc' } })
  if (!latest) return null
  if (latest.id === selected.id && !isLegacyContinuationRun(latest)) return { source: selected, retirements: [] }
  if (!isLegacyContinuationRun(latest) || selected.taskRootId || selected.runtimeProtocolVersion !== 0) return null
  const runs = await tx.agentRun.findMany({ where: { ...MAIN_RUN_FILTER, sessionId: selected.sessionId,
    userId: selected.userId, novelId: selected.novelId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (runs[0]?.id !== latest.id) return null
  const wrappers: AgentRun[] = []
  let source: AgentRun | undefined
  for (const run of runs) {
    if (!isLegacyContinuationRun(run)) { source = run; break }
    const spec = taskSpecSchema.safeParse(run.taskSpec)
    if (run.taskRootId || run.runtimeProtocolVersion !== 0 || !['paused', 'failed'].includes(run.status)
      || hasAuthorEnded(run.usage) || !spec.success || spec.data.scope.authorEffects?.manuscript !== false
      || spec.data.scope.authorEffects.structure !== false || spec.data.scope.novelId !== selected.novelId) return null
    const request = object(run.startRequest)
    if (spec.data.scope.authorEffects.requestHash !== createHash('sha256').update(String(request.prompt)).digest('hex')) return null
    const message = await tx.agentMessage.findFirst({ where: { runId: run.id, sessionId: run.sessionId, role: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
    const parts = Array.isArray(message?.parts) ? message.parts : []
    if (parts.length !== 1 || object(parts[0]).type !== 'text' || object(parts[0]).text !== request.prompt) return null
    wrappers.push(run)
  }
  if (!source || source.taskRootId || source.runtimeProtocolVersion !== 0 || source.engine !== 'loop'
    || !['paused', 'failed', 'running', 'awaiting_approval'].includes(source.status) || hasAuthorEnded(source.usage)
    || ![source.id, ...wrappers.map(run => run.id)].includes(selected.id)) return null
  const sourceSpec = taskSpecSchema.safeParse(source.taskSpec)
  if (!sourceSpec.success || sourceSpec.data.scope.novelId !== selected.novelId) return null
  const scope = sourceSpec.data.scope
  const checkpoint = object(object(source.usage).checkpoint)
  const targets = new Set([...(scope.chapterIds ?? []), ...(scope.writing?.targets.flatMap(target => target.chapterId ? [target.chapterId] : []) ?? []),
    ...(source.chapterId ? [source.chapterId] : []), ...(Array.isArray(checkpoint.pendingReviews)
      ? checkpoint.pendingReviews.flatMap(value => typeof object(value).chapterId === 'string' ? [String(object(value).chapterId)] : []) : [])])
  if (wrappers.some(run => run.manuscriptRevision !== source!.manuscriptRevision || run.chapterId && !targets.has(run.chapterId)
    || (taskSpecSchema.parse(run.taskSpec).scope.chapterIds ?? []).some(id => !targets.has(id)))) return null
  if (await tx.agentGoalExecution.count({ where: { runId: { in: [source.id, ...wrappers.map(run => run.id)] } } })) return null
  const ids = wrappers.map(run => run.id)
  if (await tx.agentOperation.count({ where: { originRunId: { in: ids }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })) return null
  const messages = await tx.agentMessage.findMany({ where: { runId: { in: ids }, role: 'assistant' }, select: { parts: true } })
  const { getAgentToolManifest } = await import('./tools/registry.js')
  const readable = new Set(getAgentToolManifest().filter(tool => tool.readOnly && !['ask_user', 'task_respond'].includes(tool.name)).map(tool => tool.name))
  const changed = (value: unknown) => {
    const part = object(value), display = object(part.display)
    return !!part.snapshot || display.kind === 'chapterDiff' && display.appliedDirectly === true
      || display.kind === 'qualityReport' && !!display.appliedBodyChange
  }
  if (messages.some(message => Array.isArray(message.parts) && message.parts.some(part => changed(part)
    || object(part).type === 'tool-call' && !readable.has(String(object(part).toolName))))) return null
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result', 'run.paused', 'run.finished'] } }, orderBy: { seq: 'asc' } })
  const calls = events.filter(event => ['tool.call', 'tool.result'].includes(event.type))
  if (calls.some(event => !readable.has(String(object(event.payload).toolName)) || changed(event.payload))) return null
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['prepared', 'dispatched', 'unknown'] } } })) return null
  const retirements: LegacyContinuationRetirement[] = []
  for (const wrapper of wrappers) {
    const history = events.filter(event => event.runId === wrapper.id)
    const terminal = history.filter(event => ['run.paused', 'run.finished'].includes(event.type)).at(-1)
    if (!terminal || history.some(event => event.seq > terminal.seq)) return null
    const pending = object(object(wrapper.usage).checkpoint).pendingReviews
    const pendingReviews = Array.isArray(pending) ? pending : []
    const retiredCalls: LegacyContinuationRetirement['calls'] = []
    for (const call of history.filter(event => event.type === 'tool.call')) {
      const payload = object(call.payload), callId = String(payload.callId), toolName = String(payload.toolName)
      const starts = history.filter(event => event.type === 'tool.call' && object(event.payload).callId === callId)
      const results = history.filter(event => event.type === 'tool.result' && object(event.payload).callId === callId)
      const result = results[0], review = pendingReviews.find(value => object(value).callId === callId)
      if (starts.length !== 1 || results.length !== 1 || result.seq <= call.seq || result.createdAt < call.createdAt
        || result.seq >= terminal.seq || object(result.payload).toolName !== toolName) return null
      if (review) {
        const item = object(review), args = object(payload.args)
        if (!['quality_analyze', 'continuity_validate'].includes(toolName) || item.toolName !== toolName
          || !targets.has(String(item.chapterId)) || !Number.isSafeInteger(item.revision)
          || object(result.payload).ok !== false || !String(object(result.payload).failureCode).startsWith('AI_PROVIDER_')
          || args.chapterId !== item.chapterId && (!item.compilationId || args.compilationId !== item.compilationId)) return null
      }
      retiredCalls.push({ callId, toolName, resultEventId: result.id, pendingReview: review ?? null })
    }
    if (pendingReviews.some(value => !retiredCalls.some(call => call.callId === object(value).callId))) return null
    const payments = await tx.aiUsageLog.findMany({ where: { agentRunId: wrapper.id }, orderBy: { id: 'asc' } })
    if (payments.some(row => row.userId !== selected.userId || row.novelId !== selected.novelId || row.reservedCreditMilli !== 0
      || !['settled', 'provider_rejected'].includes(row.billingStatus ?? '') || row.createdAt > terminal.createdAt
      || row.createdAt.getTime() + row.durationMs > terminal.createdAt.getTime())) return null
    retirements.push({ status: 'legacy_continuation_retired', usageOutcome: 'preserved', sourceRunId: source.id,
      sourceTaskId: sourceSpec.data.id, wrapperRunId: wrapper.id, wrapperTaskId: taskSpecSchema.parse(wrapper.taskSpec).id,
      manuscriptRevision: source.manuscriptRevision, terminalEventId: terminal.id, calls: retiredCalls, usageIds: payments.map(row => row.id) })
  }
  return { source, retirements }
}
