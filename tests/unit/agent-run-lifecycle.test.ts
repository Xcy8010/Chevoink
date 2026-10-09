  const readiness = (continuity: ChapterReviewReadiness['continuity'], quality: ChapterReviewReadiness['quality'], revision = 3): ChapterReviewReadiness => ({
    ready: continuity === 'complete' && quality === 'complete', checksRequired: true,
    compilationId: 'comp', chapterId: 'c', revision, continuity, quality,
    continuityErrorCount: 0, qualityErrorCount: 0, qualityReportId: quality === 'complete' ? 'report' : null,
    requiredTools: [ ...(continuity === 'complete' ? [] : [{ name: 'continuity_validate' as const, args: { compilationId: 'comp' } }]),
      ...(quality === 'complete' ? [] : [{ name: 'quality_analyze' as const, args: { compilationId: 'comp' } }]) ],
  })

import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentMessagePart, AgentStreamEventBody, AgentTodoItem, TaskSpec } from '../../shared/contracts/index.js'
import type { AgentTool, ToolContext, ToolResult } from '../../api/lib/agent/tools/types.js'
import type { chatWithTools as chatType } from '../../api/lib/ai-service.js'
import type { ChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import type { WritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(), emit: vi.fn(), persist: vi.fn(async () => ({})), journal: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  openAITools: vi.fn(() => []),
  update: vi.fn<(input: { data: Record<string, unknown> }) => Promise<{ taskSpec: TaskSpec | null; usage?: unknown; currentTurn?: number; startedAt?: Date; events?: Array<{ type: string; createdAt: Date }> }>>(async () => ({ taskSpec: null })), owner: vi.fn(async () => ({ userId: 'user' })), previous: vi.fn<(input?: { where?: Record<string, unknown> }) => Promise<unknown>>(async () => null),
  committedChapter: vi.fn(async () => false),
  savedWorkflow: vi.fn(async (): Promise<WritingWorkflowMilestone[]> => []),
  todos: vi.fn(async (): Promise<AgentTodoItem[]> => []),
  priorRuns: vi.fn(),
  report: vi.fn(async () => ({ chineseCharacters: 0, content: '' })),
  original: vi.fn<() => Promise<{ parts: Array<{ type: string; text: string }> } | null>>(async () => ({ parts: [{ type: 'text', text: '核对原任务的剩余工作。' }] })),
  tools: [] as AgentTool[],
  hiddenTools: [] as AgentTool[],
  skillReceipt: vi.fn(async () => ({})), skillLoads: vi.fn(async (...args: unknown[]) => { void args }),
  db: {} as Record<string, unknown>, runs: new Map<string, Record<string, unknown>>(),
  chapters: [] as Array<{ id: string; authorId: string; novelId: string; orderIndex: number; orderInVolume: number; volumeId: string; volume: { orderIndex: number; novelId: string; archivedAt: null }; title: string; content: string; revision: number; archivedAt: null }>,
  admissionPrompt: '', sourcePrompt: null as string | null,
  currentOriginal: null as { prompt: string; taskSpec: TaskSpec } | null,
  reviewReadiness: vi.fn<() => Promise<ChapterReviewReadiness | null>>(async () => null),
  limitedDelivery: vi.fn(async () => null as import('../../api/lib/agent/writing-delivery-limitations.js').LimitedWritingDelivery | null),
  qualityRecovery: vi.fn(async () => null as import('../../api/lib/agent/quality-format-recovery.js').QualityFormatRecovery | null),
  requestRecovery: vi.fn(async (): Promise<Awaited<ReturnType<typeof import('../../api/lib/agent/review-request-recovery.js').readReviewRequestRecovery>>> => []),
  settledQuality: vi.fn(async (): Promise<Awaited<ReturnType<typeof import('../../api/lib/agent/quality-review-admission.js').readSettledQualityReviews>>> => []),
  assertLimitedDelivery: vi.fn(async () => undefined),
  continuedContinuity: vi.fn(async (): Promise<Array<[string, string]>> => []),
  continuityRecovery: vi.fn(async () => ({ removed: [] as import('../../api/lib/agent/tool-local-failure.js').ToolRestriction[],
    settled: [] as import('../../api/lib/agent/checkpoint.js').PendingReviewCall[], recovered: [] as string[], markers: [] as string[], chapterIds: [] as string[] })),
  reviewProbe: vi.fn(async () => ({ open: true } as { open: true } | { open: false; code: string; message: string })),
}))

// These cases exercise an ordinary (non-goal-owned) loop.  Keep the goal
// lookup explicit so the test fixture cannot accidentally hit the real
// AgentGoalExecution delegate when the loop checks its ownership boundary.
vi.mock('../../api/lib/agent/goal-fence.js', () => ({
  readGoalExecution: vi.fn(async () => undefined),
  assertGoalFence: vi.fn(async () => undefined),
  assertRunGoalFence: vi.fn(async () => undefined),
}))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat }))
// The real guard has PostgreSQL/coverage regression cases. Here only its
// read-only observation is controlled to exercise real loop dispatch/order.
vi.mock('../../api/lib/agent/chapter-review-guard.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/chapter-review-guard.js')>(),
  readChapterReviewReadiness: mocks.reviewReadiness, probeChapterReviewRevision: mocks.reviewProbe,
}))
// Database call/result authentication is covered by the PostgreSQL recovery suite.
// These loop-only fixtures contain no settled report witness.
vi.mock('../../api/lib/agent/review-request-recovery.js', () => ({ readReviewRequestRecovery: mocks.requestRecovery }))
vi.mock('../../api/lib/agent/quality-review-admission.js', () => ({ readSettledQualityReviews: mocks.settledQuality }))
vi.mock('../../api/lib/agent/quality-format-recovery.js', () => ({ readQualityFormatRecovery: mocks.qualityRecovery }))
vi.mock('../../api/lib/agent/writing-delivery-limitations.js', () => ({
  readLimitedWritingDelivery: mocks.limitedDelivery, assertLimitedWritingDelivery: mocks.assertLimitedDelivery,
  limitedReviewDependency: (content: string) => content === '连续性检查',
}))
vi.mock('../../api/lib/prisma.js', () => {
  type Query = { where?: Record<string, unknown>; data?: Record<string, unknown>; orderBy?: unknown }
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true
    if (key === 'incomingChildGrant') return value === null
    if (key === 'taskSpec') {
      const clause = value as { equals: string }
      return (row.taskSpec as TaskSpec | null)?.id === clause.equals
    }
    if (key === 'volume') return matches(row.volume as Record<string, unknown>, value as Record<string, unknown>)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const clause = value as { in?: unknown[]; not?: unknown }
      if (clause.in) return clause.in.includes(row[key])
      if (Object.hasOwn(clause, 'not')) return row[key] !== clause.not
      throw new Error(`Unsupported fixture predicate: ${key}`)
    }
    return row[key] === value
  })
  const ownedRun = (input: Query) => [...mocks.runs.values()]
    .sort((a, b) => input.orderBy
      ? (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() || String(a.id).localeCompare(String(b.id)) : 0)
    .find(row => matches(row, input.where)) ?? null
  const findRun = async (input: Query) => {
    if (input.where?.id && typeof input.where.id === 'object' && Object.hasOwn(input.where.id, 'not')) {
      const previous = await mocks.previous(input) as Record<string, unknown> | null
      if (previous) {
        const id = String(previous.id ?? 'original')
        const row = { ...mocks.runs.get('run'), ...previous, id, writingBindings: null,
          createdAt: previous.createdAt ?? new Date(0), startRequest: mocks.sourcePrompt ? { prompt: mocks.sourcePrompt } : null }
        mocks.runs.set(id, row)
        return row
      }
      return null
    }
    return ownedRun(input)
  }
  const db: Record<string, unknown> = {
  DataAccessError: class extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message) }
  },
  agentRun: {
    update: async (input: Query & { data: Record<string, unknown> }) => {
      const result = await mocks.update(input)
      const id = String(input.where?.id ?? 'run')
      const row = { ...mocks.runs.get(id), ...input.data, ...result }
      mocks.runs.set(id, row)
      return row
    },
    findUniqueOrThrow: async (input: Query) => {
      const row = ownedRun(input)
      if (!row) throw new Error('Missing owned run')
      return { ...row, ...await mocks.owner() }
    },
    findFirst: findRun,
    findFirstOrThrow: async (input: Query) => {
      const row = await findRun(input)
      if (!row) throw new Error('Missing original owned task')
      return row
    },
    findMany: async (input: Query) => {
      if (input.where?.session) return [] // No spawned sessions in this ordinary-run fixture.
      if (input.where?.id && typeof input.where.id === 'object' && Object.hasOwn(input.where.id, 'not')) {
        const prior = await mocks.priorRuns(input) as Array<Record<string, unknown>>
        for (const [index, row] of prior.entries()) {
          const id = String(row.id)
          mocks.runs.set(id, { ...mocks.runs.get('run'), ...mocks.runs.get(id), ...row, id,
            createdAt: row.createdAt ?? new Date(index), startRequest: mocks.sourcePrompt ? { prompt: mocks.sourcePrompt } : null })
        }
        return prior
      }
      return [...mocks.runs.values()].filter(row => matches(row, input.where))
    }, count: vi.fn(async () => 0),
  },
  novel: { findFirst: vi.fn(async (input: Query) => matches({ id: 'novel', authorId: 'user', manuscriptRevision: 1 }, input.where) ? { id: 'novel', authorId: 'user', manuscriptRevision: 1 } : null) },
  chapter: {
    findMany: vi.fn(async (input: Query) => mocks.chapters.filter(row => matches(row, input.where))),
    findFirst: vi.fn(async (input: Query) => mocks.chapters.find(row => matches(row, input.where)) ?? null),
  },
  volume: { findFirst: vi.fn(async (input: Query) => matches({ id: 'volume', novelId: 'novel', archivedAt: null, orderIndex: 1 }, input.where) ? { id: 'volume' } : null) },
  agentChildExecutionGrant: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  storyCompilation: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  chapterQualityReport: { findFirst: vi.fn(async () => null) },
  agentSession: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async (input: Query) => matches({ id: 'session', userId: 'user', novelId: 'novel' }, input.where) ? { spawnedFromRunId: null, spawnedFromSessionId: null } : null) },
  agentMessage: { upsert: mocks.persist, create: mocks.persist, findUnique: vi.fn(async () => null), findFirst: mocks.original, findMany: vi.fn(async () => []) },
  agentConfigurationChange: { findMany: vi.fn(async () => []) },
  agentSkillRun: { upsert: mocks.skillReceipt },
  aiUsageLog: { findMany: vi.fn(async () => []) },
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/gu, ' ').trim()
    if (sql === 'SELECT id FROM novels WHERE id = ? FOR UPDATE') return values[0] === 'novel' ? [{ id: 'novel' }] : []
    if (sql === 'SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND novel_id = ? FOR UPDATE') {
      const row = mocks.runs.get(String(values[0]))
      return row?.userId === values[1] && row.novelId === values[2] ? [{ id: row.id }] : []
    }
    if (sql === 'SELECT id FROM chapters WHERE id = ? FOR SHARE') return mocks.chapters.filter(row => row.id === values[0]).map(({ id }) => ({ id }))
    throw new Error(`Unsupported fixture lock: ${sql}`)
  }),
  $transaction: vi.fn(async (work: (tx: Record<string, unknown>) => Promise<unknown>) => work(db)),
  }
  mocks.db = db
  return {
  DataAccessError: db.DataAccessError,
  prisma: db,
  }
})
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: vi.fn(async () => ({ tier: 'speed', contextWindowTokens: 128000 })) }))
vi.mock('../../api/lib/agent/agents.js', () => ({
  getAgentDefinition: () => ({ type: 'test', model: 'test', title: '测试' }),
  getToolsForAgent: () => mocks.tools,
  applySessionToolPolicy: (tools: AgentTool[]) => tools,
}))
vi.mock('../../api/lib/agent/tools/registry.js', () => ({ allTools: [], getToolByName: (name: string) => [...mocks.tools, ...mocks.hiddenTools].find(tool => tool.name === name), toOpenAITools: mocks.openAITools }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ registerActiveRun: vi.fn(), deregisterActiveRun: vi.fn() }))
vi.mock('../../api/lib/agent/baseline.js', () => ({ clearRunBaselines: vi.fn(), getLastTouchedChapter: () => undefined }))
vi.mock('../../api/lib/agent/context.js', () => ({ assembleContext: vi.fn(async () => ({ messages: [] })), insertSubagentCatalog: vi.fn() }))
vi.mock('../../api/lib/agent/skills/receipts.js', () => ({ recordSkillLoads: mocks.skillLoads }))
vi.mock('../../api/lib/agent/skills/service.js', async () => ({ resolveEnabledRuntimeSkills: vi.fn(async () => (await import('../../api/lib/agent/skills/index.js')).skillCatalog) }))
vi.mock('../../api/lib/agent/context-engine.js', () => ({ captureUserDirectives: vi.fn(), compactSessionContext: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/story-memory.js', () => ({ syncNovelMemoryProjection: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/story-compiler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/lib/agent/story-compiler.js')>(),
  readPersistedWritingWorkflowMilestones: mocks.savedWorkflow,
}))
vi.mock('../../api/lib/agent/legacy-continuity-recovery.js', () => ({ readLegacyContinuityRecovery: mocks.continuityRecovery, readContinuedContinuityRecovery: mocks.continuedContinuity }))
vi.mock('../../api/lib/agent/humanity-quality.js', () => ({ hasCommittedTaskChapter: mocks.committedChapter }))
vi.mock('../../api/lib/agent/research-sources.js', () => ({ readResearchReportForDelivery: mocks.report }))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ resolveAgent2FeatureFlags: () => ({}) }))
vi.mock('../../api/lib/agent/events.js', () => ({ createRunEventBus: () => ({ emit: mocks.emit, emitTransient: mocks.emit, persist: mocks.journal,
  commitTerminal: async (body: AgentStreamEventBody, work: (tx: Record<string, unknown>) => Promise<unknown>,
    preceding: Array<Extract<AgentStreamEventBody, { type: 'message.start' | 'text.final' }>> = []) => ({
    result: await work(mocks.db), publish: () => { for (const event of [...preceding, body]) mocks.emit(event) },
  }),
}), disposeRunEventBus: mocks.dispose }))
vi.mock('../../api/lib/agent/permissions.js', () => ({ cancelAllQuestions: vi.fn(), grantAlwaysAllow: vi.fn(), hasAlwaysAllow: () => false, rejectAllApprovals: vi.fn(), waitForApproval: vi.fn() }))
vi.mock('../../api/lib/agent/tools/todo-tools.js', () => ({ loadSessionTodoItems: mocks.todos, cancelTaskTodoItems: vi.fn(async () => []), renderTodoItems: (items: AgentTodoItem[]) => JSON.stringify(items) }))
vi.mock('../../api/lib/agent/task-lineage.js', () => ({ getTaskRunIds: async () => ['run'] }))
vi.mock('../../api/lib/agent/tools/task-orchestration-tools.js', () => ({ ORCHESTRATION_TOOL_NAMES: new Set(), assertOrchestrationResumeGuard: vi.fn(), buildOrchestrationResumeNote: vi.fn() }))
vi.mock('../../api/lib/agent/session-title.js', () => ({ autoNameSession: vi.fn() }))

const { executeAgentRun: executeRealAgentRun, handleToolCall } = await import('../../api/lib/agent/loop.js')
const { runSubagentInline } = await import('../../api/lib/agent/subagent-runner.js')
const { env } = await import('../../api/config/env.js')
const { buildTaskSpec } = await import('../../api/lib/agent/task-spec.js')
const { DataAccessError } = await import('../../api/lib/prisma.js')
const { assembleContext } = await import('../../api/lib/agent/context.js')

function seedAdmission(prompt: string, chapterId: string | null = null) {
  mocks.admissionPrompt = prompt
  mocks.runs.set('run', { id: 'run', userId: 'user', novelId: 'novel', sessionId: 'session', chapterId,
    taskSpec: null, taskRootId: null, runtimeProtocolVersion: 0, engine: 'loop', status: 'queued', currentTurn: 0,
    usage: null, startedAt: null, createdAt: new Date(), writingBindings: null, manuscriptRevision: 1,
    startRequest: { prompt }, novel: { authorId: 'user', manuscriptRevision: 1 }, session: { sandboxMode: 'default', spawnedFromRunId: null } })
}
async function executeAgentRun(params: Parameters<typeof executeRealAgentRun>[0]) {
  // Seed the authenticated admission, rather than invent scope in a mocked guard.
  seedAdmission(params.prompt, params.chapterId)
  if (mocks.currentOriginal) {
    Object.assign(mocks.runs.get('run')!, { startRequest: { prompt: mocks.currentOriginal.prompt }, taskSpec: mocks.currentOriginal.taskSpec })
  }
  return executeRealAgentRun(params)
}
function admitCurrentOriginal(prompt: string) {
  mocks.currentOriginal = { prompt, taskSpec: buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt }) }
}
type Response = Awaited<ReturnType<typeof chatType>>
const response = (content = '已完成。', toolCalls: Response['toolCalls'] = [], tokens = 10): Response => ({ content, toolCalls, reasoning: '', finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens, promptCacheHitTokens: null, promptCacheMissTokens: null } })
const call = (id: string, name = 'chapter_read', args = '{}') => ({ id, name, arguments: args })
const events = () => mocks.emit.mock.calls.map(([event]) => event as AgentStreamEventBody)
function tool(name: string, execute: () => Promise<ToolResult>, readOnly = true): AgentTool {
  return { name, title: name, description: '', readOnly, parameters: z.any(), permission: { plan: 'allow', build: 'allow', review: 'allow' }, execute: vi.fn(execute) }
}
async function run(prompt = '检查当前章节', tokenBudget?: number) {
  await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt, tokenBudget })
  expect(events().filter(event => event.type === 'error')).toEqual([])
}
function queue(...responses: Response[]) {
  for (const item of responses) mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
    for (const pending of item.toolCalls) input.onChunk?.({ type: 'tool-call-start', id: pending.id, name: pending.name })
    return item
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.chat.mockReset()
  mocks.journal.mockReset().mockResolvedValue(undefined)
  mocks.report.mockReset()
  mocks.report.mockResolvedValue({ chineseCharacters: 0, content: '' })
  mocks.original.mockReset()
  mocks.original.mockImplementation(async () => ({ parts: [{ type: 'text', text: mocks.sourcePrompt ?? mocks.admissionPrompt }] }))
  mocks.update.mockReset()
  mocks.update.mockImplementation(async () => ({} as { taskSpec: TaskSpec | null }))
  mocks.owner.mockReset()
  mocks.owner.mockResolvedValue({ userId: 'user' })
  mocks.sourcePrompt = null
  mocks.currentOriginal = null
  mocks.reviewReadiness.mockReset().mockResolvedValue(null)
  mocks.limitedDelivery.mockReset().mockResolvedValue(null)
  mocks.qualityRecovery.mockReset().mockResolvedValue(null)
  mocks.settledQuality.mockReset().mockResolvedValue([])
  mocks.requestRecovery.mockReset().mockResolvedValue([])
  mocks.continuedContinuity.mockReset().mockResolvedValue([])
  mocks.continuityRecovery.mockReset().mockResolvedValue({ removed: [], settled: [], recovered: [], markers: [], chapterIds: [] })
  mocks.assertLimitedDelivery.mockReset().mockResolvedValue(undefined)
  mocks.reviewProbe.mockReset().mockResolvedValue({ open: true })
  mocks.runs.clear()
  mocks.chapters = Array.from({ length: 19 }, (_, index) => ({ id: index === 0 ? 'c' : `chapter-${index + 1}`,
    authorId: 'user', novelId: 'novel', orderIndex: index + 1, orderInVolume: index + 1, volumeId: 'volume', volume: { orderIndex: 1, novelId: 'novel', archivedAt: null },
    title: `第${index + 1}章`, content: '当前章节正文', revision: 1, archivedAt: null }))
  seedAdmission('检查当前章节', 'c')
  mocks.todos.mockResolvedValue([])
  mocks.committedChapter.mockResolvedValue(false)
  mocks.savedWorkflow.mockReset().mockResolvedValue([])
  mocks.previous.mockResolvedValue(null)
  mocks.priorRuns.mockReset()
  mocks.priorRuns.mockResolvedValue([])
  mocks.tools = [tool('chapter_read', async () => ({ output: '当前章节正文' }))]
  mocks.hiddenTools = []
})

