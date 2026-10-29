import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { assertToolApproval, assertWritingServiceApproval, pollToolApproval, projectApprovalEvent, readWritingServiceRefusal, requestToolApproval } from '../../api/lib/agent/runtime-approval.js'

const mocks = vi.hoisted(() => ({ tx: { agentTaskRoot: { findUniqueOrThrow: vi.fn() }, storyCompilation: { findFirst: vi.fn() },
  agentExecutionOutbox: { findUnique: vi.fn(), create: vi.fn() } },
  state: vi.fn(), frame: vi.fn(), original: vi.fn(), confirmations: vi.fn(), readiness: vi.fn(), now: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(), withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ readExecutionStateInTransaction: mocks.state, readExecutionFrame: mocks.frame }))
vi.mock('../../api/lib/agent/runtime-common.js', async original => ({ ...await original<object>(), databaseNow: mocks.now }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: mocks.original, originalTaskRunIds: async () => ['run'] }))
vi.mock('../../api/lib/agent/runtime-writing-service.js', async original => ({ ...await original<object>(), readWritingServiceConfirmations: mocks.confirmations }))
vi.mock('../../api/lib/agent/chapter-review-guard.js', () => ({ readChapterReviewReadiness: mocks.readiness }))

const lease = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
let events: Map<string, Record<string, unknown>>, spec: ReturnType<typeof buildTaskSpec>, args: Record<string, unknown>
let grant: { name: string; permission: 'allow' | 'ask' | 'deny'; alwaysConfirm: boolean }
let frame: { revision: number; snapshotHash: string; state: { phase: string; messages: Array<{ role: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }> } }
beforeEach(() => {
  vi.resetAllMocks(); events = new Map()
  spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '完整重写本章' })
  spec.writingPacing = 'explicit_writing'; spec.qualityMode = 'balanced'; spec.scope.writingCoordinationProtocol = 1
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
  args = { compilationId: 'compilation' }
  frame = { revision: 0, snapshotHash: 'a'.repeat(64), state: { phase: 'idle', messages: [{ role: 'assistant', toolCalls: [{ id: 'writer', name: 'chapter_bridge_commit', arguments: JSON.stringify(args) }] }] } }
  grant = { name: 'chapter_bridge_commit', permission: 'allow', alwaysConfirm: false }
  mocks.state.mockImplementation(async () => ({ originalSpec: spec, frame, configuration: { toolAuthority: [grant], tools: [{ function: { name: grant.name } }] } }))
  mocks.frame.mockImplementation(async () => frame)
  mocks.tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ userId: 'user', novelId: 'novel', sessionId: 'session' })
  mocks.tx.storyCompilation.findFirst.mockImplementation(async ({ where }) => where.id === 'compilation' && where.userId === 'user'
    && where.novelId === 'novel' && where.runId.in.length === 1 && where.runId.in[0] === 'run'
    ? { id: 'compilation', chapterId: 'chapter', chapter: { id: 'chapter', orderIndex: 1 } } : null)
  mocks.original.mockImplementation(async () => ({ spec, prompt: '完整重写本章' }))
  mocks.confirmations.mockResolvedValue(['continuity_validate'])
  mocks.readiness.mockResolvedValue({ requiredTools: ['quality_analyze', 'continuity_validate'] })
  mocks.now.mockReturnValue(new Date('2026-10-23T00:00:00Z'))
  mocks.tx.agentExecutionOutbox.findUnique.mockImplementation(async ({ where }) => events.get(where.eventKey) ?? null)
  mocks.tx.agentExecutionOutbox.create.mockImplementation(async ({ data }) => { events.set(data.eventKey, data); return data })
})
const request = () => requestToolApproval(lease, { expectedRevision: 0, expectedHash: frame.snapshotHash, callId: 'writer', timeoutMs: 60_000, normalize: value => value })
function approve(record: Awaited<ReturnType<typeof request>>, approved = true) {
  events.set(`approval-decision:${record.id}`, { id: 'decision', taskRootId: 'root', type: 'approval.resolved', payload: { version: 1,
    requestId: record.id, requestHash: runtimeJson(record.payload).hash, approved, userId: 'user' } })
}
const assertion = () => ({ sourceHash: frame.snapshotHash, callId: 'writer', toolName: 'chapter_bridge_commit', rawArguments: JSON.stringify(args),
  argsHash: runtimeJson(args).hash, manifest: runtimeJson({ version: 1, chapterId: 'chapter', writingHash: runtimeJson({ compilationId: 'compilation', chapterId: 'chapter',
    required: { continuity: true, quality: true } }).hash, steps: [{ step: 'quality', actions: ['quality_analyze'] },
    { step: 'continuity', actions: ['continuity_validate'] }, { step: 'commit', actions: ['chapter_bridge_commit'] }] }).value })

