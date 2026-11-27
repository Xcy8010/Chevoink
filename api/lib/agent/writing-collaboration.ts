import { chapterReviewWorkflowEnabled } from './chapter-review-rollout.js'
import { sequentialWritingEnabled } from './sequential-writing-rollout.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { originalTaskRunIds } from './original-request.js'
import { readEffectiveWritingRequest } from './writing-scope.js'
import { qualityReportCheckedCurrentContent } from './quality-report-contract.js'

const SEQUENTIAL_WRITING_GUIDANCE = '创作协作：连写多章默认逐章建写：chapter_create 按目标位置建空章，chapter_write 用返回的 chapterId 写完本章，再建下一章。已有章按真实 ID 复用，回读前章只作参考。保留逐章保存回执。清单按实际交付安排；共用检查集中记录，保存和检查各按自己的回执更新，例行可选检查不自动形成待办。'
const PREVIOUS_WRITING_GUIDANCE = '创作协作：完整理解原作者目标；多章按原目标保存并保留逐章交付回执。待办记录作者要求的产物和检查，例行的可选检查不自动形成待办。需要新章时先用 chapter_create 建立仅标题的空章，再把真实 chapterId 交给 chapter_write；已有章节、准备和正文复用，不重复创建或覆盖已完成稿。'
export const WRITING_COLLABORATION_GUIDANCE = `${SEQUENTIAL_WRITING_GUIDANCE}
按实际子任务发现并加载 Skill：目录元数据不等于已使用，写作、连续性审阅和表达质量各有职责；进入新子任务时读取相应 phase 的说明，并用于当前产出，不机械加载全部技能。按原请求与具体风险决定检查；作者明确要求的检查按要求完成，局部修改只核对实际受影响的要求。
完整新章或大幅修订保存后，在交付前分别判断两类复查是否有价值。衔接复查用 continuity_validate 核对前文事实、因果、时间线和人物知道什么；人类感复查用 quality_analyze 核对人物声口、情绪铺垫、叙述节奏和表达的自然度。两项都需要时先对同一版已保存正文取得只读报告（readOnly=true），集中判断后再统一局部修改。本次连写两章及以上时，优先用已获准的 chapter_review_batch 检查成组的已保存章节。不同检查各自给结论，每章的已有有效结果直接复用。作者指定的审阅 Skill 随批次提交；作者指定审阅子 Agent 时，按批次给同一个子 Agent 准确的章节 ID、顺序和审阅范围，请逐章给出证据。
修改保存后，用 chapter_read 按需回读改动范围和受影响的前文。具体问题仍存在或修改引入了矛盾时，定位、修正并回读相关位置。核对完成即可交付；只有作者要求独立检查最终版本时，才调用相应检查，范围以实际影响为准。首轮报告记录所检正文；局部回读只能说明实际核对的位置。可选的风格意见留在报告里。部分检查失败时保留可用结果，其他正文与章节继续，未知请求先核对原回执。`

const LEGACY_WRITING_COLLABORATION_GUIDANCE = `创作协作：完整理解原作者目标；多章用原待办逐章保留正文、连续性、人类感和意见处置的完成状态，不把保存或一种检查当作全部完成。需要新章时先用 chapter_create 建立仅标题的空章，再把真实 chapterId 交给 chapter_write；已有章节、准备和正文复用，不重复创建或覆盖已完成稿。
按实际子任务发现并加载 Skill：目录元数据不等于已使用，写作、连续性审阅和表达质量各有职责；进入新子任务时读取相应 phase 的说明，并用于当前产出，不机械加载全部技能。按原请求与具体风险决定检查；作者明确要求的检查按要求完成，局部修改只核对实际受影响的要求。
完整新章或大幅修订保存后，在交付前分别判断两类复查是否有价值。衔接复查用 continuity_validate 核对前文事实、因果、时间线和人物知道什么；人类感复查用 quality_analyze 核对人物声口、情绪铺垫、叙述节奏和表达的自然度。工具可用且贴合当前需求时，优先用独立报告核对当前保存稿。先后顺序、是否同轮以及后续取舍由你按实际需要决定。衔接回执只覆盖衔接，不能证明表达质量已复查；未调用或未取得完整结果时如实说明。
复查保持同一标准，先核对报告与当前正文及前文版本。逐项区分旧问题仍存、修改引入、首轮遗漏、旧判断不成立和可选建议；真实新问题照实处理，不能换个说法反复升级建议，也不能为通过忽略漏检。相关修法合并后局部修改，复核优先看原问题、改动处及受影响的来源；没有实质变化复用有效报告。可选建议留在报告里，保存和必要核对已有结果时直接交付。错误可纠正时核对原目标和当前原文，纠正本批参数继续，不重复失败调用或改猜另一章。保存成功、报告取得、意见处理与任务目标完成分别据实说明；没有报告或报告不完整就保留未完成状态。上述协作不构成普通保存的阶段门或额外授权。`

