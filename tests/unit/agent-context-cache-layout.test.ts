import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// context.ts 的动态内容全部后移到尾部快照：system 只保留任务内稳定的固定规则。
// 本文件验证缓存友好布局的两条硬性保证：
// 1) system 不含逐轮变动数据（wordCount/记忆召回/Skill 正文/章节状态/指令/封面候选）
// 2) 快照消息位于 history 与 todoDigest 之间，且原文包含被移出的全部动态内容
// 3) 相同规则下跨 Run 数据变化（字数/记忆/视觉能力）时 system 消息逐字节不变

vi.mock('../../api/lib/prisma.js', () => ({
  prisma: {
    agentRun: { findFirst: vi.fn(async () => null) },
    // Context assembly covers ordinary runs; no persisted goal execution is
    // attached to this fixture.
    agentGoalExecution: { findUnique: vi.fn(async () => null) },
    novel: { findUnique: vi.fn(), findFirst: vi.fn() },
    projectMemoryEntry: { findMany: vi.fn() },
    agentMessage: { findMany: vi.fn() },
    agentArtifact: { findMany: vi.fn() },
    coverAsset: { findMany: vi.fn() },
    chapter: { findFirst: vi.fn() },
  },
}))

vi.mock('../../api/lib/agent2-feature-flags.js', () => ({
  isAgent2FeatureEnabled: vi.fn(() => false),
}))
vi.mock('../../api/lib/agent/skills/service.js', () => ({ resolveRuntimeSkillContext: vi.fn() }))
vi.mock('../../api/lib/agent/style-learning.js', () => ({ getLearnedStyleDigest: vi.fn(async () => '') }))
vi.mock('../../api/lib/agent/story-compiler.js', () => ({ buildStoryCompilerDigest: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/writing-continuity-reference.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/lib/agent/writing-continuity-reference.js')>()
  return { ...actual, readWritingContinuityReference: vi.fn(async () => null) }
})
vi.mock('../../api/lib/agent/writing-request-context.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/lib/agent/writing-request-context.js')>()
  return { ...actual, readChapterWritingBackground: vi.fn(async () => []), readWritingPresentation: vi.fn(async () => null) }
})

vi.mock('../../api/lib/agent/context-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/lib/agent/context-engine.js')>()
  return {
    ...actual,
    loadContextCheckpoint: vi.fn(async () => ({ checkpoint: null, sourceEndedAt: null, sourceEndMessageId: null })),
    listActiveDirectives: vi.fn(async () => [
      { id: 'directive-1', kind: 'writing', scope: 'global', text: '每天至少更新一章', status: 'active', createdAt: new Date('2026-09-01T00:00:00.000Z') },
    ]),
  }
})

vi.mock('../../api/lib/agent/story-memory.js', () => ({
  searchStoryMemory: vi.fn(),
}))

vi.mock('../../api/lib/agent/tools/todo-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/lib/agent/tools/todo-tools.js')>()
  return {
    ...actual,
    loadSessionTodoItems: vi.fn(async () => [
      { id: 'todo-1', status: 'completed', content: '通读第一章' },
      { id: 'todo-2', status: 'in_progress', content: '改写第二章开头' },
    ] as Awaited<ReturnType<typeof actual.loadSessionTodoItems>>),
  }
})

const { prisma } = await import('../../api/lib/prisma.js')
const { searchStoryMemory } = await import('../../api/lib/agent/story-memory.js')
const { assembleContext, insertSubagentCatalog } = await import('../../api/lib/agent/context.js')
const { estimateChatMessagesTokens } = await import('../../api/lib/agent/context-budget.js')
const { getLearnedStyleDigest } = await import('../../api/lib/agent/style-learning.js')
const { readChapterWritingBackground, readWritingPresentation } = await import('../../api/lib/agent/writing-request-context.js')
const { buildStoryCompilerDigest } = await import('../../api/lib/agent/story-compiler.js')
const { readWritingContinuityReference } = await import('../../api/lib/agent/writing-continuity-reference.js')
const { isAgent2FeatureEnabled } = await import('../../api/lib/agent2-feature-flags.js')
const { resolveRuntimeSkillContext } = await import('../../api/lib/agent/skills/service.js')
const { skillCatalog, SKILL_ROUTER_VERSION } = await import('../../api/lib/agent/skills/index.js')
const { buildTaskSpec } = await import('../../api/lib/agent/task-spec.js')
const { freezeTaskCapabilities } = await import('../../api/lib/agent/task-capabilities.js')

type AssembleInput = Parameters<typeof assembleContext>[0]

const baseNovel = {
  title: '星海余烬',
  displayTitle: '星海余烬',
  summary: '一颗将熄的恒星与最后的舰队。',
  tagNames: ['科幻'],
  status: 'draft',
  chapterCount: 12,
  wordCount: 34567,
  coverAssetId: 'cover-1',
}

const baseChapter = { id: 'chapter-1', title: '静默轨道', orderIndex: 3, wordCount: 1200 }

function mockState(overrides?: { novelWordCount?: number; chapterWordCount?: number; memoryTitle?: string }) {
  const novel = { ...baseNovel, wordCount: overrides?.novelWordCount ?? baseNovel.wordCount }
  const chapter = { ...baseChapter, wordCount: overrides?.chapterWordCount ?? baseChapter.wordCount }
  const memoryTitle = overrides?.memoryTitle ?? '炎脉核心设定'

  vi.mocked(prisma.novel.findUnique).mockResolvedValue(novel as never)
  vi.mocked(prisma.projectMemoryEntry.findMany).mockResolvedValue([] as never)
  // 模拟 DB 原始返回：orderBy desc（最新在前），loadSessionHistory 内部会 reverse 成正序
  vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([
    { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: '已完成第二章初稿，请过目。' }] },
    { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: '上一轮：帮我写第二章' }] },
  ] as never)
  vi.mocked(prisma.agentArtifact.findMany).mockResolvedValue([
    { id: 'plan-1', title: '第一卷大纲', updatedAt: new Date('2026-09-01T00:00:00.000Z') },
  ] as never)
  vi.mocked(prisma.coverAsset.findMany).mockResolvedValue([{ id: 'cover-9' }, { id: 'cover-1' }] as never)
  vi.mocked(prisma.chapter.findFirst).mockResolvedValue(chapter as never)
  vi.mocked(searchStoryMemory).mockResolvedValue([
    {
      memoryType: 'worldbuilding',
      status: 'confirmed',
      title: memoryTitle,
      content: '舰船引擎依赖炎脉核心供能，过载会熔毁。',
      evidence: [{ sourceType: 'chapter', sourceId: 'chapter-1' }],
    } as never,
  ] as never)
}

