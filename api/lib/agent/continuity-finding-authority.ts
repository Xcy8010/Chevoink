import type { ContinuityFindingInput } from '../../../shared/contracts/story-compiler-contracts.js'

/** Narrow classification of a critic's explicit plan-calibration finding.
 * Ambiguous evidence and author/saved-fact conflicts keep their original rank;
 * this is not a semantic proof that all model mistakes have been eliminated. */
export function classifyContinuityFindingAuthority(finding: ContinuityFindingInput, authorRequest?: string | null,
  savedBodies?: { previous: string | null; current: string }): ContinuityFindingInput {
  const planOnly = /Scene\s*Task|场景(?:任务|计划|草案)|生成(?:计划|草案)/iu.test(finding.evidence)
    && /(?:修改|调整|更新|校准|更改).{0,16}(?:任务|目标|计划|草案)|(?:任务|计划|草案).{0,16}(?:匹配|符合|对齐).{0,8}正文/u.test(finding.suggestion)
  // A critic's authority label is not proof. Bind a specific stated plan target
  // to an actual hard author clause, or quoted facts to both saved manuscripts.
  const quotes = [...finding.evidence.matchAll(/[“「『"‘]([^”」』"’]{2,360})[”」』"’]/gu)].map(match => match[1])
  const targets = [...quotes, ...[...finding.evidence.matchAll(/(?:写着|要求|目标为|代价为)[：:\s]*([^，。；;但]{2,80})/gu)].map(match => match[1].trim())]
  const authorBound = (authorRequest ?? '').split(/[。！？!?；;\n，,]+/u).some(clause =>
    /必须|务必|一定要|不得|不可|禁止|明确要求|\bmust\b|\bshall\b|\bnever\b/iu.test(clause)
    && targets.some(target => clause.includes(target)))
  const savedBound = !!savedBodies?.previous && quotes.some(quote => savedBodies.previous!.includes(quote))
    && quotes.some(quote => savedBodies.current.includes(quote) && !savedBodies.previous!.includes(quote))
  const confirmedAuthority = authorBound || savedBound
  return finding.severity === 'error' && planOnly && !confirmedAuthority
    ? { ...finding, severity: 'warning', suggestion: `计划校准，不能单凭草案偏离改写正文：${finding.suggestion}`.slice(0, 1000) }
    : finding
}
