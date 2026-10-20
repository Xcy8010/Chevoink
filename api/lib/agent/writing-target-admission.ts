import { legacyWritingRange, numeric, negativeScopeClause, type RequestedWritingRange } from './writing-target-range.js'

const mutation = /(?:修订|修正|修改|改写|重写|扩写|缩写|修复|纠正|纠错|润色|优化|调整|替换|插入|删除|删掉|精简|补充|增加|整改|续写|创作|起草|补写|补完|补齐|写完|完成|写|改|补足|解决)|\b(?:write|draft|finish|complete|revise|edit|repair|rewrite|polish|fix|replace|insert|delete|shorten|expand)\b/iu
const review = /(?:检查|审查|审阅|核对|核实|评估|分析)|\b(?:check|review|assess|evaluate)\b/iu
const reference = /(?:读取|阅读|读完|读|参考|参照|根据|对照|呼应|回顾|借鉴|比照)|\b(?:read|consult|reference)\b/iu
const denied = (clause: string) => negativeScopeClause.test(clause) || /(?:不修订|不修正|不修复|不动|不润色|不优化|never\b)/iu.test(clause)
const chapterMention = new RegExp(`(?:第|前)?\\s*${numeric}\\s*(?:章|卷)|chapter\\s*\\d+`, 'iu')
const actionStart = /(?:完成当前|必要的|\s|帮我|请你|继续|接着|然后|开始|直接|自动|自主|自行|全权|分别|明确|授权|允许|可以|针对|按照|进行|审查|审阅|检查|本次|这次|现在|请|你|先|再|只|仅|现|对|把|将|从|自|在|做|并|且)/gu
const factual = /(?:提到|写道|写着|却|曾|原文|描述|记载|表示|说过|讲述|发生|已经|已完成|已修订|已修改|修改过)/u
const advice = /(?:如何|怎样|怎么|建议|方案|思路|方法|报告|情况)|\b(?:how|advice|suggestions?|plan|report)\b/iu

/** Quoted manuscript text and titles are data, including any chapter ordinals
 * or imperative-looking words inside them. Never unwrap them into authority. */
function withoutQuotations(prompt: string) {
  return prompt.replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|《[^》]*》|"[^"\n]*"|`[^`]*`/gu, ' ')
}

function actionClauses(prompt: string) {
  // A colon keeps its introducer: "read this: edit chapter 3" is data,
  // whereas "edit: chapter 3" still has its own explicit governing action.
  const raw = withoutQuotations(prompt).split(/[，,。！？!?；;\n]+/u)
  const clauses: string[] = []
  const listTail = new RegExp(`^\\s*第?\\s*${numeric}\\s*(?:章)?(?:\\s*(?:、|和|及|与)\\s*第?\\s*${numeric}\\s*(?:章)?)*(?:\\s*(?:修改|修订|修正|优化|改))?\\s*$`, 'u')
  for (const clause of raw) {
    const previous = clauses.at(-1)
    // Only a bare chapter-list continuation inherits its governing action (and
    // negation). A factual or reading clause starting with 第1章 never joins it.
    if (previous && (listTail.test(clause) && new RegExp(`${numeric}\\s*(?:章)?\\s*$`, 'u').test(previous)
      || /^\s*一直(?:到|至)(?:最后|末章)/u.test(clause))) clauses[clauses.length - 1] += `、${clause}`
    else clauses.push(clause)
  }
  return clauses.flatMap(clause => {
    const anchor = /(?:当前(?:这)?(?:章|章节)|正在编辑(?:的)?(?:这章|章节|章))(?:之|以)?后/iu.test(clause)
    return clause.split(new RegExp(`(?:并且|并|然后|再|同时|${anchor ? '' : '之后|后|'}但|且|\\band\\b|\\bthen\\b)(?=\\s*(?:请|先|仅|只|不要|不得|不许|不能|禁止|读取|阅读|读|参考|参照|核对|检查|审阅|修订|修正|修改|改写|续写|写|read\\b|review\\b|revise\\b|edit\\b|write\\b))`, 'iu'))
  })
}

