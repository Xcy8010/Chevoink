import { prisma } from '../../api/lib/prisma.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease, releaseRunLease } from '../../api/lib/agent/runtime-lease.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { getToolsForMode, toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { initializeExecutionState, saveExecutionState } from './native-tool-test-state.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { randomUUID } from 'node:crypto'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { expect } from 'vitest'

/** A concrete read-only session policy, not inferred prose, must reject even
 * a recorded model call. Exercise the actual native effect entry boundary. */
export async function invokeAfterReadonlyPolicy(subject: { userId: string; novelId: string; runId: string }, tool: AgentTool, args: unknown) {
  let run = await prisma.agentRun.findUniqueOrThrow({ where: { id: subject.runId } })
  const originalRun = run
  const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: run.sessionId } })
  // A running legacy task cannot be converted to native execution. Test the
  // same session policy through a separate queued synthetic request instead.
  if (!run.taskRootId && run.status !== 'queued') {
    const id = randomUUID()
    run = await prisma.agentRun.create({ data: { id, userId: run.userId, novelId: run.novelId, sessionId: run.sessionId,
      chapterId: run.chapterId, status: 'queued', engine: run.engine, mode: run.mode, agentType: run.agentType, action: run.action,
      modelTier: run.modelTier, customModelId: run.customModelId, reasoningEffort: run.reasoningEffort,
      taskSpec: runtimeJson({ ...(run.taskSpec as object), id }).value,
      startRequest: runtimeJson(run.startRequest).value } })
    subject = { ...subject, runId: id }
  }
  const source = await prisma.agentMessage.findFirst({ where: { runId: run.id, role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    ?? await prisma.agentMessage.create({ data: { runId: run.id, sessionId: run.sessionId, role: 'user',
      parts: [{ type: 'text', text: (run.startRequest as { prompt?: string } | null)?.prompt ?? 'Synthetic author request' }] } })
  const root = run.taskRootId ? await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: run.taskRootId } })
    : await initializeDurableTask({ ...subject, sourceMessageId: source.id })
  const lease = await acquireRunLease({ ...subject, ownerId: 'readonly-policy-fixture', claimId: randomUUID() })
  try {
    if (!await prisma.agentExecutionState.findUnique({ where: { taskRootId: root.id } })) {
      const tools = getToolsForMode('build')
      await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
        model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
        tools: toOpenAITools(tools), toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: 'Synthetic owned request; current session access is tested separately.' }], successfulToolSignatures: [] } })
    }
    const { frame } = await loadExecutionState(subject.userId, subject.runId)
    await saveExecutionState(lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
      snapshot: { ...frame.state, messages: [...frame.state.messages, { role: 'assistant', content: null,
        toolCalls: [{ id: randomUUID(), name: tool.name, arguments: JSON.stringify(args) }] }] } })
    await prisma.agentSession.update({ where: { id: run.sessionId }, data: { sandboxMode: 'read_only' } })
    return await executeDurableToolStep(lease, new AbortController().signal)
  } finally {
    await releaseRunLease(lease)
    await prisma.agentSession.update({ where: { id: session.id }, data: { sandboxMode: session.sandboxMode } })
    if (run.id !== originalRun.id) expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: originalRun.id } })).toEqual(originalRun)
  }
}