function context(): ToolContext {
  return {
    userId: 'user', novelId: 'novel', chapterId: null, sessionId: 'session', runId: 'run',
    callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
    signal: new AbortController().signal, emit: mocks.emit,
  }
}

describe('server assessment fallback in the real execution loop', () => {
  it('resumes the old schema-blocked next49 checkpoint through actual prerequisites and body without a budget or grace reset', async () => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 49, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false,
      tailVolume: { version: 1, previousChapterId: 'previous48', previousRevision: 6, targetOrderIndex: 49 } }
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const restriction = { action: 'chapter_create', target: 'c', code: 'TOOL_SCHEMA_INVALID', reason: '连续三次参数无效，该工具未完成；继续其他可执行工作。' }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 30529, stagnantBatches: 4, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 0, writeBaseline: 0, readProgress: 2, readBaseline: 0, progressSignatures: [], toolRestrictions: [restriction] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 5, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 324803, completionTokens: 4959, totalTokens: 329762, checkpoint } })
    const milestone = (phase: 'prepare' | 'scenes'): WritingWorkflowMilestone => ({ version: 1, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 49, phase })
    const prepare = { ...tool('story_compiler_prepare', async () => ({ output: '第49章实际准备已保存', workflowMilestone: milestone('prepare') }), false),
      parameters: z.object({ targetOrderIndex: z.literal(49), volumeDecision: z.object({ kind: z.literal('continue'), reason: z.string() }) }).strict() }
    const scene = tool('scene_task_build', async () => ({ output: '第49章实际场景已保存', workflowMilestone: milestone('scenes') }), false)
    const create = { ...tool('chapter_create', async () => ({ output: '新49已创建，复用现有卷' }), false), parameters: z.object({ title: z.string() }).strict() }
    const write = tool('chapter_write', async () => ({ output: '第49章真实正文已保存', display: { kind: 'chapterDiff', chapterId: 'new49', chapterTitle: '风眼',
      before: '', after: '第49章真实新正文', appliedDirectly: true } }), false)
    const commit = tool('chapter_bridge_commit', async () => { mocks.committedChapter.mockResolvedValue(true); return { output: '已完成实际终态', requiredResult: { targetId: 'new49', contentHash: 'a'.repeat(64) } } }, false)
    mocks.tools = [prepare, scene, create, write, commit]
    mocks.chat.mockImplementationOnce(async input => {
      expect(input.messages.map((message: { content?: unknown }) => message.content).join('\n')).toContain('已授权新建全书第49章')
      expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 329762, checkpoint: { stagnantBatches: 4, tokenBudget: 500,
        toolRestrictions: [{ ...restriction, inputHash: expect.any(String) }] } })
      return response('', [call('correct-prepare', prepare.name, JSON.stringify({ targetOrderIndex: 49, volumeDecision: { kind: 'continue', reason: '当前卷真实目标尚未收束' } }))])
    })
    queue(response('', [call('scene', scene.name)]), response('', [call('create', create.name, '{"title":"风眼"}')]),
      response('', [call('write49', write.name, '{"chapterId":"new49"}')]), response('', [call('commit49', commit.name)]), response('已保存。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '继续', resume: true })
    expect(prepare.execute).toHaveBeenCalledOnce()
    expect(create.execute).toHaveBeenCalledOnce()
    expect(create.execute).toHaveBeenCalledWith(expect.anything(), { title: '风眼' })
    expect(write.execute).toHaveBeenCalledWith(expect.anything(), { chapterId: 'new49' })
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 329822, checkpoint: { maxTurns: 1, tokenBudget: 500, readProgress: 2,
      writeProgress: 2, stagnantBatches: 0, toolRestrictions: [{ ...restriction, inputHash: expect.any(String) }] } })
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('does not grant a schema-blocked resume a reading grace or bypass unknown review outcomes', async () => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 49, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 4, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 0, writeBaseline: 0, readProgress: 2, readBaseline: 0, progressSignatures: [],
      toolRestrictions: [{ action: 'chapter_create', target: 'c', code: 'TOOL_SCHEMA_INVALID', reason: '原参数失败' }],
      pendingReviews: [{ compilationId: 'unknown', chapterId: 'c', revision: 6, toolName: 'continuity_validate', callId: 'paid-unknown' }] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 5, startedAt: new Date(checkpoint.runStartedAt), usage: { promptTokens: 329762, completionTokens: 0, totalTokens: 329762, checkpoint } })
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '继续', resume: true })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 329762, checkpoint: { stagnantBatches: 4, tokenBudget: 500, pendingReviews: checkpoint.pendingReviews } })
  })
  it.each(['old-compilation', 'standalone'] as const)('does not replay a %s unknown review by changing compilation aliases for the same chapter', async scenario => {
    let state: ChapterReviewReadiness | null = scenario === 'standalone' ? null : readiness('missing', 'complete')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const check = tool('continuity_validate', async () => { throw new Error('unconfirmed response') })
    const prepare = tool('story_compiler_prepare', async () => { state = { ...readiness('missing', 'complete'), compilationId: 'new-comp' }; return { output: '同章新编译' } }, false)
    mocks.tools = [check, prepare]
    queue(response('', [call('unknown', check.name, scenario === 'standalone' ? '{"chapterId":"c"}' : '{"compilationId":"comp"}'),
      call('prepare', prepare.name), call('new-alias', check.name, '{"compilationId":"new-comp"}')]), response('检查结果尚未确认。'))
    await run('写下一章')
    expect(check.execute).toHaveBeenCalledOnce()
    expect(prepare.execute).toHaveBeenCalledOnce()
    const pending = (mocks.runs.get('run')?.usage as { checkpoint: { pendingReviews: Array<{ callId: string; compilationId: string | null }> } }).checkpoint.pendingReviews
    expect(pending).toEqual([expect.objectContaining({ callId: 'unknown', compilationId: scenario === 'standalone' ? null : 'comp' })])
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'new-alias', ok: false, durationMs: 0 }))
  })
  it('keeps known continuity failures scoped to the reviewed body across three failures and a fourth new revision', async () => {
    let state = readiness('missing', 'complete', 1), checks = 0
    mocks.reviewReadiness.mockImplementation(async () => state)
    const check = tool('continuity_validate', async () => {
      checks++
      if (checks < 4) { state = readiness('incomplete', 'complete', state.revision); return { outcome: 'failed', failureCode: 'CONTINUITY_EVIDENCE_UNLOCATED', output: '已返回但定位未完成' } }
      state = readiness('complete', 'complete', state.revision)
      return { output: '最终版本检查完成' }
    })
    const edit = tool('chapter_edit_range', async () => {
      state = readiness('stale', 'complete', state.revision + 1)
      return { output: '已按当前正文修正', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '章', before: `正文${state.revision - 1}`, after: `正文${state.revision}`, appliedDirectly: true, revision: state.revision } }
    }, false)
    const commit = tool('chapter_bridge_commit', async () => { expect(state.ready).toBe(true); mocks.committedChapter.mockResolvedValue(true); return { output: '已提交' } }, false)
    mocks.tools = [check, edit, commit]
    queue(...[1, 2, 3].flatMap(n => [response('', [call(`check${n}`, check.name, '{"compilationId":"comp"}'), call(`repeat${n}`, check.name, '{"compilationId":"comp"}')]),
      response('', [call(`edit${n}`, edit.name, JSON.stringify({ chapterId: 'c', patches: [{ oldText: `正文${n}`, newText: `正文${n + 1}` }] }))])]), response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('', [call('fresh-commit', commit.name, '{"compilationId":"comp"}')]), response('已完成。'))
    await run('写下一章')
    expect(checks).toBe(4)
    expect(edit.execute).toHaveBeenCalledTimes(3)
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(events().filter(event => event.type === 'tool.result' && event.callId.startsWith('repeat'))).toHaveLength(3)
    expect((mocks.runs.get('run')?.usage as { checkpoint: { toolRestrictions?: unknown[] } }).checkpoint.toolRestrictions ?? []).toEqual([])
  })
  it.each(['CONTINUITY_EVIDENCE_UNLOCATED', 'CONTINUITY_REPORT_INCOMPLETE'])('%s clears the received pending call and keeps the blocked commit card and remaining batch', async failureCode => {
    let state = readiness('missing', 'complete')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const check = tool('continuity_validate', async () => { state = readiness('incomplete', 'complete'); return { outcome: 'failed', failureCode, output: '已收到报告，证据尚未定位' } })
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不应执行' }), false)
    const read = tool('chapter_read', async () => ({ output: '当前正文仍保留' }))
    mocks.tools = [check, commit, read]
    queue(response('', [call('check', check.name, '{"compilationId":"comp"}'), call('commit', commit.name, '{"compilationId":"comp"}'), call('read', read.name)]), response('报告尚未确认，正文保留。'))
    await run('写下一章')
    expect(check.execute).toHaveBeenCalledOnce()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(read.execute).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'commit', ok: false, durationMs: 0 }))
    const checkpoint = (mocks.runs.get('run')?.usage as { checkpoint: { pendingReviews?: unknown[]; toolRestrictions?: unknown[] } }).checkpoint
    expect(checkpoint.pendingReviews ?? []).toEqual([])
    expect(checkpoint.toolRestrictions ?? []).toEqual([])
  })
  it('keeps a bad wait as a failed observation while the next authorized call in the batch executes', async () => {
    const wait = tool('task_wait', async () => ({ outcome: 'failed', failureCode: 'TASK_WAIT_TARGET_NOT_FOUND', output: '任务身份不是窗口编号；当前任务没有派生窗口' }))
    const reader = tool('chapter_read', async () => ({ output: '当前目标的实际正文证据' }))
    mocks.tools = [wait, reader]
    queue(response('', [call('bad', wait.name, '{"sessionIds":["task-spec-id"]}'), call('next', reader.name)]), response('核对完成。'))
    await run('核对当前正文')
    expect(reader.execute).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', toolName: 'task_wait', ok: false, failureCode: 'TASK_WAIT_TARGET_NOT_FOUND' }))
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('does not promote an inline child prerequisite receipt to parent workflow progress', async () => {
    const prepare = tool('story_compiler_prepare', async () => ({ output: '准备已保存',
      workflowMilestone: { version: 1, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 20, phase: 'prepare' } }), false)
    const outcome = await handleToolCall(call('child', prepare.name), [prepare], { ...context(), inlineChild: true }, { emit: mocks.emit } as never, 'message', 'run')
    expect(outcome.part.status).toBe('success')
    expect(outcome.workflowMilestone).toBeUndefined()
    expect(outcome.requiredResult).toBeUndefined()
  })
  it('resumes a stagnant next-chapter task through first prerequisites and a saved body without resetting cumulative usage', async () => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 20, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 6, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 0, writeBaseline: 0, readProgress: 1, readBaseline: 0, progressSignatures: [] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 10, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 524000, completionTokens: 51, totalTokens: 524051, checkpoint } })
    const milestone = (phase: 'prepare' | 'scenes') => ({ version: 1 as const, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 20, phase })
    let body = ''
    const prepare = tool('story_compiler_prepare', async () => ({ output: '真实目标20准备已保存', workflowMilestone: milestone('prepare') }), false)
    const scene = tool('scene_task_build', async () => ({ output: '真实场景已保存', workflowMilestone: milestone('scenes') }), false)
    const write = tool('chapter_write', async () => { expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { writeProgress: 0, stagnantBatches: 0 } }); body = '第20章的实际正文'; return { output: '正文已保存',
      display: { kind: 'chapterDiff', chapterId: 'new20', chapterTitle: '第20章', before: '', after: body, appliedDirectly: true } } }, false)
    const commit = tool('chapter_bridge_commit', async () => { expect(body).toBe('第20章的实际正文'); mocks.committedChapter.mockResolvedValue(true); return { output: '终态已保存', requiredResult: { targetId: 'new20', contentHash: 'a'.repeat(64) } } }, false)
    mocks.tools = [prepare, scene, write, commit]
    queue(response('', [call('p', prepare.name)]), response('', [call('s', scene.name)]), response('', [call('w', write.name)]), response('', [call('c', commit.name)]), response('已保存。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(write.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 524101, checkpoint: { tokenBudget: 500, maxTurns: 1, readProgress: 1, writeProgress: 2, stagnantBatches: 0 } })
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('recovers an old saved preparation before the first read turn and then writes the actual next chapter', async () => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 20, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 6, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 0, writeBaseline: 0, readProgress: 1, readBaseline: 0, progressSignatures: [] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 10, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 524000, completionTokens: 51, totalTokens: 524051, checkpoint } })
    const milestone = (phase: 'prepare' | 'scenes'): WritingWorkflowMilestone => ({
      version: 1, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 20, phase,
    })
    mocks.savedWorkflow.mockResolvedValue([milestone('prepare')])
    const preparedKey = `workflow:${JSON.stringify(['user', 'novel', taskSpec.id, 20, 'prepare'])}`
    const read = tool('chapter_bridge_get', async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({
        checkpoint: { writeProgress: 0, readProgress: 1, stagnantBatches: 0, progressSignatures: [preparedKey] } })
      return { output: '真实已保存的编译准备，尚无场景和正文' }
    })
    const scene = tool('scene_task_build', async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { writeProgress: 0, stagnantBatches: 1 } })
      return { output: '场景已保存', workflowMilestone: milestone('scenes') }
    }, false)
    let body = ''
    const write = tool('chapter_write', async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { writeProgress: 0, stagnantBatches: 0 } })
      body = '第20章真实新正文'
      return { output: '正文已保存', display: { kind: 'chapterDiff', chapterId: 'new20', chapterTitle: '第20章', before: '', after: body, appliedDirectly: true } }
    }, false)
    const commit = tool('chapter_bridge_commit', async () => {
      expect(body).toBe('第20章真实新正文')
      mocks.committedChapter.mockResolvedValue(true)
      return { output: '终态已提交', requiredResult: { targetId: 'new20', contentHash: 'b'.repeat(64) } }
    }, false)
    mocks.tools = [read, scene, write, commit]
    mocks.chat.mockImplementationOnce(async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 524051,
        checkpoint: { writeProgress: 0, readProgress: 1, stagnantBatches: 0, progressSignatures: [preparedKey] } })
      return response('', [call('read', read.name)])
    })
    queue(response('', [call('scene', scene.name)]),
      response('', [call('write', write.name)]), response('', [call('commit', commit.name)]), response('已保存。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '继续', resume: true })
    expect(read.execute).toHaveBeenCalledOnce()
    expect(write.execute).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 524101,
      checkpoint: { tokenBudget: 500, maxTurns: 1, writeProgress: 2, readProgress: 1, stagnantBatches: 0 } })
  })

  it.each(['credited', 'missing', 'foreign'] as const)('does not mint a resume grace from %s preparation observations', async state => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 20, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const key = `workflow:${JSON.stringify(['user', 'novel', taskSpec.id, 20, 'prepare'])}`
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 6, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 0, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: state === 'credited' ? [key] : [] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 10, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100, checkpoint } })
    mocks.savedWorkflow.mockResolvedValue(state === 'missing' ? [] : [{ version: 1, userId: state === 'foreign' ? 'foreign' : 'user',
      novelId: 'novel', runId: 'run', targetOrderIndex: 20, phase: 'prepare' }])
    const read = tool('chapter_bridge_get', async () => ({ output: '只读取状态不能创造新的准备或正文进度' }))
    const scene = tool('scene_task_build', async () => ({ output: '不应被此读取解锁' }), false)
    mocks.tools = [read, scene]
    queue(response('', [call('read', read.name)]), response('', [call('scene', scene.name)]))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '继续', resume: true })
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(scene.execute).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 110,
      checkpoint: { tokenBudget: 500, maxTurns: 1, writeProgress: 0, readProgress: 0, stagnantBatches: 7 } })
  })

  it('does not let a repeated preparation receipt or prose complete a chapter or erase persisted stagnation', async () => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 20, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const signature = `workflow:${JSON.stringify(['user', 'novel', taskSpec.id, 20, 'prepare'])}`
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 4, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 0, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [signature] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 10, startedAt: new Date(checkpoint.runStartedAt), usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100, checkpoint } })
    const prepare = tool('story_compiler_prepare', async () => ({ output: '新编号/新摘要，同一目标',
      workflowMilestone: { version: 1, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 20, phase: 'prepare' } }), false)
    mocks.tools = [prepare]
    queue(response('本章已完成', [call('p', prepare.name)]))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 110, checkpoint: { writeProgress: 0, stagnantBatches: 5 } })
  })
  it('withholds a false aesthetic completion claim and asks for one authorized merged decision without another critic', async () => {
    let state = { ...readiness('complete', 'complete'), qualityCandidateCount: 2 }
    mocks.reviewReadiness.mockImplementation(async () => state)
    mocks.reviewProbe.mockResolvedValue({ open: true })
    const edit = tool('chapter_edit_range', async () => { state = { ...state, qualityCandidateCount: 0 }; return { output: '候选已处理或明确留置' } }, false)
    const critic = tool('quality_analyze', async () => ({ output: '不应再次检查' }))
    const commit = tool('chapter_bridge_commit', async () => { expect(state.qualityCandidateCount).toBe(0); mocks.committedChapter.mockResolvedValue(true); return { output: '终态已提交' } }, false)
    mocks.tools = [edit, critic, commit]
    queue(response('全部审美建议已经应用。'), response('', [call('merged', edit.name, '{"chapterId":"c"}')]),
      response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('已保存。'))
    await run('写下一章')
    expect(edit.execute).toHaveBeenCalledOnce()
    expect(critic.execute).not.toHaveBeenCalled()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'text.final', text: '正在核对检查意见的处理结果。' }))
    const history = mocks.chat.mock.calls[1][0].messages
    expect(history.some((message: { content?: string }) => message.content === '全部审美建议已经应用。')).toBe(false)
    expect(history.some((message: { content?: string }) => message.content?.includes('仍有原授权范围内的意见待处理'))).toBe(true)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('reads pending decisions before an early commit and discards the unexecuted commit proposal', async () => {
    let state = { ...readiness('complete', 'complete'), qualityCandidateCount: 1 }
    mocks.reviewReadiness.mockImplementation(async () => state)
    mocks.reviewProbe.mockResolvedValue({ open: true })
    const reader = tool('chapter_bridge_get', async () => ({ output: '当前候选仍需一次合并处理' }))
    const edit = tool('chapter_edit_range', async () => { state = { ...state, qualityCandidateCount: 0 }; return { output: '已处理' } }, false)
    const commit = tool('chapter_bridge_commit', async () => { expect(state.qualityCandidateCount).toBe(0); mocks.committedChapter.mockResolvedValue(true); return { output: '终态提交' } }, false)
    mocks.tools = [reader, edit, commit]
    queue(response('提交终态。', [call('early-commit', commit.name, '{"compilationId":"comp"}')]),
      response('', [call('merged', edit.name, '{"chapterId":"c"}')]), response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('已保存。'))
    await run('写下一章')
    expect(reader.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(events().filter(event => event.type === 'tool.call').map(event => event.toolName)).toEqual(['chapter_bridge_commit', 'chapter_bridge_get', 'chapter_edit_range', 'chapter_bridge_commit'])
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'early-commit', ok: false, durationMs: 0 }))
    expect(mocks.chat.mock.calls[1][0].messages.filter((message: { role: string; toolCallId?: string }) => message.role === 'tool' && message.toolCallId === 'early-commit')).toEqual([])
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('does not introduce chapter review reads into a conversation tool batch', async () => {
    mocks.reviewReadiness.mockRejectedValue(new Error('A conversation must not read an old compilation'))
    queue(response('', [call('read', 'chapter_read')]), response('你好。'))
    await run('你好')
    expect(mocks.reviewReadiness).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it.each(['CONTINUITY_INPUT_STALE', 'CHAPTER_NOT_FOUND'])('treats %s during optional progress observation as no progress, not an internal failure', async code => {
    mocks.reviewReadiness.mockRejectedValueOnce(new DataAccessError(409, code, '目标已变化'))
    mocks.committedChapter.mockResolvedValue(true)
    queue(response('', [call('read', 'chapter_read')]), response('正文已保存。'))
    await run('写下一章')
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it.each(['persisted', 'live'] as const)('counts %s current quality progress at stagnant four and lets the writer handle findings', async source => {
    const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'c', prompt: '写下一章' })
    mocks.currentOriginal = { prompt: '写下一章', taskSpec }
    const evidence = { taskId: taskSpec.id, userId: 'user', novelId: 'novel', chapterId: 'c', orderIndex: 50,
      contentHash: 'a'.repeat(64), phases: ['quality'] as Array<'quality' | 'decision'> }
    let state: ChapterReviewReadiness = source === 'persisted'
      ? { ...readiness('complete', 'complete'), qualityCandidateCount: 6, decisionPending: true, progressEvidence: evidence }
      : readiness('complete', 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 4, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 2, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [] }
    mocks.update.mockResolvedValueOnce({ taskSpec, currentTurn: 5, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 329762, completionTokens: 0, totalTokens: 329762, checkpoint } })
    const critic = tool('quality_analyze', async () => {
      state = { ...readiness('complete', 'complete'), qualityCandidateCount: 6, decisionPending: true, progressEvidence: evidence }
      return { output: '当前版本检查完成，6条意见待处理' }
    })
    const retain = tool('chapter_edit_range', async () => {
      state = { ...state, decisionPending: false, progressEvidence: { ...evidence, phases: ['quality', 'decision'] } }
      return { output: '已核对六条意见并保存绑定当前版本的留置理由，正文不变' }
    }, false)
    const commit = tool('chapter_bridge_commit', async () => {
      expect(state.decisionPending).toBe(false)
      mocks.committedChapter.mockResolvedValue(true)
      return { output: '终态已提交' }
    }, false)
    mocks.tools = [critic, retain, commit]
    if (source === 'live') queue(response('', [call('early', commit.name, '{"compilationId":"comp"}')]))
    queue(response('', [call('retain', retain.name, '{"chapterId":"c"}')]),
      response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('已保存。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '继续', resume: true })
    expect(critic.execute).toHaveBeenCalledTimes(source === 'live' ? 1 : 0)
    expect(retain.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { tokenBudget: 500, maxTurns: 1, writeProgress: 2, resumeCount: 0 } })
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('replaces a premature commit with assessment and requires a new commit after its result', async () => {
    let state = readiness('complete', 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const critic = tool('quality_analyze', async () => { state = readiness('complete', 'complete'); return { output: '当前版本检查完成' } })
    const commit = tool('chapter_bridge_commit', async () => { expect(state.ready).toBe(true); mocks.committedChapter.mockResolvedValue(true); return { output: '提交完成' } }, false)
    mocks.tools = [critic, commit]
    queue(response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('', [call('fresh-commit', commit.name, '{"compilationId":"comp"}')]), response('正文已保存，检查完成。'))
    await run('写下一章')
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(events().filter(event => event.type === 'tool.call').map(event => event.toolName)).toEqual(['chapter_bridge_commit', 'quality_analyze', 'chapter_bridge_commit'])
    const history = mocks.chat.mock.calls[1][0].messages
    const emittedIds = events().filter(event => event.type === 'tool.result' && event.callId !== 'commit').map(event => event.callId)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'commit', ok: false, durationMs: 0 }))
    expect(history.filter((message: { role: string; toolCalls?: unknown[] }) => message.role === 'assistant' && message.toolCalls?.length).flatMap((message: { toolCalls: Array<{ id: string }> }) => message.toolCalls.map(item => item.id))).toEqual(emittedIds)
    expect(history.filter((message: { role: string }) => message.role === 'tool').map((item: { toolCallId: string }) => item.toolCallId)).toEqual(emittedIds)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('replaces an unverified completion claim with progress and completes the missing check', async () => {
    let state = readiness('complete', 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const critic = tool('quality_analyze', async () => { state = readiness('complete', 'complete'); return { output: '检查完成' } })
    const commit = tool('chapter_bridge_commit', async () => { mocks.committedChapter.mockResolvedValue(true); return { output: '提交完成' } }, false)
    mocks.tools = [critic, commit]
    queue(response('已完成全部质量检查。'), response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('已保存。'))
    await run('写下一章')
    expect(critic.execute).toHaveBeenCalledOnce()
    const parts = mocks.persist.mock.calls.flatMap(([input]) => (input as { create?: { parts?: Array<{ type: string; text?: string }> }; data?: { parts?: Array<{ type: string; text?: string }> } }).create?.parts ?? [])
    expect(parts.some(part => part.text === '已完成全部质量检查。')).toBe(false)
    expect(parts.some(part => part.text === '正文已保存，正在完成当前版本的必要检查。')).toBe(true)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'text.final', text: '正文已保存，正在完成当前版本的必要检查。' }))
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('saves an authorized patch after rename and reviews only the final saved revision before commit', async () => {
    let state = readiness('complete', 'complete')
    mocks.reviewReadiness.mockImplementation(async () => state)
    mocks.reviewProbe.mockResolvedValue({ open: false, code: 'REVIEW_REPAIR_RECHECK_REQUIRED', message: '旧报告不是当前版本' })
    const rename = tool('chapter_rename', async () => { state = readiness('stale', 'complete', 4); return { output: '标题已更新' } }, false)
    const check = tool('continuity_validate', async () => { state = readiness('complete', state.quality, state.revision); return { output: '当前版本检查完成' } })
    const quality = tool('quality_analyze', async () => { state = readiness(state.continuity, 'complete', state.revision); return { output: '当前质量检查完成' } })
    const edit = tool('chapter_edit_range', async () => { expect(state.continuity).toBe('stale'); state = readiness('stale', 'stale', 5); return { output: '局部修订已保存' } }, false)
    const commit = tool('chapter_bridge_commit', async () => { expect(state.ready).toBe(true); expect(state.revision).toBe(5); mocks.committedChapter.mockResolvedValue(true); return { output: '提交完成' } }, false)
    mocks.tools = [rename, check, quality, edit, commit]
    queue(response('', [call('rename', rename.name), call('old-edit', edit.name, '{"chapterId":"c"}')]),
      response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('', [call('quality', quality.name, '{"compilationId":"comp"}')]), response('', [call('fresh-commit', commit.name, '{"compilationId":"comp"}')]), response('已保存。'))
    await run('写下一章')
    expect(check.execute).toHaveBeenCalledOnce()
    expect(edit.execute).toHaveBeenCalledOnce()
    expect(quality.execute).toHaveBeenCalledOnce()
    expect(events().some(event => event.type === 'tool.call' && event.callId === 'old-edit')).toBe(true)
    expect(events().filter(event => event.type === 'tool.call').map(event => event.toolName)).toEqual(['chapter_rename', 'chapter_edit_range', 'chapter_bridge_commit', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit'])
  })
  it('permits successive partial and full edits without interposed paid checks, then checks the final revision', async () => {
    let state = readiness('complete', 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    mocks.reviewProbe.mockImplementation(async () => state.ready ? { open: true } : { open: false, code: 'REVIEW_REPAIR_RECHECK_REQUIRED', message: '尚缺当前检查' })
    const check = tool('continuity_validate', async () => { state = readiness('complete', state.quality, state.revision); return { output: '连续性完成' } })
    const quality = tool('quality_analyze', async () => { state = readiness(state.continuity, 'complete', state.revision); return { output: '质量报告已保存，含另一条建议' } })
    const edit = tool('chapter_edit_range', async () => { state = readiness('stale', 'stale', state.revision + 1); return { output: '局部修订已保存', semanticTransition: { targetId: 'c', beforeHash: String(state.revision - 1).repeat(64), afterHash: String(state.revision).repeat(64) } } }, false)
    const write = tool('chapter_write', async () => { expect(check.execute).not.toHaveBeenCalled(); expect(quality.execute).not.toHaveBeenCalled(); state = readiness('stale', 'stale', state.revision + 1); return { output: '最终修订保存', semanticTransition: { targetId: 'c', beforeHash: String(state.revision - 1).repeat(64), afterHash: String(state.revision).repeat(64) } } }, false)
    const commit = tool('chapter_bridge_commit', async () => { expect(state.ready).toBe(true); mocks.committedChapter.mockResolvedValue(true); return { output: '终态保存' } }, false)
    mocks.tools = [check, quality, edit, write, commit]
    queue(response('开始修改第一条。', [call('old-part', edit.name, '{"chapterId":"c"}')]),
      response('', [call('next-part', edit.name, '{"chapterId":"c","oldText":"第二处","newText":"已修改"}')]),
      response('', [call('merged', write.name, '{"chapterId":"c"}')]),
      response('检查已通过，提交终态。', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('', [call('quality', quality.name, '{"compilationId":"comp"}')]), response('', [call('fresh-commit', commit.name, '{"compilationId":"comp"}')]), response('已保存。'))
    await run('写下一章')
    expect(edit.execute).toHaveBeenCalledTimes(2)
    expect(write.execute).toHaveBeenCalledOnce()
    expect(state.revision).toBe(6)
    expect(check.execute).toHaveBeenCalledOnce()
    expect(quality.execute).toHaveBeenCalledOnce()
    expect(events().filter(event => event.type === 'tool.call').map(event => event.toolName)).toEqual([
      'chapter_edit_range', 'chapter_edit_range', 'chapter_write', 'chapter_bridge_commit', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit',
    ])
    const saved = mocks.persist.mock.calls.flatMap(([input]) => (input as { create?: { parts?: AgentMessagePart[] } }).create?.parts ?? [])
    expect(saved.filter(part => part.type === 'tool-call').map(part => part.type === 'tool-call' && part.toolName)).toEqual([
      'chapter_edit_range', 'chapter_edit_range', 'chapter_write', 'chapter_bridge_commit', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit',
    ])
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('continues final-version checks after the old three-check count instead of manufacturing limited delivery', async () => {
    let state = { ...readiness('stale', 'stale'), continuityExhausted: true }
    mocks.reviewReadiness.mockImplementation(async () => state)
    const check = tool('continuity_validate', async () => { state = { ...readiness('complete', 'stale'), continuityExhausted: false }; return { output: '第四次最终版本检查完成' } })
    const critic = tool('quality_analyze', async () => { state = readiness('complete', 'complete'); return { output: '质量检查已保存' } })
    const commit = tool('chapter_bridge_commit', async () => { mocks.committedChapter.mockResolvedValue(true); return { output: '当前版本终态提交' } }, false)
    const reader = tool('chapter_read', async () => ({ output: '同批独立读取完成' }))
    mocks.tools = [check, critic, commit, reader]
    queue(response('', [call('commit', commit.name, '{"compilationId":"comp"}'), call('remaining-read', reader.name)]), response('', [call('quality', critic.name, '{"compilationId":"comp"}')]), response('', [call('fresh-commit', commit.name, '{"compilationId":"comp"}')]), response('正文已保存。'))
    await run('写下一章')
    expect(check.execute).toHaveBeenCalledOnce()
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(reader.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.assertLimitedDelivery).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(mocks.runs.get('run')).toMatchObject({ status: 'completed' })
  })
  it.each(['QUALITY_REPORT_INCOMPLETE', 'QUALITY_EVIDENCE_UNLOCATED'])('keeps %s local through commit preflight and executes the remaining batch', async failureCode => {
    let state = readiness('complete', 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const critic = tool('quality_analyze', async () => { state = readiness('complete', 'incomplete'); return { outcome: 'failed', failureCode, output: '该报告已确认无效' } })
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不能提交' }), false)
    const reader = tool('chapter_read', async () => ({ output: '独立读取已完成' }))
    mocks.tools = [critic, commit, reader]
    queue(response('', [call('quality', critic.name, '{"chapterId":"c"}')]),
      response('', [call('commit', commit.name, '{"compilationId":"comp"}'), call('read', reader.name)]), response('正文保留，质量检查受限。'))
    await run('写下一章')
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(reader.execute).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
    expect(events().some(event => event.type === 'run.finished' && event.status === 'failed')).toBe(false)
  })
  it('keeps an independent batch read after a substituted assessment fails, without executing the old commit', async () => {
    let state = readiness('complete', 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const critic = tool('quality_analyze', async () => { state = readiness('complete', 'incomplete'); return { outcome: 'failed', failureCode: 'QUALITY_EVIDENCE_UNLOCATED', output: '一条证据未定位' } })
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不得提交' }), false)
    const reader = tool('chapter_read', async () => ({ output: '独立读取' }))
    mocks.tools = [critic, commit, reader]
    queue(response('', [call('early', commit.name, '{"compilationId":"comp"}'), call('independent', reader.name)]), response('正文保留，检查尚未完成。'))
    await run('写下一章')
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(reader.execute).toHaveBeenCalledOnce()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(events().filter(event => event.type === 'tool.result' && event.toolName === 'chapter_bridge_commit')).toEqual([expect.objectContaining({ callId: 'early', ok: false, durationMs: 0 })])
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
  })
  it('recovers a received old format failure, handles its finding, checks the edited revision and actually commits', async () => {
    let state = readiness('complete', 'incomplete')
    const order: string[] = []
    mocks.reviewReadiness.mockImplementation(async () => state)
    mocks.qualityRecovery.mockResolvedValue({ version: 1, key: 'a'.repeat(64), taskId: 'task', reportId: 'old-report', chapterId: 'c',
      chapterRevision: state.revision, compilationId: 'comp', contextHash: 'b'.repeat(64), evidenceHash: 'c'.repeat(64) })
    const oldKey = `comp:c:${state.revision}:quality_analyze`
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 0, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [], reviewAttempts: [oldKey],
      toolRestrictions: ['comp', 'c'].map(target => ({ action: 'quality_analyze', target, code: 'QUALITY_REPORT_INCOMPLETE', reason: '已知格式故障' })) }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 11, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 723000, completionTokens: 893, totalTokens: 723893, checkpoint } })
    const critic = tool('quality_analyze', async () => {
      order.push(`quality:r${state.revision}`)
      state = { ...readiness('complete', 'complete', state.revision), qualityCandidateCount: order.length === 1 ? 1 : 0 }
      return { output: '完整报告已保存，已知格式错误恢复。' }
    })
    const bridge = tool('chapter_bridge_get', async () => { order.push('finding'); return { output: '当前报告有一条有依据的重复解释建议，Writer须处理。' } })
    const edit = tool('chapter_edit_range', async () => {
      order.push('edit')
      state = readiness('stale', 'missing', state.revision + 1)
      return { output: '已删除有证据的重复解释。', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '天光',
        before: '他攥紧枪杆。他用力攥紧枪杆。', after: '他攥紧枪杆。', appliedDirectly: true } }
    }, false)
    const continuity = tool('continuity_validate', async () => { order.push(`continuity:r${state.revision}`); state = readiness('complete', 'missing', state.revision); return { output: '新版本连续性复核完成。' } })
    const commit = tool('chapter_bridge_commit', async () => { expect(state.ready).toBe(true); expect(state.qualityCandidateCount ?? 0).toBe(0); order.push('commit'); mocks.committedChapter.mockResolvedValue(true); return { output: '当前版本终态已实际提交。' } }, false)
    mocks.tools = [critic, bridge, edit, continuity, commit]
    queue(response('', [call('premature', commit.name, '{"compilationId":"comp"}')]),
      response('', [call('findings', bridge.name, '{"compilationId":"comp"}')]),
      response('', [call('edit', edit.name, '{"chapterId":"c"}')]),
      response('', [call('commit', commit.name, '{"compilationId":"comp"}')]), response('', [call('quality-final', critic.name, '{"compilationId":"comp"}')]), response('', [call('fresh-commit', commit.name, '{"compilationId":"comp"}')]), response('正文已保存，检查和终态提交完成。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(order).toEqual(['quality:r3', 'finding', 'edit', 'continuity:r4', 'quality:r4', 'commit'])
    expect(critic.execute).toHaveBeenCalledTimes(2)
    expect(edit.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { tokenBudget: 500, reviewAttempts: expect.arrayContaining([oldKey, `quality-format-recovery:${'a'.repeat(64)}`]) } })
    expect(Number((mocks.runs.get('run')?.usage as { totalTokens: number }).totalTokens)).toBeGreaterThan(723893)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(mocks.limitedDelivery).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not complete or emit a limited delivery after an exhausted format recovery; resumed=%s', async resume => {
    let state = readiness('complete', resume ? 'incomplete' : 'missing')
    mocks.reviewReadiness.mockImplementation(async () => state)
    const critic = tool('quality_analyze', async () => {
      state = readiness('complete', 'incomplete')
      return { outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE', output: '格式恢复后报告仍不可用，正文保留。' }
    })
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不能提交' }), false)
    const reader = tool('chapter_read', async () => ({ output: '独立核对已完成' }))
    mocks.tools = [critic, commit, reader]
    if (resume) {
      const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
        activeExecutionMs: 100, stagnantBatches: 0, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
        writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0, progressSignatures: [], reviewHandoffCount: 1,
        toolRestrictions: [{ action: 'quality_analyze', target: 'comp', code: 'QUALITY_REPORT_INCOMPLETE', reason: '已确认的报告格式故障' }] }
      mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 2, startedAt: new Date(checkpoint.runStartedAt),
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint } })
      queue(response('质量检查仍未完成。'))
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
      expect(critic.execute).not.toHaveBeenCalled()
      expect(reader.execute).not.toHaveBeenCalled()
      expect(mocks.chat).toHaveBeenCalledOnce()
      expect(Number((mocks.runs.get('run')?.usage as { totalTokens: number }).totalTokens)).toBeGreaterThanOrEqual(120)
    } else {
      queue(response('', [call('quality', critic.name, '{"compilationId":"comp"}'),
        call('commit', commit.name, '{"compilationId":"comp"}'), call('read', reader.name)]), response('质量检查仍未完成。'))
      await run('写下一章')
      expect(critic.execute).toHaveBeenCalledOnce()
      expect(reader.execute).toHaveBeenCalledOnce()
      expect(mocks.chat).toHaveBeenCalledTimes(2)
    }
    expect(commit.execute).not.toHaveBeenCalled()
    expect(mocks.limitedDelivery).not.toHaveBeenCalled()
    expect(mocks.assertLimitedDelivery).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
    expect(events().some(event => event.type === 'run.finished' && event.status === 'succeeded')).toBe(false)
    expect(mocks.runs.get('run')).toMatchObject({ status: 'paused' })
    expect(mocks.runs.get('run')?.usage).not.toHaveProperty('deliveryProof')
  })
  it('does not replay pending unknown work or bypass the original tool ceiling', async () => {
    mocks.chat.mockImplementation(async () => response('检查尚未完成，原文保留。'))
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'incomplete'))
    const critic = tool('quality_analyze', async () => ({ output: '不能重放' }))
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不能提交' }), false)
    mocks.tools = [critic, commit]
    queue(response('', [call('commit', commit.name, '{"compilationId":"comp"}')]))
    await run('写下一章')
    expect(critic.execute).not.toHaveBeenCalled()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(mocks.chat.mock.calls.length).toBeGreaterThan(1)
    expect(events().at(-1)).not.toMatchObject({ type: 'run.finished', status: 'completed' })
    expect(mocks.runs.get('run')?.errorMessage).toContain('未完成或结果尚未确认')
  })
  it('does not obtain a hidden assessment tool when the original ceiling excludes it', async () => {
    mocks.chat.mockImplementation(async () => response('检查尚未完成，原文保留。'))
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const hidden = tool('quality_analyze', async () => ({ output: '不能越权调用' }))
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不能提交' }), false)
    mocks.tools = [commit]; mocks.hiddenTools = [hidden]
    queue(response('', [call('commit', commit.name, '{"compilationId":"comp"}')]))
    await run('写下一章')
    expect(hidden.execute).not.toHaveBeenCalled()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(mocks.runs.get('run')?.errorMessage).toContain('缺少必要检查')
  })
  it('stops one failed automatic critic without a new request or a commit', async () => {
    mocks.chat.mockImplementation(async () => response('检查尚未完成，原文保留。'))
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => { throw new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'unknown outcome') })
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不能提交' }), false)
    mocks.tools = [critic, commit]
    queue(response('', [call('commit', commit.name, '{"compilationId":"comp"}')]))
    await run('写下一章')
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(mocks.chat.mock.calls.length).toBeGreaterThan(1)
    expect(events().filter(event => event.type === 'tool.result')).toEqual([expect.objectContaining({ callId: 'commit', ok: false, durationMs: 0 }), expect.objectContaining({ ok: false, failureCode: 'AI_PROVIDER_TIMEOUT' })])
    expect(events().at(-1)).not.toMatchObject({ type: 'run.finished', status: 'completed' })
  })
  it('terminates supplier quota rejection once with a Chinese actionable notice', async () => {
    mocks.chat.mockRejectedValueOnce(new DataAccessError(502, 'AI_PROVIDER_QUOTA_EXCEEDED', '模型供应商余额或额度不足，请管理员检查上游账户。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章' })
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('供应商余额'))).toHaveLength(1)
    expect(mocks.runs.get('run')?.errorMessage).toContain('上游账户')
  })
  it('does not pay for a fallback before reporting invalid commit parameters', async () => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => ({ output: '不应执行' }))
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不应执行' }), false)
    commit.parameters = z.object({ compilationId: z.string().min(1) }).strict()
    mocks.tools = [critic, commit]
    queue(response('', [call('invalid-commit', commit.name, '{"compilationId":123}')]), response('参数尚未确认。'))
    await run('检查当前章节的提交参数，不改写正文')
    expect(critic.execute).not.toHaveBeenCalled()
    expect(commit.execute).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'invalid-commit', ok: false, summary: '参数校验失败' }))
  })
  it.each(['quality_analyze', 'continuity_validate'] as const)('persists %s before dispatch and refuses unknown replay after a fresh resume', async name => {
    mocks.reviewReadiness.mockResolvedValue(readiness(name === 'continuity_validate' ? 'stale' : 'complete', 'missing'))
    const critic = tool(name, async () => {
      const saved = mocks.runs.get('run')?.usage as { checkpoint: { pendingReviews: unknown[] } }
      expect(saved.checkpoint.pendingReviews).toEqual([{ compilationId: 'comp', chapterId: 'c', revision: 3, toolName: name, callId: 'paid-check' }])
      throw new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'unknown upstream receipt')
    })
    mocks.tools = [critic]
    queue(response('', [call('paid-check', name, '{"compilationId":"comp"}')]))
    await run('写下一章')
    const stopped = structuredClone(mocks.runs.get('run')!)
    const savedUsage = structuredClone(stopped.usage) as { checkpoint: { activeExecutionMs: number } }
    mocks.chat.mockClear()
    mocks.update.mockResolvedValueOnce(stopped as never)
    // Even a report saved just before the interruption is not the missing
    // original tool receipt; a changed revision cannot erase unknown work.
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'complete', 4))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.runs.get('run')?.errorMessage).toContain('未确认的请求')
    const { activeExecutionMs, ...storedCheckpoint } = savedUsage.checkpoint
    expect(mocks.runs.get('run')?.usage).toMatchObject({ ...savedUsage, checkpoint: storedCheckpoint })
    expect((mocks.runs.get('run')?.usage as typeof savedUsage).checkpoint.activeExecutionMs).toBeGreaterThanOrEqual(activeExecutionMs)
  })
  it.each(['QUALITY_REPORT_INCOMPLETE', 'QUALITY_EVIDENCE_UNLOCATED'])('records a known persisted %s report without inventing an unknown paid outcome or refunding the attempt', async failureCode => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => ({ output: '已保存未完成的检查报告', outcome: 'failed', failureCode }))
    mocks.tools = [critic]
    queue(response('', [call('known-report', critic.name, '{"compilationId":"comp"}')]), response('检查尚未完成。'))
    await run('写下一章')
    const usage = mocks.runs.get('run')?.usage as { checkpoint: { reviewAttempts: string[]; pendingReviews?: unknown[] } }
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(usage.checkpoint.pendingReviews).toBeUndefined()
    expect(usage.checkpoint.reviewAttempts).toContain('comp:c:3:quality_analyze')
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: false, failureCode }))
  })
  it.each(['matching', 'wrong-chapter', 'wrong-revision'] as const)('reconciles only a matching finished request receipt: %s', async scenario => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const proof = { version: 1 as const, chapterId: scenario === 'wrong-chapter' ? 'foreign' : 'c',
      revision: scenario === 'wrong-revision' ? 2 : 3, contentHash: 'a'.repeat(64) }
    const critic = tool('quality_analyze', async () => ({ output: '请求返回但报告未保存', outcome: 'failed',
      failureCode: 'QUALITY_REPORT_SAVE_FAILED', reviewRequestFinished: proof }))
    mocks.tools = [critic]
    queue(response('', [call('save-failure', critic.name, '{"compilationId":"comp"}')]), response('检查尚未完成。'))
    await run('写下一章')
    const usage = mocks.runs.get('run')?.usage as { checkpoint: { reviewAttempts: string[]; pendingReviews?: unknown[] } }
    expect(usage.checkpoint.reviewAttempts).toContain('comp:c:3:quality_analyze')
    if (scenario === 'matching') expect(usage.checkpoint.pendingReviews).toBeUndefined()
    else expect(usage.checkpoint.pendingReviews).toEqual([{ compilationId: 'comp', chapterId: 'c', revision: 3,
      toolName: 'quality_analyze', callId: 'save-failure' }])
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: false,
      failureCode: 'QUALITY_REPORT_SAVE_FAILED', reviewRequestFinished: proof }))
    expect(events().at(-1)).not.toMatchObject({ type: 'run.finished', status: 'completed' })
  })
  it('keeps request uncertainty when the returned receipt cannot be durably persisted', async () => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => ({ output: '报告未保存', outcome: 'failed', failureCode: 'QUALITY_REPORT_SAVE_FAILED',
      reviewRequestFinished: { version: 1, chapterId: 'c', revision: 3, contentHash: 'a'.repeat(64) } }))
    mocks.tools = [critic]
    mocks.journal.mockRejectedValueOnce(new Error('journal unavailable'))
    queue(response('', [call('receipt-not-durable', critic.name, '{"compilationId":"comp"}')]))
    await run('写下一章')
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { pendingReviews: [{ callId: 'receipt-not-durable' }] } })
    expect(mocks.chat).toHaveBeenCalledOnce()
  })
  it.each(['persisted', 'unavailable'] as const)('journals a failed billing reconciliation before allowing a new version check: %s', async journal => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => { throw new Error('old local failure') })
    mocks.tools = [critic]
    queue(response('', [call('old-failure', critic.name, '{"compilationId":"comp"}')]), response('检查尚未完成。'))
    await run('写下一章')
    const stopped = structuredClone(mocks.runs.get('run')!)
    mocks.update.mockResolvedValueOnce(stopped as never)
    const receipt = { status: 'terminal_failed_billing_known' as const, sourceRunId: 'run', sourceResultId: 'failed-result',
      sourceReportId: 'failed-report', usageIds: ['primary', 'format'], admissionId: 'author-continue:terminal',
      currentRevision: 4, currentContentHash: 'b'.repeat(64) }
    mocks.settledQuality.mockResolvedValue([{ callId: 'old-failure', compilationId: 'comp', chapterId: 'c', revision: 3,
      toolName: 'quality_analyze', reconciliation: receipt }])
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing', 4))
    mocks.chat.mockClear()
    if (journal === 'unavailable') mocks.journal.mockRejectedValueOnce(new Error('reconciliation journal unavailable'))
    critic.execute = vi.fn(async () => ({ output: '当前版本仍需复核', outcome: 'failed', failureCode: 'QUALITY_REPORT_INCOMPLETE' }))
    queue(response('', [call('new-version-check', critic.name, '{"compilationId":"comp"}')]), response('检查尚未完成。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(events()).toContainEqual(expect.objectContaining({ type: 'review.reconciled', callId: 'old-failure', revision: 3, receipt }))
    expect(mocks.journal).toHaveBeenCalled()
    if (journal === 'unavailable') {
      expect(critic.execute).not.toHaveBeenCalled()
      expect(mocks.chat).not.toHaveBeenCalled()
      expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { pendingReviews: [{ callId: 'old-failure', revision: 3 }] } })
      return
    }
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { reviewAttempts: expect.arrayContaining(['comp:c:3:quality_analyze', 'comp:c:4:quality_analyze']) } })
    expect((mocks.runs.get('run')?.usage as { checkpoint: unknown }).checkpoint).not.toHaveProperty('pendingReviews')
  })
  it('inherits unresolved review evidence on a typed continuation without a fresh budget or paid turn', async () => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => { throw new DataAccessError(502, 'AI_PROVIDER_TRANSPORT', 'unknown') })
    mocks.tools = [critic]
    queue(response('', [call('unknown-check', critic.name, '{"compilationId":"comp"}')]), response('原调用结果未知，等待确认。'))
    await run('写下一章')
    const original = { ...structuredClone(mocks.runs.get('run')!), id: 'prior' }
    mocks.previous.mockResolvedValue(original as never)
    mocks.priorRuns.mockResolvedValue([original])
    mocks.original.mockResolvedValue({ parts: [{ type: 'text', text: '写下一章' }] })
    mocks.chat.mockClear()
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '继续' })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.errorMessage).toContain('未确认的请求')
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { inheritedTokens: (original.usage as { totalTokens: number }).totalTokens, inheritedTurns: original.currentTurn,
      pendingReviews: [{ compilationId: 'comp', chapterId: 'c', revision: 3, toolName: 'quality_analyze', callId: 'unknown-check' }] } })
  })
  it('protects standalone quality requests without creating a compiler on resume', async () => {
    const critic = tool('quality_analyze', async () => { throw new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'unknown') })
    mocks.tools = [critic]
    queue(response('', [call('standalone', critic.name, '{"chapterId":"c"}')]))
    await run('检查当前章节')
    const stopped = structuredClone(mocks.runs.get('run')!)
    expect(stopped.usage).toMatchObject({ checkpoint: { pendingReviews: [ { compilationId: null, chapterId: 'c', revision: 1,
      toolName: 'quality_analyze', callId: 'standalone' } ] } })
    mocks.update.mockResolvedValueOnce(stopped as never)
    mocks.chat.mockClear()
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '检查当前章节', resume: true })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.errorMessage).toContain('未确认的请求')
  })
  it('sends no critic when pre-dispatch evidence cannot persist and does not invent an unknown request', async () => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => ({ output: '不应执行' }))
    mocks.tools = [critic]
    mocks.update.mockImplementation(async input => {
      if ((input.data.usage as { checkpoint?: { pendingReviews?: unknown[] } } | undefined)?.checkpoint?.pendingReviews?.length) throw new Error('checkpoint unavailable')
      return {} as never
    })
    queue(response('', [call('not-sent', critic.name, '{"compilationId":"comp"}')]))
    await run('写下一章')
    expect(critic.execute).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect((mocks.runs.get('run')?.usage as { checkpoint: unknown }).checkpoint).not.toHaveProperty('pendingReviews')
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })
  it.each(['default', 'alias', 'envelope'] as const)('journals normalized %s critic targets without an editor chapter and survives resume', async format => {
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { pendingReviews: [{ compilationId: 'comp', chapterId: 'c',
        revision: 3, toolName: 'quality_analyze', callId: 'normalized' }] } })
      throw new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'unknown')
    })
    critic.parameters = z.object({ compilationId: z.string().optional() })
    critic.coerceArgs = raw => {
      const args = raw as { compilationId?: string; compilation_id?: string }
      return { compilationId: args.compilationId ?? args.compilation_id }
    }
    mocks.tools = [critic]
    const args = format === 'default' ? '{}' : format === 'alias' ? '{"compilation_id":"comp"}' : '{"arguments":"{\\"compilationId\\":\\"comp\\"}"}'
    queue(response('', [call('normalized', critic.name, args)]))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '写下一章' })
    const stopped = structuredClone(mocks.runs.get('run')!)
    mocks.update.mockResolvedValueOnce(stopped as never)
    mocks.chat.mockClear()
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '写下一章', resume: true })
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.runs.get('run')?.errorMessage).toContain('未确认的请求')
  })
})