function buildInput(visionEnabled = false): AssembleInput {
  return {
    // assembleContext 不消费 agent 字段，最小构造即可
    agent: { id: 'writer', name: '写作 Agent' } as unknown as AssembleInput['agent'],
    mode: 'build',
    sessionId: 'session-1',
    runId: 'run-1',
    userId: 'user-1',
    novelId: 'novel-1',
    chapterId: 'chapter-1',
    prompt: '把第三章开头改得更抓人',
    selection: null,
    attachments: [{ id: 'reference-image', kind: 'image', name: '参考图.png', url: 'https://example.test/reference.png' }],
    visionEnabled,
    taskSpec: {
      id: 'spec-1',
      intent: 'revise',
      scope: { novelId: 'novel-1', chapterIds: ['chapter-1'] },
      goals: ['改写第三章开头'],
      hardConstraints: [],
      softPreferences: [],
      expectedOutputs: [{ kind: 'text', description: '改写后的章节正文', required: true }],
      postconditions: [],
      ambiguity: 'none',
      creativeFreedom: 'balanced',
      qualityMode: 'premium',
      createdAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
    },
    modelTier: 'standard',
  }
}

describe('assembleContext 缓存友好布局（阶段二：动态上下文后移）', () => {
  it('uses the frozen conversational catalog to avoid unrelated cover, plan, compiler and style reads', async () => {
    const input = buildInput()
    input.prompt = '你好'
    input.attachments = []
    input.taskSpec = { ...input.taskSpec, intent: 'write', writingPacing: 'conversation_only', goals: ['你好'], scope: {
      novelId: input.novelId, authorEffects: { version: 1, requestHash: 'a'.repeat(64), manuscript: false, structure: false },
      capabilityCatalog: { version: 1, requestHash: 'a'.repeat(64), kind: 'conversation', names: ['chapter_read', 'ask_user'] },
    } }
    vi.mocked(isAgent2FeatureEnabled).mockReturnValue(true)
    const result = await assembleContext(input)
    expect(prisma.coverAsset.findMany).not.toHaveBeenCalled()
    expect(prisma.agentArtifact.findMany).not.toHaveBeenCalled()
    expect(buildStoryCompilerDigest).not.toHaveBeenCalled()
    expect(getLearnedStyleDigest).not.toHaveBeenCalled()
    expect(JSON.stringify(result.messages)).not.toContain('技能操作：')
    const workspace = result.messages.find(message => String(message.content).startsWith('[当前作品上下文快照]'))
    expect(String(workspace?.content)).not.toContain('【封面候选】')
    expect(String(result.messages.at(-1)?.content)).toBe('你好')
    expect(result.inputEstimates!.system.tokens).toBeGreaterThan(0)
  })
  it('reuses the novel rule query for genre tags while retaining cover identity and the exact original request', async () => {
    const input = buildInput()
    const { messages } = await assembleContext(input)
    expect(prisma.novel.findUnique).toHaveBeenCalledTimes(2) // rule bundle plus existing cover mapping
    expect(prisma.novel.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ select: { tagNames: true } }))
    const text = JSON.stringify(messages)
    expect(text).toContain('科幻')
    expect(text).toContain('cover-1')
    expect(String(messages.at(-1)?.content)).toContain(input.prompt)
  })
  it('keeps inferred fallback memory visibly unconfirmed with its actual source revision for legacy tasks', async () => {
    vi.mocked(searchStoryMemory).mockResolvedValueOnce([])
    vi.mocked(prisma.projectMemoryEntry.findMany).mockImplementation(args => {
      const pending = Promise.resolve(args?.take === 12 ? [{
        memoryType: 'characterCard', status: 'inferred', title: '待核人物动机', content: '尚未证实的推断',
        evidence: [{ sourceType: 'chapter', sourceId: 'source-chapter', revision: 8 }],
      }] as never : [] as never)
      Object.defineProperty(pending, Symbol.toStringTag, { value: 'PrismaPromise' })
      return pending as ReturnType<typeof prisma.projectMemoryEntry.findMany>
    })
    const { messages } = await assembleContext(buildInput())
    const text = JSON.stringify(messages)
    expect(text).toContain('[角色/inferred] 待核人物动机')
    expect(text).toContain('chapter:source-chapter@r8')
    expect(text).toContain('inferred 需按证据核实')
  })
  it('avoids arbitrary fallback preload after no relevant memory match for a fresh interpreted task without dropping compiler obligations', async () => {
    const input = buildInput()
    input.taskSpec.scope.authorEffects = { version: 1, requestHash: 'a'.repeat(64), manuscript: true, structure: false }
    vi.mocked(searchStoryMemory).mockResolvedValueOnce([])
    vi.mocked(isAgent2FeatureEnabled).mockImplementation(flag => flag === 'storyCompiler')
    vi.mocked(buildStoryCompilerDigest).mockResolvedValueOnce('当前章节检查未完成；原事实与待核提议保留。')
    const { messages } = await assembleContext(input)
    expect(prisma.projectMemoryEntry.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ take: 12 }))
    expect(buildStoryCompilerDigest).toHaveBeenCalledWith(input.userId, input.novelId, input.chapterId, input.runId)
    expect(JSON.stringify(messages)).toContain('当前章节检查未完成；原事实与待核提议保留。')
    expect(String(messages.at(-1)?.content)).toContain(input.prompt)
  })
  it('overlaps the owned goal read with workspace waits while preserving the original request', async () => {
    let release!: () => void
    const memory = vi.mocked(searchStoryMemory).getMockImplementation()!
    const pendingMemory = new Promise<void>(resolve => { release = resolve })
    vi.mocked(searchStoryMemory).mockImplementationOnce(async (...args) => { await pendingMemory; return memory(...args) })
    const pending = assembleContext(buildInput())
    try {
      await vi.waitFor(() => expect(prisma.agentGoalExecution.findUnique).toHaveBeenCalledWith({ where: { runId: 'run-1' }, include: { goal: true } }))
    } finally { release() }
    const result = await pending
    expect(String(result.messages.at(-1)?.content)).toContain('把第三章开头改得更抓人')
    expect(result.messages[0].role).toBe('system')
  })
  it('measures context waits without adding timings or changing authorization inside model messages', async () => {
    const result = await assembleContext(buildInput())
    expect(Object.keys(result.timings)).toEqual(['checkpointMs', 'resourcesMs', 'skillsMs', 'styleMs', 'writingPresentationMs', 'goalMs', 'totalMs'])
    expect(Object.values(result.timings).every(value => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(JSON.stringify(result.messages)).not.toContain('checkpointMs')
    console.info('[synthetic-context-timing]', result.timings)
  })
  it('accounts for every assembled input section without recording story text or changing request order', async () => {
    const input = buildInput()
    const result = await assembleContext(input)
    const estimates = result.inputEstimates!
    expect(Object.keys(estimates)).toEqual(['system', 'goal', 'history', 'workspace', 'todo', 'task', 'intent'])
    expect(Object.values(estimates).reduce((sum, item) => sum + item.messages, 0)).toBe(result.messages.length)
    expect(Object.values(estimates).reduce((sum, item) => sum + item.tokens, 0)).toBe(estimateChatMessagesTokens(result.messages))
    expect(JSON.stringify(estimates)).not.toMatch(/星海余烬|chapter-1|把第三章/)
    expect(result.messages[0].role).toBe('system')
    expect(String(result.messages.at(-1)?.content)).toContain(input.prompt)
    expect(String(result.messages.at(-2)?.content)).toContain(input.taskSpec.goals[0])
    expect(JSON.stringify(result.messages)).not.toContain('inputEstimates')
  })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-03T04:00:00.000Z'))
    vi.clearAllMocks()
    vi.mocked(isAgent2FeatureEnabled).mockReturnValue(false)
    vi.mocked(readWritingContinuityReference).mockResolvedValue(null)
    vi.mocked(resolveRuntimeSkillContext).mockResolvedValue({ catalog: skillCatalog, routerVersion: SKILL_ROUTER_VERSION })
    mockState()
  })

  function interpretedInput(prompt: string): AssembleInput {
    const input = { ...buildInput(), prompt, attachments: [] }
    input.taskSpec = freezeTaskCapabilities(buildTaskSpec({ runId: input.runId, novelId: input.novelId, chapterId: input.chapterId,
      prompt, authorWritingProtocol: 2 }), { prompt }, ['skill_catalog', 'skill_load', 'chapter_read', 'plan_save'])
    vi.mocked(isAgent2FeatureEnabled).mockImplementation(flag => flag === 'skill2')
    return input
  }

  it.each(['里面其中一个题材写小说推荐哪个？', '如何写一个人物的犹豫？', '只讨论人物设定，不要改正文。'])('does not auto-load manuscript skills for an actual non-greeting discussion: %s', async prompt => {
    const input = interpretedInput(prompt), original = structuredClone(input.taskSpec)
    expect(input.taskSpec.scope.authorEffects?.manuscript).toBe(false)
    expect(input.taskSpec.scope.capabilityCatalog?.kind).toBe('full')
    const result = await assembleContext(input)
    expect(result.skillRoute?.selected).toEqual([])
    expect(result.availableSkillVersions).toHaveLength(skillCatalog.length)
    const snapshot = String(result.messages.find(message => String(message.content).startsWith('[当前作品上下文快照]'))?.content)
    expect(snapshot).toContain('本轮是讨论或作品操作，不自动装载章节正文技法')
    expect(snapshot).not.toContain('[Skill cn-')
    expect(snapshot).not.toContain('本轮未加载、但当前作品已启用的技能')
    expect(snapshot).not.toContain('按原写作请求完成最终版本的连续性与人类感检查')
    expect(input.taskSpec).toEqual(original)
  })

  it('retains enabled author skills and explicit builtin pins in a discussion without loading other builtin prose skills', async () => {
    const input = interpretedInput('请按我指定的方法讨论三个题材，不写正文。')
    const custom = { ...skillCatalog.find(skill => skill.id === 'cn-character-voice.v3')!, id: 'author-topic-comparison', owner: 'user' as const,
      resources: { draft: '比较三个题材的读者期待。' }, triggerLabels: ['题材讨论'] }
    vi.mocked(resolveRuntimeSkillContext).mockResolvedValueOnce({ catalog: [...skillCatalog, custom], routerVersion: SKILL_ROUTER_VERSION })
    input.pinnedSkillIds = ['cn-character-voice.v3', 'unknown-disabled-skill']
    const result = await assembleContext(input), selected = result.skillRoute!.selected.map(skill => skill.id)
    expect(selected).toEqual(expect.arrayContaining(['author-topic-comparison', 'cn-character-voice.v3']))
    expect(selected).not.toContain('cn-webfiction-draft.v3')
    expect(selected).not.toContain('cn-emotion-grounding.v3')
    expect(selected).not.toContain('unknown-disabled-skill')
    expect(result.availableSkillVersions).toHaveLength(skillCatalog.length + 1)
  })

  it.each(['plan', 'review'] as const)('uses the actual %s workflow when manuscript work is requested in a read-only mode', async mode => {
    const input = interpretedInput('写下一章。')
    input.mode = mode
    const result = await assembleContext(input)
    expect(result.skillRoute?.phase).toBe(mode === 'plan' ? 'plan' : 'critique')
    expect(result.skillRoute?.selected.some(skill => skill.id === 'cn-webfiction-draft.v3')).toBe(false)
    expect(String(result.messages[0].content)).toContain('本轮只完成当前模式允许的分析与规划')
  })

  it('loads planning methods for an actual proposal and prose foundations for actual chapter writing', async () => {
    const plan = interpretedInput('帮我写一本科幻小说。')
    expect(plan.taskSpec.writingPacing).toBe('proposal_only')
    const planned = await assembleContext(plan)
    expect(planned.skillRoute?.phase).toBe('plan')
    expect(planned.skillRoute?.selected.map(skill => skill.id)).toEqual(expect.arrayContaining(['cn-project-positioning.v3', 'cn-long-outline.v3']))
    const draft = interpretedInput('写下一章。')
    const written = await assembleContext(draft)
    expect(written.skillRoute?.phase).toBe('draft')
    expect(written.skillRoute?.selected.map(skill => skill.id)).toEqual(expect.arrayContaining(['cn-character-voice.v3', 'cn-emotion-grounding.v3', 'cn-prose-specificity.v3']))
  })

  it('keeps the original routing interpretation for a frozen historical router', async () => {
    const input = interpretedInput('里面选哪个题材？')
    vi.mocked(resolveRuntimeSkillContext).mockResolvedValueOnce({ catalog: skillCatalog, routerVersion: '4.0.0' })
    const result = await assembleContext(input)
    expect(result.skillRoute?.routerVersion).toBe('4.0.0')
    expect(result.skillRoute?.phase).toBe('draft')
    expect(result.skillRoute?.selected.map(skill => skill.id)).toContain('cn-webfiction-draft.v3')
    expect(result.skillRoute?.reasonCodes).not.toContain('DRAFT_FOUNDATION')
  })

  it('freezes empty discussion routing through resume while preserving legacy 4.1 drafting', async () => {
    const input = interpretedInput('如何写一个人物的犹豫？')
    const fresh = await assembleContext(input)
    expect(fresh.skillRoute?.selected).toEqual([])
    vi.mocked(resolveRuntimeSkillContext).mockResolvedValueOnce({ catalog: skillCatalog, routerVersion: SKILL_ROUTER_VERSION })
    const resumed = await assembleContext({ ...input, includeCurrentRunHistory: true })
    expect(resumed.skillRoute?.routerVersion).toBe(SKILL_ROUTER_VERSION)
    expect(resumed.skillRoute?.selected).toEqual([])
    expect(resumed.availableSkillVersions).toEqual(fresh.availableSkillVersions)
    vi.mocked(resolveRuntimeSkillContext).mockResolvedValueOnce({ catalog: skillCatalog, routerVersion: '4.1.0' })
    const legacy = await assembleContext({ ...input, includeCurrentRunHistory: true })
    expect(legacy.skillRoute?.routerVersion).toBe('4.1.0')
    expect(legacy.skillRoute?.selected.map(skill => skill.id)).toContain('cn-webfiction-draft.v3')
  })

  it('provides truthful cover state and optional next-step boundaries without putting changing facts into system', async () => {
    const input = interpretedInput('为新作品提出下一步建议，不要执行。')
    vi.mocked(prisma.novel.findUnique).mockResolvedValueOnce({ ...baseNovel, coverAssetId: null, chapterCount: 0, wordCount: 0 } as never)
    const result = await assembleContext(input)
    const system = String(result.messages[0].content), snapshot = String(result.messages.find(message => String(message.content).startsWith('[当前作品上下文快照]'))?.content)
    expect(snapshot).toContain('正式封面：未设置（生成候选不等于已应用）')
    expect(system).toContain('1–2 条符合当前作品阶段的可选下一步建议')
    expect(system).toContain('这类阶段末尾问题用普通作者语言结束本轮')
    expect(system).toContain('不调用提问工具挂起、不新建后续待办或产物')
    expect(system).toContain('只有下一条明确请求才执行下一阶段')
    expect(system).toContain('作者仅要标题正文、仅要结果或明确不要建议时不附加')
    expect(system).toContain('不能用下一步建议掩盖本次未完成')
    expect(system).toContain('本轮对同一对象的最新成功工具回执优先于旧快照')
    expect(system).not.toContain('正式封面：未设置')
    mockState()
    const covered = await assembleContext(input)
    expect(String(covered.messages.find(message => String(message.content).startsWith('[当前作品上下文快照]'))?.content)).toContain('正式封面：已设置')
    expect(covered.messages[0].content).toBe(result.messages[0].content)
  })

  it.each(['你好', '如何给小说起书名？', '写科幻新书第一章。'])('does not derive creation permission from the bootstrap placeholder: %s', async prompt => {
    const input = interpretedInput(prompt)
    vi.mocked(prisma.novel.findUnique).mockResolvedValueOnce({ ...baseNovel, title: '未命名作品', displayTitle: null,
      summary: '先创建一部作品，再继续完善简介、章节和封面。', tagNames: [], chapterCount: 0, wordCount: 0, coverAssetId: null } as never)
    const { messages } = await assembleContext(input), system = String(messages[0].content)
    expect(system).toContain('占位状态不是创建授权')
    expect(system).toContain('仅当原始作者请求明确创建正式作品，或已授权的正文写作确需正式作品时')
    expect(system).toContain('普通问候、讨论、解释、建议或只读任务不创建作品')
    expect(system).not.toContain('作者本轮是在让你真正创建第一部作品')
  })

  it('does not require the research and prototype pipeline before an explicitly requested first chapter, including legacy guidance', async () => {
    const input = buildInput()
    input.prompt = '写科幻新书第一章。'
    input.taskSpec = { ...input.taskSpec, intent: 'write', goals: [input.prompt] }
    const { messages } = await assembleContext(input), system = String(messages[0].content)
    expect(system).toContain('明确授权的首章或其他章节写作不因作品是新书而被要求先完成研究、方向选择、宪章和前三章试制')
    expect(system).toContain('核心现实事实高风险')
    expect(system).toContain('只有没有档案或确需刷新才按原授权 research_dossier_build')
    expect(system).not.toContain('新书应按“研究档案')
    expect(system).not.toContain('那次调用完全没执行')
    expect(system).not.toContain('同一份产物（计划/章节）在一次任务里只落盘一次')
    expect(system).toContain('写入后失败可能已有局部成果')
    expect(system).toContain('不把重复调用当成幂等或无副作用的证明')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('always adds trusted time to the dynamic snapshot and refreshes it only for a new assembly', async () => {
    const input = { ...buildInput(), prompt: '你好' }
    const first = await assembleContext(input)
    const frozen = structuredClone(first.messages)
    const firstSnapshot = first.messages.find(message => String(message.content).startsWith('[当前作品上下文快照]'))
    expect(String(firstSnapshot?.content)).toContain('2026-11-03T04:00:00.000Z')
    expect(String(firstSnapshot?.content)).toContain('2026-11-03T12:00:00.000+08:00')
    expect(String(first.messages[0].content)).not.toContain('2026-11-03')
    vi.setSystemTime(new Date('2026-11-04T04:00:00.000Z'))
    mockState()
    const second = await assembleContext({ ...input, runId: 'run-2' })
    expect(second.messages[0]).toEqual(first.messages[0])
    expect(JSON.stringify(second.messages)).toContain('2026-11-04T04:00:00.000Z')
    expect(first.messages).toEqual(frozen)
  })

  it('exposes authenticated predecessor body facts before writing, scoped to the first frozen target', async () => {
    const input = buildInput()
    input.taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [
      { chapterId: null, orderIndex: 48 }, { chapterId: null, orderIndex: 49 },
    ], titleAndBodyOnly: false, repairAuthorized: false }
    vi.mocked(readWritingContinuityReference).mockResolvedValueOnce({ version: 1, targetOrderIndex: 48,
      predecessor: { chapterId: 'chapter-47', revision: 3, orderIndex: 47, contentHash: 'a'.repeat(64) },
      facts: [{ field: 'body', claim: '林岑左腿旧伤未愈，仍须拄拐。', proofHash: 'b'.repeat(64), preserved: false,
        sources: [{ chapterId: 'chapter-45', revision: 2, contentHash: 'c'.repeat(64), start: 20, end: 35 }] }] })
    const { messages } = await assembleContext(input)
    expect(readWritingContinuityReference).toHaveBeenCalledTimes(1)
    expect(readWritingContinuityReference).toHaveBeenCalledWith(prisma, { userId: input.userId, novelId: input.novelId, runId: input.runId }, 48)
    expect(String(messages.at(-1)?.content)).toContain('[body] 林岑左腿旧伤未愈，仍须拄拐。')
    expect(String(messages.at(-1)?.content)).toContain('chapter-45@r2:20-35')
    expect(String(messages.at(-1)?.content)).toContain('只对应全书第 48 章，其他目标须各自读取')
    expect(String(messages[0].content)).not.toContain('林岑左腿')
  })

  it('dates the recent exchange and keeps a news follow-up focused despite unrelated novel tags', async () => {
    vi.mocked(prisma.novel.findUnique).mockResolvedValue({ ...baseNovel, tagNames: ['都市', '异能'] } as never)
    const question = '今天有什么值得关注的新闻？'
    const answer = '可考虑航天新突破、城市记忆与机器人陪伴三个方向。'
    vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([
      { id: 'news-answer', role: 'assistant', createdAt: new Date('2026-11-01T02:01:00Z'), parts: [{ type: 'text', text: answer }] },
      { id: 'news-question', role: 'user', createdAt: new Date('2026-11-01T02:00:00Z'), parts: [{ type: 'text', text: question }] },
    ] as never)
    const input = buildInput()
    input.prompt = '里面其中一个题材写小说推荐哪个？'
    input.attachments = []
    input.taskSpec.writingPacing = 'conversation_only'
    input.taskSpec.scope.authorEffects = { version: 1, requestHash: 'a'.repeat(64), manuscript: false, structure: false }
    const { messages } = await assembleContext(input)
    expect(messages[1]).toEqual({ role: 'user', content: `[服务端历史发言时间：2026-11-01T02:00:00.000Z（UTC）]\n${question}` })
    expect(messages[2]).toEqual({ role: 'assistant', content: `[服务端历史发言时间：2026-11-01T02:01:00.000Z（UTC）]\n${answer}` })
    expect(String(messages[0].content)).toContain('指代先对应最近相关会话中的候选')
    expect(messages.at(-1)?.content).toBe(input.prompt)
    expect(readWritingContinuityReference).not.toHaveBeenCalled()
    expect(String(messages.at(-1)?.content)).not.toContain('题材写作要点')
    expect(String(messages.at(-1)?.content)).not.toContain('首章收益与情绪强度')
  })

  it('reserves the exact recent exchange before an oversized historical tool receipt', async () => {
    const question = '列出三个新闻题材供我选择。'
    const answer = '一是机器人陪伴，二是航天突破，三是城市记忆。'
    vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([
      { id: 'latest', role: 'assistant', createdAt: new Date('2026-11-01T02:01:00Z'), parts: [
        { type: 'text', text: answer },
        { type: 'tool-call', toolName: 'web_search', status: 'success', summary: '历史检索记录'.repeat(4000) },
      ] },
      { id: 'question', role: 'user', createdAt: new Date('2026-11-01T02:00:00Z'), parts: [{ type: 'text', text: question }] },
    ] as never)
    const result = await assembleContext({ ...buildInput(), contextWindowTokens: 8192 })
    const history = result.messages.slice(1, result.messages.findIndex(message => String(message.content).startsWith('[当前作品上下文快照]')))
    expect(history.some(message => message.role === 'user' && String(message.content).endsWith(question))).toBe(true)
    expect(history.some(message => message.role === 'assistant' && String(message.content).endsWith(answer))).toBe(true)
    expect(JSON.stringify(history)).not.toContain('历史检索记录')
    expect(JSON.stringify(history)).toContain('消息或回执未完整进入当前窗口')
    expect(JSON.stringify(history)).toContain('共 1 组消息或回执')
    expect(JSON.stringify(history)).toContain('session_message_read')
    expect(result.inputEstimates!.history.tokens).toBeLessThan(2000)
  })

  it('separates an old chapter repair and false saved claims from the frozen next-chapter task on resume', async () => {
    const input = buildInput()
    input.prompt = '写下一章'
    input.includeCurrentRunHistory = true
    input.taskSpec = { ...input.taskSpec, intent: 'write', goals: ['写下一章'], scope: { novelId: 'novel-1', chapterIds: ['chapter-1'],
      writing: { version: 1, kind: 'bounded', targets: [{ orderIndex: 48, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false } } }
    vi.mocked(prisma.chapter.findFirst).mockResolvedValue({ ...baseChapter, orderIndex: 47 } as never)
    vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([
      { id: 'current-false', runId: 'run-1', role: 'assistant', parts: [{ type: 'text', text: '章节已创建，连续性已达三次上限。' }] },
      { id: 'old-repair', runId: 'old-run', role: 'assistant', parts: [{ type: 'text', text: '第47章修订并提交终态。' }] },
    ] as never)
    const { messages } = await assembleContext(input)
    expect(messages.filter(message => message.role === 'assistant')).toHaveLength(0)
    expect(messages.some(message => String(message.content).includes('其他任务历史发言；仅作背景'))).toBe(true)
    expect(messages.some(message => String(message.content).includes('本任务已保存助手发言；可能含未执行打算或错误判断'))).toBe(true)
    const intent = String(messages.at(-1)?.content)
    expect(intent).toContain('全书第 48 章')
    expect(intent).toContain('编辑器当前第47章只是界面位置')
    expect(intent).toContain('历史任务的失败、检查上限和助手自述不属于当前目标')
    expect(intent).toContain('章节编号、编译编号和派生窗口编号不能互换')
  })

  it('restores only the interrupted run thinking and keeps a greeting as the final task intent', async () => {
    vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([
      { id: 'partial', runId: 'run-1', role: 'assistant', parts: [{ type: 'reasoning', text: '正在准备回答这次问候' }] },
      { id: 'greeting', runId: 'run-1', role: 'user', parts: [{ type: 'text', text: '你好' }] },
      { id: 'old', runId: 'other-run', role: 'assistant', parts: [{ type: 'reasoning', text: '旧任务写第三章' }] },
    ] as never)
    const { messages } = await assembleContext({ ...buildInput(), prompt: '你好', includeCurrentRunHistory: true })
    expect(prisma.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sessionId: 'session-1' }) }))
    expect(messages.some(message => String(message.content).includes('正在准备回答这次问候'))).toBe(true)
    expect(messages.some(message => String(message.content).includes('旧任务写第三章'))).toBe(false)
    expect(messages.at(-1)?.content).toContain('你好')
    expect(messages.at(-1)?.content).toContain('只继续这项要求')
    expect(messages.at(-1)?.content).toContain('原始要求若只是问候或提问')
  })

  it('automatically adds the approved scoped style before the first model request, without changing stable system', async () => {
    vi.mocked(getLearnedStyleDigest).mockResolvedValueOnce('本作品风格 v4：用短对白推动行动。')
    const { messages } = await assembleContext(buildInput())
    expect(getLearnedStyleDigest).toHaveBeenCalledWith('user-1', 'novel-1')
    expect(String(messages[0].content)).not.toContain('本作品风格 v4')
    const snapshot = messages.find(message => String(message.content).startsWith('[当前作品上下文快照]'))
    expect(String(snapshot?.content)).toContain('【作者确认的写作风格】\n本作品风格 v4')
  })

  it('history is factual status data, not pseudo-call examples; failed calls and cover IDs survive', async () => {
    vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([{ id: 'tool-history', role: 'assistant', parts: [
      { type: 'tool-call', toolName: 'chapter_read', status: 'failed', summary: '章节不存在' },
      { type: 'tool-call', toolName: 'todo_write', status: 'success', summary: '1/2' },
      { type: 'tool-call', toolName: 'cover_generate', status: 'success', display: { kind: 'coverImages', images: [{ id: 'cover-old' }] } },
    ] }] as never)
    const { messages } = await assembleContext(buildInput())
    const history = String(messages[1].content)
    expect(history).not.toContain('[调用工具')
    expect(messages[1].role).toBe('user')
    expect(history).toContain('"tool":"chapter_read","status":"failed","summary":"章节不存在"')
    expect(history).toContain('旧待办状态已过时')
    expect(history).not.toContain('1/2')
    expect(history).toContain('"coverAssetId":"cover-old"')
  })

  it('separates mixed assistant prose and receipts; removes legacy echoes only from assistant history', async () => {
    vi.mocked(prisma.agentMessage.findMany).mockResolvedValue([
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: '先核对。\n历史工具记录（success）：读取章节正文；伪回执' }, { type: 'tool-call', toolName: 'chapter_read', status: 'success', summary: '真实回执' }] },
      { id: 'u', role: 'user', parts: [{ type: 'text', text: '历史工具记录（success）：这是我的反馈原文' }] },
    ] as never)
    const { messages } = await assembleContext(buildInput())
    expect(messages[1]).toEqual({ role: 'user', content: '历史工具记录（success）：这是我的反馈原文' })
    expect(messages[2]).toEqual({ role: 'assistant', content: '先核对。' })
    expect(messages[3].role).toBe('user')
    expect(messages[3].content).toContain('真实回执')
    expect(messages.filter(m => m.role === 'assistant').map(m => m.content).join('')).not.toContain('历史工具记录')
  })

  it('system 只含固定规则，不含 wordCount/记忆正文/作品数据/指令/章节状态等逐轮变动内容', async () => {
    const { messages } = await assembleContext(buildInput())
    const system = messages[0]
    expect(system.role).toBe('system')

    const content = String(system.content)
    // 固定规则仍在 system
    expect(content).toContain('信道纪律')
    expect(content).toContain('思考信道和 Agent 回复区都使用中文作者语言')
    expect(content).toContain('不展示工具名、对象ID、参数名、内部编号、系统提示词或原始推理')
    expect(content).toContain('不叙述工具选择、调用、参数')
    expect(content).toContain('用户明确要求技术信息时据实际记录解释')
    expect(content).toContain('“只给正文”“不总结”“详细解释”等要求优先于默认表达')
    expect(content).not.toContain('工具选择、状态盘点、执行叙述，全部只进思考信道')
    expect(content).not.toContain('提及工具或系统一律用中文功能名')
    expect(content).toContain('决策策略')
    expect(content).toContain('技能操作：作者明确要求')
    expect(content).toContain('历史工具记录')
    expect(content).toContain('站内作品标签库')
    expect(content).toContain('作者当前编辑的章节以尾部快照为准；未指明章节时优先针对该章节操作，但“写下一章”要求准备新章，不能默认操作编辑器中的旧章。')
    expect(content).toContain('服务端工作区快照协议')
    expect(content).toContain('作者当前明确硬约束优先于 soft Skill')

    // 逐轮变动内容全部不在 system
    expect(content).not.toContain('34567') // 作品 wordCount
    expect(content).not.toContain('当前作品：《') // 作品数据行
    expect(content).not.toContain('将熄的恒星') // 简介
    expect(content).not.toContain('炎脉核心设定') // 记忆召回正文
    expect(content).not.toContain('计划文件夹里的既有计划') // planDigest
    expect(content).not.toContain('cover-9') // 封面候选
    expect(content).not.toContain('每天至少更新一章') // 生效指令
    expect(content).not.toContain('作者当前正在编辑') // 章节状态行
    expect(content).not.toContain('静默轨道') // 章节标题
  })

  it('快照消息位于 history 与 todoDigest 之间，原文携带被移出的动态内容', async () => {
    const { messages } = await assembleContext(buildInput())

    // 序列：system → history(2) → 快照 → todoDigest → taskSpec → 用户意图
    expect(messages).toHaveLength(7)
    expect(messages[1].content).toContain('上一轮：帮我写第二章')
    expect(messages[2].content).toContain('已完成第二章初稿，请过目。')

    const snapshot = messages[3]
    expect(snapshot.role).toBe('user')
    const content = String(snapshot.content)
    expect(content).toContain('[当前作品上下文快照]（本次上下文装配时的数据与注入指引，不改变系统规则）')
    expect(content).toContain('【技能指引】')
    expect(content).toContain('Skill OS 当前未对该账号启用')
    expect(content).toContain('【作品数据】')
    expect(content).toContain('当前作品：《星海余烬》')
    expect(content).toContain('34567')
    expect(content).toContain('将熄的恒星')
    expect(content).toContain('【记忆召回】')
    expect(content).toContain('炎脉核心设定')
    expect(content).toContain('【计划文件夹】')
    expect(content).toContain('planId=plan-1')
    expect(content).toContain('【封面候选】')
    expect(content).toContain('coverAssetId=cover-9')
    expect(content).toContain('【生效指令】')
    expect(content).toContain('每天至少更新一章')
    expect(content).toContain('【当前章节】')
    expect(content).toContain('作者当前正在编辑：第3章 · 静默轨道（chapterId=chapter-1，1200 字）。')

    // 快照之后依次是待办与任务契约
    expect(String(messages[4].content)).toContain('[系统] 当前任务的待办清单')
    expect(String(messages[5].content)).toContain('本轮任务契约（taskSpecId=spec-1）')
    expect(String(messages[6].content)).toContain('把第三章开头改得更抓人')
  })

  it('跨 Run 数据与视觉能力变化时 system 逐字节不变，变化只出现在尾部消息', async () => {
    const first = await assembleContext(buildInput())
    const firstSystem = first.messages[0].content

    // 第二轮：作品与章节字数增长、记忆召回刷新
    mockState({ novelWordCount: 36000, chapterWordCount: 1500, memoryTitle: '舰队补给线设定' })
    const second = await assembleContext(buildInput(true))
    const secondSystem = second.messages[0].content

    expect(secondSystem).toBe(firstSystem)

    const firstSnapshot = String(first.messages[3].content)
    const secondSnapshot = String(second.messages[3].content)
    expect(firstSnapshot).toContain('34567')
    expect(firstSnapshot).toContain('炎脉核心设定')
    expect(secondSnapshot).toContain('36000')
    expect(secondSnapshot).toContain('舰队补给线设定')
    expect(String(second.messages.at(-1)?.content)).toContain('图片像素已直接随本轮发送')
  })

  it('子 Agent 目录插入尾部执行区，不再改写 system 前缀', async () => {
    const { messages } = await assembleContext(buildInput())
    const systemBefore = messages[0].content

    insertSubagentCatalog(messages, '[子 Agent 目录]\n- 审稿员（subagentId=reviewer-1）')

    expect(messages[0].content).toBe(systemBefore)
    expect(String(messages.at(-3)?.content)).toContain('[服务端子 Agent 目录]')
    expect(String(messages.at(-2)?.content)).toContain('本轮任务契约')
    expect(String(messages.at(-1)?.content)).toContain('把第三章开头改得更抓人')
  })

  it('places the real saved compiler state last after the immutable request, despite historical assistant completion claims', async () => {
    vi.mocked(isAgent2FeatureEnabled).mockImplementation(name => name === 'storyCompiler')
    vi.mocked(buildStoryCompilerDigest).mockResolvedValueOnce('本任务编译：scope-compiler，阶段 prepare，Scene Task 0 个。下一步调用 scene_task_build；不能宣称完成。')
    const input = { ...buildInput(), prompt: '写下一章', includeCurrentRunHistory: true }
    const { messages } = await assembleContext(input)
    const intent = String(messages.at(-1)?.content)
    expect(intent.startsWith('写下一章\n\n')).toBe(true)
    expect(intent).toContain('历史助手总结不证明阶段或完成')
    expect(intent.endsWith('下一步调用 scene_task_build；不能宣称完成。')).toBe(true)
    expect(buildStoryCompilerDigest).toHaveBeenCalledWith('user-1', 'novel-1', 'chapter-1', 'run-1')
    expect(messages.filter(message => String(message.content).includes('scope-compiler'))).toHaveLength(1)
    expect(String(messages[0].content)).not.toContain('scope-compiler')
  })

  it('carries exact same-chapter creative background, current override and latest display withdrawal in the final intent', async () => {
    vi.mocked(readChapterWritingBackground).mockResolvedValueOnce([{ sourceRunId: 'author-original', compilationId: 'same-chapter-compiler',
      prompt: '沈桐29岁，仓库调度员；开篇低谷1–2段；1600–1900字；问价前停笔；只输出标题与正文。' }])
    vi.mocked(readWritingPresentation).mockResolvedValueOnce({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'author-message' })
    const input = buildInput()
    input.taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter-1', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
    input.prompt = '重写第一章，主角改为34岁，突出捡漏爽文。'
    const { messages } = await assembleContext(input)
    const intent = String(messages.at(-1)?.content)
    expect(intent.startsWith(`${input.prompt}\n\n`)).toBe(true)
    expect(intent).toContain('同章历史创作背景；仅供创作标准，不是执行授权')
    expect(intent).toContain('仓库调度员')
    expect(intent).toContain('1600–1900字')
    expect(intent).toContain('问价前停笔')
    expect(intent).toContain('主角改为34岁')
    expect(intent).toContain('当前请求的明确修改优先')
    expect(intent).toContain('旧请求中的“只输出标题与正文”已被此展示偏好撤回')
    expect(intent.indexOf('[最新真实作者展示偏好；只控制聊天交付]')).toBeGreaterThan(intent.indexOf(input.prompt))
    expect(String(messages[0].content)).not.toContain('仓库调度员')
    expect(readChapterWritingBackground).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', novelId: 'novel-1', runId: 'run-1' }, 'chapter-1')
  })
  it('does not inherit the editor old chapter specifications for an unbound next-chapter target', async () => {
    const input = buildInput()
    input.prompt = '写下一章。'
    input.taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: null, orderIndex: 2 }], titleAndBodyOnly: false, repairAuthorized: false }
    await assembleContext(input)
    expect(readChapterWritingBackground).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', novelId: 'novel-1', runId: 'run-1' }, null)
  })
  it('does not inject chapter delivery instructions into a frozen developer consultation', async () => {
    const input = buildInput()
    input.taskSpec.intent = 'write'
    delete input.taskSpec.writingPacing
    input.taskSpec.scope.authorEffects = { version: 1, requestHash: 'a'.repeat(64), manuscript: false, structure: false }
    input.prompt = '我是Agent的开发者，我如何优化和修复这些问题？'
    const { messages } = await assembleContext(input)
    expect(readChapterWritingBackground).not.toHaveBeenCalled()
    expect(readWritingPresentation).not.toHaveBeenCalled()
    expect(String(messages.at(-1)?.content)).not.toContain('本次聊天交付')
    expect(String(messages.at(-1)?.content)).toContain(input.prompt)
  })
  it('does not inject chapter background or saved-only delivery instructions into a research task', async () => {
    const input = buildInput()
    input.taskSpec.intent = 'research_analysis'
    input.prompt = '分析合成素材，保存研究报告并展示报告。'
    const { messages } = await assembleContext(input)
    expect(readChapterWritingBackground).not.toHaveBeenCalled()
    expect(readWritingPresentation).not.toHaveBeenCalled()
    expect(String(messages.at(-1)?.content)).not.toContain('本次聊天交付')
    expect(String(messages.at(-1)?.content)).not.toContain('同章历史创作背景')
  })

  it('restores full request constraints and current genre near the intent, keeping a stable system across changed genre', async () => {
    const prompt = '写都市异能爽文第一章。主角周砚，29岁，设备维护员；1800字；低谷只用一段，停在买主报价前；只输出标题与正文。'
    const first = await assembleContext({ ...buildInput(), prompt, includeCurrentRunHistory: true })
    const last = String(first.messages.at(-1)?.content)
    expect(last).toContain(prompt)
    expect(last).toContain('首章收益与情绪强度')
    expect(last).toContain('只继续这项要求')
    expect(String(first.messages[0].content)).not.toContain('首章收益与情绪强度')
    const second = await assembleContext({ ...buildInput(), prompt: '原来是爽文，现在改成慢热悬疑，不要爽文。' })
    expect(second.messages[0].content).toBe(first.messages[0].content)
    expect(String(second.messages.at(-1)?.content)).toContain('慢热的积累')
    expect(String(second.messages.at(-1)?.content)).not.toContain('首章收益与情绪强度')
  })
  it('durable pinned guidance remains server context and preserves the original author message', async () => {
    const { messages } = await assembleContext(buildInput())
    const original = structuredClone(messages.at(-1))
    const prefix = messages[0].content
    insertSubagentCatalog(messages, '作者本轮手动指定 subagentId=reviewer-1；用 subagent_run 调用。', 'system')
    expect(messages.at(-3)?.role).toBe('system')
    expect(messages.at(-3)?.content).toContain('subagentId=reviewer-1')
    expect(messages[0].content).toBe(prefix)
    expect(messages.at(-1)).toEqual(original)
  })
  it('uses compact task guidance only for an interpreted request while preserving its original evidence and legacy layout', async () => {
    const legacyInput = buildInput()
    const legacy = await assembleContext(legacyInput)
    // Each real DB query returns a fresh descending array. The history loader
    // reverses its query result; do not share that mutable mock across reads.
    mockState()
    const input = buildInput()
    input.taskSpec.scope.authorEffects = { version: 1, requestHash: 'a'.repeat(64), manuscript: true, structure: false }
    const current = await assembleContext(input)
    const system = String(current.messages[0].content)
    expect(system.length).toBeLessThan(String(legacy.messages[0].content).length)
    expect(system).toContain('工具失败可能发生在已保存或已请求之后')
    expect(system).not.toContain('那次调用完全没执行')
    expect(system).not.toContain('同一份产物（计划/章节）在一次任务里只落盘一次')
    expect(current.messages.slice(1)).toEqual(legacy.messages.slice(1))
    expect(String(current.messages.at(-1)?.content)).toContain(input.prompt)
    expect(input.taskSpec.scope.authorEffects.manuscript).toBe(true)
  })
})
