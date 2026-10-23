/** Original author requirements, independent of executable review/runtime
 * modules. Importing a writer schema must not initialize the provider chain. */
export function originalChapterReviewRequirements(original: { prompt: string | null; spec: unknown }) {
  const spec = original.spec && typeof original.spec === 'object' && !Array.isArray(original.spec) ? original.spec as Record<string, unknown> : null
  const writing = ['write', 'revise'].includes(String(spec?.intent)) && !['conversation_only', 'proposal_only'].includes(String(spec?.writingPacing))
    && ['balanced', 'premium'].includes(String(spec?.qualityMode))
  const clauses = original.prompt?.split(/[。！？!?；;\n，,]+/u) ?? []
  const waived = (kind: 'continuity' | 'quality') => clauses.some(clause =>
    !/(?:不要|不得|不能|不许|勿|不可|禁止)\s*(?:再)?\s*(?:跳过|省略|略过|取消)|(?:do not|don't|never|must not)\s+(?:skip|omit|bypass)/iu.test(clause)
    && !/(?:标题|章名|错别字|标点|单句|前文|前章|第[\d一二三四五六七八九十百千零〇两]+章)/u.test(clause)
    && /(?:不要|无需|不用|不必|跳过|不做|不进行|skip|do not|don't).{0,12}(?:检查|审查|审阅|评估|check|review)/iu.test(clause)
    && (/(?:不要|无需|不用|不必|跳过)(?:再|做|进行|任何|所有|全部|自动|额外|完整)*(?:检查|审查|审阅|评估)(?:了)?\s*$/u.test(clause)
      || /(?:skip|do not|don't).{0,8}(?:all|any).{0,8}(?:checks|reviews)/iu.test(clause)
      || (kind === 'quality' ? /质量|人类感|AI味|quality/iu : /连续性|连贯性|一致性|continuity/iu).test(clause)))
  return { continuity: writing && !waived('continuity'), quality: writing && !waived('quality') }
}
