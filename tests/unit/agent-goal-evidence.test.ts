import { describe, expect, it } from 'vitest'
import { inspectGoalEvidence, nextGoalProgress, objectiveRequirements } from '../../api/lib/agent/goal-evidence.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import type { AgentGoal, Prisma } from '@prisma/client'

describe('goal evidence progress fuse', () => {
  it('counts three unchanged executable rounds with the same persisted blocker', () => {
    const first = nextGoalProgress({ progressHash: null, blockFingerprint: null, blockCount: 0 }, 'facts-1', ['CHAPTER_REQUIRED:goal-1'])
    const second = nextGoalProgress(first, 'facts-1', ['CHAPTER_REQUIRED:goal-1'])
    const third = nextGoalProgress(second, 'facts-1', ['CHAPTER_REQUIRED:goal-1'])

    expect(first.blockCount).toBe(1)
    expect(second.blockCount).toBe(2)
    expect(third).toMatchObject({ blockCount: 3, blocked: true })
  })

  it('does not stop a longer goal while real saved chapter output is progressing', () => {
    const first = nextGoalProgress({ progressHash: null, blockFingerprint: null, blockCount: 0 }, 'chapter-1', ['CHAPTER_REQUIRED:goal-1'])
    const second = nextGoalProgress(first, 'chapters-1-and-2', ['CHAPTER_REQUIRED:goal-1'])
    expect(second).toMatchObject({ blockCount: 1, blocked: false })
  })

  it('resets the fuse when the persisted blocker is resolved or changes', () => {
    const first = nextGoalProgress({ progressHash: 'facts-1', blockFingerprint: null, blockCount: 2 }, 'facts-2', ['CHAPTER_REQUIRED:goal-1'])
    const resolved = nextGoalProgress(first, 'facts-3', [])
    const changed = nextGoalProgress(resolved, 'facts-4', ['PLAN_NOT_SAVED:goal-1'])

    expect(resolved).toMatchObject({ blockCount: 1, blocked: false })
    expect(changed).toMatchObject({ blockCount: 1, blocked: false })
  })
})

