import type { AgentGoal, Prisma } from '@prisma/client'
import { countReportChineseCharacters } from '../../../shared/agent-output.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeJson } from './runtime-common.js'

type GoalEvidenceTx = Prisma.TransactionClient

const chineseDigits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function parseCount(raw: string | undefined): number | null {
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw) > 0 ? Number(raw) : null
  let total = 0
  let current = 0
  for (const character of raw) {
    if (character in chineseDigits) current = chineseDigits[character]
    else if (character === '十') { total += (current || 1) * 10; current = 0 }
    else if (character === '百') { total += (current || 1) * 100; current = 0 }
    else return null
  }
  const value = total + current
  return value > 0 && value <= 1000 ? value : null
}

export function objectiveRequirements(objective: string, specs: Array<ReturnType<typeof taskSpecSchema.parse>>) {
  const requiredOutputs = specs.flatMap(spec => spec.expectedOutputs.filter(output => output.required))
  const outputText = requiredOutputs.map(output => output.description).join('；')
  const chapter = specs.some(spec => ['write', 'revise', 'global_transform'].includes(spec.intent)
    && spec.writingPacing !== 'proposal_only' && spec.writingPacing !== 'conversation_only')
    && (/(?:章|正文|续写)/u.test(objective) || requiredOutputs.some(output => output.kind === 'text' && /(?:章|正文)/u.test(output.description)))
  const readOnlyRequest = /^(?:(?:请|帮我|给我)\s*)?(?:查看|看看|解释|说明|介绍|评价|点评)/u.test(objective.trim())
  const plan = !readOnlyRequest && (specs.some(spec => spec.intent === 'plan')
    || requiredOutputs.some(output => output.kind === 'artifact' && /(?:计划|大纲|规划|方案)/u.test(output.description))
  )
  const research = specs.some(spec => spec.intent === 'research_analysis')
    || /(?:研究|调研|拆书|分析报告|研究报告|拆解)/u.test(outputText)
  const importJob = !readOnlyRequest && /导入/u.test(objective)
  const cover = !readOnlyRequest && /(?:设为|设置|替换|应用|更换|换成|作为).{0,24}封面|封面.{0,16}(?:替换|更换|换成|设为|设置为)/u.test(objective)
  const explicitOrdinal = /第\s*[一二两三四五六七八九十百\d]+\s*[章节回]/u.test(objective)
  const quantity = /(?:前|共|连续|写|完成|创作|生成)?\s*([一二两三四五六七八九十百\d]+)\s*[章节回]/u.exec(objective)
  const requiredChapterCount = chapter ? (explicitOrdinal ? 1 : parseCount(quantity?.[1]) ?? 1) : 0
  const minimumResearchCharacters = Math.max(0, ...requiredOutputs
    .filter(output => research && output.kind === 'validation_report')
    .map(output => output.minimumChineseCharacters ?? 0))
  // Domain receipts prove storage/version/approval, not arbitrary prose
  // requirements. Only this deliberately small grammar is fully automatic.
  const automaticChapter = /^(?:请|帮我)?(?:写|续写|完成|创作)(?:[一二两三四五六七八九十百\d]+章|下一章)(?:正文)?[。！!]?$/u.test(objective.trim())
  const automaticCover = /^(?:请|帮我)?(?:把)?(?:这张|上传的|这张上传的)?图片(?:设置|设)为(?:当前)?作品封面[。！!]?$/u.test(objective.trim())
  const needsAuthorVerification = !automaticChapter && !automaticCover
  return { chapter, plan, research, importJob, cover, requiredChapterCount, minimumResearchCharacters, needsAuthorVerification }
}

function compilationTargetKey(compilation: { chapterId: string | null; targetOrderIndex: number }) {
  return compilation.chapterId ? `chapter:${compilation.chapterId}` : `order:${compilation.targetOrderIndex}`
}

function isPurePlanningObjective(objective: string) {
  const text = objective.trim()
  const planning = /(?:制定|规划|设计|做|写|生成).{0,16}(?:大纲|计划|规划|方案|提纲)/u.test(text)
  if (!planning) return false
  const writesBody = /(?:写|创作|续写)(?:.{0,16})(?:(?:第\s*)?[一二两三四五六七八九十百千0-9]+\s*章|正文|小说|故事|全书|整本|章节)(?!\s*(?:大纲|计划|规划|方案|提纲))/u.test(text)
    || /完成.{0,16}(?:小说|故事|全书|整本|正文|章节)/u.test(text)
  return !writesBody
}

