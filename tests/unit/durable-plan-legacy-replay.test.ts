import { beforeEach, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { planSaveTool } from '../../api/lib/agent/tools/write-tools.js'
import { novelPlanHash } from '../../api/lib/agent/novel-plan-contract.js'
import { createHash } from 'node:crypto'
import { executeDurablePlanSave, planTargetHash } from '../../api/lib/agent/tools/durable-plan.js'
import { DataAccessError } from '../../api/lib/prisma.js'

const mocks = vi.hoisted(() => ({
  tx: { $queryRaw: vi.fn(), agentOperation: { findUnique: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() },
    agentArtifact: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() } },
  admitted: vi.fn(), prepare: vi.fn(), commit: vi.fn(), reduce: vi.fn(), failure: vi.fn(),
}))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(),
  withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx),
}))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', async original => ({ ...await original<object>(),
  readAdmittedToolOperation: mocks.admitted, prepareToolCursorOperation: mocks.prepare,
}))
vi.mock('../../api/lib/agent/runtime-operations.js', async original => ({ ...await original<object>(),
  commitOperationEffect: mocks.commit, recordToolFailure: mocks.failure,
}))
vi.mock('../../api/lib/agent/runtime-reducer.js', async original => ({ ...await original<object>(), reduceExecutionReceipt: mocks.reduce }))

