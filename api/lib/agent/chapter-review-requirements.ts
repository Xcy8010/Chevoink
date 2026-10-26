import { lexAuthorWritingRequest } from './author-writing-request.js'
import { chapterNumber, numeric } from './writing-target-range.js'

type ReviewTarget = { id?: string | null; orderIndex?: number }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only original human instructions for this authenticated chapter may waive
 * its delivery checks. Quoted data and another chapter never grant a waiver. */
export function originalChapterReviewRequirements(original: { prompt: string | null; spec: unknown }, target?: ReviewTarget): { continuity: boolean; quality: boolean } {
  const spec = object(original.spec), scope = object(spec.scope), writingScope = object(scope.writing)
  const writing = ['write', 'revise'].includes(String(spec.intent)) && !['conversation_only', 'proposal_only'].includes(String(spec.writingPacing))
    && ['balanced', 'premium'].includes(String(spec.qualityMode))
  const targets = (Array.isArray(writingScope.targets) ? writingScope.targets : []).map(object)
    .filter(item => Number.isSafeInteger(item.orderIndex) && Number(item.orderIndex) > 0)
  if (!target) {
    const required = targets.map(item => originalChapterReviewRequirements(original, { id: typeof item.chapterId === 'string' ? item.chapterId : null, orderIndex: Number(item.orderIndex) }))
    return { continuity: writing && (!required.length || required.some(item => item.continuity)),
      quality: writing && (!required.length || required.some(item => item.quality)) }
  }
  const order = target.orderIndex ?? targets.find(item => item.chapterId === target.id)?.orderIndex
    ?? (targets.length === 1 ? targets[0].orderIndex : undefined)
  if (!targets.some(item => item.orderIndex === order && (!target.id || !item.chapterId || item.chapterId === target.id)))
    return { continuity: writing, quality: writing }
  const single = targets.length === 1 && targets[0].orderIndex === order
  const anchored = !!target.id && (scope.chapterId === target.id || scope.anchorChapterId === target.id)
  const lexical = lexAuthorWritingRequest(original.prompt ?? '')
  const uncertain = /[？?]|是否|要不要|能否|可否|行不行|吗|如果|假如|假设|除非|\b(?:if|unless|whether|can we|should we|could we)\b/iu
  const sentences = new Map<number, typeof lexical.clauses>()
  for (const clause of lexical.clauses) {
    const group = sentences.get(clause.sentence) ?? []
    group.push(clause); sentences.set(clause.sentence, group)
  }
  const clauses = [...sentences.values()].flatMap(group => {
    // Conditions and questions scope over commas; quoted text is already masked.
    const sentence = lexical.masked.slice(group[0].start, group.at(-1)!.end + 1)
    if (uncertain.test(sentence)) return []
    let chapterScope = ''
    return group.flatMap(({ masked: clause }) => clause.split(/[，,]/u).flatMap(piece => piece.split(/但是|不过|然而|可是|但|而且|同时|并且|而|\bbut\b|\bwhile\b/iu).map(part => {
      const positions = [...part.matchAll(new RegExp('第\\s*(' + numeric + ')\\s*章|\\bchapter\\s+(\\d+)\\b', 'giu'))]
      if (positions.length) chapterScope = positions.map(match => match[0]).join(' ') + ' '
      else if (/(?:本章|当前章|这一章|这章|this chapter|current chapter)/iu.test(part)) chapterScope = '本章 '
      return positions.length || /(?:本章|当前章|这一章|这章|this chapter|current chapter)/iu.test(part) ? part : chapterScope + part
    })))
  })
  const kinds = { quality: /质量|人类感|AI\s*味|quality/iu, continuity: /连续性|连贯性|一致性|continuity/iu }
  const applies = (clause: string) => {
    if (/(?:标题|章名|错别字|标点|单句|前文|前章|上章|其他章|其余章|别的章|示例|例如|比如|假如|假设|提示词|文案|台词)/u.test(clause)
      || /(?:回复|输出|显示|写入).{0,12}(?:无需|不用|不要|跳过)/u.test(clause)) return false
    const positions = [...clause.matchAll(new RegExp('第\\s*(' + numeric + ')\\s*章|\\bchapter\\s+(\\d+)\\b', 'giu'))]
      .map(match => chapterNumber(match[1] ?? match[2]))
    if (positions.length) return Number.isSafeInteger(order) && positions.every(position => position === order)
    if (/(?:本章|当前章|这一章|这章|this chapter|current chapter)/iu.test(clause)) return single || anchored
    return single || /(?:所有|全部|各|上述).{0,6}章节|\ball chapters\b/iu.test(clause)
  }
  const waived = (kind: keyof typeof kinds) => {
    const relevant = clauses.filter(clause => applies(clause) && (kinds[kind].test(clause)
      || !kinds.quality.test(clause) && !kinds.continuity.test(clause)))
    const protectedCheck = relevant.some(clause => /(?:不要|不得|不能|不许|勿|不可|禁止|无需|不用|不允许|不可以|不准|不应|别)\s*(?:再)?\s*(?:跳过|省略|略过|取消|不做|不进行|不检查)|(?:不是|并非|不代表|不能|不得).{0,6}(?:无需|不用|不需要|不要|不必|不做|不检查)|(?:不必|无需|不用).{0,4}(?:不做|通过)|(?:必须|务必|照常|仍需|仍要|保留|继续).{0,12}(?:检查|审查|审阅|评估)|(?<!不)需要.{0,12}(?:检查|审查|审阅|评估)|(?<![不需])(?:要做|要进行).{0,12}(?:检查|审查|审阅|评估)|(?:检查|审查|审阅|评估).{0,6}(?:必须|务必|仍需|照常|不能跳过)|(?:必须|务必).{0,6}通过|(?:checks?|reviews?).{0,8}(?:required|mandatory)|(?:must|required|mandatory).{0,12}(?:check|review)|(?:do not|don't|never|must not)\s+(?:skip|omit|bypass)/iu.test(clause))
    return !protectedCheck && relevant.some(clause => /(?:不检查|不审查|不审阅|不评估)/u.test(clause) || /(?:不要|无需|不用|不需要|不必|跳过|省略|取消|不做|不进行|skip|do not|don't).{0,12}(?:检查|审查|审阅|评估|check|review)/iu.test(clause))
  }
  return { continuity: writing && !waived('continuity'), quality: writing && !waived('quality') }
}
