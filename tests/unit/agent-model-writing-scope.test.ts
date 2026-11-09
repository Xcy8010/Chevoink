import { afterEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { agentWritingScopeInputSchema } from '../../shared/contracts/agent-writing-scope.js'
import { bindAgentWritingScope, enableAgentWritingScope, readAgentWritingScope } from '../../api/lib/agent/agent-writing-scope.js'
import { buildTaskSpec, requiresManuscriptDelivery, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { originalChapterReviewRequirements } from '../../api/lib/agent/chapter-review-requirements.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { getToolsForMode } from '../../api/lib/agent/tools/registry.js'
import * as originals from '../../api/lib/agent/original-request.js'
import * as writing from '../../api/lib/agent/writing-scope.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

afterEach(() => vi.restoreAllMocks())
function fixture(prompt = '这一页读着像播报，把说话的劲儿调自然一点，落到稿子里。') {
  const ctx: ToolContext = { userId: 'author', novelId: 'novel', sessionId: 'session', runId: 'run', chapterId: 'chapter', mode: 'build',
    callId: 'model-scope', creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal }
  const spec = JSON.parse(JSON.stringify(enableAgentWritingScope(buildTaskSpec({ ...ctx, prompt, authorWritingProtocol: 2, localEditProtocol: 1, reviewProtocol: 1 })))) as ReturnType<typeof buildTaskSpec>
  const original = { prompt, spec, taskId: spec.id, sourceRunId: 'run', parentRunId: null }
  const run = { id: 'run', userId: 'author', novelId: 'novel', sessionId: 'session', chapterId: 'chapter', status: 'running', incomingChildGrant: null,
    engine: 'loop', runtimeProtocolVersion: 0, goalExecution: null, session: { sandboxMode: 'workspace', spawnedFromRunId: null, spawnedFromSessionId: null },
    startRequest: withHumanAdmission({ novelId: 'novel', sessionId: 'session', chapterId: 'chapter', prompt, mode: 'build' }) }
  const chapter = { id: 'chapter', orderIndex: 1, revision: 4, content: '窗外雨停了。那句誓言不能动。她收起伞。' }
  const artifacts: Array<{ metadata: unknown }> = []
  const mocks = { agentRun: { findFirst: vi.fn(async () => run) },
    agentMessage: { findMany: vi.fn(async () => [{ id: 'human', runId: 'run', sessionId: 'session', role: 'user', parts: [{ type: 'text', text: prompt }] }]) },
    chapter: { findMany: vi.fn(async () => [chapter]) }, agentArtifact: { findMany: vi.fn(async () => artifacts),
      create: vi.fn(async ({ data }: { data: { metadata: unknown } }) => { artifacts.push(data); return data }) } }
  const tx = mocks as unknown as Prisma.TransactionClient
  vi.spyOn(originals, 'readOriginalTaskRequest').mockResolvedValue(original)
  vi.spyOn(writing, 'lockWritingRunLineage').mockResolvedValue(undefined)
  return { ctx, spec, original, run, chapter, artifacts, mocks, tx }
}

it('offers model-driven body tools independently of lexical guesses while ordinary chat needs no binding', () => {
  const f = fixture('你好，今天状态怎么样？')
  const names = restrictToolsToTask(getToolsForMode('build'), f.spec, 'build').map(tool => tool.name)
  expect(names).toEqual(expect.arrayContaining(['task_scope_bind', 'chapter_read', 'chapter_edit_range']))
  expect(requiresManuscriptDelivery(f.spec)).toBe(false)
  expect(renderTaskSpec(f.spec)).toContain('在聊天交付正文或答复时直接输出')
  expect(f.artifacts).toHaveLength(0)
})

it('locks the main model interpretation once, preserves the original request and replays the same binding', async () => {
  const f = fixture(), before = JSON.stringify(f.original)
  const input = agentWritingScopeInputSchema.parse({ intent: 'revise', targets: [{ chapterId: 'chapter' }], locality: 'local' })
  expect(await bindAgentWritingScope(f.tx, f.ctx, input)).toMatchObject({ intent: 'revise', targets: [{ chapterId: 'chapter' }] })
  expect(await bindAgentWritingScope(f.tx, f.ctx, input)).toMatchObject({ intent: 'revise' })
  expect(f.mocks.agentArtifact.create).toHaveBeenCalledOnce()
  const effective = await readAgentWritingScope(f.tx, f.ctx, f.original, f.spec)
  expect(effective?.spec.scope.localEditBoundary).toMatchObject({ version: 4, kind: 'semantic' })
  expect(originalChapterReviewRequirements({ prompt: f.original.prompt, spec: effective!.spec })).toEqual({ continuity: true, quality: true })
  expect(requiresManuscriptDelivery(effective!.spec)).toBe(true)
  expect(JSON.stringify(f.original)).toBe(before)
  await expect(bindAgentWritingScope(f.tx, f.ctx, { ...input, locality: 'chapter' })).rejects.toMatchObject({ code: 'TASK_SCOPE_BIND_CONFLICT' })
})

it.each(['foreign-target', 'protected', 'readonly', 'selection-other', 'cancelled', 'no-human', 'bad-preservation'] as const)(
  'rejects the real %s boundary without a receipt or body effect', async scenario => {
    const f = fixture(), input = agentWritingScopeInputSchema.parse({ intent: 'revise', targets: [{ chapterId: 'chapter' }], locality: 'local' })
    if (scenario === 'foreign-target') input.targets[0].chapterId = 'other-novel-chapter'
    if (scenario === 'protected') f.ctx.protectedChapterIds = new Set(['chapter'])
    if (scenario === 'readonly') f.run.session.sandboxMode = 'read_only'
    if (scenario === 'cancelled') f.mocks.agentRun.findFirst.mockResolvedValue(null as never)
    if (scenario === 'no-human') f.mocks.agentMessage.findMany.mockResolvedValue([])
    if (scenario === 'bad-preservation') input.targets[0].preserveText = ['并不存在的誓言']
    if (scenario === 'selection-other') f.spec.scope.selectionBoundary = { version: 1, chapterId: 'different-selected-chapter', revision: 4,
      contentHash: 'a'.repeat(64), start: 1, end: 3, prefix: 'a', suffix: 'b' }
    await expect(bindAgentWritingScope(f.tx, f.ctx, input)).rejects.toBeDefined()
    expect(f.artifacts).toHaveLength(0)
  })

it('uses structured review requirements instead of reparsing words in each quality layer', async () => {
  const f = fixture()
  await bindAgentWritingScope(f.tx, f.ctx, agentWritingScopeInputSchema.parse({ intent: 'revise', targets: [{ chapterId: 'chapter' }], requiredChecks: [] }))
  const effective = await readAgentWritingScope(f.tx, f.ctx, f.original, f.spec)
  expect(originalChapterReviewRequirements({ prompt: f.original.prompt, spec: effective!.spec })).toEqual({ continuity: false, quality: false })
})

it('keeps old protocols and tampered receipts outside model binding', async () => {
  const f = fixture(), input = agentWritingScopeInputSchema.parse({ intent: 'revise', targets: [{ chapterId: 'chapter' }] })
  delete f.spec.scope.agentWritingProtocol
  await expect(bindAgentWritingScope(f.tx, f.ctx, input)).rejects.toMatchObject({ code: 'TASK_SCOPE_BIND_UNAVAILABLE' })
  f.spec.scope.agentWritingProtocol = 1
  await bindAgentWritingScope(f.tx, f.ctx, input)
  Object.assign(f.artifacts[0].metadata as object, { taskId: 'different-task' })
  await expect(readAgentWritingScope(f.tx, f.ctx, f.original, f.spec)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
})

it.each([true, false])('preserves next-chapter volume handling only when the main Agent admits it, allow=%s', async allowNewTailVolume => {
  const f = fixture('接上后面的剧情，写好下一章。')
  await bindAgentWritingScope(f.tx, f.ctx, agentWritingScopeInputSchema.parse({ intent: 'write', targets: [{ orderIndex: 2 }], allowNewTailVolume }))
  const bound = await readAgentWritingScope(f.tx, f.ctx, f.original, f.spec)
  expect(Boolean(bound?.spec.scope.writing?.tailVolume)).toBe(allowNewTailVolume)
  if (allowNewTailVolume) expect(bound?.spec.scope.writing?.tailVolume).toMatchObject({ targetOrderIndex: 2, previousChapterId: 'chapter', previousRevision: 4 })
})