describe('phase skills in the real execution loop', () => {
  it('restores cached phases across chapters and after the active hint is compacted away', async () => {
    const { routeSkills } = await import('../../api/lib/agent/skills/index.js')
    vi.mocked(assembleContext).mockResolvedValueOnce({ messages: [], skillRoute: routeSkills({ mode: 'build', intent: 'write', prompt: '续写正文', freedom: 'balanced' }) })
    mocks.tools = ['story_compiler_prepare', 'scene_task_build', 'chapter_write'].map(name => tool(name, async () => {
      if (name !== 'chapter_write') return { output: '已完成阶段' }
      const chapter = mocks.chapters[0], before = chapter.content
      chapter.content += '\n新写入的场景正文。'
      chapter.revision++
      return { output: '已保存正文', display: { kind: 'chapterDiff', chapterId: chapter.id, chapterTitle: chapter.title,
        before, after: chapter.content, appliedDirectly: true, revision: chapter.revision } }
    }))
    const stages: Array<{ name: string; expected: string | null }> = [
      { name: 'story_compiler_prepare', expected: null },
      { name: 'scene_task_build', expected: '/ scene /' },
      { name: 'chapter_write', expected: '/ draft /' },
      { name: 'story_compiler_prepare', expected: '/ critique /' },
      { name: 'scene_task_build', expected: '/ scene /' },
      { name: 'chapter_write', expected: '/ draft /' },
    ]
    for (const [index, stage] of stages.entries()) mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      const hints = input.messages.filter(message => typeof message.content === 'string' && message.content.includes('系统·创作阶段工作方法'))
      if (stage.expected) { expect(hints).toHaveLength(1); expect(hints[0].content).toContain(stage.expected) }
      return response('', [call(`stage${index}`, stage.name, JSON.stringify({ chapter: index }))])
    })
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      const index = input.messages.findIndex(message => typeof message.content === 'string' && message.content.includes('系统·创作阶段工作方法'))
      expect(index).toBeGreaterThanOrEqual(0)
      input.messages.splice(index, 1) // emulate the existing checkpoint compactor
      return response('', [call('read-after-compaction', 'chapter_write', '{"chapter":7}')])
    })
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      expect(input.messages.filter(message => typeof message.content === 'string' && message.content.includes('系统·创作阶段工作方法'))).toHaveLength(1)
      return response('已完成。')
    })
    await run('续写正文')
    expect(mocks.chat).toHaveBeenCalledTimes(8)
    expect(events().filter(event => event.type === 'skill.route' && event.phase === 'scene')).toHaveLength(1)
  })
  it('loads the new phase once between complete tool batches without extra model requests', async () => {
    const { routeSkills } = await import('../../api/lib/agent/skills/index.js')
    vi.mocked(assembleContext).mockResolvedValueOnce({ messages: [], skillRoute: routeSkills({ mode: 'build', intent: 'plan', prompt: '规划大纲', freedom: 'balanced' }) })
    mocks.tools = [tool('scene_task_build', async () => ({ output: '场景已建立' }))]
    queue(response('', [call('s1', 'scene_task_build')]), response('', [call('s2', 'scene_task_build', '{"chapter":2}')]), response('已完成。'))
    await run('规划并续写正文')
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(events().filter(event => event.type === 'skill.route' && event.phase === 'draft')).toHaveLength(1)
    const messages = mocks.chat.mock.calls[1][0].messages as Array<{ role: string; content?: string; toolCallId?: string }>
    const digestAt = messages.findIndex(message => message.content?.includes('系统·创作阶段工作方法'))
    expect(digestAt).toBeGreaterThan(messages.findIndex(message => message.role === 'tool' && message.toolCallId === 's1'))
    expect(mocks.skillLoads.mock.calls.some(args => args[3] === 'phase')).toBe(true)
  })
  it('does not load a stage for a failed tool', async () => {
    const { routeSkills } = await import('../../api/lib/agent/skills/index.js')
    vi.mocked(assembleContext).mockResolvedValueOnce({ messages: [], skillRoute: routeSkills({ mode: 'build', intent: 'plan', prompt: '规划大纲', freedom: 'balanced' }) })
    mocks.tools = [tool('scene_task_build', async () => { throw new Error('fixture failure') })]
    queue(response('', [call('s1', 'scene_task_build')]), response('场景未完成。'))
    await run('规划并续写正文')
    expect(events().filter(event => event.type === 'skill.route')).toHaveLength(1)
  })
})

