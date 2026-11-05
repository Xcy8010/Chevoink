import { beforeEach, expect, it, vi } from 'vitest'
const parentState = vi.hoisted(() => vi.fn())
const activationCeiling = vi.hoisted(() => vi.fn())
vi.mock('../../api/lib/agent/goal-activation.js', async original => ({ ...await original<object>(), readGoalActivationToolCeiling: activationCeiling }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(), readExecutionStateInTransaction: parentState }))
import { readEffectiveNativeTooling, readNativeToolAdmission } from '../../api/lib/agent/native-tool-policy.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import type { RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { getAgentDefinition } from '../../api/lib/agent/agents.js'

const lease = { userId: 'owner', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const definition = { type: 'function' as const, function: { name: 'chapter_read', description: '合成读取', parameters: { type: 'object' } } }
const grant = { name: 'chapter_read', permission: 'ask' as const, dangerous: false, alwaysConfirm: false }
const configuration = { mode: 'build' as const, agentType: 'orchestrator', tools: [definition], toolAuthority: [grant] }
const db = { agentGoal: { findUniqueOrThrow: vi.fn() }, $queryRaw: vi.fn().mockResolvedValue([]), agentTaskRoot: { findUniqueOrThrow: vi.fn() }, agentSession: { findFirst: vi.fn() }, agentGoalExecution: { findFirst: vi.fn() } }
const task = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: '再检查一下能否新增后续卷', authorWritingProtocol: 2 })
const current = (token: RunLeaseToken = lease, settings = configuration) => readEffectiveNativeTooling(db as unknown as RuntimeTx, token,
  settings as Parameters<typeof readEffectiveNativeTooling>[2], { ...task, scope: { ...task.scope, authorEffects: { ...task.scope.authorEffects!, structure: false, manuscript: false },
    capabilityCatalog: { version: 1, kind: 'conversation', requestHash: task.scope.authorEffects!.requestHash, names: ['chapter_read'] } } })

beforeEach(() => {
  vi.resetAllMocks()
  activationCeiling.mockResolvedValue(null)
  db.agentGoal.findUniqueOrThrow.mockResolvedValue({ id: 'goal' })
  db.$queryRaw.mockResolvedValue([])
  db.agentTaskRoot.findUniqueOrThrow.mockImplementation(async ({ where }) => ({ id: where.id, userId: 'owner', novelId: 'novel', sessionId: where.id === 'parent' ? 'parent-session' : 'session' }))
  parentState.mockResolvedValue({ configuration, originalSpec: task })
  db.agentSession.findFirst.mockResolvedValue({ toolPolicy: {}, sandboxMode: 'workspace', spawnedFromSessionId: null })
  db.agentGoalExecution.findFirst.mockResolvedValue(null)
})


it('restores real-role tools missing from a legacy inferred catalog without changing saved configuration or its identity', async () => {
  const before = runtimeJson(configuration).hash
  const result = await current()
  expect(result.tools.some(tool => tool.function.name === 'volume_create')).toBe(true)
  expect(result.tools.some(tool => tool.function.name === 'chapter_write')).toBe(true)
  expect(result.toolAuthority.find(item => item.name === 'volume_create')?.permission).not.toBe('deny')
  expect(result.toolAuthority.find(item => item.name === 'chapter_read')).toEqual(grant)
  expect(runtimeJson(configuration).hash).toBe(before)
  expect(configuration.tools).toEqual([definition])
  expect(db.agentSession.findFirst).toHaveBeenCalledWith({ where: { id: 'session', userId: 'owner', novelId: 'novel' } })
})

it('honors actual read-only session settings even when the old configuration allowed writes', async () => {
  db.agentSession.findFirst.mockResolvedValue({ toolPolicy: { contentWrite: 'allow' }, sandboxMode: 'read_only' })
  const result = await current()
  expect(result.tools.some(tool => tool.function.name === 'chapter_read')).toBe(true)
  expect(result.toolAuthority.some(item => ['volume_create', 'chapter_write'].includes(item.name))).toBe(false)
})

it('preserves a real child grant ceiling and stricter ask rather than promoting the child to main-agent permissions', async () => {
  const token = { ...lease, parent: { taskRootId: 'parent' } } as RunLeaseToken
  const result = await current(token)
  expect(result.tools.map(tool => tool.function.name)).toEqual(['chapter_read'])
  expect(result.toolAuthority).toEqual([grant])
})

