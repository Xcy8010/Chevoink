import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { originalTaskRunIds } from './original-request.js'
import { readEffectiveWritingRequest } from './writing-scope.js'
import { qualityReportCheckedCurrentContent } from './quality-report-contract.js'

export const WRITING_COLLABORATION_GUIDANCE = `创作协作：完整理解原作者目标；多章用原待办逐章保留正文、连续性、人类感和意见处置的完成状态，不把保存或一种检查当作全部完成。需要新章时先用 chapter_create 建立仅标题的空章，再把真实 chapterId 交给 chapter_write；已有章节、准备和正文复用，不重复创建或覆盖已完成稿。
按实际子任务发现并加载 Skill：目录元数据不等于已使用，写作、连续性审阅和表达质量各有职责；进入新子任务时读取相应 phase 的说明，并用于当前产出，不机械加载全部技能。完整章节写作按原请求与创作模式核验连续性及人类感；局部修改只核对实际受影响的要求。
复查保持同一标准，先核对报告与当前正文及前文版本。逐项区分旧问题仍存、修改引入、首轮遗漏、旧判断不成立和可选建议；真实新问题照实处理，不能换个说法反复升级建议，也不能为通过忽略漏检。相关修法合并后局部修改，再独立核验最终版本；没有实质变化复用有效报告。错误可纠正时核对原目标和当前原文，纠正本批参数继续，不重复失败调用或改猜另一章。保存成功、报告取得、意见处理与任务目标完成分别据实说明；没有报告或报告不完整就保留未完成状态。上述协作不构成普通保存的阶段门或额外授权。`

export const COLLABORATION_MARKER = '[系统/章节协作事实]'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (content: string) => createHash('sha256').update(content).digest('hex')

/** Task-owned observations only. This does not schedule checks, certify goals,
 * create semantic progress, or decide whether any tool is permitted. */
export async function readWritingCollaborationDigest(db: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string }) {
  const original = await readEffectiveWritingRequest(db, subject)
  const runIds = await originalTaskRunIds(db, subject, original)
  const touched = new Set<string>()
  const observe = (name: unknown, result: unknown, args: unknown) => {
    if (!['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_read', 'continuity_validate', 'quality_analyze'].includes(String(name))) return
    const display = object(object(result).display), input = object(args)
    const id = typeof display.chapterId === 'string' ? display.chapterId : input.chapterId
    if (typeof id === 'string') touched.add(id)
  }
  const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId }, select: { taskRootId: true } })
  if (run?.taskRootId) {
    if (!await db.agentExecutionState.findUnique({ where: { taskRootId: run.taskRootId }, select: { taskRootId: true } })) return ''
    const state = await (await import('./runtime-state.js')).readExecutionStateInTransaction(db, run.taskRootId)
    const evidence = await (await import('./runtime-evidence.js')).collectDurableToolEvidence(db, run.taskRootId, state.frame.revision)
    for (const effect of evidence.effects) {
      if (effect.outcome !== 'succeeded') continue
      const [receipt, operation] = await Promise.all([
        db.agentEffectReceipt.findUniqueOrThrow({ where: { operationId: effect.operationId } }),
        db.agentOperation.findUniqueOrThrow({ where: { id: effect.operationId }, select: { inputSnapshot: true } }),
      ])
      observe(effect.action, object(receipt.result).toolResult, object(object(operation.inputSnapshot).input).args)
    }
  } else {
    const messages = await db.agentMessage.findMany({ where: { runId: { in: runIds }, role: 'assistant',
      run: { userId: subject.userId, novelId: subject.novelId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { parts: true } })
    for (const message of messages) for (const value of Array.isArray(message.parts) ? message.parts : []) {
      const part = object(value)
      if (part.type === 'tool-call' && part.status === 'success') observe(part.toolName, part, part.args)
    }
  }
  if (!touched.size) return ''
  const chapters = await db.chapter.findMany({ where: { id: { in: [...touched] }, authorId: subject.userId, ...activeChapterScope(subject.novelId) },
    orderBy: { orderIndex: 'asc' }, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  const facts = []
  for (const chapter of chapters) {
    const [artifact, quality] = await Promise.all([
      db.agentArtifact.findFirst({ where: { runId: { in: runIds }, artifactType: 'continuityReview',
        run: { userId: subject.userId, novelId: subject.novelId }, metadata: { path: ['continuityReport', 'chapterId'], equals: chapter.id } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { metadata: true } }),
      db.chapterQualityReport.findFirst({ where: { runId: { in: runIds }, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, chapterRevision: true, status: true, deterministicMetrics: true } }),
    ])
    const report = object(object(artifact?.metadata).continuityReport)
    // Rebuild actual ordered predecessor membership and plan dependencies, not
    // merely the old report's still-existing source IDs.
    let dependencyCurrent = false, dependencyUnavailable = false
    if (artifact && chapter.content.trim()) {
      try {
        const currentSnapshot = await (await import('./continuity-review.js')).buildContinuitySnapshot({ ...subject, chapterId: chapter.id },
          { chapterId: chapter.id, ...(typeof report.focus === 'string' ? { focus: report.focus } : {}) }, db)
        dependencyCurrent = report.contextHash === currentSnapshot.contextHash
      } catch (error) {
        // A stale plan/target is an advisory unknown, not permission to stop
        // ordinary editing. Receipt corruption and ownership errors still fail.
        if (!(error instanceof DataAccessError) || !['PLAN_CONTEXT_STALE', 'PLAN_CONTEXT_INVALID', 'COMPILATION_NOT_FOUND',
          'CHAPTER_NOT_FOUND', 'QUALITY_TARGET_AMBIGUOUS', 'QUALITY_TASK_TARGET_REQUIRED'].includes(error.code)) throw error
        dependencyUnavailable = true
      }
    }
    const continuity = !artifact ? '未调用' : dependencyUnavailable ? '依赖需重新核对，未当作通过' : report.revision !== chapter.revision || report.contentHash !== hash(chapter.content) || !dependencyCurrent ? '已过期'
      : !report.billingKnown ? '费用或结果待核' : !report.complete ? '报告未完成' : '当前版本报告已取得，意见另行判断'
    const qualityState = !quality ? '未调用' : quality.chapterRevision !== chapter.revision ? '已过期'
      : !qualityReportCheckedCurrentContent(quality, chapter.revision, chapter.content) ? '当前正文尚无完整独立报告' : '正文版本报告已取得，仍需核对上下文与意见'
    facts.push({ chapterId: chapter.id, orderIndex: chapter.orderIndex, title: chapter.title, revision: chapter.revision,
      body: chapter.content.trim() ? '当前已有保存正文' : '空章，正文未写入', continuity, humanity: qualityState })
  }
  return `${COLLABORATION_MARKER}\n原目标：${original.prompt}\n${WRITING_COLLABORATION_GUIDANCE}\n当前任务真实章节：${JSON.stringify(facts)}\n这些事实不是全目标完成证明；对照完整原请求和原待办继续尚未完成事项，最终如实交代未完成检查。`
}