function effect(clause: string): 'mutation' | 'review' | null {
  if (denied(clause) || /(?:只读|read.only)/iu.test(clause)) return null
  // An explanation/request for advice does not request an effect. Report
  // delivery after an explicit effect is allowed, but never a report object.
  const operation = mutation.exec(clause)
  const check = review.exec(clause)
  const ref = reference.exec(clause)
  const chosen = operation && (!check || operation.index <= check.index || /(?:审查|检查|审阅)\s*(?:并)?(?:优化|修复|修订|修正|修改)/u.test(clause))
    ? { match: operation, kind: 'mutation' as const } : check ? { match: check, kind: 'review' as const } : null
  if (!chosen || ref && ref.index < chosen.match.index) return null
  const before = clause.slice(0, chosen.match.index)
  const after = clause.slice(chosen.match.index + chosen.match[0].length)
  if (advice.test(before) || /^\s*(?:的)?(?:建议|方案|思路|方法|报告|情况)/u.test(after) || factual.test(before)) return null
  // Target-first instructions are valid, but a bare story statement containing
  // "写/改" is not. A named chapter plus imperative repair is explicit.
  const targetPrefix = before.replace(new RegExp(`(?:第|前)?\\s*${numeric}\\s*(?:章|卷)?|首章|[、及与和至到—–~～-]`, 'gu'), '')
  if (before.replace(actionStart, '') !== ''
    && targetPrefix.replace(/(?:正在编辑|\s|帮我|继续|开始|当前|下一|章节|最后|开头|结尾|片段|选区|这里|此处|正文|全书|整本|进行|必要|针对|之后|以后|自动|自主|分别|请|仅|只|先|本|这|的|章|段|句|首|末|做|对|把|将|从|自|在|后)/gu, '') !== ''
    && !(chapterMention.test(before) && /问题帮我\s*$/u.test(before))
    && !/^\s*(?:please\s+)?$/iu.test(before)) return null
  return chosen.kind
}

function targetClause(clause: string) {
  const ref = reference.exec(clause)
  const bounded = ref ? clause.slice(0, ref.index) : clause
  // Unknown relationships between two chapter objects must fail closed, not
  // fall through to the old lexical preference for 第1章 or 前两章.
  const objects = [...bounded.matchAll(new RegExp(`(?:第|前)?\\s*${numeric}\\s*(?:章)?(?:\\s*(?:、|及|与|和|至|到|[-–—−~～〜－])\\s*第?\\s*${numeric}\\s*(?:章)?)*\\s*章|首章|chapter\\s*\\d+`, 'giu'))]
  return { clause: bounded, ambiguous: objects.length > 1 && !/(?:从|自).*(?:到|至).*(?:最后|末章)/u.test(bounded) }
}

function mergeRanges(ranges: RequestedWritingRange[]): RequestedWritingRange | null {
  if (!ranges.length) return null
  const first = ranges[0]
  if (ranges.every(item => JSON.stringify(item) === JSON.stringify(first))) return first
  // Separate explicit effects may name multiple chapters. Relative and
  // whole-book ranges cannot be safely combined with another interpretation.
  if (ranges.some(item => item.volume !== first.volume || !['first', 'range', 'list'].includes(item.kind))) return null
  const positions = [...new Set(ranges.flatMap(item => item.kind === 'list' ? item.positions ?? []
    : Array.from({ length: item.count ?? 1 }, (_, i) => (item.start ?? 1) + i)))]
  return positions.length <= 1000 ? { kind: 'list', positions, ...(first.volume ? { volume: first.volume } : {}) } : null
}

export function parseWritingTargets(prompt: string) {
  const clauses = actionClauses(prompt)
  const effects = clauses.flatMap(clause => {
    const kind = effect(clause)
    return kind ? [{ clause, kind }] : []
  })
  // Once the request contains a mutation, review/read targets are context.
  // They must not become a second mutation target or override its ordinal.
  const mutationEffects = effects.filter(item => item.kind === 'mutation')
  const selected = mutationEffects.length ? mutationEffects : effects
  const parsed = selected.map(item => ({ ...targetClause(item.clause), kind: item.kind }))
    .map(item => ({ ...item, range: legacyWritingRange(item.clause) }))
  const ranges = parsed.flatMap(item => item.range ? [item.range] : [])
  const range = mergeRanges(ranges)
  const ambiguous = ranges.length > 0 && !range
    || parsed.some(item => item.ambiguous || !item.range && chapterMention.test(item.clause))
  const exclusions = clauses.filter(clause => denied(clause)
    && /(?:不(?:要|得|许|能|必)?|禁止|无需|不用|别).{0,12}(?:修改|修订|修正|修复|改写|写|改|动|润色|优化|重写)|(?:do not|don't|must not).{0,16}(?:write|edit|revise|repair|rewrite|polish|fix)/iu.test(clause))
  return { range: ambiguous ? null : range, ambiguous, hasAction: effects.length > 0, exclusions }
}

/** Fresh admission only. Historical missing contracts use legacyWritingRange. */
export function requestedWritingRange(prompt: string) {
  return parseWritingTargets(prompt).range
}

/** Only explicit new-protocol exclusions use the extended denial vocabulary. */
export function writingExclusionRange(clause: string) {
  return legacyWritingRange(clause
    .replace(/不(?=修订|修正|修复|动|润色|优化)/gu, '')
    .replace(/(?:不继续|不批量|不续写|不生成|不要|无需|不用|不必|禁止|不得|不能|别|do not|don't|must not)|不(?=写|改|修改)/giu, ''))
}
