import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { parseQualityJsonObject } from './quality-evidence.js'
import { inspectTerminalReview, readTerminalCandidate, terminalJointFactVerdictSchema, terminalQuoteAddressDiagnostics } from './terminal-state-review.js'
import { readTerminalProofVerdicts } from './terminal-proof-verdict.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'

export type TerminalCandidateCorrection = { version: 1; candidateHash: string; contentHash: string; paths: string[]; guidance: string }
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const currentOnly = /^(?:exitState\.(?:location|action|storyTime|emotion(?:\.\d+)?)|lastUnfinishedAction)$/u

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
    if (inspectTerminalReview(candidate, content, response, true, context, diagnostics)
      || diagnostics.length !== 1 || diagnostics[0].code !== 'inheritance_invalid'
      || !currentOnly.test(diagnostics[0].path ?? '')) return null
    const parsed: unknown = parseQualityJsonObject(response, 'continuity', 3)
    const verdicts = z.array(terminalJointFactVerdictSchema).max(200).safeParse(object(parsed)?.terminalVerdicts)
    if (!verdicts.success) return null
    const facts = terminalCandidateFacts(candidate)
    if (terminalQuoteAddressDiagnostics(response, content, context, candidate)?.some(item => item.reason !== 'relocated')) return null
    const addressed = verdicts.data.map(item => 'factId' in item
      ? facts.find(f => f.id === item.factId && (item.path === undefined || item.path === f.path))
      : facts.find(f => f.path === item.path))
    const proofs = readTerminalProofVerdicts(object(parsed)?.terminalProofVerdicts, candidate, context)
    if (addressed.some(fact => !fact) || !proofs) return null
    const allPaths = [...addressed.map(fact => fact!.path), ...proofs.verdicts.map(item => item.path)]
    if (allPaths.length !== facts.length || new Set(allPaths).size !== facts.length) return null
    const paths = verdicts.data.flatMap(item => {
      const fact = 'factId' in item ? facts.find(f => f.id === item.factId && (item.path === undefined || item.path === f.path))
        : facts.find(f => f.path === item.path)
      return fact && currentOnly.test(fact.path) && item.verdict === 'supported'
        && item.sourceEvidence.some(ref => /^[pt]/u.test(ref.segmentId)) ? [fact.path] : []
    })
    if (!paths.includes(diagnostics[0].path!)) return null
    return { version: 1, candidateHash: runtimeJson(candidate).hash, contentHash: createHash('sha256').update(content).digest('hex'), paths,
      guidance: `当前终态候选尚未得到独立证实。${JSON.stringify(paths.map(path => ({ path, claim: facts.find(f => f.path === path)!.claim })))} 属于本章结束时的状态，前章引用不能单独证明或继承这些状态。关联的当前候选为${JSON.stringify({ location: candidate.exitState.location, action: candidate.exitState.action, lastUnfinishedAction: candidate.lastUnfinishedAction })}。阅读真实正文及必要的承接上下文，核对整组位置、方向、动作和未完成动作是否指向同一对象、同一侧，以及动作是否已经发生；必要时用 terminalPatch 精确纠正相互依赖的候选，保留其余已记录事实。不得为迁就候选改正文，也不得把这份失败报告当作通过。修改后仍须经过原版本、请求结果、费用和独立复核保护；相同候选不得重复付费。` }
  } catch { return null }
}