describe('objective evidence boundaries', () => {
  const requirements = (objective: string) => objectiveRequirements(objective, [buildTaskSpec({ novelId: 'novel', runId: 'run', prompt: objective })])
  it('can count a simple chapter objective, but cannot infer arbitrary content requirements from one saved plan', () => {
    expect(requirements('写三章')).toMatchObject({ chapter: true, requiredChapterCount: 3, needsAuthorVerification: false })
    expect(requirements('制定包含每个人物关系和100章结构的创作大纲')).toMatchObject({ plan: true, chapter: false, needsAuthorVerification: true })
    expect(requirements('写三章，每章包含三处伏笔且各有2000字')).toMatchObject({ chapter: true, requiredChapterCount: 3, needsAuthorVerification: true })
  })
  it('does not manufacture mutation requirements from questions about domain objects', () => {
    expect(requirements('查看当前作品封面')).toMatchObject({ cover: false, needsAuthorVerification: true })
    expect(requirements('解释一键导入怎么使用')).toMatchObject({ importJob: false, needsAuthorVerification: true })
    expect(requirements('看看这个计划')).toMatchObject({ plan: false, needsAuthorVerification: true })
    expect(requirements('把这张图片设为作品封面')).toMatchObject({ cover: true, needsAuthorVerification: false })
  })

  it('does not count rebuilt compilation IDs as new progress on the same unchanged chapter', async () => {
    const chapter = { id: 'chapter', revision: 1, content: '当前正文', wordCount: 4, orderIndex: 1 }
    const compilation = { id: 'compile-1', status: 'active', stage: 'validation', chapterId: chapter.id, targetOrderIndex: 1, chapter, bridge: null }
    let compilations = [compilation]
    const tx = {
      agentGoalExecution: { findMany: async () => [{ runId: 'run', trigger: 'author', run: { status: 'completed', taskRootId: null,
        taskSpec: buildTaskSpec({ novelId: 'novel', runId: 'run', prompt: '写三章' }) } }] },
      agentGoalRevision: { findUniqueOrThrow: async () => ({ objective: '写三章' }) },
      storyCompilation: { findMany: async () => compilations }, agentArtifact: { findMany: async () => [] },
      novelImportJob: { findMany: async () => [] }, novel: { findUniqueOrThrow: async () => ({ coverAssetId: null }) },
      agentGoalEvidence: { findUnique: async () => null }, agentOperation: { findMany: async () => [] }, agentGoalUsage: { count: async () => 0 },
      agentMessage: { findMany: async () => [] }, agentExecutionOutbox: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient
    const goal = { id: 'goal', userId: 'user', novelId: 'novel', currentRevision: 1, currentRunId: 'run' } as AgentGoal
    const before = await inspectGoalEvidence(tx, goal)
    compilations = [compilation, { ...compilation, id: 'compile-2' }]
    const after = await inspectGoalEvidence(tx, goal)
    expect(after.progressHash).toBe(before.progressHash)
    expect(after.blockers).toEqual(before.blockers)
    expect(after.blockers).toContainEqual({ code: 'CHAPTER_NOT_COMMITTED', id: 'chapter:chapter' })
  })

  it.each([
    ['制定100章大纲', false],
    ['写一本小说', true],
    ['制定大纲，然后写三章', true],
    ['先制定大纲，再写第一章', true],
    ['只制定大纲，然后写三章', true],
  ] as const)('uses only the current parent contract and applies the scope rule to %s', async (objective, expectedScopeDecision) => {
    const parentSpec = buildTaskSpec({ novelId: 'novel', runId: 'parent', prompt: '写一本小说' })
    const childSpec = { ...parentSpec, id: 'child-spec', runId: 'child', ambiguity: 'must_ask' as const }
    const executions = [
      { runId: 'parent', trigger: 'author', run: { status: 'completed', taskRootId: null, taskSpec: parentSpec, outputSummary: '计划已保存' } },
      { runId: 'child', trigger: 'subagent', run: { status: 'completed', taskRootId: null, taskSpec: childSpec, outputSummary: null } },
    ]
    const tx = {
      agentGoalExecution: { findMany: async () => executions },
      agentGoalRevision: { findUniqueOrThrow: async () => ({ objective }) },
      storyCompilation: { findMany: async () => [] },
      agentArtifact: { findMany: async () => [{ id: 'plan', title: '全书大纲', content: '完整计划', artifactType: 'chapterPlan', metadata: { savedAsPlan: true } }] },
      novelImportJob: { findMany: async () => [] }, novel: { findUniqueOrThrow: async () => ({ coverAssetId: null }) },
      agentGoalEvidence: { findUnique: async () => null }, agentOperation: { findMany: async () => [] }, agentGoalUsage: { count: async () => 0 },
      agentMessage: { findMany: async () => [] }, agentExecutionOutbox: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient
    const goal = { id: 'goal', userId: 'user', novelId: 'novel', currentRevision: 1, currentRunId: 'parent' } as AgentGoal
    const inspection = await inspectGoalEvidence(tx, goal)
    expect(inspection.needsScopeDecision).toBe(expectedScopeDecision)
    expect(inspection.requirements.plan).toBe(true)
    expect(inspection.hasDeliverable).toBe(true)
    if (expectedScopeDecision) {
      expect(inspection.blockers).toContainEqual({ code: 'GOAL_SCOPE_DECISION_REQUIRED', id: goal.id })
    } else {
      expect(inspection.blockers).not.toContainEqual(expect.objectContaining({ code: 'GOAL_SCOPE_DECISION_REQUIRED' }))
    }
  })

  it('keeps must_ask blocked without a new server-authorized goal revision', async () => {
    const spec = buildTaskSpec({ novelId: 'novel', runId: 'parent', prompt: '写' })
    const executions = [{ runId: 'parent', trigger: 'author', run: { status: 'completed', taskRootId: null, taskSpec: spec, outputSummary: null } }]
    const answers = [{ type: 'tool-call', toolName: 'ask_user', status: 'success', display: { kind: 'question', question: '写哪一段？', options: [{ label: '第一章' }, { label: '大纲' }], answer: '好的' } }]
    const tx = {
      agentGoalExecution: { findMany: async () => executions }, agentGoalRevision: { findUniqueOrThrow: async () => ({ objective: '写' }) },
      storyCompilation: { findMany: async () => [] }, agentArtifact: { findMany: async () => [] }, novelImportJob: { findMany: async () => [] },
      novel: { findUniqueOrThrow: async () => ({ coverAssetId: null }) }, agentGoalEvidence: { findUnique: async () => null },
      agentOperation: { findMany: async () => [] }, agentGoalUsage: { count: async () => 0 },
      agentMessage: { findMany: async () => [{ parts: answers }] }, agentExecutionOutbox: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient
    const goal = { id: 'goal', userId: 'user', novelId: 'novel', currentRevision: 1, currentRunId: 'parent' } as AgentGoal
    const unresolved = await inspectGoalEvidence(tx, goal)
    expect(unresolved.needsScopeDecision).toBe(true)
    expect(unresolved.blockers).toContainEqual({ code: 'GOAL_SCOPE_DECISION_REQUIRED', id: goal.id })

    answers[0].display.answer = '先写第一章'
    const stillUnresolved = await inspectGoalEvidence(tx, goal)
    expect(stillUnresolved.needsScopeDecision).toBe(true)
    expect(stillUnresolved.blockers).toContainEqual({ code: 'GOAL_SCOPE_DECISION_REQUIRED', id: goal.id })
  })
})