describe('BYOK paid-tool isolation', () => {
  it.each(['web_search', 'research_dossier_build', 'cover_generate', 'view_image'])('keeps %s quota failure local to the paid tool', async name => {
    const ctx = context()
    const runtime = await (await import('../../api/lib/credits.js')).getModelTierRuntime()
    ctx.modelRuntime = { ...runtime, tier: 'custom', multiplierBps: 0 }
    const admitted = tool(name, async () => { throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '平台额度不足') })
    const result = await handleToolCall(call('paid', name), [admitted], ctx, { emit: mocks.emit }, 'message', 'run')
    expect(result.part.status).toBe('failed')
    expect(result.observation).toContain('自定义文本模型')
    expect(result.observation).toContain('不要重复调用')
  })
  it('does not swallow platform quota errors for a built-in model', async () => {
    const admitted = tool('web_search', async () => { throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '平台额度不足') })
    await expect(handleToolCall(call('paid', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
  })
  it('keeps platform quota failure local to the paid tool for the zero-rate free tier', async () => {
    const ctx = context()
    const runtime = await (await import('../../api/lib/credits.js')).getModelTierRuntime()
    ctx.modelRuntime = { ...runtime, tier: 'lite', multiplierBps: 0, provider: 'deepseek', modelName: 'fixture-free', baseUrl: null, apiKey: null,
      reasoningEffort: 'low', reasoningEfforts: ['low', 'high', 'max'], visionEnabled: false }
    const admitted = tool('web_search', async () => { throw new DataAccessError(402, 'CREDITS_EXHAUSTED', '平台额度不足') })
    const result = await handleToolCall(call('paid', 'web_search'), [admitted], ctx, { emit: mocks.emit }, 'message', 'run')
    expect(result.part.status).toBe('failed')
    expect(result.observation).toContain('免费模型')
    expect(result.observation).toContain('不要重复调用')
  })
})

describe('original task context on resume', () => {
  it.each([
    ['AI_PROVIDER_EMPTY_RESPONSE', '模型未返回有效内容', false],
    ['AI_PROVIDER_TRANSPORT', '模型连接中断，结果未确认', true],
    ['AI_PROVIDER_INCOMPLETE', '模型输出中断，检查未完成', true],
    ['AI_PROVIDER_TIMEOUT', '模型网关超时', true],
  ] as const)('keeps %s feedback truthful without replaying an unconfirmed paid result', async (code, label, unconfirmed) => {
    const check = tool('continuity_validate', async () => { throw new DataAccessError(502, code, 'synthetic provider failure') })
    const outcome = await handleToolCall(call('check', check.name), [check], context(), { emit: mocks.emit }, 'message', 'run')
    expect(outcome).toMatchObject({ part: { status: 'failed', summary: label }, providerFailure: true, providerFailureCode: code })
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: false, failureCode: code, summary: label }))
    if (unconfirmed) {
      expect(outcome.observation).toContain('先核对原调用与已保存状态')
      expect(outcome.observation).toContain('不要盲目重发未知付费请求')
      expect(outcome.observation).not.toContain('最多重试一次')
    }
    expect(check.execute).toHaveBeenCalledOnce()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('consumes output-limit feedback without replaying or committing an unfinished review', async () => {
    mocks.chat.mockImplementation(async () => response('检查尚未完成，原文保留。'))
    const critic = tool('continuity_validate', async () => { throw new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'output limit') })
    const commit = tool('chapter_bridge_commit', async () => ({ output: '不得执行的提交' }))
    mocks.tools = [critic, commit]
    queue(response('', [call('check', 'continuity_validate'), call('commit', 'chapter_bridge_commit'), call('repeat', 'continuity_validate')]), response('检查未完成，已保留正文并停止提交。'))
    await run()
    expect(critic.execute).toHaveBeenCalledTimes(1)
    expect(commit.execute).not.toHaveBeenCalled()
    expect(mocks.chat.mock.calls.length).toBeGreaterThan(1)
    const submitted = mocks.chat.mock.calls[0][0] as Parameters<typeof chatType>[0]
    for (const id of ['commit', 'repeat']) expect(submitted.messages).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: id, content: expect.any(String) }))
    expect(events().filter(event => event.type === 'tool.result' && event.callId === 'check')).toEqual([expect.objectContaining({ callId: 'check', ok: false, summary: '模型输出达到上限，检查未完成' })])
    expect(events().filter(event => event.type === 'tool.result' && ['commit', 'repeat'].includes(event.callId)).every(event => event.type === 'tool.result' && !event.ok)).toBe(true)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.paused' }))
    const stopText = String(mocks.runs.get('run')?.errorMessage)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes(stopText))).toHaveLength(1)
  })
  it.each(['quality_analyze', 'continuity_validate', 'creative_critique', 'cover_generate'])('stops the first unknown %s request without dispatching other parameters in the batch', async name => {
    const failing = tool(name, async () => { throw new DataAccessError(502, 'AI_PROVIDER_TIMEOUT', 'gateway timeout') })
    mocks.tools = [failing]
    queue(response('', [call('q1', name, '{"compilationId":"first"}'), call('q2', name, '{"compilationId":"second"}'), call('q3', name, '{}')]), response('操作未完成，正文保留。'))
    await run()
    expect(failing.execute).toHaveBeenCalledOnce()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events().filter(event => event.type === 'tool.result')).toEqual(expect.arrayContaining([expect.objectContaining({ summary: '模型网关超时', ok: false })]))
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'failed' }))
  })
  it('announces parameter preparation before the model finishes, without admitting execution early', async () => {
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      input.onChunk?.({ type: 'tool-call-start', id: 'preparing-read', name: 'chapter_read' })
      expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.delta', callId: 'preparing-read', toolName: 'chapter_read', title: 'chapter_read', argsChars: 0 }))
      expect(events().filter(event => event.type === 'tool.call')).toEqual([])
      input.onChunk?.({ type: 'tool-call-arguments-delta', id: 'preparing-read', delta: ' '.repeat(1024) })
      expect(events().filter(event => event.type === 'tool.delta').at(-1)).toMatchObject({ toolName: 'chapter_read', argsChars: 1024 })
      expect(mocks.tools[0].execute).not.toHaveBeenCalled()
      return response('', [call('preparing-read')])
    })
    queue(response('已核对。'))
    await run()
    expect(events().filter(event => event.type === 'tool.call').map(event => event.callId)).toEqual(['preparing-read'])
    expect(mocks.tools[0].execute).toHaveBeenCalledOnce()
  })
  it('restores the complete research request on typed continue and does not revive legacy writing authority', async () => {
    const originalPrompt = '搜索并拆解这本小说，不要写章节。' + '核对人物与情节证据。'.repeat(130)
    const taskSpec = { ...buildTaskSpec({ runId: 'original', novelId: 'novel', prompt: originalPrompt }), intent: 'write' as const }
    const prior = { id: 'original', taskSpec, usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      status: 'paused', currentTurn: 1, startedAt: new Date() }
    mocks.previous.mockResolvedValue(prior as never)
    mocks.priorRuns.mockResolvedValue([prior])
    mocks.original.mockResolvedValue({ parts: [{ type: 'text', text: originalPrompt }] })
    const write = tool('chapter_write', async () => ({ output: 'must not write' }), false)
    mocks.tools.push(write)
    queue(response('', [call('forbidden', 'chapter_write')]), response('资料不足，未改动作品。'))
    await run('继续')
    expect(write.execute).not.toHaveBeenCalled()
    expect(assembleContext).toHaveBeenCalledWith(expect.objectContaining({
      prompt: originalPrompt + '\n\n[用户本次要求] 继续',
      taskSpec: expect.objectContaining({ id: taskSpec.id, intent: 'research_analysis' }),
    }))
    expect(mocks.original).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sessionId: 'session', role: 'user', run: expect.objectContaining({ userId: 'user', novelId: 'novel',
        taskSpec: { path: ['id'], equals: taskSpec.id } }),
    }) }))
  })
  it('does not call the model when typed continuation has lost the original request', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', prompt: '分析这本小说' })
    mocks.previous.mockResolvedValue({ id: 'original', taskSpec } as never)
    mocks.original.mockResolvedValue(null)
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null,
      mode: 'build', prompt: '继续' })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'run_input_required' }))
  })
  it('does not accept a claimed complete report when persisted sections are still short', async () => {
    mocks.chat.mockResolvedValue(response('完整研究报告已完成。'))
    await run('拆解这本小说，研究报告至少10000字。')
    expect(mocks.report).toHaveBeenCalledTimes(5)
    expect(mocks.report).toHaveBeenCalledWith({ userId: 'user', novelId: 'novel', sessionId: 'session', runId: 'run' })
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(mocks.tools.some(item => item.name === 'todo_write')).toBe(false)
  })
  it('continues missing report sections and finishes only after persisted length reaches the requirement', async () => {
    let saved = 100
    const content = '# 研究报告\n\n已经保存的结构与人物分析。'
    mocks.report.mockImplementation(async () => ({ chineseCharacters: saved, content }))
    mocks.tools.push(tool('research_report_save', async () => {
      saved = 10000
      return { output: '已保存缺失区块，报告共10000个汉字。' }
    }, false))
    queue(response('报告已完成。'), response('', [call('save-section', 'research_report_save')]), response('研究结果如下。'))
    await run('拆解这本小说，研究报告至少10000字。')
    expect(mocks.report).toHaveBeenCalledTimes(2)
    expect(mocks.tools.at(-1)?.execute).toHaveBeenCalledTimes(1)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'text.final', text: content, asReasoning: false }))
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      parts: expect.arrayContaining([{ type: 'text', text: content }]),
    }) }))
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('does not require a research artifact for ordinary chapter tasks', async () => {
    queue(response('已完成。'))
    await run('写第十九章。')
    expect(mocks.report).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('narrows a legacy misclassified research run on explicit resume and persists the same task identity', async () => {
    const prompt = '搜索并拆解这本小说，不要写章节。'
    const legacy = { ...buildTaskSpec({ runId: 'run', novelId: 'novel', prompt }), intent: 'write' as const }
    mocks.update.mockResolvedValueOnce({ ...{ taskSpec: legacy }, usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      currentTurn: 1, startedAt: new Date() })
    const write = tool('chapter_write', async () => ({ output: 'must not write' }), false)
    mocks.tools.push(write)
    queue(response('', [call('blocked-resume', 'chapter_write')]), response('资料不足，未改动作品。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null,
      mode: 'build', prompt, resume: true })
    expect(write.execute).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      taskSpec: expect.objectContaining({ id: legacy.id, intent: 'research_analysis' }),
    }) }))
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'blocked-resume', ok: false }))
  })
  it.each(['chapter_write', 'plan_save', 'memory_save', 'task_send', 'subagent_delegate'])('rejects model-requested %s during book research even with an allowed registry tool', async toolName => {
    const write = tool(toolName, async () => ({ output: 'must not write' }), false)
    mocks.tools.push(write)
    queue(response('', [call('forbidden-write', toolName)]), response('资料不足，未改动作品。'))
    await run('搜索并拆解这本小说，不要写章节。')
    expect(write.execute).not.toHaveBeenCalled()
    const { captureUserDirectives } = await import('../../api/lib/agent/context-engine.js')
    expect(captureUserDirectives).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', callId: 'forbidden-write', ok: false }))
  })
  it.each([false, true])('preserves the exact request and run identity when resume=%s', async resume => {
    const prompt = '只完成第19章，不能重开旧章节的任务窗口。' + '原始详细要求。'.repeat(100)
    queue(response('已完成。'))
    if (resume) mocks.update.mockResolvedValueOnce({ taskSpec: null,
      ...{ usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 }, currentTurn: 1, startedAt: new Date() } })
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null,
      mode: 'build', prompt, resume, selection: { text: '本次选区', start: 0, end: 4 } })
    expect(assembleContext).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', prompt,
      includeCurrentRunHistory: resume, selection: { text: '本次选区', start: 0, end: 4 } }))
    expect(events().filter(event => event.type === 'error')).toEqual([])
    if (resume) {
      expect(mocks.persist).not.toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ role: 'user' }) }))
      expect(mocks.previous).not.toHaveBeenCalled()
    }
  })
})

