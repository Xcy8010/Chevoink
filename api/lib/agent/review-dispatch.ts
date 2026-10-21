import { COMPILER_CONTINUITY_PROTOCOL } from './compiler-continuity-contract.js'
import type { ChapterReviewReadiness } from './chapter-review-guard.js'
import { projectReviewCycle } from './review-cycle.js'

/** Current facts only. This is neither a writing grant nor a retry/paid-call instruction. */
export function projectCurrentReviewNextStep(readiness: ChapterReviewReadiness) {
  const retained = readiness.retainedDecisions ?? []
  const same = (a: { source: string; reportId: string; findingId: string }, b: typeof a) =>
    a.source === b.source && a.reportId === b.reportId && a.findingId === b.findingId
  const pending = (readiness.requiredDecisions ?? []).filter(item => !retained.some(saved => same(item, saved)))
  const decisionPending = readiness.decisionPending ?? (readiness.continuityErrorCount > 0 || readiness.qualityErrorCount > 0
    || (readiness.qualityCandidateCount ?? 0) > 0)
  const incomplete = readiness.requiredTools.some(tool => (tool.name === 'quality_analyze' ? readiness.quality : readiness.continuity) === 'incomplete')
  const state = !readiness.ready ? incomplete ? 'blocked' : 'check_required'
    : readiness.terminalReview?.state === 'unverified' ? 'terminal_review_required'
      : readiness.mustPassPending ? 'must_pass_required'
      : decisionPending ? 'decision_required' : 'commit_available'
  const cycle = readiness.reviewCycle ?? projectReviewCycle(null, { revision: readiness.revision,
    contentHash: readiness.decisionBinding?.contentHash ?? '', ready: readiness.ready, pending: decisionPending, findings: [] })
  return { version: 1 as const, compilationId: readiness.compilationId, chapterId: readiness.chapterId, revision: readiness.revision,
    phase: cycle.phase, reviewCycle: cycle,
    ...(readiness.reviewBoundPlan ? { reviewBoundPlan: readiness.reviewBoundPlan } : {}),
    ...(readiness.terminalReview ? { terminalReview: readiness.terminalReview } : {}),
    state, continuity: readiness.continuity, quality: readiness.quality, binding: readiness.decisionBinding ?? null,
    requiredTools: readiness.requiredTools, pending, details: (readiness.decisionDetails ?? []).filter(item => state === 'must_pass_required' || pending.some(ref => same(item, ref))),
    decisionBatchesAvailable: readiness.reviewProtocol === 1,
    retainedCount: retained.length, automaticCandidateCount: readiness.qualityCandidateCount ?? 0,
    completeStrictReview: readiness.completeStrictReview === true, selectionOnly: readiness.selectionOnly === true,
    retentionCompletes: state === 'decision_required', unresolvedFactErrors: readiness.continuityErrorCount + readiness.qualityErrorCount }
}