/** Facts come from owned domain records, never a model's todo/summary. */
export async function inspectGoalEvidence(tx: GoalEvidenceTx, goal: AgentGoal) {
  const executions = await tx.agentGoalExecution.findMany({ where: { goalId: goal.id, goalRevision: goal.currentRevision }, include: { run: true } })
  const runIds = executions.map(row => row.runId)
  const roots = executions.flatMap(row => row.run.taskRootId ? [row.run.taskRootId] : [])
  const revision = await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: goal.currentRevision } } })
  const compilations = await tx.storyCompilation.findMany({ where: { userId: goal.userId, novelId: goal.novelId, runId: { in: runIds } },
    include: { bridge: true, chapter: { select: { id: true, revision: true, content: true, wordCount: true, orderIndex: true } } }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] })
  const artifacts = await tx.agentArtifact.findMany({ where: { runId: { in: runIds }, artifactType: { in: ['chapterPlan', 'researchReport'] } },
    select: { id: true, title: true, content: true, artifactType: true, metadata: true }, orderBy: { id: 'asc' } })
  const imports = await tx.novelImportJob.findMany({ where: { userId: goal.userId, novelId: goal.novelId, agentRunId: { in: runIds } },
    include: { commit: true }, orderBy: { id: 'asc' } })
  const novel = await tx.novel.findUniqueOrThrow({ where: { id: goal.novelId }, select: { coverAssetId: true } })
  const coverReceipt = await tx.agentGoalEvidence.findUnique({ where: { goalId_revision_criterionId: {
    goalId: goal.id, revision: goal.currentRevision, criterionId: 'cover-applied',
  } } })
  const unresolved = await tx.agentOperation.findMany({ where: { taskRootId: { in: roots }, action: { notIn: ['goal_read', 'goal_report'] }, status: { in: ['prepared', 'dispatched', 'unknown'] } },
    select: { id: true, action: true, status: true }, orderBy: { id: 'asc' } })
  const unknownUsage = await tx.agentGoalUsage.count({ where: { goalId: goal.id, status: { in: ['reserved', 'unknown'] } } })
  const activeChildren = executions.filter(row => row.trigger === 'subagent' && ['queued', 'running', 'awaiting_approval'].includes(row.run.status))
  const chapters = [...new Map(compilations.filter(row => row.status === 'completed' && row.bridge?.committedAt && row.chapter?.content.trim()
    && row.bridge.targetRevision === row.chapter.revision).map(row => ({ id: row.chapter!.id, revision: row.chapter!.revision,
    contentHash: runtimeJson({ content: row.chapter!.content }).hash, wordCount: row.chapter!.wordCount,
    orderIndex: row.chapter!.orderIndex, targetOrderIndex: row.targetOrderIndex, compilationId: row.id, bridgeId: row.bridge!.id }))
    .map(chapter => [chapter.id, chapter])).values()]
  const plans = artifacts.filter(row => row.artifactType === 'chapterPlan' && row.content.trim()
    && row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    && (row.metadata as Record<string, unknown>).savedAsPlan === true
    && (row.metadata as Record<string, unknown>).todoList !== true).map(row => ({ id: row.id, title: row.title,
    contentHash: runtimeJson({ content: row.content }).hash, characters: Array.from(row.content).length }))
  const reports = artifacts.filter(row => row.artifactType === 'researchReport' && row.content.trim()).map(row => ({ id: row.id, title: row.title,
    contentHash: runtimeJson({ content: row.content }).hash, chineseCharacters: countReportChineseCharacters(row.content) }))
  const appliedCover = coverReceipt?.status === 'verified' && coverReceipt.targetId === novel.coverAssetId ? novel.coverAssetId : null
  const facts = { chapters, plans, reports, imports: imports.map(row => ({ id: row.id, status: row.status, commitId: row.commit?.jobId ?? null })),
    coverAssetId: appliedCover }
  const parentExecutions = executions.filter(row => row.trigger !== 'subagent')
  const parentExecution = (goal.currentRunId ? parentExecutions.find(row => row.runId === goal.currentRunId) : undefined)
    ?? parentExecutions.at(-1)
  const parentSpecs = parentExecution ? taskSpecSchema.safeParse(parentExecution.run.taskSpec) : null
  const specs = parentSpecs?.success ? [parentSpecs.data] : []
  const requirements = objectiveRequirements(revision.objective, specs)
  const currentParentSpec = parentSpecs?.success ? parentSpecs.data : undefined
  const needsScopeDecision = Boolean(currentParentSpec && (
    currentParentSpec.ambiguity === 'must_ask'
    || currentParentSpec.writingPacing === 'proposal_only' && !isPurePlanningObjective(revision.objective)
  ))
  const completedCompilationIds = new Set(chapters.map(chapter => chapter.compilationId))
  const committedTargets = new Set(compilations.filter(compilation => completedCompilationIds.has(compilation.id)).map(compilationTargetKey))
  const incompleteByTarget = new Map<string, (typeof compilations)[number]>()
  if (requirements.chapter) for (const compilation of compilations) {
    if (completedCompilationIds.has(compilation.id) || committedTargets.has(compilationTargetKey(compilation))) continue
    incompleteByTarget.set(compilationTargetKey(compilation), compilation)
  }
  const blockers = [
    // Rebuilding the same target's compilation is not a different blocker.
    ...[...incompleteByTarget.keys()].map(id => ({ code: 'CHAPTER_NOT_COMMITTED', id })),
    ...(requirements.chapter && chapters.length < requirements.requiredChapterCount ? [{ code: 'CHAPTER_REQUIRED', id: goal.id }] : []),
    ...(requirements.plan && plans.length === 0 ? [{ code: 'PLAN_NOT_SAVED', id: goal.id }] : []),
    ...(requirements.research && reports.length === 0 ? [{ code: 'REPORT_NOT_SAVED', id: goal.id }] : []),
    ...(requirements.research && requirements.minimumResearchCharacters > 0
      && reports.every(report => report.chineseCharacters < requirements.minimumResearchCharacters)
      ? [{ code: 'REPORT_TOO_SHORT', id: goal.id }] : []),
    ...(requirements.importJob && imports.every(job => job.status !== 'succeeded' || !job.commit) ? [{ code: 'IMPORT_NOT_COMMITTED', id: goal.id }] : []),
    ...(requirements.cover && !facts.coverAssetId ? [{ code: 'COVER_NOT_APPLIED', id: goal.id }] : []),
    ...unresolved.map(row => ({ code: 'OPERATION_UNRESOLVED', id: row.id })),
    ...activeChildren.map(row => ({ code: 'CHILD_EXECUTING', id: row.runId })),
    ...executions.filter(row => row.trigger !== 'subagent' && ['queued', 'running', 'awaiting_approval'].includes(row.run.status))
      .map(row => ({ code: 'RUN_EXECUTING', id: row.runId })),
    ...(unknownUsage ? [{ code: 'USAGE_UNRESOLVED', id: goal.id }] : []),
    ...imports.filter(row => !['succeeded', 'cancelled', 'expired', 'failed'].includes(row.status)).map(row => ({ code: 'IMPORT_AWAITING_RESULT', id: row.id })),
    ...(needsScopeDecision ? [{ code: 'GOAL_SCOPE_DECISION_REQUIRED', id: goal.id }] : []),
  ]
  const hasResearch = reports.some(report => report.chineseCharacters >= requirements.minimumResearchCharacters)
  const authorReviewOutput = executions.filter(row => row.trigger !== 'subagent' && row.run.outputSummary?.trim())
    .map(row => ({ hash: runtimeJson({ content: row.run.outputSummary }).hash }))
  const hasDeliverable = (requirements.chapter && chapters.length >= requirements.requiredChapterCount)
    || (requirements.plan && plans.length > 0) || (requirements.research && hasResearch)
    || (requirements.importJob && imports.some(job => job.status === 'succeeded' && Boolean(job.commit))) || (requirements.cover && Boolean(facts.coverAssetId))
    || (!requirements.chapter && !requirements.plan && !requirements.research && !requirements.importJob && !requirements.cover && authorReviewOutput.length > 0)
  const chapterProgress = [...new Map(compilations.flatMap(row => row.chapter ? [[row.chapter.id, { id: row.chapter.id,
    hash: runtimeJson({ content: row.chapter.content }).hash, committed: chapters.some(chapter => chapter.id === row.chapter!.id) }] as const] : [])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
  const hashes = (values: Array<{ contentHash: string }>) => [...new Set(values.map(value => value.contentHash))].sort()
  const progress = { requirements, chapters: requirements.chapter ? chapterProgress : [],
    plans: requirements.plan ? hashes(facts.plans) : [], reports: requirements.research ? hashes(facts.reports) : [],
    imports: requirements.importJob ? facts.imports.filter(row => row.commitId !== null).map(row => ({ id: row.id, committed: true })) : [],
    coverAssetId: requirements.cover ? facts.coverAssetId : null,
    ...(!requirements.chapter && !requirements.plan && !requirements.research && !requirements.importJob && !requirements.cover
      ? { authorReviewOutput: [...new Set(authorReviewOutput.map(output => output.hash))].sort() } : {}) }
  return { objective: revision.objective, facts, requirements, progressHash: runtimeJson(progress).hash,
    needsScopeDecision, hasDeliverable, blockers,
    childrenExecuting: activeChildren.some(row => row.run.status === 'queued' || row.run.status === 'running') }
}

/** Count the same persisted blocker across rounds, not localized model explanations. */
export function nextGoalProgress(previous: { progressHash: string | null; blockFingerprint: string | null; blockCount: number },
  progressHash: string, blockerCodes: string[], seenProgressHashes: string[] = []) {
  const fingerprint = runtimeJson([...new Set(blockerCodes.length ? blockerCodes : ['NO_VERIFIED_PROGRESS'])].sort()).hash
  // Hashes contain persisted domain output, not model narration/todo wording.
  // Three rounds with the same blocker AND no actual progress trip the fuse.
  const repeated = previous.progressHash === progressHash || seenProgressHashes.includes(progressHash)
  const count = repeated ? previous.blockCount + 1 : 1
  return { progressHash, blockFingerprint: fingerprint, blockCount: count, blocked: count >= 3 }
}