it('uses the original real role and never falls back to the main role', async () => {
  expect(getAgentDefinition('research').type).toBe('research')
  const role = await current(lease, { ...configuration, agentType: 'research' })
  expect(role.toolAuthority.some(item => item.name === 'volume_create')).toBe(false)
  await expect(current(lease, { ...configuration, agentType: 'missing-role' })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
})

it.each(['session', 'owner'])('rejects real %s ownership failures', async problem => {
  if (problem === 'session') db.agentSession.findFirst.mockResolvedValue(null)
  else db.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ id: 'root', userId: 'another', novelId: 'novel', sessionId: 'session' })
  await expect(current()).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
})

it('recovers a new admitted tool after restart while leaving old operations without metadata on their original path', () => {
  const toolAdmission = { version: 1, definition, grant }
  const snapshot = runtimeJson({ input: { args: {}, toolAdmission } })
  const operation = { action: 'chapter_read', inputSnapshot: snapshot.value, inputHash: snapshot.hash }
  expect(readNativeToolAdmission(operation)).toEqual(toolAdmission)
  expect(readNativeToolAdmission({ ...operation, inputSnapshot: { input: { args: {} } } })).toBeNull()
  expect(readNativeToolAdmission({ ...operation, inputSnapshot: { input: { args: { toolAdmission } } } })).toBeNull()
})

it.each(['hash', 'action', 'schema'] as const)('rejects changed admitted %s evidence instead of minting a new tool grant', field => {
  const snapshot = runtimeJson({ input: { toolAdmission: { version: 1, definition, grant } } })
  const operation = { action: field === 'action' ? 'volume_create' : 'chapter_read', inputSnapshot: snapshot.value,
    inputHash: field === 'hash' ? 'a'.repeat(64) : snapshot.hash }
  if (field === 'schema') operation.inputSnapshot = runtimeJson({ input: { toolAdmission: { version: 1, definition, grant: { ...grant, permission: 'invented' } } } }).value
  expect(() => readNativeToolAdmission(operation)).toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
})

it.each(['deny', 'read_only'])('intersects an issued child ceiling with the current parent %s policy', async restriction => {
  const token = { ...lease, parent: { taskRootId: 'parent', runId: 'parent-run', ownerId: 'p', claimId: 'pc', epoch: 1n, grantId: 'g' } } as RunLeaseToken
  const child = { ...configuration, toolAuthority: [{ name: 'chapter_write', permission: 'allow' as const, alwaysConfirm: false, dangerous: false }] }
  parentState.mockResolvedValue({ configuration: child, originalSpec: task })
  db.agentSession.findFirst.mockImplementation(async ({ where }) => where.id === 'parent-session'
    ? { toolPolicy: restriction === 'deny' ? { contentWrite: 'deny' } : {}, sandboxMode: restriction === 'read_only' ? 'read_only' : 'workspace' }
    : { toolPolicy: {}, sandboxMode: 'workspace' })
  const result = await current(token, child)
  expect(result.toolAuthority.some(item => item.name === 'chapter_write')).toBe(false)
  expect(parentState).toHaveBeenCalledWith(db, 'parent')
})

it.each(['ask', 'deny', 'alwaysConfirm'] as const)('preserves an existing actual root %s grant while restoring missing names', async restriction => {
  const saved = { ...grant, permission: restriction === 'deny' ? 'deny' as const : restriction === 'ask' ? 'ask' as const : 'allow' as const, alwaysConfirm: restriction === 'alwaysConfirm' }
  const result = await current(lease, { ...configuration, toolAuthority: [saved] })
  const recovered = result.toolAuthority.find(item => item.name === 'chapter_read')
  if (restriction === 'deny') expect(recovered).toBeUndefined()
  else expect(recovered).toMatchObject({ permission: 'ask', alwaysConfirm: saved.alwaysConfirm })
  expect(result.tools.some(tool => tool.function.name === 'volume_create')).toBe(true)
})


it.each([null, []])('distinguishes an absent goal activation ceiling from an explicit empty ceiling: %j', async ceiling => {
  db.agentGoalExecution.findFirst.mockResolvedValue({ goalId: 'goal' })
  activationCeiling.mockResolvedValue(ceiling)
  const result = await current()
  expect(result.tools.some(tool => tool.function.name === 'chapter_read')).toBe(ceiling === null)
  expect(result.tools.some(tool => tool.function.name === 'volume_create')).toBe(ceiling === null)
  expect(runtimeJson(configuration).hash).toBe(runtimeJson({ mode: 'build', agentType: 'orchestrator', tools: [definition], toolAuthority: [grant] }).hash)
})