export type CurrentReviewNextStep = NonNullable<ReturnType<typeof projectCurrentReviewNextStep>>
export function currentReviewNextStepGuidance(step: CurrentReviewNextStep) {
  const facts = `当前 compilationId=${step.compilationId}、chapterId=${step.chapterId}、r${step.revision}：连续性=${step.continuity}，质量=${step.quality}。`
  const authority = step.reviewBoundPlan ? step.reviewBoundPlan.guidance : step.selectionOnly
    ? '原任务仅授权冻结选区或局部范围，写入只能使用 chapter_edit_range 逐字唯一锚点，保留范围外正文；未明确定位则先请作者补准确原文或选区后重新发起任务。不得使用 chapter_write、chapter_append 或元数据修改扩大范围。'
    : step.phase === 'verification'
      ? '复核已开始，原写作权限不能重开本轮润色。只有精确落在尚未尝试的原始义务或当前完整报告真实错误证据内的改动仍可按原权限与必要审批执行；新建议或 unknown 关系本身不提供写入依据。'
      : '具体修改仍须原始作者写入授权与必要审批，允许时使用当前正文的精确 chapter_edit_range，也可原授权内 chapter_write。'
  const scope = `${authority}报告不授予定位或写入权限；未定位、重叠、证据不足的意见可引用真实ref说明保留原因，不能猜测位置或机械改剧情。quality_finding_feedback 的 rejected 仅为反馈态度，不能替代绑定当前版本的 retainedFindings 理由与决定。`
  const candidates = `自动本批安全候选=${step.automaticCandidateCount}（自动修订最多8处）；${step.completeStrictReview ? '完整严格意见义务独立于自动安全窗口，' : ''}当前尚需处置${step.pending.length}项，已明确留置${step.retainedCount}项。`
  const retentionTemplate = { ...(step.decisionBatchesAvailable && step.pending.length > 40 ? { decisionOnly: true } : {}), retainedFindings: step.pending.slice(0, 40).map(item => ({ ...item, reason: '说明此意见为何应保留或无法安全修改' })) }
  const batch = step.decisionBatchesAvailable
    ? '超过单次40项时可用 decisionOnly:true 分批保存真实保留决定，不提交章节终态；每批后重读当前待处理引用，最后普通提交仍校验全部当前义务。'
    : '原任务未开放 decisionOnly 分批能力；普通 retainedFindings 提交仍须完整覆盖当前原有义务，不扩展冻结工具参数。'
  const phase = step.phase === 'verification'
    ? `本周期已经保存真实修订（基线r${step.reviewCycle.baselineRevision}），当前处于最终核验。新出现的纯质量建议须由当前模型逐项核对并写明具体保留原因；不能因每次完整检查又有新措辞就自动开启下一轮润色。首次复核已开始后，正文写入只接受精确落在尚未尝试的原始义务证据或当前完整报告真实错误证据内的改动；仅称为回归、模糊重叠或unknown不授予写入。相同锚点意见延续同一问题，不推断已解决；任何合法再修改仍使最终检查失效。当前意见关系：${JSON.stringify(step.reviewCycle.findings)}。`
    : '当前处于初始评估与意见决策：核对真实意见后，在原授权内完成所需修改；完整修改后进入最终核验。'
  if (step.state === 'terminal_review_required') return `${facts}${step.continuity === 'complete' ? '正文独立检查已完成' : '当前完整独立检查尚待确认'}；终态候选尚未证实，不能提交。未证实路径：${JSON.stringify(step.terminalReview?.unresolved ?? [])}。这是候选事实核对，不是正文问题或额外改稿依据。保留原候选与证据，核对实际正文和当前报告；不要静默清空已知事实、杜撰结构或为证明候选而改文。候选变更仍须按原预算和恢复准入核验，状态提示不授权重发未知调用。${step.reviewBoundPlan?.guidance ?? ''}`
  if (step.state === 'blocked') return `${facts}${phase}必要检查未确认完成。读取已保存状态与失败证据；不重放未知或已尝试付费请求，不以改文购买新检查，也不以留置替代完整检查。正文与进度保留，尚不能提交为完成。`
  if (step.state === 'check_required') return `${facts}${phase}最终保存版本仍缺必要检查：${JSON.stringify(step.requiredTools)}。先核对当前状态，仅通过原工具、原审批、原预算与恢复准入执行缺项；不重买已完成检查。尚不能提交为完成。`
  if (step.state === 'must_pass_required') return `${facts}${candidates}${scope}原作者明确要求检查通过；retainedFindings不能替代硬通过要求。按证据合法修改后复核最终版本；无法安全完成时保留事实及阻碍，不能提交或宣称通过。当前真实意见：${JSON.stringify(step.details)}。`
  if (step.state === 'commit_available') return `${facts}当前必要检查与意见决策已齐备，可在原权限及必要审批下提交 chapter_bridge_commit。${step.unresolvedFactErrors > 0 ? '保留的事实错误仍未解决，留置不表示检查通过。' : ''}`
  const action = step.phase === 'verification'
    ? '先用 chapter_bridge_get / quality_report_get 核对真实引用。对 new_advisory 或 unknown 的纯建议保持当前正文，不调用 chapter_edit_range、chapter_write 或 chapter_append 追改；下一步逐项填写 source、reportId、findingId、reason，通过 chapter_bridge_commit.retainedFindings 作合理保留决定。只有另有精确原始义务或当前真实错误证据时才继续其必要修复，不能把关系标签当许可。'
    : '先用 chapter_bridge_get / quality_report_get 核对真实意见，在原授权内精确应用或通过 chapter_bridge_commit 的 retainedFindings 逐项合理保留。'
  return `${facts}${phase}${candidates}${scope}${action}${batch}实际修改后复核最终保存版本；正文未变无需重买检查，也不制造无变化正文写入。详情：${JSON.stringify(step.details)}。精确参数模板（仅当前首批最多40项，reason须替换为实际原因）：${JSON.stringify(retentionTemplate)}。留置不是修复，不能声称全部意见已应用。`
}

export function reviewDispatchKey(readiness: { compilationId: string | null; chapterId: string; revision: number }, name: string): string {
  const base = `${readiness.compilationId}:${readiness.chapterId}:${readiness.revision}:${name}`
  return name === 'continuity_validate' ? `${base}:protocol${COMPILER_CONTINUITY_PROTOCOL}` : base
}

/** A completed assessment can still have one unspent, authorized decision.
 * This schedules a prompt, never a write, paid request or a new repair round. */
export function nextMergedReviewReminder(readiness: ChapterReviewReadiness | null,
  available: ReadonlySet<string>, attempted: ReadonlySet<string>, channelOpen: boolean): string | null {
  if (!readiness?.ready || !readiness.checksRequired || !channelOpen
    || !(readiness.decisionPending ?? (readiness.continuityErrorCount > 0 || (readiness.qualityCandidateCount ?? 0) > 0))
    || !['chapter_edit_range', 'chapter_write', 'chapter_bridge_commit'].some(name => available.has(name))) return null
  const key = reviewDispatchKey(readiness, 'merged')
  return attempted.has(key) ? null : key
}

/** Schedule one missing assessment, then reread the saved state. Existing
 * incomplete/unknown work is never dispatched again by this fallback. */
export function nextReviewDispatch(readiness: ChapterReviewReadiness | null,
  available: ReadonlySet<string>, attempted: ReadonlySet<string>, recovered: ReadonlySet<string> = new Set(),
  recoveryKeys: ReadonlyMap<string, string> = new Map()) {
  if (!readiness || readiness.ready) return { kind: 'ready' as const }
  const tool = readiness.requiredTools[0]
  if (!tool) return { kind: 'blocked' as const, reason: '当前版本的必要检查尚未确认完成。正文已保存，不能提交为完成。' }
  const status = tool.name === 'continuity_validate' ? readiness.continuity : readiness.quality
  const originalKey = reviewDispatchKey(readiness, tool.name)
  const key = recoveryKeys.get(originalKey) ?? originalKey
  if ((status === 'incomplete' && !recovered.has(originalKey) && !recoveryKeys.has(originalKey)) || attempted.has(key)) {
    return { kind: 'blocked' as const, reason: '当前版本的必要检查未完成或结果尚未确认。正文与进度保留，已停止重复检查请求，未判定检查通过。' }
  }
  if (!available.has(tool.name)) return { kind: 'blocked' as const,
    reason: '原任务允许的工具中缺少必要检查，正文与进度保留；未扩大工具权限，也未判定任务完成。' }
  return { kind: 'tool' as const, tool, key }
}