describe('persisted legacy checkpoint budgets', () => {
  const resume = () => executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel',
    chapterId: 'c', mode: 'build', prompt: '检查当前章节', resume: true })
  it('preserves historical raw slice values without treating them as effective limits', async () => {
    const started = Date.now() - 1000
    const tokenBudget = env.agentRunTokenBudgetCeiling + 2_006_003
    const checkpoint = { version: 1, runStartedAt: started, resumeCount: 2, compactionCount: 2,
      maxTurns: env.agentMaxTurns + 150, tokenBudget, manualResumeCount: 1,
      writeProgress: 2, writeBaseline: 2, readProgress: 2, readBaseline: 2, progressSignatures: [] }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 2, startedAt: new Date(started),
      usage: { promptTokens: tokenBudget - 3000, completionTokens: 0, totalTokens: tokenBudget - 3000, checkpoint } })
    queue(response('已完成。'))
    await resume()
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ totalTokens: tokenBudget - 2990,
      checkpoint: { controlPolicy: 'until_completion', origin: 'unknown_legacy', tokenBudget, manualResumeCount: 1 } })
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it('resumes actual work after a paused gap without resetting token consumption', async () => {
    const now = Date.now(), started = now - (env.agentRunWallClockMinutes + 10) * 60_000
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 1, startedAt: new Date(started),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      events: [{ type: 'run.started', createdAt: new Date(started) },
        { type: 'run.paused', createdAt: new Date(started + 60_000) }] })
    queue(response('已完成。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded',
      usage: expect.objectContaining({ totalTokens: 130 }) }))
  })

  it('continues after a historical cumulative execution-time threshold and retains usage', async () => {
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 1,
      startedAt: new Date(Date.now() - (env.agentRunWallClockMinutes + 1) * 60_000),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } })
    queue(response('已完成检查。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded',
      usage: expect.objectContaining({ totalTokens: 130 }) }))
  })

  it('retains cumulative usage, earned slices, progress and the original clock on resume', async () => {
    const started = Date.now() - 1000
    const checkpoint = { version: 1, runStartedAt: started, resumeCount: 1, compactionCount: 1,
      maxTurns: env.agentMaxTurns + 50, tokenBudget: 4000000,
      writeProgress: 2, writeBaseline: 2, readProgress: 3, readBaseline: 3, progressSignatures: ['existing-evidence'] }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 2, startedAt: new Date(started),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint } } })
    queue(response('已完成。'))
    await resume()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished',
      usage: expect.objectContaining({ promptTokens: 110, completionTokens: 20, totalTokens: 130 }) }))
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data).toMatchObject({ currentTurn: 3, usage: { checkpoint: { ...checkpoint,
      version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy' } } })
    expect(mocks.update.mock.calls[0]?.[0].data).not.toHaveProperty('startedAt')
  })

  it('does not call the provider or overwrite corrupt saved usage with zero', async () => {
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 8,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint: { version: 999 } } } })
    await resume()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.update.mock.calls.every(([input]) => !Object.hasOwn(input.data, 'usage'))).toBe(true)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'run_checkpoint_unconfirmed' }))
  })

  it('resumes an exhausted historical chain without granting another slice', async () => {
    const started = Date.now() - 60_000
    const ceiling = env.agentRunTokenBudgetCeiling
    const checkpoint = { version: 1, runStartedAt: started, resumeCount: 2, compactionCount: 2,
      maxTurns: env.agentMaxTurns + 100, tokenBudget: ceiling,
      writeProgress: 5, writeBaseline: 5, readProgress: 5, readBaseline: 5, progressSignatures: [],
      inheritedTokens: ceiling + 6_003 - 1_285_735, inheritedTurns: 56, inheritedExecutionMs: 60_000 }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 19, startedAt: new Date(started),
      usage: { promptTokens: 1_285_735, completionTokens: 0, totalTokens: 1_285_735, checkpoint } } })
    queue(response('已完成。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded' }))
    expect(events().some(event => event.type === 'text.final' && event.text.includes('手动续跑'))).toBe(false)
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ totalTokens: 1_285_745, checkpoint: {
      controlPolicy: 'until_completion', manualResumeCount: 0, tokenBudget: ceiling,
      inheritedTokens: checkpoint.inheritedTokens, inheritedTurns: 56, maxTurns: checkpoint.maxTurns } })
  })

  it('retains used-up historical manual grants while completing the author task', async () => {
    const ceiling = env.agentRunTokenBudgetCeiling
    const checkpoint = { version: 1, runStartedAt: Date.now(), resumeCount: 4, compactionCount: 4,
      maxTurns: env.agentMaxTurns + 300, tokenBudget: ceiling + 4_000_000,
      writeProgress: 5, writeBaseline: 5, readProgress: 5, readBaseline: 5, progressSignatures: [],
      inheritedTokens: ceiling + 4_000_000 - 1_000_000, inheritedTurns: 70, manualResumeCount: 2 }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 3, startedAt: new Date(),
      usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, checkpoint } } })
    queue(response('已完成检查。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalledOnce()
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ totalTokens: 1_000_010, checkpoint: {
      controlPolicy: 'until_completion', manualResumeCount: 2, tokenBudget: checkpoint.tokenBudget,
      resumeCount: 4, compactionCount: 4, maxTurns: checkpoint.maxTurns } })
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded' }))
  })

  it('continues a checkpoint-less historical run with cumulative accounting and no new slice', async () => {
    const ceiling = env.agentRunTokenBudgetCeiling
    mocks.update.mockResolvedValueOnce({ taskSpec: null, ...{ currentTurn: 2, startedAt: new Date(),
      usage: { promptTokens: ceiling, completionTokens: 0, totalTokens: ceiling } } })
    queue(response('已完成。'))
    await resume()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished', status: 'succeeded' }))
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ totalTokens: ceiling + 10, checkpoint: {
      controlPolicy: 'until_completion', manualResumeCount: 0, tokenBudget: 500, maxTurns: 1 } })
  })

  it('keeps confirmed stream usage when stopped before a complete model response', async () => {
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      input.onUsage?.({ promptTokens: 40, completionTokens: null, totalTokens: null })
      input.onUsage?.({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
      throw new DOMException('stopped', 'AbortError')
    })
    await run('检查当前章节')
    const paused = mocks.update.mock.calls.find(([input]) => input.data.status === 'paused')?.[0]
    expect(paused?.data.usage).toMatchObject({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
    expect(mocks.chat).toHaveBeenCalledOnce()
  })

  it('counts the final usage delta once after intermediate stream observations', async () => {
    mocks.chat.mockImplementationOnce(async (input: Parameters<typeof chatType>[0]) => {
      input.onUsage?.({ promptTokens: 20, completionTokens: null, totalTokens: null })
      input.onUsage?.({ promptTokens: 40, completionTokens: 0, totalTokens: 40 })
      return response('已完成。', [], 50)
    })
    await run('检查当前章节')
    expect(events()).toContainEqual(expect.objectContaining({ type: 'run.finished',
      usage: { promptTokens: 50, completionTokens: 0, totalTokens: 50 } }))
  })
})