export function writingCollaborationGuidance(reviewWorkflow: boolean, sequential: boolean) {
  if (reviewWorkflow) return sequential ? WRITING_COLLABORATION_GUIDANCE
    : PREVIOUS_WRITING_GUIDANCE + WRITING_COLLABORATION_GUIDANCE.slice(SEQUENTIAL_WRITING_GUIDANCE.length)
  return sequential ? SEQUENTIAL_WRITING_GUIDANCE + LEGACY_WRITING_COLLABORATION_GUIDANCE.slice(LEGACY_WRITING_COLLABORATION_GUIDANCE.indexOf('\n'))
    : LEGACY_WRITING_COLLABORATION_GUIDANCE
}

export const COLLABORATION_MARKER = '[系统/章节协作事实]'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (content: string) => createHash('sha256').update(content).digest('hex')

/** Task-owned observations only. This does not schedule checks, certify goals,
 * create semantic progress, or decide whether any tool is permitted. */
export async function readWritingCollaborationDigest(db: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string }) {
  const original = await readEffectiveWritingRequest(db, subject)
  const reviewWorkflow = chapterReviewWorkflowEnabled(original.spec)
  const guidance = writingCollaborationGuidance(reviewWorkflow, sequentialWritingEnabled(original.spec))
  const runIds = await originalTaskRunIds(db, subject, original)
  const touched = new Set<string>()
  const chapterReads = new Map<string, { revision: number; range?: { start: number; end: number } }>()
  const revised = new Map<string, number>()
  const batchReviews = new Map<string, Map<string, { version: number; status: string }>>()
  const observe = (name: unknown, result: unknown, args: unknown) => {
    const display = object(object(result).display), input = object(args)
    if (name === 'chapter_review_batch' && display.kind === 'reviewBatch'
      && typeof display.reviewType === 'string' && Array.isArray(display.chapters)) {
      for (const value of display.chapters) {
        const row = object(value)
        if (typeof row.chapterId !== 'string' || typeof row.revision !== 'number' || typeof row.status !== 'string') continue
        const reviews = batchReviews.get(row.chapterId) ?? new Map()
        reviews.set(display.reviewType, { version: row.revision, status: row.status })
        batchReviews.set(row.chapterId, reviews)
        touched.add(row.chapterId)
      }
      return
    }
    if (!['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'chapter_read', 'continuity_validate', 'quality_analyze'].includes(String(name))) return
    const id = typeof display.chapterId === 'string' ? display.chapterId : input.chapterId
    if (typeof id !== 'string') return
    touched.add(id)
    if (name === 'chapter_edit_range' && display.kind === 'chapterDiff' && display.appliedDirectly
      && typeof display.revision === 'number' && display.after !== display.before) revised.set(id, display.revision)
    if (name === 'chapter_read' && display.kind === 'chapterRef' && typeof display.revision === 'number' && !display.archiveOnly) {
      const range = object(display.range)
      chapterReads.set(id, { revision: display.revision, ...(typeof range.start === 'number' && typeof range.end === 'number'
        ? { range: { start: range.start, end: range.end } } : {}) })
    }
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
    const batch = batchReviews.get(chapter.id)
    const read = chapterReads.get(chapter.id)
    facts.push({ chapterId: chapter.id, orderIndex: chapter.orderIndex, title: chapter.title, revision: chapter.revision,
      body: chapter.content.trim() ? '当前已有保存正文' : '空章，正文未写入',
      ...(artifact || !batch?.has('continuity') ? { continuity } : {}),
      ...(quality || !batch?.has('quality') ? { humanity: qualityState } : {}),
      ...(batch ? { batchReviewReceipts: Object.fromEntries(batch) } : {}),
      ...(reviewWorkflow && read ? { lastRead: read } : {}),
      ...(reviewWorkflow && revised.get(chapter.id) === chapter.revision && read?.revision !== chapter.revision
        ? { readback: '本次修改已保存，尚未回读这个版本的改动处' } : {}) })
  }
  return reviewWorkflow ? `${COLLABORATION_MARKER}\n原目标：${original.prompt}\n${guidance}\n当前任务真实章节：${JSON.stringify(facts)}\n继续原请求中的未完成事项，或处理有原文证据且影响交付的问题。未调用、未完成和过期是检查状态，不自动形成待办。本章推进了剧情时，先按当前补记规则处理相关档案，再按实际保存结果交付。结尾交代已保存成果与关键改动，只补充作者要求但未完成的具体检查，或确实影响交付、需要作者判断的问题。可选检查和旧版报告状态留在工具详情。`
    : `${COLLABORATION_MARKER}\n原目标：${original.prompt}\n${guidance}\n当前任务真实章节：${JSON.stringify(facts)}\n继续原请求中的未完成事项，或处理有原文证据且影响交付的问题。未调用、未完成和过期是检查状态，不自动形成待办。本章推进了剧情时，先按当前补记规则处理相关档案，再按实际保存结果交付。说明作者要求但尚未完成的检查。`
}
