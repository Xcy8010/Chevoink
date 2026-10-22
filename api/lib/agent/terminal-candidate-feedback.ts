import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { inspectTerminalReview, readTerminalCandidate, terminalJointFactVerdictSchema, terminalQuoteAddressDiagnostics } from './terminal-state-review.js'
import { readTerminalProofVerdicts } from './terminal-proof-verdict.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'

export type TerminalCandidateCorrection = { version: 1; candidateHash: string; contentHash: string; paths: string[];
  issues?: Array<{ path: string; reason: string }>; guidance: string }
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Advisory processing feedback, never a complete report, proof, edit authority
 * or dispatch grant. Reproduce the saved rejection against the current frozen
 * evidence; do not reinterpret an old contract or manufacture an attestation. */
export function terminalCandidateCorrection(validation: unknown, content: string, context: TerminalEvidenceContext): TerminalCandidateCorrection | null {
  const saved = object(validation), audit = object(saved?.continuityCriticResponse), raw = object(audit?.rawResponse)
  const candidate = readTerminalCandidate(validation)
  if (!candidate || context.verdictProtocol !== 5 || saved?.independentCheck !== 'unavailable'
    || audit?.classification !== 'terminal_invalid' || audit.parserVersion !== 8
    || raw?.complete !== true || raw.encoding !== 'json-string' || typeof raw.content !== 'string'
    || runtimeJson(audit.terminalCandidate).hash !== runtimeJson(candidate).hash
    || runtimeJson(audit.terminalEvidence).hash !== runtimeJson(context).hash
    || audit.terminalContentHash !== runtimeJson({ content }).hash) return null
  try {
    const response: unknown = JSON.parse(raw.content)
    if (typeof response !== 'string' || response.length !== audit.characterCount
      || createHash('sha256').update(response).digest('hex') !== audit.contentHash) return null
    const diagnostics: Parameters<typeof inspectTerminalReview>[5] = []
    if (inspectTerminalReview(candidate, content, response, true, context, diagnostics) || !diagnostics.length) return null
    const parsed: unknown = parseQualityJsonObject(response, 'continuity', 3)
    const verdicts = z.array(terminalJointFactVerdictSchema).max(200).safeParse(object(parsed)?.terminalVerdicts)
    if (!verdicts.success) return null
    const facts = terminalCandidateFacts(candidate)
    const addressed = verdicts.data.map(item => 'factId' in item
      ? facts.find(f => f.id === item.factId && (item.path === undefined || item.path === f.path))
      : facts.find(f => f.path === item.path))
    const proofs = readTerminalProofVerdicts(object(parsed)?.terminalProofVerdicts, candidate, context)
    if (addressed.some(fact => !fact) || !proofs) return null
    const allPaths = [...addressed.map(fact => fact!.path), ...proofs.verdicts.map(item => item.path)]
    if (allPaths.length !== facts.length || new Set(allPaths).size !== facts.length) return null
    const inheritedPaths = verdicts.data.flatMap(item => {
      const fact = 'factId' in item ? facts.find(f => f.id === item.factId && (item.path === undefined || item.path === f.path))
        : facts.find(f => f.path === item.path)
      return fact && item.verdict === 'supported'
        && item.sourceEvidence.some(ref => /^[pt]/u.test(ref.segmentId)) ? [fact.path] : []
    })
    // A rejected address is evidence of an unresolved binding, never evidence
    // that the claimed fact is true or false. Only exhaustive, uniquely mapped
    // candidate responses can feed the existing bounded processing episode.
    const addresses = terminalQuoteAddressDiagnostics(response, content, context, candidate)
      ?.filter(item => item.reason !== 'relocated' && facts.some(fact => fact.path === item.path)) ?? []
    const pending = [...diagnostics.flatMap(item => item.path && inheritedPaths.includes(item.path)
      ? [{ path: item.path, reason: item.code }] : []),
    ...addresses.map(item => ({ path: item.path, reason: item.reason })),
    ...verdicts.data.flatMap((item, index) => item.verdict !== 'supported'
      ? [{ path: addressed[index]!.path, reason: item.verdict }] : []),
    ...proofs.verdicts.flatMap(item => item.verdict !== 'supported' ? [{ path: item.path, reason: item.verdict }] : [])]
    const issues = [...new Map(pending.map(item => [`${item.path}:${item.reason}`, item])).values()]
    if (!issues.length) return null
    const paths = [...new Set(issues.map(item => item.path))]
    return { version: 1, candidateHash: runtimeJson(candidate).hash, contentHash: createHash('sha256').update(content).digest('hex'), paths, issues,
      guidance: `当前终态候选的证据绑定未通过核验：${JSON.stringify(paths.map(path => ({ path, claim: facts.find(f => f.path === path)!.claim })))}。失败诊断：${JSON.stringify({ issues, addresses })}。这是未解决的绑定，不是事实裁决。核对当前正文与真实前章；持续事实可选择已有的完整继承证明，本章位置和动作须由本章证实。较早章的引文不能冒充紧邻前章依据。区分指令、计划与实际完成，核对对象、门序和内外侧。用 terminalPatch 明确替换有依据的候选项，保留其余事实及未解决义务；不能只删除难处理事实或改正文迁就候选。修改后仍须独立复核；失败报告保持失败，相同输入和未知付费请求不得重发。` }
  } catch { return null }
}