describe('tool execution authority (real dispatch, mocked global registry)', () => {
  it('closes a resolved failure with a failed terminal event, without claiming an effect', async () => {
    const admitted = tool('chapter_write', async () => ({ outcome: 'failed', output: '正文已由作者修改，未覆盖。', summary: '正文变更未执行' }), false)
    const result = await handleToolCall(call('conflict', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(admitted.execute).toHaveBeenCalledOnce()
    expect(result.part).toMatchObject({ status: 'failed', summary: '正文变更未执行' })
    expect(result.part.snapshot).toBeUndefined()
    expect(result.observation).toContain('未覆盖')
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ callId: 'conflict', ok: false, summary: '正文变更未执行' }),
    ])
  })

  it('closes a throwing normalizer without executing or exposing its private exception', async () => {
    const admitted = { ...tool('scene_task_build', async () => ({ output: '不应执行' })), coerceArgs: vi.fn(() => { throw new Error('private-payload') }) }
    const result = await handleToolCall(call('normalize', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(admitted.execute).not.toHaveBeenCalled()
    expect(result.part.status).toBe('failed')
    expect(result.observation).not.toContain('private-payload')
    expect(events().filter(event => event.type === 'tool.call')).toHaveLength(1)
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ callId: 'normalize', ok: false, summary: '参数归一化失败' }),
    ])
  })

  it.each(['chapter_write', 'task_create', 'subagent_delegate', 'memory_save'])('cannot resurrect excluded %s from the global registry', async name => {
    const hidden = tool(name, async () => ({ output: '不应执行' }), false)
    mocks.hiddenTools = [hidden]
    const result = await handleToolCall(call('excluded', name), mocks.tools, context(), { emit: mocks.emit }, 'message', 'run')
    expect(hidden.execute).not.toHaveBeenCalled()
    expect(result.part.status).toBe('denied')
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ callId: 'excluded', ok: false }),
    ])
  })

  it('rejects an excluded malformed call before coercion or retry advice', async () => {
    const hidden = { ...tool('chapter_write', async () => ({ output: '' }), false), coerceArgs: vi.fn(() => ({})) }
    mocks.hiddenTools = [hidden]
    const result = await handleToolCall(call('excluded', hidden.name, '{'), [], context(), { emit: mocks.emit }, 'message', 'run')
    expect(result.part.status).toBe('denied')
    expect(result.observation).not.toContain('请修正后重试')
    expect(hidden.coerceArgs).not.toHaveBeenCalled()
    expect(hidden.execute).not.toHaveBeenCalled()
  })

  it('still executes an explicitly admitted writing tool', async () => {
    const admitted = tool('chapter_write', async () => ({ output: '合法写作' }), false)
    const result = await handleToolCall(call('allowed', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(admitted.execute).toHaveBeenCalledOnce()
    expect(result.part.status).toBe('success')
  })

  it('does not regain a hidden writing tool during a real continuation loop', async () => {
    admitCurrentOriginal('检查当前章节，不要改写正文。')
    const hidden = tool('chapter_write', async () => ({ output: '不应执行' }), false)
    mocks.hiddenTools = [hidden]
    queue(response('', [call('hidden-resume', hidden.name)]), response('当前任务无写入授权，未修改正文。'))
    await run('继续')
    expect(hidden.execute).not.toHaveBeenCalled()
    expect(events().filter(event => event.type === 'tool.result')).toContainEqual(expect.objectContaining({ callId: 'hidden-resume', ok: false }))
  })

  it.each(['granted', 'empty', 'missing', 'unknown-role', 'orchestrator-role'] as const)('respects a %s parent snapshot through the real inline runner', async authority => {
    const candidate = tool('chapter_read', async () => ({ output: '已读' }))
    candidate.permission = { plan: 'deny', build: 'deny', review: 'allow' }
    mocks.tools = [candidate]
    const parent = context()
    parent.mode = 'plan'
    if (authority !== 'missing') parent.toolAuthority = authority !== 'empty'
      ? new Map([['chapter_read', { permission: 'allow', alwaysConfirm: false, dangerous: false }]])
      : new Map()
    queue(response('', [call('child-read')]), response('已读取。'))
    const result = await runSubagentInline({
      subagentCallId: 'child', subtaskRunId: 'subrun', name: '一致性', role: authority === 'unknown-role' ? 'invalid' : authority === 'orchestrator-role' ? 'orchestrator' : 'continuity',
      triggerCondition: '', prompt: '', task: '读取', mode: 'review', parentRunId: 'run',
      sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, messageId: 'message',
      modelRuntime: await (await import('../../api/lib/credits.js')).getModelTierRuntime(),
      bus: { emit: mocks.emit }, toolContextBase: parent, sessionPolicy: null,
    })
    if (authority === 'granted') {
      expect(candidate.execute).toHaveBeenCalledOnce()
      expect(vi.mocked(candidate.execute).mock.calls[0][0].mode).toBe('review')
    } else {
      expect(candidate.execute).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: false, denied: true })
      if (authority !== 'empty') expect(mocks.chat).not.toHaveBeenCalled()
    }
  })

  it('honors an inherited forced confirmation even with automatic approval enabled', async () => {
    const admitted = tool('chapter_write', async () => ({ output: '不应执行' }), false)
    const ctx = context()
    ctx.toolAuthority = new Map([[admitted.name, { permission: 'ask', alwaysConfirm: true, dangerous: true }]])
    const { waitForApproval } = await import('../../api/lib/agent/permissions.js')
    vi.mocked(waitForApproval).mockResolvedValueOnce({ approved: false, alwaysAllow: false, timedOut: false })
    const previous = env.agentAutoApprove
    env.agentAutoApprove = true
    try {
      const result = await handleToolCall(call('confirm', admitted.name), [admitted], ctx, { emit: mocks.emit }, 'message', 'run')
      expect(waitForApproval).toHaveBeenCalledOnce()
      expect(admitted.execute).not.toHaveBeenCalled()
      expect(result.part.status).toBe('denied')
    } finally { env.agentAutoApprove = previous }
  })
})

