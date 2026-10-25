import { describe, expect, it, vi } from 'vitest'
import type { AgentGoal, Prisma } from '@prisma/client'
import { createAgentGoalSchema } from '../../shared/contracts/agent-goal.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { readFreshGoalSource, readFreshGoalBootstrapSource } from '../../api/lib/agent/fresh-goal-source.js'

function fixture(version: 1 | 2) {
  const goal = { id: 'goal', userId: 'user', novelId: 'novel', sessionId: 'session' } as AgentGoal
  const body = createAgentGoalSchema.parse({ requestId: '11111111-1111-4111-8111-111111111111', objective: '完整重写第一章正文。',
    options: { mode: 'build', chapterId: 'chapter', qualityMode: 'balanced', creativeFreedom: 'balanced' } })
  const envelope = { operation: 'create', target: { sessionId: goal.sessionId }, body }
  const nativeAdmission: Record<string, unknown> = { version, origin: 'http', envelope,
    ...(version === 2 ? { continuityReportProtocol: 5, writingCoordinationProtocol: 2 } : {}) }
  const revision = { objective: body.objective, sourceActionId: body.requestId,
    request: { ...body.options, nativeAdmission }, authorityHash: '' }
  const authenticate = () => { revision.authorityHash = runtimeJson({ objective: revision.objective, request: revision.request, novelId: goal.novelId, userId: goal.userId }).hash }
  authenticate()
  const spec = JSON.parse(JSON.stringify(buildTaskSpec({ runId: 'run', novelId: goal.novelId, chapterId: 'chapter', prompt: body.objective,
    ...(version === 2 ? { continuityReportProtocol: 5 as const } : {}) }))) as ReturnType<typeof buildTaskSpec>
  spec.scope.writingCoordinationProtocol = version
  spec.intent = 'revise'
  spec.writingPacing = 'explicit_writing'
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  const run = { id: 'run', mode: 'act', taskSpec: spec, startRequest: { ...body.options, novelId: goal.novelId, sessionId: goal.sessionId, prompt: body.objective } }
  const binding = { goal, goalRevision: 1, continuationIndex: 1, trigger: 'author', sourceEventId: `${goal.id}:1:1` }
  const db = { agentGoalRevision: { findUniqueOrThrow: vi.fn(async () => revision) }, agentGoalCommand: { findUnique: vi.fn(async () => ({ requestHash: runtimeJson(envelope).hash,
    response: { id: goal.id, sessionId: goal.sessionId, novelId: goal.novelId, revision: 1 } })) },
  agentGoalExecution: { findUnique: vi.fn(async () => binding) }, agentRun: { findFirst: vi.fn(async () => run) } }
  return { goal, body, revision, nativeAdmission, authenticate, spec, binding, db: db as unknown as Prisma.TransactionClient }
}
describe('goal creation freezes its writing contract before first start', () => {
  it.each([1, 2] as const)('authenticates creation v%s without upgrading its writing phase contract', async version => {
    const f = fixture(version), before = runtimeJson({ revision: f.revision, spec: f.spec }).hash
    const source = await readFreshGoalSource(f.db, f.goal)
    expect(source?.continuityReportProtocol).toBe(version === 2 ? 5 : undefined)
    expect(source?.writingCoordinationProtocol).toBe(version === 2 ? 2 : undefined)
    await expect(readFreshGoalBootstrapSource(f.db, 'user', 'run')).resolves.not.toBeNull()
    expect(runtimeJson({ revision: f.revision, spec: f.spec }).hash).toBe(before)
  })
  it.each(['missing-report', 'missing-writing', 'wrong-report', 'v1-new-fields', 'authority-hash'] as const)('refuses %s without source normalization', async fault => {
    const f = fixture(fault === 'v1-new-fields' ? 1 : 2)
    if (fault === 'missing-report') delete f.nativeAdmission.continuityReportProtocol
    if (fault === 'missing-writing') delete f.nativeAdmission.writingCoordinationProtocol
    if (fault === 'wrong-report') f.nativeAdmission.continuityReportProtocol = 4
    if (fault === 'v1-new-fields') Object.assign(f.nativeAdmission, { continuityReportProtocol: 5, writingCoordinationProtocol: 2 })
    f.authenticate()
    if (fault === 'authority-hash') f.revision.authorityHash = '0'.repeat(64)
    const before = runtimeJson(f.revision).hash
    await expect(readFreshGoalSource(f.db, f.goal)).rejects.toMatchObject({ code: 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' })
    expect(runtimeJson(f.revision).hash).toBe(before)
  })
  it.each([1, 2] as const)('rejects a saved execution outside creation v%s instead of rewriting it', async version => {
    const f = fixture(version)
    if (version === 1) Object.assign(f.spec.scope, { continuityReportProtocol: 5, writingCoordinationProtocol: 2 })
    else delete f.spec.scope.continuityReportProtocol
    const before = runtimeJson(f.spec).hash
    await expect(readFreshGoalBootstrapSource(f.db, 'user', 'run')).rejects.toMatchObject({ code: 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' })
    expect(runtimeJson(f.spec).hash).toBe(before)
  })
  it('does not infer admission or paid phases for an unmarked old goal', async () => {
    const f = fixture(1)
    delete (f.revision.request as Record<string, unknown>).nativeAdmission
    f.authenticate()
    expect(await readFreshGoalSource(f.db, f.goal)).toBeNull()
  })
})
