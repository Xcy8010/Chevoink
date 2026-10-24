import { createHash } from 'node:crypto'
import { runtimeJson } from './runtime-common.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { readTerminalCandidate } from './terminal-state-review.js'
import { terminalReviewAddressCatalog, normalizeTerminalResponseRows } from './terminal-review-addresses.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import { terminalReviewRowDiagnostics } from './terminal-review-row-diagnostics.js'
import { continuitySourceCatalog } from './continuity-review-context.js'
import type { TerminalCandidateCorrection } from './terminal-candidate-feedback.js'

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** Advisory ONLY: a bad disposition must not erase the available sources and
 * candidate-processing route. No report/proof/coverage/dispatch/commit is
 * certified here. Reproduce the complete saved rejection, then require the
 * ordinary/proof address sets to be exhaustive before exposing the bad rows. */
export function terminalReportCorrection(validation: unknown, content: string, context: TerminalEvidenceContext, previous: string | null) : TerminalCandidateCorrection | null {
  const saved = object(validation), audit = object(saved?.continuityCriticResponse), raw = object(audit?.rawResponse)
  const candidate = readTerminalCandidate(validation)
  if (!candidate || saved?.independentCheck !== 'unavailable' || context.verdictProtocol !== 6
    || audit?.responseContract !== 3 || audit.parserVersion !== 8 || audit.classification !== 'terminal_invalid'
    || raw?.complete !== true || raw.encoding !== 'json-string' || typeof raw.content !== 'string'
    || runtimeJson(audit.terminalCandidate).hash !== runtimeJson(candidate).hash
    || runtimeJson(audit.terminalEvidence).hash !== runtimeJson(context).hash
    || audit.terminalContentHash !== runtimeJson({ content }).hash) return null
  try {
    const response: unknown = JSON.parse(raw.content)
    if (typeof response !== 'string' || response.length !== audit.characterCount
      || createHash('sha256').update(response).digest('hex') !== audit.contentHash) return null
    const scope = audit.sourceScope === undefined ? undefined : continuitySourceScopeSchema.parse(audit.sourceScope)
    const reproduced = inspectContinuityResponse(response, { current: content, previous, terminalEvidence: context }, true, 8, candidate, scope, { responseContract: 3 })
    if (!reproduced.structured || reproduced.audit.classification !== 'terminal_invalid' || reproduced.invalidSourceReferences.length
      || runtimeJson(reproduced.audit.terminalReviewDiagnostics ?? []).hash !== runtimeJson(audit.terminalReviewDiagnostics ?? []).hash) return null
    const value = object(parseQualityJsonObject(response, 'continuity', 3))
    if (!value) return null
    const projection = normalizeTerminalResponseRows(value)
    if (projection.error) return null
    const wire = projection.record
    const rows = terminalReviewRowDiagnostics(candidate, { current: content, previous, terminalEvidence: context }, wire)
    if (!rows) return null
    const catalog = terminalReviewAddressCatalog(candidate, context)
    const diagnostics = reproduced.audit.terminalReviewDiagnostics ?? []
    const sources = continuitySourceCatalog({ current: content, previous, terminalEvidence: context }).terminalSources
    const quoteIssue = (row: { code: string; segmentId?: string }) => row.code === 'evidence_quote_invalid'
      && sources.some(source => source.segmentId === row.segmentId)
    // An aggregate is admissible only alongside the same reproduced table's
    // concrete row issues. Unknown global errors still have no recovery authority.
    const aggregate = (code: string) => code === 'fact_disposition_invalid' && !!rows.bad.get('terminalDispositions')?.size
      || code === 'proposal_disposition_invalid' && !!rows.bad.get('proposalDispositions')?.size
    if (!diagnostics.length || diagnostics.some(row => !row.path ? !aggregate(row.code)
      : !/^((terminalDispositions|proposalDispositions)(\.|$))/u.test(row.path) && !quoteIssue(row))
      || rows.diagnostics.some(row => !/^((terminalDispositions|proposalDispositions)(\.|$))/u.test(row.path ?? '') && !quoteIssue(row))) return null
    const unresolved = catalog.obligations.map(row => ({ ...row, reported: Array.isArray(wire.terminalDispositions) ? wire.terminalDispositions.find(value => object(value)?.obligationIndex === row.obligationIndex) : undefined, path: `factCoverage.${row.id}` }))
    const proposals = catalog.proposals.map(row => ({ ...row, reported: Array.isArray(wire.proposalDispositions) ? wire.proposalDispositions.find(value => object(value)?.proposalIndex === row.proposalIndex) : undefined, path: `proposalChanges.${row.id}` }))
    const issues = [...unresolved, ...proposals].map(row => ({ path: row.path, reason: 'report_contract_unresolved' }))
      .concat(rows.diagnostics.filter(row => row.code === 'evidence_quote_invalid').map(row => ({ path: row.path!, reason: 'report_reference_invalid' })))
    if (!issues.length) return null
    const replacements = catalog.claims.filter(row => ['knowledge', 'body', 'objects', 'relationships', 'openLoops'].includes(row.field))
      .map(({ claimIndex: candidateIndex, field, claim }) => ({ candidateIndex, field, claim }))
    return { version: 1, candidateHash: runtimeJson(candidate).hash, contentHash: createHash('sha256').update(content).digest('hex'),
      paths: issues.map(row => row.path), issues,
      guidance: `独立响应已收到，正文意见已保留；终态处置表未通过核验，检查尚未通过，不能提交。该问题不要求改写正文，也不允许重复相同付费检查。具体诊断（全部坏行）：${JSON.stringify(rows.diagnostics.length ? rows.diagnostics : diagnostics)}。引用或地址错误属于独立报告，不证明候选事实错误；不要缩减 terminalState 或丢掉 inheritedProofs 来修报告。当前完整候选和新基准：${JSON.stringify({ baseCandidateHash: runtimeJson(candidate).hash, terminalState: candidate })}。合法持久替代目录：${JSON.stringify(replacements)}。需要处理的旧事实和提议（reported为原始未获完整认证的意见，不能自动作为裁决）：${JSON.stringify({ obligations: unresolved, proposals })}。结合当前全文与原前章逐项处理：旧事实仍成立时显式选择可用 inheritedProofs 还原原字段和完整主张；事实确有改变时用 terminalPatch 添加有据的持久候选，再由独立检查确认替代或解除。动作、地点、未完成动作不能直接充当持久事实替代。unknown 和格式错误都不是删除旧义务的许可；不得自动判未变或通过。保留全部有效候选、原报告、账务和原有有限处理次数。` }
  } catch { return null }
}

/** Executing the tool can yield actionable pending work without certifying an
 * independent pass. Persisted independentCheck stays unavailable; guards still
 * block commit. Explicit false also fences unchanged review redispatch. */
export function terminalReportRecoveryResult(validation: unknown, content: string, context: TerminalEvidenceContext | undefined, previous: string | null) {
  const correction = context ? terminalReportCorrection(validation, content, context, previous) : null
  return correction ? { outcome: 'failed' as const, failureCode: 'CONTINUITY_REPORT_INCOMPLETE', reviewCompleted: false, summary: '连续性报告未通过核验 · 待处理', output: correction.guidance } : null
}