describe('explicit composite approval using the existing author decision', () => {
  it('shows the actual review/commit steps when only a child action asks for confirmation', async () => {
    const record = await request()
    expect(mocks.tx.storyCompilation.findFirst).toHaveBeenCalledWith({ where: { userId: 'user', novelId: 'novel', runId: { in: ['run'] }, id: 'compilation', status: { in: ['active', 'completed'] } },
      include: { chapter: true }, orderBy: { createdAt: 'desc' } })
    expect(record.payload).toMatchObject({ args, argsHash: runtimeJson(args).hash, writingServices: assertion().manifest })
    const projected = await projectApprovalEvent(mocks.tx as never, record, 'user')
    expect(projected).toMatchObject({ type: 'permission.ask', toolName: 'chapter_bridge_commit', args: { 写入参数: args,
      后续操作: ['独立质量复核', '独立连续性复核', '提交本章承接状态'] } })
    expect((await pollToolApproval(lease, { expectedRevision: 0, expectedHash: frame.snapshotHash, callId: 'writer' })).event).toEqual(projected)
    approve(record)
    await expect(assertWritingServiceApproval(mocks.tx as never, lease, assertion())).resolves.toBeUndefined()
  })
  it('reuses the exact displayed manifest without extending its expiry', async () => {
    const record = await request(), originalPayload = structuredClone(record.payload)
    expect(mocks.tx.storyCompilation.findFirst).toHaveBeenCalledOnce()
    mocks.tx.storyCompilation.findFirst.mockRejectedValue(new Error('A frozen approval must not query a fresh ordinal'))
    mocks.now.mockReturnValue(new Date('2026-10-23T00:00:30Z'))
    expect(await request()).toBe(record)
    expect(record.payload).toEqual(originalPayload)
    expect(record.payload).toHaveProperty('expiresAt', '2026-10-23T00:01:00.000Z')
    expect(mocks.tx.storyCompilation.findFirst).toHaveBeenCalledOnce()
    expect(mocks.tx.agentExecutionOutbox.create).toHaveBeenCalledOnce()
  })
  it.each(['missing', 'foreign'] as const)('refuses a fresh manifest for a %s owned target before creating an approval', async target => {
    if (target === 'missing') mocks.tx.storyCompilation.findFirst.mockResolvedValueOnce(null)
    else {
      args.compilationId = 'another-compilation'
      frame.state.messages[0].toolCalls![0].arguments = JSON.stringify(args)
    }
    await expect(request()).rejects.toMatchObject({ code: 'COMPILATION_NOT_FOUND' })
    expect(mocks.tx.storyCompilation.findFirst).toHaveBeenCalledWith({ where: { userId: 'user', novelId: 'novel', runId: { in: ['run'] }, id: args.compilationId, status: { in: ['active', 'completed'] } },
      include: { chapter: true }, orderBy: { createdAt: 'desc' } })
    expect(mocks.confirmations).not.toHaveBeenCalled()
    expect(mocks.tx.agentExecutionOutbox.create).not.toHaveBeenCalled()
    expect(events.size).toBe(0)
  })
  it('never treats a previously approved ordinary writer as confirmation of its child services', async () => {
    const record = await request()
    delete (record.payload as { writingServices?: unknown }).writingServices
    approve(record)
    const input = assertion()
    await expect(assertToolApproval(mocks.tx as never, lease, input.sourceHash, input.callId, input.toolName, input.rawArguments, input.argsHash)).resolves.toBeUndefined()
    await expect(assertWritingServiceApproval(mocks.tx as never, lease, input)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    // Reading an unchanged ordinary dialog cannot supply its missing services.
    expect(await request()).toBe(record)
  })
  it.each(['target', 'candidate', 'steps'] as const)('does not reuse an approved decision for a different %s', async kind => {
    const record = await request(); approve(record)
    const input = assertion(), manifest = JSON.parse(JSON.stringify(input.manifest))
    if (kind === 'target') manifest.chapterId = 'another-chapter'
    if (kind === 'candidate') manifest.writingHash = 'b'.repeat(64)
    if (kind === 'steps') manifest.steps.pop()
    await expect(assertWritingServiceApproval(mocks.tx as never, lease, { ...input, manifest })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it.each(['denied', 'expired', 'pending'] as const)('keeps the original %s decision closed', async kind => {
    const record = await request()
    if (kind === 'denied') approve(record, false)
    if (kind === 'expired') mocks.now.mockReturnValue(new Date('2026-10-23T00:01:01Z'))
    await expect(assertWritingServiceApproval(mocks.tx as never, lease, assertion())).rejects.toMatchObject({ code:
      kind === 'denied' ? 'RUNTIME_APPROVAL_DENIED' : kind === 'expired' ? 'RUNTIME_APPROVAL_EXPIRED' : 'RUNTIME_APPROVAL_REQUIRED' })
  })
  it.each(['denied', 'expired'] as const)('authenticates a service-only %s decision while the writer grant remains allow', async kind => {
    const record = await request()
    if (kind === 'denied') approve(record, false)
    else mocks.now.mockReturnValue(new Date('2026-10-23T00:01:01Z'))
    expect(grant.permission).toBe('allow')
    expect(await readWritingServiceRefusal(mocks.tx as never, lease, assertion())).toMatchObject({ status: kind })
  })
  it('does not use an ordinary denied writer request as a composite refusal', async () => {
    const record = await request()
    delete (record.payload as { writingServices?: unknown }).writingServices
    approve(record, false)
    expect(await readWritingServiceRefusal(mocks.tx as never, lease, assertion())).toBeNull()
  })
  it('rejects a declined manifest that no longer matches the same original writing decisions', async () => {
    const record = await request()
    const payload = record.payload as { writingServices: { writingHash: string } }
    payload.writingServices.writingHash = 'e'.repeat(64)
    approve(record, false)
    await expect(readWritingServiceRefusal(mocks.tx as never, lease, assertion())).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  })
  it('cannot use a composite dialog to enlarge a denied child grant', async () => {
    mocks.confirmations.mockRejectedValueOnce(Object.assign(Error('Child denied'), { code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' }))
    await expect(request()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
    expect(events.size).toBe(0)
  })
  it('retains the exact unmarked approval payload and presentation', async () => {
    delete spec.scope.writingCoordinationProtocol; grant.permission = 'ask'; grant.name = 'chapter_write'
    args = { chapterId: 'chapter', content: '真实保存的正文' }
    frame.state.messages[0].toolCalls![0] = { id: 'writer', name: grant.name, arguments: JSON.stringify(args) }
    const record = await request()
    expect(record.payload).not.toHaveProperty('writingServices')
    expect(await projectApprovalEvent(mocks.tx as never, record, 'user')).toMatchObject({ args })
    expect(mocks.confirmations).not.toHaveBeenCalled()
  })
  it.each(['unmarked', 'marked'] as const)('does not invent confirmation for an allowed %s call', async kind => {
    if (kind === 'unmarked') delete spec.scope.writingCoordinationProtocol
    grant.name = 'chapter_write'
    frame.state.messages[0].toolCalls![0].name = grant.name
    mocks.confirmations.mockResolvedValue([])
    await expect(request()).rejects.toMatchObject({ code: 'RUNTIME_EFFECT_NOT_AUTHORIZED' })
    expect(events.size).toBe(0)
  })
})