const args = { title: '历史冻结计划', content: '原完整计划' }
const lease = { userId: 'u', runId: 'r', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const ctx = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', callId: 'call', mode: 'plan', signal: new AbortController().signal,
  toolAuthority: new Map([['plan_save', { permission: 'allow', alwaysConfirm: false }]]),
  durablePlan: { lease, operationKey: 'exec:0', cursor: { expectedRevision: 0, expectedHash: 'frame' }, expected: { id: null, hash: null } },
} as ToolContext
beforeEach(() => {
  vi.resetAllMocks()
  mocks.tx.$queryRaw.mockResolvedValue([{ id: 'n' }])
  mocks.tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ novelId: 'n', sessionId: 's' })
  mocks.tx.agentArtifact.findMany.mockResolvedValue([])
  mocks.tx.agentArtifact.findFirst.mockResolvedValue({ id: 'saved', title: args.title, content: args.content, metadata: { savedAsPlan: true } })
  mocks.prepare.mockResolvedValue({ operation: { id: 'op', inputHash: 'input' }, pending: { revision: 1, snapshotHash: 'pending' } })
  mocks.commit.mockImplementation(async (_lease, _id, _hash, work) => ({ result: await work(mocks.tx) }))
})
it.each([false, true])('grants legacy creation only after authenticating an operation that already existed: %s', async existing => {
  mocks.tx.agentOperation.findUnique.mockResolvedValue(existing ? { id: 'old-op' } : null)
  mocks.admitted.mockResolvedValue({ input: { args } })
  const write = vi.fn(async () => ({ output: '已保存', summary: '已保存', display: { kind: 'planFile' as const, artifactId: 'saved', title: args.title, content: args.content } }))
  await executeDurablePlanSave(ctx, args, raw => raw, write)
  expect(write).toHaveBeenCalledWith(mocks.tx, undefined, existing ? true : undefined, undefined)
  expect(mocks.admitted).toHaveBeenCalledTimes(existing ? 1 : 0)
  if (existing) {
    expect(mocks.admitted).toHaveBeenCalledWith(lease, { operationId: 'old-op', action: 'plan_save', novelId: 'n', callId: 'call' }, mocks.tx)
    expect(mocks.admitted.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0])
  }
})
it('does not turn an invalid old operation into a fresh legacy creation', async () => {
  mocks.tx.agentOperation.findUnique.mockResolvedValue({ id: 'old-op' })
  mocks.admitted.mockRejectedValue(new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原操作来源无法核实'))
  const write = vi.fn()
  await expect(executeDurablePlanSave(ctx, args, raw => raw, write)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.commit).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})

it('never upgrades a new missing-kind call to legacy when interrupted after PREPARED and before its refusal receipt', async () => {
  let operation: { id: string; input: Record<string, unknown> } | null = null
  const interrupted = new Error('interrupted after PREPARED, before effect callback')
  mocks.tx.agentOperation.findUnique.mockImplementation(async () => operation)
  mocks.admitted.mockImplementation(async () => ({ input: operation!.input }))
  mocks.prepare.mockImplementation(async (_lease, _cursor, input) => {
    operation ??= { id: 'new-op', input: input.operationInput }
    expect(input.operationInput).toEqual(operation.input)
    return { operation: { id: operation.id, inputHash: 'original-input' }, pending: { revision: 1, snapshotHash: 'pending' } }
  })
  mocks.commit.mockRejectedValueOnce(interrupted).mockImplementationOnce(async (_lease, _id, _hash, work) => ({ result: await work(mocks.tx) }))
  mocks.failure.mockImplementation(async (_lease, input) => ({ result: { outcome: 'failed', effectApplied: false, code: input.code,
    toolResult: { output: input.output, summary: input.summary } } }))
  const write = vi.fn(async (tx, _hash, legacyCreationReplay) => planSaveTool.execute({ ...ctx, durablePlan: undefined,
    transaction: tx, legacyPlanCreationReplay: legacyCreationReplay }, args))
  await expect(executeDurablePlanSave(ctx, args, raw => raw, write)).rejects.toBe(interrupted)
  expect(mocks.prepare.mock.calls[0][2].operationInput).toMatchObject({ planProtocol: 1 })
  expect(write).not.toHaveBeenCalled()
  const result = await executeDurablePlanSave(ctx, args, raw => raw, write)
  expect(result.outcome).toBe('failed')
  expect(result.output).toContain('planKind=outline')
  expect(write).toHaveBeenCalledExactlyOnceWith(mocks.tx, undefined, undefined, undefined)
  expect(mocks.tx.agentArtifact.findFirst).not.toHaveBeenCalled()
  expect(mocks.failure).toHaveBeenCalledWith(lease, expect.objectContaining({ code: 'PLAN_WRITE_REJECTED' }))
})

it('passes the full verified durable plan version to typed append without changing the admitted model arguments', async () => {
  const plan = { id: 'typed', title: '大纲', content: '原大纲正文', metadata: { savedAsPlan: true, planKind: 'outline' } }
  const input = { title: plan.title, planId: plan.id, content: '追加完整小节', mode: 'append' as const,
    expectedContentHash: createHash('sha256').update(plan.content).digest('hex') }
  const fullBaseline = planTargetHash(plan), semanticBaseline = novelPlanHash(plan)
  mocks.tx.agentArtifact.findFirst.mockImplementation(async () => plan)
  mocks.tx.agentArtifact.updateMany.mockImplementation(async ({ data }) => { Object.assign(plan, data); return { count: 1 } })
  const context = { ...ctx, durablePlan: { ...ctx.durablePlan!, expected: { id: plan.id, hash: fullBaseline } } }
  const write = vi.fn(async (tx, contentHash, _legacyCreationReplay, semanticHash) => planSaveTool.execute({ ...context,
    durablePlan: undefined, transaction: tx, planContentHashes: new Map([[plan.id, contentHash]]), planSemanticHashes: new Map([[plan.id, semanticHash]]) }, input))
  const result = await executeDurablePlanSave(context, input, raw => raw, write)
  expect(result.outcome).not.toBe('failed')
  expect(write).toHaveBeenCalledWith(mocks.tx, input.expectedContentHash, undefined, semanticBaseline)
  expect(mocks.prepare.mock.calls[0][2].effectiveArgs).toEqual(input)
  expect(mocks.prepare.mock.calls[0][2].effectiveArgs).not.toHaveProperty('expectedPlanHash')
  expect(plan.content).toBe('原大纲正文\n\n追加完整小节')
})
