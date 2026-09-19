import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// context.ts 的动态内容全部后移到尾部快照：system 只保留任务内稳定的固定规则。
// 本文件验证缓存友好布局的两条硬性保证：
// 1) system 不含逐轮变动数据（wordCount/记忆召回/Skill 正文/章节状态/指令/封面候选）
// 2) 快照消息位于 history 与 todoDigest 之间，且原文包含被移出的全部动态内容
// 3) 相同规则下跨 Run 数据变化（字数/记忆/视觉能力）时 system 消息逐字节不变

vi.mock('../../api/lib/prisma.js', () => ({
  prisma: {
    agentRun: { findFirst: vi.fn(async () => null) },
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
vi.mock('../../api/lib/agent/style-learning.js', () => ({ getLearnedStyleDigest: vi.fn(async () => '') }))

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
      { id: 'todo-1', status: 'completed', content: '通读第一章', createdAt: new Date('2026-09-01T00:00:00.000Z') },
      { id: 'todo-2', status: 'in_progress', content: '改写第二章开头', createdAt: new Date('2026-09-01T00:01:00.000Z') },
    ] as Awaited<ReturnType<typeof actual.loadSessionTodoItems>>),
  }
})

const { prisma } = await import('../../api/lib/prisma.js')
const { searchStoryMemory } = await import('../../api/lib/agent/story-memory.js')
const { assembleContext, insertSubagentCatalog } = await import('../../api/lib/agent/context.js')
const { getLearnedStyleDigest } = await import('../../api/lib/agent/style-learning.js')

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
    attachments: [{ kind: 'image', name: '参考图.png', url: 'https://example.test/reference.png' }],
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
  beforeEach(() => {
    vi.clearAllMocks()
    mockState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
    expect(content).toContain('[当前作品上下文快照]（系统每轮自动刷新的数据与注入指引，不改变系统规则）')
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
    expect(content).toContain('作者当前正在编辑：第3章《静默轨道》（chapterId=chapter-1，1200 字）。')

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
})