describe('Agent run admission and completion lifecycle (real loop, mocked provider/persistence)', () => {
  it.each([false, true])('allows one persisted legacy locator diagnostic read, never replenished on resume (already used=%s)', async used => {
    const hash = 'a'.repeat(64)
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 4, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 3, writeBaseline: 0, readProgress: 4, readBaseline: 0,
      progressSignatures: [`read-range:${JSON.stringify(['c', hash])}:0-10`],
      ...(used ? { inputProtocolRecovery: { protocol: 2, key: 'b'.repeat(64) } } : {}),
      toolRestrictions: ['chapter_edit_range', 'chapter_write', 'chapter_append'].map(action => ({ action, target: 'c', code: 'CHAPTER_ANCHOR_CONFLICT', reason: '旧定位失败审计' })) }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 26, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint } })
    const read = tool('chapter_read', async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { stagnantBatches: 4, tokenBudget: 500,
        inputProtocolRecovery: { protocol: 2, key: used ? 'b'.repeat(64) : expect.any(String) } } })
      return { output: '已核对当前正文', observedChapterRange: { targetId: 'c', contentHash: hash, start: 0, end: 10 } }
    })
    const edit = tool('chapter_edit_range', async () => {
      expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { stagnantBatches: 5, readProgress: 4, writeProgress: 3, tokenBudget: 500 } })
      return { output: '真实修改已保存', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '火墙', before: '旧句', after: '修订句', revision: 2, appliedDirectly: true } }
    }, false)
    const commit = tool('chapter_bridge_commit', async () => { mocks.committedChapter.mockResolvedValue(true); return { output: '核验终态已提交' } }, false)
    mocks.tools = [read, edit, commit]
    queue(response('', [call('read', read.name, '{"chapterId":"c"}')]), response('', [call('correct', edit.name, '{"chapterId":"c","oldText":"旧句","newText":"修订句"}'), call('commit', commit.name)]), response('完成。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(read.execute).toHaveBeenCalledOnce()
    expect(edit.execute).toHaveBeenCalledTimes(used ? 0 : 1)
    expect(commit.execute).toHaveBeenCalledTimes(used ? 0 : 1)
    expect(mocks.runs.get('run')).toMatchObject({ status: used ? 'paused' : 'completed', usage: { checkpoint: { tokenBudget: 500,
      readProgress: 4, writeProgress: used ? 3 : 4, stagnantBatches: used ? 5 : 0,
      inputProtocolRecovery: { protocol: 2, key: used ? 'b'.repeat(64) : expect.any(String) } } } })
  })
  it('narrows a saved legacy anchor family ban without resetting failed-batch or budget counters', async () => {
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', runStartedAt: Date.now() - 1000,
      activeExecutionMs: 100, stagnantBatches: 4, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500,
      writeProgress: 3, writeBaseline: 0, readProgress: 4, readBaseline: 0, progressSignatures: [],
      toolRestrictions: ['chapter_edit_range', 'chapter_write', 'chapter_append'].map(action => ({ action, target: 'c', code: 'CHAPTER_ANCHOR_CONFLICT', reason: '旧定位失败审计' })) }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 26, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint } })
    const edit = tool('chapter_edit_range', async () => ({ output: '真实正文变化', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '火墙',
      before: '旧句。\n\n下一段。', after: '修订句。\n\n下一段。', revision: 2, appliedDirectly: true } }), false)
    const commit = tool('chapter_bridge_commit', async () => { mocks.committedChapter.mockResolvedValue(true); return { output: '已核验提交' } }, false)
    mocks.tools = [edit, commit]
    queue(response('', [call('correct', edit.name, '{"chapterId":"c","oldText":"旧句。下一段。","newText":"修订句。\\n\\n下一段。"}'), call('commit', commit.name)]), response('完成。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(edit.execute).toHaveBeenCalledOnce()
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')).toMatchObject({ status: 'completed', usage: { totalTokens: 140, checkpoint: { tokenBudget: 500,
      activeExecutionMs: expect.any(Number), writeProgress: 4, readProgress: 4, toolRestrictions: checkpoint.toolRestrictions.map(item => ({ ...item, inputHash: expect.any(String) })) } } })
    const beforeProvider = mocks.update.mock.calls.find(([input]) => input.data.usage?.checkpoint?.toolRestrictions?.some((item: {inputHash?: string}) => item.inputHash))?.[0]
    expect(beforeProvider?.data.usage.checkpoint).toMatchObject({ stagnantBatches: 4, tokenBudget: 500, writeProgress: 3, readProgress: 4 })
  })
  it('can correct an anchor after three input failures without freezing other manuscript tools', async () => {
    let attempts = 0
    const edit = tool('chapter_edit_range', async () => ++attempts <= 3
      ? { outcome: 'failed', failureCode: 'CHAPTER_ANCHOR_CONFLICT', summary: '第2处未匹配', output: '本批未写入，纠正锚点。' }
      : { output: '正文已保存', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '火墙', before: '旧正文', after: '修订正文', appliedDirectly: true, revision: 2 } }, false)
    const commit = tool('chapter_bridge_commit', async () => { mocks.committedChapter.mockResolvedValue(true); return { output: '已验证并提交终态' } }, false)
    mocks.tools = [edit, commit]
    const badArgs = JSON.stringify({ chapterId: 'c', oldText: '不匹配', newText: '修订正文' })
    queue(response('', [call('bad-1', edit.name, badArgs)]), response('', [call('bad-2', edit.name, badArgs)]),
      response('', [call('bad-3', edit.name, badArgs)]), response('', [call('correct', edit.name, '{"chapterId":"c","oldText":"旧正文","newText":"修订正文"}'), call('commit', commit.name)]), response('已完成。'))
    await run('写下一章')
    expect(edit.execute).toHaveBeenCalledTimes(4)
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.runs.get('run')?.status).toBe('completed')
    const restrictions = (mocks.runs.get('run')?.usage as { checkpoint: { toolRestrictions: Array<{action: string;inputHash?: string}> } }).checkpoint.toolRestrictions
    expect(restrictions).toEqual([expect.objectContaining({ action: 'chapter_edit_range', inputHash: expect.any(String) })])
  })
  it.each(['CONTINUITY_CHECK_LIMIT', 'REVIEW_AUTOMATION_STOPPED', 'REPAIR_NOT_AUTHORIZED', 'REVIEW_REPAIR_RECHECK_REQUIRED'])('keeps a requested review incomplete without aborting independent work after %s', async failureCode => {
    const checking = tool('continuity_validate', async () => ({ outcome: 'failed', failureCode, summary: '自动检查已停止', output: '保留正文，检查未完成。' }))
    const reading = tool('chapter_read', async () => ({ output: '已核对当前正文' }))
    mocks.tools = [checking, reading]
    queue(response('', [call('check', checking.name), call('read', reading.name)]), response('正文保留，检查未完成。'))
    await run('检查当前章节')
    expect(checking.execute).toHaveBeenCalledOnce()
    expect(reading.execute).toHaveBeenCalledOnce()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: false, failureCode }))
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
    expect(mocks.runs.get('run')?.errorMessage).toContain('检查未完成')
    expect(mocks.runs.get('run')?.status).toBe('paused')
  })
  it('isolates exhausted checks and unauthorized writes while independent reads still execute', async () => {
    const checking = tool('continuity_validate', async () => ({ outcome: 'failed', failureCode: 'CONTINUITY_CHECK_LIMIT', summary: '检查次数耗尽', output: '实际检查次数耗尽' }))
    const editing = tool('chapter_edit_range', async () => { throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '原请求未授权修改已有章') }, false)
    const later = tool('chapter_write', async () => ({ output: '不应执行' }), false)
    const reading = tool('chapter_read', async () => ({ output: '合法正文读取' }))
    mocks.tools = [checking, editing, later, reading]
    queue(response('', [call('check', checking.name)]), response('', [call('edit', editing.name, '{"chapterId":"another"}'),
      call('same-target-write', later.name, '{"chapterId":" another "}'), call('independent-read', reading.name)]), response('正文保留，剩余操作受限。'))
    await run('写下一章')
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(later.execute).not.toHaveBeenCalled()
    expect(reading.execute).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
    expect(mocks.runs.get('run')?.errorMessage).toContain('原请求未授权修改已有章')
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { toolRestrictions: expect.any(Array) } })
  })
  it('can finish authorized chapter delivery after an optional edit is refused', async () => {
    const before = mocks.chapters[0].content
    let committed = false
    const editing = tool('chapter_edit_range', async () => { throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '仅有警告，不自动改写') }, false)
    const commit = tool('chapter_bridge_commit', async () => { committed = true; mocks.committedChapter.mockResolvedValue(true); return { output: '正文与终态已核验提交' } }, false)
    mocks.tools = [editing, commit]
    queue(response('', [call('optional-edit', editing.name), call('allowed-commit', commit.name)]), response('正文已保存，警告保留待审。'))
    await run('写下一章')
    expect(committed).toBe(true)
    expect(commit.execute).toHaveBeenCalledOnce()
    expect(mocks.chapters[0].content).toBe(before)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    const handoffContext = mocks.chat.mock.calls[1][0].messages
    expect(handoffContext).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'allowed-commit', content: expect.stringContaining('正文与终态已核验提交') }))
  })
  it('does not pause or zero a run when resume admission loses its state fence', async () => {
    mocks.update.mockRejectedValueOnce(new DataAccessError(409, 'TASK_AUTHORIZATION_RUNTIME_UPGRADE_REQUIRED', '任务状态已变化'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel',
      chapterId: null, mode: 'build', prompt: '原任务', resume: true })
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'task_authorization_runtime_upgrade_required' }))
    expect(events().some(event => event.type === 'run.finished' || event.type === 'run.paused')).toBe(false)
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it.each(['stored', 'previous'] as const)('does not downgrade a durable %s task into the legacy executor even when authorization JSON is absent', async source => {
    const durable = { taskSpec: null, taskRootId: 'durable-root', runtimeProtocolVersion: 1 }
    if (source === 'stored') mocks.update.mockResolvedValueOnce(durable as never)
    else mocks.previous.mockResolvedValueOnce(durable as never)
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '继续' })
      expect(mocks.chat).not.toHaveBeenCalled()
      expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'task_authorization_runtime_upgrade_required' }))
      expect(mocks.update).toHaveBeenCalledOnce()
      const { syncNovelMemoryProjection } = await import('../../api/lib/agent/story-memory.js')
      expect(syncNovelMemoryProjection).not.toHaveBeenCalled()
    } finally { logger.mockRestore() }
  })

  it.each(['stored', 'previous'] as const)('does not rebuild corrupt %s authorization as a default write task', async source => {
    const invalid = { taskSpec: { id: 'root', authorization: { version: 99 } } }
    if (source === 'stored') mocks.update.mockResolvedValueOnce(invalid as never)
    else mocks.previous.mockResolvedValueOnce(invalid as never)
    const write = tool('chapter_write', async () => ({ output: '不应写入' }), false)
    mocks.tools = [write]
    queue(response('', [call('must-not-write', 'chapter_write')]), response())
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '继续' })
      expect(write.execute).not.toHaveBeenCalled()
      expect(mocks.chat).not.toHaveBeenCalled()
      expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'task_authorization_invalid' }))
      const { syncNovelMemoryProjection } = await import('../../api/lib/agent/story-memory.js')
      expect(syncNovelMemoryProjection).not.toHaveBeenCalled()
    } finally { logger.mockRestore() }
  })
  it('terminates a blocked Reader card as failed without suggesting access-control bypass retries', async () => {
    mocks.tools = [tool('web_read', async () => { throw new DataAccessError(422, 'WEB_READ_BLOCKED', '[WEB_READ_BLOCKED] 目标页面要求登录，不得绕过。') })]
    queue(response('读取参考页面。', [call('reader-blocked', 'web_read')]), response('该来源要求登录，未取得正文。'))
    await run('读取公开网页资料')
    const results = events().filter(event => event.type === 'tool.result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ callId: 'reader-blocked', ok: false, summary: '网站要求验证或限制访问' })
    const nextContext = JSON.stringify(mocks.chat.mock.calls[1][0].messages)
    expect(nextContext).toContain('不得绕过')
    expect(nextContext).not.toContain('可以调整参数重试')
  })
  it('does not finalize a successful run again when its terminal journal flush fails', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.dispose.mockRejectedValueOnce(new Error('journal offline'))
    try {
      queue(response('核对完成。'))
      await run()
      expect(events().filter(event => event.type === 'run.finished')).toEqual([
        expect.objectContaining({ status: 'succeeded' }),
      ])
      expect(mocks.update.mock.calls.flatMap(([input]) => input.data.status ? [input.data.status] : [])).toEqual(['running', 'completed'])
      expect(mocks.dispose).toHaveBeenCalledOnce()
    } finally { logger.mockRestore() }
  })
  it('allows a completed continuation without inventing a todo plan at the end', async () => {
    queue(response('第二十二章正文已保存，校验已通过。'))
    await run('请继续完成之前的任务。')
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(events().filter(event => event.type === 'tool.call')).toHaveLength(0)
  })
  it('still follows through on promised work when a continuation has no todo list', async () => {
    queue(response('先读取章节。'), response('', [call('read')]), response('核对完成。'))
    await run('继续')
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })
  it.each(['{', JSON.stringify({ _contextCompacted: true, originalChars: 4000, arguments: { content: 'excerpt' } })])('bounds repeated invalid arguments (%s) instead of spending the entire long-task budget', async args => {
    queue(...['bad1', 'bad2', 'bad3'].map(id => response('', [call(id, 'chapter_read', args)])), response('参数仍无效，已保存进度。'))
    await run()
    expect(mocks.tools[0].execute).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledTimes(4)
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
  })
  it('never executes a provider-truncated tool even when its JSON can be repaired', async () => {
    queue(response('', [{ ...call('partial', 'chapter_read', '{"chapterId":"c'), incomplete: true }]), response('', [call('valid')]), response())
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(events().filter(event => event.type === 'tool.result')).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'partial', ok: false }), expect.objectContaining({ callId: 'valid', ok: true }),
    ]))
  })

  it('restores local tool restrictions without resetting usage or historical handoff counts', async () => {
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default',
      runStartedAt: Date.now() - 1000, activeExecutionMs: 100, stagnantBatches: 0,
      resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500, writeProgress: 1, writeBaseline: 0, readProgress: 0, readBaseline: 0,
      progressSignatures: [], reviewHandoffCount: 1, toolRestrictions: [{action:'continuity_validate',target:'c',code:'CONTINUITY_CHECK_LIMIT',reason:'原任务检查次数耗尽'}] }
    mocks.update.mockResolvedValueOnce({ taskSpec: null, currentTurn: 2, startedAt: new Date(checkpoint.runStartedAt),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, checkpoint } })
    const checking = tool('continuity_validate', async () => ({ output: '不应再次派发' }))
    const reading = tool('chapter_read', async () => ({ output: '正文保留' }))
    mocks.tools = [checking,reading]
    queue(response('', [call('blocked', checking.name, '{"chapterId":"c"}'), call('read', reading.name)]), response('保留当前进度。'))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
    expect(checking.execute).not.toHaveBeenCalled()
    expect(reading.execute).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 140, checkpoint: { reviewHandoffCount: 1, toolRestrictions: checkpoint.toolRestrictions } })
  })
  it('guides a truncated plan into bounded section saves without executing the partial payload', async () => {
    const save = vi.fn(async () => ({ output: '已保存计划' }))
    mocks.tools = [tool('plan_save', save, false)]
    queue(response('', [{ ...call('partial-plan', 'plan_save', '{"content":"未完整'), incomplete: true }]), response('', [call('whole-section', 'plan_save')]), response('已保存。'))
    await run('制定计划')
    expect(save).toHaveBeenCalledTimes(1)
    const next = JSON.stringify(mocks.chat.mock.calls[1][0].messages)
    expect(next).toContain('mode=append')
    expect(next).toContain('expectedContentHash')
    expect(events().filter(event => event.type === 'tool.result')).toEqual(expect.arrayContaining([expect.objectContaining({ callId: 'partial-plan', ok: false })]))
  })
  it('rejects duplicate calls before any running event/card, retaining one complete call/result pair', async () => {
    queue(response('', [call('a')]), response('', [call('b')]), response())
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(events().filter(event => event.type === 'tool.call').map(event => event.callId)).toEqual(['a'])
    expect(events().filter(event => event.type === 'tool.result').map(event => event.callId)).toEqual(['a'])
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('does not replay an unclassified validator exception with an unknown external outcome', async () => {
    let count = 0
    mocks.tools = [tool('continuity_validate', async () => {
      count++
      if (count === 1) throw new Error('temporary failure')
      return count === 2 ? { output: '修订至 r2', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '章', before: '旧', after: '新', appliedDirectly: true, revision: 2 } } : { output: 'r2 已通过' }
    }, false)]
    queue(...['a', 'b', 'c', 'd'].map(id => response('', [call(id, 'continuity_validate')])), response())
    await run()
    expect(count).toBe(1)
    expect(events().filter(event => event.type === 'tool.result' && event.callId !== 'a')).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'b', ok: false }), expect.objectContaining({ callId: 'c', ok: false }), expect.objectContaining({ callId: 'd', ok: false }),
    ]))
    expect((mocks.runs.get('run')?.usage as { checkpoint: { pendingReviews: Array<{ callId: string }> } }).checkpoint.pendingReviews).toEqual([expect.objectContaining({ callId: 'a' })])
  })

  it('invalidates continuity after an explicitly authorized quality revision changes persisted text, then commits', async () => {
    let revision = 1, checkedRevision = 0, committed = false
    mocks.tools = [
      tool('continuity_validate', async () => { checkedRevision = revision; return { output: `r${revision}通过` } }, false),
      tool('quality_revision_apply', async () => {
        await (await import('../../api/lib/agent/original-request.js')).assertOriginalRepairAuthority(
          mocks.db as never, { userId: 'user', novelId: 'novel', runId: 'run' })
        const before = mocks.chapters[0].content
        revision++
        mocks.chapters[0].content = '已修订正文'
        mocks.chapters[0].revision = revision
        return { output: '质量修订完成', display: { kind: 'chapterDiff', chapterId: 'c', chapterTitle: '第一章',
          before, after: mocks.chapters[0].content, appliedDirectly: true, revision },
          snapshot: { target: 'chapter', targetId: 'c', field: 'content', previousValue: before } }
      }, false),
      tool('chapter_bridge_commit', async () => {
        committed = checkedRevision === revision
        return committed ? { output: '已提交' } : { outcome: 'failed', output: '旧版本不能提交' }
      }, false),
    ]
    queue(response('', [call('first', 'continuity_validate')]), response('', [call('quality', 'quality_revision_apply')]),
      response('', [call('verify', 'continuity_validate')]), response('', [call('commit', 'chapter_bridge_commit')]), response())
    await run('完成本章质量检查，修复质量问题并提交章节终态')
    expect(mocks.chapters[0].content).toBe('已修订正文')
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(2)
    expect(committed).toBe(true)
    expect(events().filter(event => event.type === 'tool.result' && !event.ok)).toHaveLength(0)
  })

  it('preserves the persisted body when the author requests only quality checks', async () => {
    const before = mocks.chapters[0].content
    mocks.tools = [tool('quality_analyze', async () => ({ output: '检查完成，正文保留。', display: {
      kind: 'qualityReport', reportId: 'readonly-quality', chapterId: 'c', chapterRevision: 1,
      status: 'passed', repairRound: 0, findings: [],
    } }))]
    queue(response('', [call('readonly-quality', 'quality_analyze')]), response('质量检查完成。'))
    await run('只检查当前章节质量，不要改写正文。')
    expect(mocks.chapters[0].content).toBe(before)
    expect(mocks.chapters[0].revision).toBe(1)
    expect(events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ ok: true, display: expect.objectContaining({ repairRound: 0 }) }),
    ])
  })

  it('typed continue restores pending todos and never reports success on repeated empty steps', async () => {
    admitCurrentOriginal('检查当前章节并完成整改。')
    mocks.todos.mockResolvedValue([{ content: '完成第七章整改', status: 'pending' }])
    queue(...Array.from({ length: 5 }, () => response('现在写入正文。')))
    await run('请继续完成之前的任务。')
    expect(mocks.todos).toHaveBeenCalledWith('session', ['run'])
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it.each(['stop', 'length'] as const)('bounds thinking-only %s responses without replaying their reasoning or claiming completion', async finishReason => {
    const empty = { ...response(''), reasoning: '无效思考'.repeat(1000), finishReason }
    queue(empty, empty)
    await run()
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(JSON.stringify(mocks.chat.mock.calls[1][0].messages)).not.toContain('无效思考')
    expect(mocks.update.mock.calls.some(([arg]) => String(arg.data.errorMessage).includes('连续两轮'))).toBe(true)
    const reason = String(mocks.runs.get('run')?.errorMessage)
    const notice = events().filter(event => event.type === 'text.final' && event.text === reason)
    expect(notice).toHaveLength(1)
    expect(notice[0]).toMatchObject({ asReasoning: false })
    if (notice[0].type !== 'text.final') throw new Error('Missing failure explanation')
    expect(events().slice(-3)).toEqual([
      { type: 'message.start', messageId: notice[0].messageId, role: 'assistant' },
      notice[0], expect.objectContaining({ type: 'run.finished', status: 'failed' }),
    ])
    expect(mocks.persist).toHaveBeenCalledWith({ data: {
      id: notice[0].messageId, runId: 'run', sessionId: 'session', role: 'assistant', parts: [{ type: 'text', text: reason }],
    } })
    expect(mocks.runs.get('run')).toMatchObject({ status: 'failed', currentTurn: 2, usage: { totalTokens: 20 } })
  })

  it.each(['internal', 'provider'] as const)('publishes a single persisted server explanation before the ordinary %s failure closes the stream', async kind => {
    mocks.chat.mockRejectedValueOnce(kind === 'provider'
      ? new DataAccessError(502, 'AI_PROVIDER_TRANSPORT', '模型连接中断，原调用结果未确认。')
      : new Error('synthetic private implementation detail'))
    await run()
    const reason = String(mocks.runs.get('run')?.errorMessage)
    expect(reason).toContain(kind === 'provider' ? '模型连接中断，原调用结果未确认。' : '任务执行遇到内部异常')
    expect(reason).not.toContain('private implementation')
    const finalEvents = events().slice(-3)
    expect(finalEvents).toEqual([
      expect.objectContaining({ type: 'message.start', role: 'assistant' }),
      expect.objectContaining({ type: 'text.final', text: reason, asReasoning: false }),
      expect.objectContaining({ type: 'run.finished', status: 'failed' }),
    ])
    if (finalEvents[1].type !== 'text.final') throw new Error('Missing failure explanation')
    expect(finalEvents[0]).toMatchObject({ messageId: finalEvents[1].messageId })
    expect(mocks.persist).toHaveBeenCalledWith({ data: {
      id: finalEvents[1].messageId, runId: 'run', sessionId: 'session', role: 'assistant', parts: [{ type: 'text', text: reason }],
    } })
    expect(events().filter(event => event.type === 'text.final' && event.text === reason)).toHaveLength(1)
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it('does not publish a failure explanation or retry finalization when the failed transaction is unconfirmed', async () => {
    const original = mocks.update.getMockImplementation()!
    mocks.update.mockImplementation(async input => {
      if (input.data.status === 'failed') throw new Error('synthetic unconfirmed failure commit')
      return original(input)
    })
    queue(response(''), response(''))
    await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '检查当前章节' })
    expect(events().filter(event => event.type === 'run.finished' || event.type === 'run.paused')).toHaveLength(0)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('连续两轮'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'error', code: 'run_status_unconfirmed' })
    expect(mocks.update.mock.calls.filter(([input]) => input.data.status === 'failed')).toHaveLength(1)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it('recovers an empty response through real tools and preserves explicit user-facing refusal', async () => {
    queue(response(''), response('', [call('actual')]), response('无法完成该要求，请调整范围。'))
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(1)
    expect(mocks.chat).toHaveBeenCalledTimes(3)
  })

  it('bounds unchanged memory source failures instead of exhausting the task budget', async () => {
    mocks.tools = [tool('memory_save', async () => { throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '来源版本不匹配') }, false)]
    queue(...['one', 'two', 'three'].map(id => response('', [call(id, 'memory_save')])), response('来源仍未核实。'))
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(3)
    expect(events().filter(e => e.type === 'tool.result').every(e => e.type === 'tool.result' && e.summary === '记忆来源需要重新核对')).toBe(true)
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
  })

  it('resets consecutive no-progress reminders after actual advancement, supporting more than four milestones', async () => {
    admitCurrentOriginal('核对各章的人物与情节证据。')
    mocks.todos.mockResolvedValue([{ content: '整改全书', status: 'pending' }])
    mocks.tools.push(tool('todo_write', async () => ({ output: '已完成', display: { kind: 'todoList', items: [{ content: '整改全书', status: 'completed' }] } }), false))
    let chapter = 0
    mocks.tools[0] = tool('chapter_read', async () => ({ output: `第${++chapter}章的不同正文证据` }))
    for (let index = 0; index < 7; index++) queue(response('先读取章节。'), response('', [call(`r${index}`, 'chapter_read', JSON.stringify({ chapter: index }))]))
    queue(response('', [call('done', 'todo_write')]), response())
    await run('继续')
    expect(mocks.chat).toHaveBeenCalledTimes(16)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('bounds no-tool retries by unfinished work without stopping at an internal token value', async () => {
    admitCurrentOriginal('检查当前章节并完成整改。')
    mocks.todos.mockResolvedValue([{ content: '整改', status: 'pending' }])
    queue(...Array.from({ length: 5 }, () => response('现在写入正文。', [], 600)))
    await run('继续', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(events().at(-1)).toMatchObject({ usage: { totalTokens: 3000 } })
  })

  it('a genuinely new request does not inherit unfinished work', async () => {
    mocks.todos.mockResolvedValue([{ content: '无关旧任务', status: 'pending' }])
    queue(response('这是当前章节的摘要。'))
    await run('总结当前章节')
    expect(mocks.todos).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('inherits the original goal on a typed continuation and persists it on the new run', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', chapterId: null, prompt: '整改前七章的人物动机' })
    const previous = { id: 'original', taskSpec, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
      status: 'paused', currentTurn: 1, startedAt: new Date() }
    mocks.sourcePrompt = '整改前七章的人物动机'
    mocks.previous.mockResolvedValue(previous as never)
    mocks.priorRuns.mockResolvedValue([previous])
    mocks.todos.mockResolvedValue([{ content: '整改前七章', status: 'completed' }])
    queue(response())
    await run('请继续完成之前的任务。')
    expect(mocks.update.mock.calls).toContainEqual([expect.objectContaining({ where: { id: 'run' },
      data: expect.objectContaining({ taskSpec: { ...taskSpec, runId: 'run' },
        usage: expect.objectContaining({ checkpoint: expect.objectContaining({ inheritedTokens: 100, inheritedTurns: 1 }) }) }) })])
    expect(mocks.priorRuns).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sessionId: 'session', userId: 'user', novelId: 'novel', taskSpec: { path: ['id'], equals: taskSpec.id },
    }) }))
  })

  it('passes the admission-frozen scope to model tool presentation without using the editor anchor', async () => {
    queue(...Array.from({ length: 5 }, () => response('仍未写完，请核对任务。')))
    await run('写下一章')
    expect(mocks.openAITools).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ writing: expect.objectContaining({
      kind: 'bounded', targets: [{ orderIndex: 20, chapterId: null }],
    }) }))
  })

  it('returns specific failed feedback for chapter position mismatch without certifying completion', async () => {
    const admitted = tool('chapter_create', async () => { throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '章节位置不在原任务中') }, false)
    const result = await handleToolCall(call('mismatch', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(result).toMatchObject({ recoveryCode: 'AUTHOR_CHAPTER_SCOPE', part: { status: 'failed', summary: '章节目标或位置与原请求不符' } })
    expect(result.observation).toContain('不表示任务已结束')
    expect(result.observation).toContain('现有授权范围内')
  })

  it('does not suggest the old editor chapter for a rejected chapter_create input', async () => {
    const admitted = { ...tool('chapter_create', async () => ({ output: 'must not execute' }), false), parameters: z.object({ title: z.string().min(1) }) }
    const result = await handleToolCall(call('invalid-create', admitted.name), [admitted], { ...context(), chapterId: 'old-editor-chapter' }, { emit: mocks.emit }, 'message', 'run')
    expect(result).toMatchObject({ part: { status: 'failed', summary: '参数校验失败' } })
    expect(result.observation).toContain('本次调用完全没有执行')
    expect(result.observation).not.toContain('old-editor-chapter')
    expect(result.observation).not.toContain('当前正在编辑')
    expect(admitted.execute).not.toHaveBeenCalled()
  })

  it('returns frozen next49 instructions for rejected PREPARE and CREATE inputs without suggesting the editor anchor', async () => {
    const writingScope: TaskSpec['scope'] = { novelId: 'novel', writing: { version: 1, kind: 'bounded',
      targets: [{ chapterId: null, orderIndex: 49 }], titleAndBodyOnly: false, repairAuthorized: false,
      tailVolume: { version: 1, previousChapterId: 'previous48', previousRevision: 6, targetOrderIndex: 49 } } }
    const prepare = tool('story_compiler_prepare', async () => { throw new DataAccessError(400, 'INVALID_ARGUMENTS', 'chapterId 与全书位置冲突') }, false)
    const create = { ...tool('chapter_create', async () => ({ output: 'must not execute' }), false), parameters: z.object({ title: z.string(), volumeOrder: z.number().int() }) }
    const ctx = { ...context(), chapterId: 'old-editor-chapter', writingScope }
    const failedPrepare = await handleToolCall(call('conflicting', prepare.name, '{"chapterId":"previous48","targetOrderIndex":49}'), [prepare], ctx, { emit: mocks.emit }, 'message', 'run')
    expect(failedPrepare).toMatchObject({ recoveryCode: 'INVALID_ARGUMENTS', part: { status: 'failed' } })
    expect(failedPrepare.observation).toContain('已授权新建全书第49章')
    expect(failedPrepare.observation).toContain('先纠正准备参数')
    const failedCreate = await handleToolCall(call('bad-string', create.name, '{"title":"风眼","volumeOrder":"2"}'), [create], ctx, { emit: mocks.emit }, 'message', 'run')
    expect(failedCreate).toMatchObject({ failureCode: 'TOOL_SCHEMA_INVALID', part: { status: 'failed' } })
    expect(failedCreate.observation).toContain('已授权新建全书第49章')
    expect(failedCreate.observation).toContain('省略 newVolume')
    expect(failedCreate.observation).not.toContain('old-editor-chapter')
    expect(failedCreate.observation).not.toContain('绝对禁止放弃重试')
    expect(create.execute).not.toHaveBeenCalled()
  })

  it('still stops after three chapter scope failures without dispatching a fourth call', async () => {
    mocks.tools = [tool('chapter_create', async () => { throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '位置不符') }, false)]
    queue(...['one', 'two', 'three', 'four'].map(id => response('', [call(id, 'chapter_create', JSON.stringify({ title: id }))])), response('目标仍需确认。'))
    await run('新增一章')
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(3)
    expect(mocks.chat).toHaveBeenCalledTimes(4)
    expect(events().filter(e => e.type === 'tool.result').every(e => e.type === 'tool.result' && e.summary === '章节目标或位置与原请求不符')).toBe(true)
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
  })

  it('keeps cancellation ahead of chapter mismatch correction feedback', async () => {
    const controller = new AbortController()
    const admitted = tool('chapter_create', async () => { controller.abort(); throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '位置不符') }, false)
    const result = await handleToolCall(call('cancelled', admitted.name), [admitted], { ...context(), signal: controller.signal }, { emit: mocks.emit }, 'message', 'run')
    expect(result).toMatchObject({ part: { status: 'failed', summary: '已中断' } })
    expect(result.recoveryCode).toBeUndefined()
    expect(result.observation).toContain('停止后续执行')
  })

  it.each(['RUNTIME_SCOPE_MISMATCH', 'RUNTIME_PARENT_LEASE_LOST'])('does not encourage correcting or retrying %s', async code => {
    const admitted = tool('chapter_create', async () => { throw new DataAccessError(409, code, '原任务状态不匹配') }, false)
    const result = await handleToolCall(call('lost-authority', admitted.name), [admitted], context(), { emit: mocks.emit }, 'message', 'run')
    expect(result).toMatchObject({ part: { status: 'failed', summary: '原任务状态或授权不匹配' } })
    expect(result.recoveryCode).toBeUndefined()
    expect(result.observation).toContain('停止后续写入')
    expect(result.observation).toContain('不得调整参数重试')
    expect(result.observation).not.toContain('可以调整参数重试')
    expect(result.observation).not.toContain('不表示任务已结束')
  })

  it('persists a copied legacy goal contract run binding even without a previousTask lookup', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', prompt: '检查章节' })
    mocks.update.mockResolvedValueOnce({ taskSpec, usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 }, currentTurn: 0 })
    queue(response())
    await run('检查章节')
    expect(mocks.previous).not.toHaveBeenCalled()
    expect(mocks.update.mock.calls).toContainEqual([expect.objectContaining({ where: { id: 'run' },
      data: expect.objectContaining({ taskSpec: { ...taskSpec, runId: 'run' } }) })])
    expect(assembleContext).toHaveBeenCalledWith(expect.objectContaining({ taskSpec: { ...taskSpec, runId: 'run' } }))
  })

  it('typed continuation includes all local run usage once, without double-counting inherited snapshots', async () => {
    const taskSpec = buildTaskSpec({ runId: 'original', novelId: 'novel', chapterId: null, prompt: '检查章节' })
    const base = { status: 'paused', currentTurn: 1, startedAt: new Date(), taskSpec }
    const first = { ...base, id: 'first', usage: { promptTokens: 300, completionTokens: 0, totalTokens: 300 } }
    const second = { ...base, id: 'second', usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200,
      checkpoint: { version: 1, runStartedAt: Date.now(), resumeCount: 0, compactionCount: 0,
        maxTurns: env.agentMaxTurns, tokenBudget: 500, writeProgress: 0, writeBaseline: 0, readProgress: 0,
        readBaseline: 0, progressSignatures: [], inheritedTokens: 300, inheritedTurns: 1, manualResumeCount: 2 } } }
    mocks.sourcePrompt = '检查章节'
    mocks.previous.mockResolvedValue(second as never)
    mocks.priorRuns.mockResolvedValue([first, second])
    queue(response('检查完成。'))
    await run('继续')
    expect(mocks.chat).toHaveBeenCalledOnce()
    const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
    expect(terminal?.data.usage).toMatchObject({ totalTokens: 10,
      checkpoint: { controlPolicy: 'until_completion', inheritedTokens: 500, inheritedTurns: 2, tokenBudget: 500, manualResumeCount: 2 } })
  })

  it('does not stop a batch that contains duplicates followed by new productive work', async () => {
    let reads = 0
    mocks.chapters[1].content = '第二章的独立人物与情节证据。'
    mocks.tools[0] = tool('chapter_read', async () => ({ output: mocks.chapters[reads++].content }))
    queue(response('', [call('a')]), response('', [...Array.from({ length: 4 }, (_, i) => call(`dup${i}`)), call('fresh', 'chapter_read', '{"chapter":2}')]), response())
    await run()
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(2)
    expect(mocks.chat).toHaveBeenCalledTimes(3)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('permits identical todo arguments to advance an atomically accepted partial completion', async () => {
    admitCurrentOriginal('完成当前章节的一、二两项检查。')
    let completed = 0
    const items: AgentTodoItem[] = [{ content: '一', status: 'in_progress' }, { content: '二', status: 'pending' }]
    mocks.todos.mockResolvedValue(items)
    mocks.tools = [tool('todo_write', async () => ({ output: `完成${++completed}项`, display: { kind: 'todoList', items: items.map((item, i) => ({ ...item, status: i < completed ? 'completed' : 'in_progress' })) } }))]
    queue(response('', [call('t1', 'todo_write')]), response('', [call('t2', 'todo_write')]), response())
    await run('继续')
    expect(completed).toBe(2)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
  })

  it('completes productive work beyond internal cumulative values without a technical checkpoint', async () => {
    const original = env.agentRunTokenBudgetCeiling
    env.agentRunTokenBudgetCeiling = 1200
    try {
      mocks.todos.mockResolvedValue([{ content: '整改', status: 'pending' }])
      mocks.tools = [tool('chapter_write', async () => {
        const chapter = mocks.chapters[0], before = chapter.content
        chapter.content = '本章已修订并保存的新正文。'
        chapter.revision++
        return { output: '已保存', display: { kind: 'chapterDiff', chapterId: chapter.id, chapterTitle: chapter.title,
          before, after: chapter.content, appliedDirectly: true, revision: chapter.revision } }
      }, false)]
      queue(response('', [call('write', 'chapter_write')], 600), response('本章修订完成。', [], 600))
      await run('修订当前章节正文', 500)
      expect(mocks.chat).toHaveBeenCalledTimes(2)
      expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
      expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded', usage: { totalTokens: 1200 } })
      expect(mocks.chapters[0]).toMatchObject({ content: '本章已修订并保存的新正文。', revision: 2 })
      const terminal = mocks.update.mock.calls.find(([input]) => input.data.status === 'completed')?.[0]
      expect(terminal?.data.usage).toMatchObject({ checkpoint: { controlPolicy: 'until_completion', tokenBudget: 500, manualResumeCount: 0 } })
    } finally { env.agentRunTokenBudgetCeiling = original }
  })

  it.each([
    { toolName: 'chapter_read', prompt: '读取章节并完成检查' },
    { toolName: 'research_report_read', prompt: '分析这本小说' },
  ])('29 R08: a productive $toolName completes beyond the internal value without inventing todos', async ({ toolName, prompt }) => {
    mocks.tools = [tool(toolName, async () => ({ output: toolName === 'research_report_read'
      ? JSON.stringify({ content: '已保存的正文片段，包含可核验的材料。', sections: [] }) : '已保存的正文片段，包含可核验的材料。' }))]
    queue(response('', [call('read', toolName)], 600), response('检查完成，结果如下。'))
    await run(prompt, 500)
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(mocks.todos).not.toHaveBeenCalled()
  })

  it('29 R08: repeated checklist completion cannot replace the required chapter or reset no-progress', async () => {
    mocks.todos.mockResolvedValue([{ content: '整改正文', status: 'pending' }])
    mocks.tools = [tool('todo_write', async () => ({ output: '清单已完成',
      display: { kind: 'todoList', items: [{ content: '整改正文', status: 'completed' }] } }), false)]
    queue(...Array.from({ length: 4 }, (_, index) => response('', [call(`todo-${index}`, 'todo_write', JSON.stringify({ index }))], 600)))
    await run('写下一章', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(4)
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(4)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('29 R08: changed read arguments returning identical evidence remain bounded by no-progress', async () => {
    queue(...Array.from({ length: 5 }, (_, start) => response('', [call(`read-${start}`, 'chapter_read', JSON.stringify({ start }))], 600)))
    await run('读取并检查章节', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(5)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('29 R08: failed reads stop at the no-progress boundary without a paid wrap-up', async () => {
    mocks.tools = [tool('chapter_read', async () => ({ outcome: 'failed', output: '正文读取失败' }))]
    queue(...Array.from({ length: 4 }, (_, start) => response('', [call(`failed-${start}`, 'chapter_read', JSON.stringify({ start }))], 600)))
    await run('读取并检查章节', 500)
    expect(mocks.chat).toHaveBeenCalledTimes(4)
    expect(mocks.tools[0].execute).toHaveBeenCalledTimes(4)
    expect(events().filter(event => event.type === 'text.final' && event.text.includes('已到检查点'))).toHaveLength(0)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })

  it('29 R01/R09: unconfirmed DB finalization never emits a fabricated terminal status', async () => {
    const original = mocks.update.getMockImplementation()!
    mocks.update.mockImplementation(async input => {
      if (input.data.status === 'completed') throw new Error('fixture connection lost at commit')
      return original(input)
    })
    try {
      queue(response('已经完成的结果。'))
      await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: null, mode: 'build', prompt: '解释这段内容' })
      expect(events().filter(event => event.type === 'run.finished' || event.type === 'run.paused')).toHaveLength(0)
      expect(events().at(-1)).toMatchObject({ type: 'error', code: 'run_status_unconfirmed' })
      expect(mocks.update.mock.calls.filter(([input]) => ['completed', 'failed', 'paused'].includes(String(input.data.status)))).toHaveLength(1)
      expect(mocks.dispose).toHaveBeenCalledOnce()
    } finally { mocks.update.mockImplementation(original) }
  })
})


describe('author-directed task ending in the real execution loop', () => {
  function answerTool(answer: string) {
    return tool('ask_user', async () => ({ output: `作者的回答：${answer}`, display: { kind: 'question', question: '如何处理剩余工作？', options: [{ label: '继续' }, { label: '结束' }], answer } }))
  }
  it('honors the real author answer, skips the same-batch write, and does not fake an unfinished outcome', async () => {
    const write = tool('chapter_write', async () => ({ output: '不应执行' }), false)
    mocks.tools = [answerTool('待办为啥变成六条了？不都完成了吗？全部标注完成，然后结束'), write]
    queue(response('', [call('answer', 'ask_user'), call('write', 'chapter_write')]))
    await run('写下一章')
    expect(write.execute).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled', authorEnded: { fulfilled: false } })
    expect(mocks.update.mock.calls.at(-1)?.[0].data.usage).toMatchObject({ authorEnded: { fulfilled: false } })
  })
  it('finishes a verified next chapter successfully when the author ends the remaining work', async () => {
    mocks.committedChapter.mockResolvedValue(true)
    mocks.tools = [answerTool('现在结束任务')]
    queue(response('', [call('answer', 'ask_user')]))
    await run('写下一章')
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded', authorEnded: { fulfilled: true } })
    expect(mocks.chat).toHaveBeenCalledTimes(1)
  })
  it.each(['不要结束，继续检查', '写完后结束', '如果已经完成就结束', '结束任务（不是现在）'])('does not treat a conditional or negated answer as immediate termination: %s', async answer => {
    mocks.tools = [answerTool(answer)]
    queue(response('', [call('answer', 'ask_user')]), response('已完成检查。'))
    await run()
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(events().at(-1)).not.toHaveProperty('authorEnded')
  })
  it('recognizes a selected ending option with its exact persisted label and detail', async () => {
    mocks.tools = [tool('ask_user', async () => ({ output: '作者的回答已保存', display: {
      kind: 'question', question: '下一步？', options: [{ label: '先结束本任务', detail: '本任务到此交付，保留已写内容' }],
      answer: '先结束本任务（本任务到此交付，保留已写内容）',
    } }))]
    queue(response('', [call('answer', 'ask_user')]))
    await run('写下一章')
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled', authorEnded: { fulfilled: false } })
  })
  it('does not resume an author-ended task from a typed continuation', async () => {
    mocks.previous.mockResolvedValueOnce({ id: 'previous', usage: { authorEnded: { fulfilled: false } }, runtimeProtocolVersion: 0, taskRootId: null } as never)
    await run('继续')
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled', authorEnded: { fulfilled: false } })
  })
  it('cancelled todos cannot stand in for missing next-chapter evidence', async () => {
    mocks.tools.push(tool('todo_write', async () => ({ output: '已撤销', display: { kind: 'todoList', items: [{ content: '写下一章', status: 'cancelled', reason: '不再执行' }] } })))
    queue(response('', [call('todo', 'todo_write')]), ...Array.from({ length: 5 }, () => response('任务已结束。')))
    await run('写下一章')
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
  })
  it('does not accept model prose as author cancellation', async () => {
    queue(...Array.from({ length: 5 }, () => response('作者要求结束，本任务已结束。')))
    await run('写下一章')
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(events().at(-1)).not.toHaveProperty('authorEnded')
  })
  it('does not let obsolete pending bookkeeping overrule a verified single next-chapter deliverable', async () => {
    mocks.committedChapter.mockResolvedValue(true)
    mocks.tools.push(tool('todo_write', async () => ({ output: '旧重复清单', display: { kind: 'todoList', items: [{ content: '检查上一章', status: 'pending' }] } })))
    queue(response('', [call('todo', 'todo_write')]), response('新章正文及终态已提交。'))
    await run('写下一章')
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' })
    expect(mocks.chat).toHaveBeenCalledTimes(2)
  })
})

describe('P0 rejected edits and unchanged chapter rereads', () => {
  it('bounds the same rejection across changed arguments and writer tools even with intervening reads', async () => {
    const denied = async (): Promise<ToolResult> => { throw new DataAccessError(409, 'REVIEW_MERGED_REVISION_REQUIRED', '留置意见编号无效') }
    const edit = tool('chapter_edit_range', denied, false), write = tool('chapter_write', denied, false)
    let reads = 0
    const read = tool('chapter_read', async () => ({ output: '真实但尚未解决拒绝的新读取' + ++reads,
      observedChapterRange: { targetId: 'c', contentHash: 'a'.repeat(64), start: 0, end: reads * 10 } }))
    mocks.tools = [edit, write, read]
    queue(response('', [call('fail-1', edit.name, '{"chapterId":"c","oldText":"甲"}')]),
      response('', [call('read-1', read.name, '{"chapterId":"c","limit":10}')]),
      response('', [call('fail-2', write.name, '{"chapterId":"c","content":"新正文"}')]),
      response('', [call('read-2', read.name, '{"chapterId":"c","limit":20}')]),
      response('', [call('fail-3', edit.name, '{"chapterId":"c","oldText":"不同原文"}')]), response('改写目标受限，保留正文。'))
    await run('修改本章')
    expect(edit.execute).toHaveBeenCalledTimes(2)
    expect(write.execute).toHaveBeenCalledOnce()
    expect(read.execute).toHaveBeenCalledTimes(2)
    expect(mocks.chat).toHaveBeenCalledTimes(6)
    expect(events().at(-1)).toMatchObject({ type: 'run.paused', reason: 'needs_input' })
    expect(mocks.runs.get('run')?.errorMessage).toContain('同一目标上三次')
    expect(mocks.runs.get('run')?.usage).toMatchObject({ totalTokens: 60 })
  })

  it('does not let changing read lengths after a full chapter observation reset stagnation', async () => {
    const read = tool('chapter_read', async () => ({ output: 'unused' }))
    vi.mocked(read.execute).mockImplementation(async (_ctx, raw) => {
      const end = (raw as { limit: number }).limit
      return { output: '正文切片 0-' + end, observedChapterRange: { targetId: 'c', contentHash: 'b'.repeat(64), start: 0, end } }
    })
    mocks.tools = [read]
    for (const [index, limit] of [881, 50, 10, 20, 100].entries()) queue(response('', [call('read-' + index, read.name, JSON.stringify({ chapterId: 'c', limit }))]))
    await run('读取当前章节')
    expect(read.execute).toHaveBeenCalledTimes(5)
    expect(mocks.chat).toHaveBeenCalledTimes(5)
    expect(events().at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' })
    expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { readProgress: 1, stagnantBatches: 4 } })
  })
})


describe('confirmed review request failures', () => {
  it.each(['terminal', 'unknown'] as const)('%s preserves request truth and executes independent work in the same batch', async status => {
    mocks.chat.mockImplementation(async () => response('检查尚未完成，原文保留。'))
    mocks.chapters[0].revision = 3
    mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
    const critic = tool('quality_analyze', async () => {
      const { record } = beginTextRequest('request-usage')
      record.status = status
      record.billingKnown = status === 'terminal'
      if (status === 'unknown') return { output: '旧工具局部回执不能覆盖实际未知链', outcome: 'failed', failureCode: 'QUALITY_REPORT_SAVE_FAILED',
        reviewRequestFinished: { version: 1, chapterId: 'c', revision: 3, contentHash: 'a'.repeat(64) } }
      throw new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'length')
    })
    const independent = tool('chapter_read', async () => ({ output: '独立读取完成' }))
    mocks.tools = [critic, independent]
    queue(response('', [call('failed-review', critic.name, '{"chapterId":"c","compilationId":"comp"}'), call('independent-read', independent.name)]), response('正文保留，检查尚未完成。'))
    await run('写下一章')
    expect(independent.execute).toHaveBeenCalledOnce()
    expect(critic.execute).toHaveBeenCalledOnce()
    expect(events().at(-1)).toMatchObject({ type: 'run.paused' })
    const result = events().find(event => event.type === 'tool.result' && event.callId === 'failed-review')
    const checkpoint = (mocks.runs.get('run')?.usage as { checkpoint: { pendingReviews?: unknown[] } }).checkpoint
    if (status === 'terminal') {
      expect(result).toMatchObject({ reviewRequestFinished: { chapterId: 'c', revision: 3, usageIds: ['request-usage'] } })
      expect(checkpoint.pendingReviews).toBeUndefined()
    } else {
      expect(result).not.toHaveProperty('reviewRequestFinished')
      expect(checkpoint.pendingReviews).toHaveLength(1)
    }
  })
})


it('pauses after consuming a failed admission-bound recovery without replaying it or refunding its attempt', async () => {
  mocks.chapters[0].revision = 3
  mocks.reviewReadiness.mockResolvedValue(readiness('complete', 'missing'))
  const critic = tool('quality_analyze', async () => {
    const { record } = beginTextRequest('new-usage')
    record.status = 'terminal'
    record.billingKnown = true
    throw new DataAccessError(502, 'AI_PROVIDER_EMPTY_RESPONSE', 'empty')
  })
  mocks.tools = [critic]
  // A genuine resume uses the same task spec; its old request reconciliation is
  // independently authenticated by the PG reader suite.
  seedAdmission('写下一章', 'c')
  const stored = structuredClone(mocks.runs.get('run')!)
  mocks.update.mockResolvedValueOnce(stored as never)
  mocks.requestRecovery.mockResolvedValue([{ compilationId: 'comp', chapterId: 'c', revision: 3,
    toolName: 'quality_analyze', callId: 'old-review', reconciliation: { status: 'terminal_failed_billing_known',
      sourceRunId: 'run', sourceResultId: 'old-result', sourceReportId: null, usageIds: ['old-usage'],
      admissionId: 'author-continue:new', currentRevision: 3, currentContentHash: 'a'.repeat(64) } }])
  queue(response('', [call('new-review', critic.name, '{"chapterId":"c","compilationId":"comp"}')]), response('检查未完成，保留正文。'))
  await executeAgentRun({ runId: 'run', sessionId: 'session', userId: 'user', novelId: 'novel', chapterId: 'c', mode: 'build', prompt: '写下一章', resume: true })
  expect(critic.execute).toHaveBeenCalledOnce()
  expect(mocks.chat).toHaveBeenCalledTimes(2)
  expect(events().at(-1)).toMatchObject({ type: 'run.paused' })
  expect(mocks.runs.get('run')?.usage).toMatchObject({ checkpoint: { reviewAttempts: expect.arrayContaining(['review-recovery:author-continue:new:old-review']) } })
})


it.each([
  ['QUALITY_REPORT_INCOMPLETE', false, false],
  ['QUALITY_EVIDENCE_UNLOCATED', false, false],
  ['QUALITY_REPORT_INCOMPLETE', true, false],
  ['QUALITY_REPORT_INCOMPLETE', false, true],
  ['QUALITY_EVIDENCE_UNLOCATED', false, true],
  ['QUALITY_REPORT_INCOMPLETE', true, true],
] as const)('local %s reviewCompleted=%s billingKnown=%s cannot conceal unresolved text requests', async (failureCode, reviewCompleted, billingKnown) => {
  mocks.chapters[0].revision = 3
  mocks.reviewReadiness.mockImplementation(async () => readiness('complete', 'missing', mocks.chapters[0].revision))
  const critic = tool('quality_analyze', async () => {
    const { record } = beginTextRequest('local-response-usage')
    record.status = 'terminal'
    record.billingKnown = billingKnown
    return { outcome: 'failed', failureCode, reviewCompleted, output: '报告尚未完成' }
  })
  const reader = tool('chapter_read', async () => {
    // A concurrent author edit creates a new body version; it does not settle
    // the original request or grant another provider dispatch.
    mocks.chapters[0].revision = 4
    mocks.chapters[0].content = '作者更新后的正文'
    return { output: '读取当前正文' }
  })
  mocks.tools = [critic, reader]
  queue(response('', [call('local-failure', critic.name, '{"chapterId":"c","compilationId":"comp"}'),
    ...(!billingKnown ? [call('read-new-body', reader.name), call('repeat-new-version', critic.name, '{"chapterId":"c"}')] : [])]), response('检查未完成，正文保留。'))
  await run('写下一章')
  expect(critic.execute).toHaveBeenCalledOnce()
  const checkpoint = (mocks.runs.get('run')?.usage as { checkpoint: { pendingReviews?: unknown[] } }).checkpoint
  if (billingKnown) expect(checkpoint.pendingReviews).toBeUndefined()
  else {
    expect(mocks.chapters[0].revision).toBe(4)
    expect(checkpoint.pendingReviews).toEqual([{ compilationId: 'comp', chapterId: 'c', revision: 3,
      toolName: 'quality_analyze', callId: 'local-failure' }])
    expect(events().filter(event => event.type === 'tool.result' && event.callId === 'local-failure')[0]).not.toHaveProperty('reviewRequestFinished')
  }
})
