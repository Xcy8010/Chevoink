import { describe, expect, it } from 'vitest'
import { lexAuthorWritingRequest, parseAuthorWritingExclusion, parseAuthorWritingRequest } from '../../api/lib/agent/author-writing-request.js'
import { chapterRevisionPrompt, nextChapterContinuationPrompt } from '../support/writing-target-prompt.js'
import { shortSceneRequest } from '../support/writing-clarification-fixture.js'

describe('fresh structured author-writing interpretation, protocol 2', () => {
  it.each([
    '仅修改第3章。请先读取前两章。不修改第1、2章。', '仅修改第3章。请先读取前两章。',
    '请先读取第1章。仅修改第3章。', '仅修改第3章。请先读取第1章。', '仅修改第3章，第1章提到一扇窗。',
    '仅修改第3章。先阅读前两章作为参考。', '仅修改第3章并核对第1章。', '修改第3章时参考第1章。',
    '修改第3章以呼应第1章。', '读取第1章后修改第3章。', '仅修改第3章。第1章却写“请修改第二章”。',
    '只修订第三章《第一章的信》。前两章已经写完。', '仅修正第三章的正文。不要跳过检查第1章。',
    '请修改：第三章。', chapterRevisionPrompt,
  ])('binds only the revised author target: %s', prompt => {
    expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'range', start: 3, count: 1 }, ambiguous: false, hasAction: true, intent: 'revise' })
  })
  it.each([
    '读取前两章', '参考第1章。第3章却写“修改第2章”。', '前两章已经写完。', '给出修改第3章的建议',
    '第1章提到如何修改第3章', '不要修改第1章，第2章修改', '“修改第1章”。读取第3章。',
    '第1章主角尝试修改日期。', '请阅读这句：修改当前章节。', '请读取这句文字：修改第3章。',
    '引用原文：修改第3章。', '请阅读提示：修改首段。',
    '请读取这句：“续写下一章，只写这一章，作为第4章正式写入”。',
    '不要续写下一章，不要作为第4章正式写入。', '请阅读：作为第4章正式写入。',
  ])('does not turn data, advice, history, reading or denial into an author mutation: %s', prompt => {
    expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, hasAction: false, intent: null })
  })
  it.each(['续写下一章，只写这一章。', '写下一章。仅续写该章。', '写下一章。只完成本章正文。'])(
    'keeps demonstratives as a restriction on one relative target: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'next', count: 1 }, ambiguous: false, intent: 'write' })
    })
  it.each(['在当前章之后写下一章', '当前章节以后续写下一章', '在正在编辑的章节之后继续写下一章',
    'After the current chapter write the next chapter', 'Write the next chapter after the current chapter'])(
    'binds the editor-relative relation across the writing predicate: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'next', count: 1, anchor: 'editor' }, intent: 'write', ambiguous: false })
    })
  it('keeps an editor-relative target distinct from its absolute placement confirmation', () => {
    const parsed = parseAuthorWritingRequest('在当前章之后写下一章，作为第4章正式写入。只写这一章。')
    expect(parsed).toMatchObject({ range: { kind: 'next', count: 1, anchor: 'editor' }, confirmedNextOrderIndex: 4, ambiguous: false })
    // The consumer resolves this selector to 2 for editor=1, regardless of the
    // existing last chapter=3, and must reject confirmation=4 at admission.
    expect((parsed.range!.anchor === 'editor' ? 1 : 3) + 1).not.toBe(parsed.confirmedNextOrderIndex)
  })
  it.each(['读取当前章之后的内容，写下一章', '在当前章之后读取第1章然后写下一章',
    '写下一章。当前章之后曾经有空白。', '写下一章。引用：“在当前章之后写下一章”。'])(
    'does not borrow an editor relation from data or another predicate: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt).range).toEqual({ kind: 'next', count: 1 })
    })
  it.each(['第二卷第2章当前已存正文，请做一次局部修订。先读取第1章作为参考，不修改第1、2、3章。',
    '第二卷第2章现有草稿，请修订第二段。', '第三章，请修改结尾。', '第三章的正文，做一次必要修订。'])(
    'binds a preceding nominal chapter scope to a following generic body object: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: prompt.includes('卷') ? { kind: 'range', start: 2, count: 1, volume: 2 }
        : { kind: 'range', start: 3, count: 1 }, ambiguous: false, intent: 'revise' })
    })
  it.each(['第1章提到一扇门，修改结尾。', '第1章提出建议，修改结尾。', '第1章门未关，局部修订。',
    '读取第1章，修改结尾。', '第1章的正文。做一次局部修订。'])(
    'never treats contextual or sentence-separated chapter prose as the next operation scope: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt).range).toBeNull()
    })
  it.each(['作为第4章正式写入', '作为第四章保存', '作为全书第4章落稿'])(
    'keeps an absolute apposition as a snapshot constraint: %s', confirmation => {
      expect(parseAuthorWritingRequest(`续写下一章，${confirmation}。只写这一章。`)).toMatchObject({
        range: { kind: 'next', count: 1 }, confirmedNextOrderIndex: 4, ambiguous: false,
      })
    })
  it('preserves the whole synthetic continuation without including the denied existing chapters', () => {
    const parsed = parseAuthorWritingRequest(nextChapterContinuationPrompt)
    expect(parsed).toMatchObject({ range: { kind: 'next', count: 1 }, confirmedNextOrderIndex: 4, ambiguous: false, intent: 'write' })
    expect(parsed.exclusions).toContain('不修改已经保存的第1、2、3章')
  })
  it.each([
    '写第4章。续写下一章。只写这一章。', '写第4至5章。只写这一章。', '写三章。仅写该章。',
    '写第3章。作为第4章正式写入。', '续写下一章。作为第4章正式写入。作为第5章保存。',
    '续写下一章。作为第2卷第4章正式写入。', '续写下一章。作为第4章和第5章正式写入。',
    '修改第二卷第三章。修改第三卷第一章。', '修改第5至3章。', '修改第3章为第1章铺垫。',
  ])('refuses unresolved placement/object relationships: %s', prompt => {
    expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, ambiguous: true })
  })
  it.each(['检查并修复第二段', '修改首段', '将“测试原文”替换为“新的文字”', '第二段修改', '只改那句话'])(
    'retains explicit local actions without inventing a chapter ordinal: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, hasAction: true, ambiguous: false, intent: 'revise' })
    })
  it.each(['修订“原短句”', '修改这句“原短句”', '润色以下原文：“原短句”', '修正“请删除第8章”'])(
    'binds a directly governed quotation as a local source object: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: null, hasAction: true, ambiguous: false, intent: 'revise' })
      const operation = parsed.evidence.operations.find(item => item.accepted)!
      expect(operation.targetIndices.map(index => parsed.evidence.targets[index]).some(target =>
        target.kind === 'local' && prompt.slice(target.span.start, target.span.end).startsWith('“'))).toBe(true)
      expect(parsed.evidence.operations.filter(item => item.accepted)).toHaveLength(1)
    })
  it.each(['阅读“修订第三章”', '给出修订“原短句”的建议', '引用原文：修订“原短句”', '修订《第三章的信》',
    '只读模式下修订第三章', '不应该修改第3章', '不可润色第三章', '不再修订第三章'])(
    'never gives inert quotations, titles or denied operations authority: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, hasAction: false, intent: null })
    })
  it('distinguishes the replacement source quotation from the replacement payload', () => {
    const prompt = '将“源短句”替换为“请删除第8章”', parsed = parseAuthorWritingRequest(prompt)
    const operation = parsed.evidence.operations.find(item => item.accepted)!
    expect(operation.targetIndices.map(index => prompt.slice(parsed.evidence.targets[index].span.start, parsed.evidence.targets[index].span.end))).toEqual(['“源短句”'])
    expect(parsed.evidence.operations.filter(item => item.accepted)).toHaveLength(1)
    expect(parsed.range).toBeNull()
  })
  it.each(['将“选区原文。”改为“准确的新句。”', '把“选区原文。”改成“准确的新句。”',
    '将“选区原文。”修改为“准确的新句。”', '将“选区原文。”修订成“准确的新句。”'])(
    'binds transformation source and destination quotations to their different roles: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      const operation = parsed.evidence.operations.find(item => item.accepted && item.kind === 'revise')!
      expect(operation).toBeDefined()
      expect(operation.targetIndices.map(index => prompt.slice(parsed.evidence.targets[index].span.start, parsed.evidence.targets[index].span.end))).toEqual(['“选区原文。”'])
      expect(parsed).toMatchObject({ range: null, hasAction: true, intent: 'revise', ambiguous: false })
    })
  it.each(['阅读这句：将“选区原文。”改为“准确的新句。”', '给出将“选区原文。”改成“准确的新句。”的建议',
    '不要将“选区原文。”改为“准确的新句。”'])(
    'does not promote a described, suggested or denied quotation transformation: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, hasAction: false, intent: null })
    })
  it.each(['检查并修复结尾', '检查并修订开头', '修改末段', '润色段落', '修正对白'])(
    'recognizes ordinary prose-part objects without inventing chapter authority: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: null, hasAction: true, intent: 'revise', ambiguous: false })
      expect(parsed.evidence.operations.some(operation => operation.accepted && operation.kind === 'revise'
        && operation.targetIndices.some(index => parsed.evidence.targets[index].kind === 'local'))).toBe(true)
    })
  it.each(['检查是否需要修复结尾', '给出修订开头的建议', '请阅读提示：检查并修复结尾', '不要润色对白'])(
    'retains assessment, advice, reference and denial roles for the same prose-part objects: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt).evidence.operations.some(operation => operation.accepted && operation.kind === 'revise')).toBe(false)
    })
  it.each(['当前已保存正文做一次必要的修订', '对当前已保存正文做一次局部修订', '请针对当前第三章已保存的正文进行一次必要修订',
    '本次给第三章现有草稿做一次局部修订', '第三章的现有草稿做一次修订', '把第三章当前已保存正文做一次修订'])(
    'binds an object and an operation through modifiers, without a prefix whitelist: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ ambiguous: false, hasAction: true, intent: 'revise' })
      if (prompt.includes('三')) expect(parsed.range).toEqual({ kind: 'range', start: 3, count: 1 })
      else expect(parsed.range).toBeNull()
    })
  it.each(['完成第三章的连续性检查', '对第三章当前已保存正文做一次人类感和连续性检查', '完成当前第三章正文的人类感检查',
    '检查第三章正文', '把第三章的检查完成'])(
    'treats completion of a check as review rather than a prose mutation: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: { kind: 'range', start: 3, count: 1 }, intent: 'review', hasAction: true, ambiguous: false })
      expect(parsed.evidence.operations.filter(operation => operation.accepted).every(operation => operation.kind === 'review')).toBe(true)
    })
  it.each([
    ['完成第三章的连续性检查并修订第五章正文', 5],
    ['修订第五章正文并完成第三章的连续性检查', 5],
    ['完成第三章的连续性检查并修订正文', 3],
    ['修订第三章正文并完成连续性检查', 3],
    ['修订并检查第三章', 3],
  ])('binds review and revision independently in either order: %s', (prompt, ordinal) => {
    const parsed = parseAuthorWritingRequest(prompt as string)
    expect(parsed).toMatchObject({ range: { kind: 'range', start: ordinal, count: 1 }, intent: 'revise', ambiguous: false })
    expect(parsed.evidence.operations.some(operation => operation.kind === 'review' && operation.accepted)).toBe(true)
    expect(parsed.evidence.operations.some(operation => operation.kind === 'write' && operation.accepted)).toBe(false)
  })
  it.each(['完成第三章修订检查', '对第三章做修订检查'])(
    'keeps a revision named as the subject of a check as review: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'range', start: 3, count: 1 }, intent: 'review', ambiguous: false })
    })
  it.each(['只续写下一章，不修改已经保存的第1章，完成质量与连续性检查并按必要性修订复检。',
    '写下一章，按需修订复检。', '续写下一章。检查后按需要修订复检。'])(
    'keeps conditional execution instructions distinct from an assessment question: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: { kind: 'next', count: 1 }, intent: 'write', ambiguous: false })
      expect(parsed.evidence.operations.some(operation => operation.accepted && operation.kind === 'revise')).toBe(true)
    })
  it.each(['检查是否需要按必要性修订第3章正文', '只检查按必要性修订第3章是否有必要',
    'Check whether if necessary revise chapter 3'])(
    'does not let an execution modifier escape an enclosing assessment: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt).evidence.operations.some(operation => operation.accepted && operation.kind === 'revise')).toBe(false)
    })
  it('keeps a short scene and its completion instruction free of any chapter selector', () => {
    const parsed = parseAuthorWritingRequest(shortSceneRequest)
    expect(parsed).toMatchObject({ range: null, ambiguous: false, intent: 'write', hasAction: true })
    expect(parsed.evidence.operations.filter(operation => operation.accepted).flatMap(operation => operation.targetIndices)
      .some(index => parsed.evidence.targets[index].range !== null)).toBe(false)
    // A write to a prose part is not a local revision grant. Empty-book
    // placement clarification must be decided by the fresh freeze consumer.
    expect(parsed.evidence.operations.some(operation => operation.accepted && operation.kind === 'revise')).toBe(false)
  })
  it.each([
    '检查是否需要修改第二段', '只检查第3章是否需要修订正文', '检查第3章需不需要修订正文',
    '看看需不需要润色第二段', '判断修改第二段有没有必要', '检视第3章是否需要修订正文',
    '评估第3章有没有必要修改正文', '分析第3章有无必要修订正文', '检查修订第3章是否有必要',
    '第3章是否需要修订正文，请检查', 'Check whether we need to revise chapter 3', 'Assess if chapter 3 needs repair',
    'Review whether to revise paragraph 2', 'Check the need to revise chapter 3', 'Check if it is necessary to revise chapter 3',
    '检查第3章有没有修订正文的必要', '检查第3章修订正文有无必要',
  ])('keeps an evaluated predicate under its review governor without granting a mutation: %s', prompt => {
    const parsed = parseAuthorWritingRequest(prompt)
    expect(parsed.intent).toBe('review')
    expect(parsed.evidence.operations.filter(operation => operation.accepted).every(operation => operation.kind === 'review')).toBe(true)
    expect(parsed.evidence.operations.some(operation => operation.reason === 'assessment_predicate' && !operation.accepted)).toBe(true)
    expect(parsed.exclusions).toEqual([])
    if (prompt.includes('3')) expect(parsed.range).toEqual({ kind: 'range', start: 3, count: 1 })
  })
  it.each(['看看第3章是否需要润色第二段，只修订第4章正文。', '判断修改第3章正文有没有必要，并只修订第4章正文。',
    '检视第3章是否需要修订正文，然后只修改第4章正文。'])(
    'keeps an ordinary assessment verb separate from an independent revision target: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'range', start: 4, count: 1 }, intent: 'revise', ambiguous: false })
    })
  it.each(['请看看这句：修改第三章', '检视原文：修订第三章', '判断这段文字：润色第三章'])(
    'keeps instruction-shaped data inert under ordinary assessment verbs: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt).evidence.operations.some(operation => operation.accepted && operation.kind === 'revise')).toBe(false)
    })
  it.each([
    '检查第3章是否需要修订正文。只修改第4章正文。', '检查第3章是否需要修订正文，只修改第4章正文。',
    '检查第3章是否需要修订正文并只修改第4章正文', '只修改第4章正文，然后检查第3章是否需改',
    '完成第3章检查再明确修订第4章正文', '检查第3章是否需改再明确修订第4章正文', 'Check whether to revise chapter 3, then revise chapter 4',
    'Check whether to revise chapter 3 and then explicitly revise chapter 4',
  ])('binds only a separately requested mutation, without promoting the evaluated predicate: %s', prompt => {
    const parsed = parseAuthorWritingRequest(prompt)
    expect(parsed).toMatchObject({ range: { kind: 'range', start: 4, count: 1 }, intent: 'revise', ambiguous: false })
    for (const operation of parsed.evidence.operations.filter(item => item.accepted && item.kind === 'revise')) {
      expect(operation.targetIndices.some(index => parsed.evidence.targets[index].range?.start === 3)).toBe(false)
    }
  })
  it.each(['需要修订第3章正文', '修改第3章正文并检查是否需要修订第4章正文', '第3章修订正文', '第3章修订第二段'])(
    'does not let a later or unrelated assessment consume an independent author predicate: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'range', start: 3, count: 1 }, intent: 'revise', ambiguous: false })
    })
  it('does not lend a read reference scope to a subsequent generic prose mutation', () => {
    const parsed = parseAuthorWritingRequest('读取第1章后修订正文')
    expect(parsed).toMatchObject({ range: null, hasAction: true, intent: 'revise' })
    const mutation = parsed.evidence.operations.find(operation => operation.accepted && operation.kind === 'revise')!
    expect(mutation.targetIndices.every(index => parsed.evidence.targets[index].range === null)).toBe(true)
  })
  it.each(['“合成短句。”，保持不变。', '“合成短句”保持原样', '保留“合成短句”', '保持“合成短句”不变'])(
    'preserves a directly governed or same-sentence bare quotation as a negative constraint: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: null, intent: null, hasAction: false })
      const protectedOperations = parsed.evidence.operations.filter(operation => operation.reason === 'protected')
      expect(protectedOperations.length).toBeGreaterThan(0)
      expect(protectedOperations.every(operation => operation.kind === 'revise' && operation.polarity === 'negative' && !operation.accepted)).toBe(true)
      expect(protectedOperations.some(operation => operation.targetIndices.some(index =>
        prompt.slice(parsed.evidence.targets[index].span.start, parsed.evidence.targets[index].span.end).startsWith('“合成短句')))).toBe(true)
    })
  it('retains a quotation-only clause without turning its payload or a later constraint into authority', () => {
    const prompt = '“修订第3章。”，保持不变。', parsed = parseAuthorWritingRequest(prompt)
    expect(parsed.evidence.clauses).toHaveLength(2)
    expect(parsed.evidence.clauses[0].masked.trim()).toBe('')
    expect(parsed.evidence.clauses[0].sentence).toBe(parsed.evidence.clauses[1].sentence)
    expect(parsed).toMatchObject({ range: null, intent: null, hasAction: false })
    const separate = parseAuthorWritingRequest('“合成短句”。保持不变。')
    expect(separate.evidence.operations.flatMap(operation => operation.targetIndices)).toEqual([])
    expect(parseAuthorWritingRequest('“修订第3章”')).toMatchObject({ range: null, hasAction: false })
  })
  it.each(['\n', '。', '；'])('does not carry a reading scope across a hard boundary: %s', boundary => {
    expect(parseAuthorWritingRequest(`先通读全书${boundary}仅修改第3章。`)).toMatchObject({ range: { kind: 'range', start: 3, count: 1 }, intent: 'revise' })
  })
  it('merges only independent absolute effects in one volume', () => {
    expect(parseAuthorWritingRequest('修改第3章。修正第5章。读取第一章。').range).toEqual({ kind: 'list', positions: [3, 5] })
    expect(parseAuthorWritingRequest('修改第二卷第三章。修订第二卷第五章。').range).toEqual({ kind: 'list', positions: [3, 5], volume: 2 })
    expect(parseAuthorWritingRequest('修改第1、3章').range).toEqual({ kind: 'list', positions: [1, 3] })
    expect(parseAuthorWritingRequest('写下一章，按必要性修订复检')).toMatchObject({ range: { kind: 'next', count: 1 }, intent: 'write' })
  })
  it.each(['全书统一修改人名', '批量替换所有章节的称呼', '对所有章节，修改主角姓名。', '全书统一，把主角姓名修改为合成人物。'])(
    'keeps the global manuscript object connected to its real revision: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: { kind: 'existing', start: 1 }, intent: 'revise', hasAction: true })
    })
  it('does not let negation jump from one operation to another', () => {
    expect(parseAuthorWritingRequest('全书，不要统一修改，续写下一章。')).toMatchObject({ range: { kind: 'next', count: 1 }, intent: 'write', ambiguous: false })
    const parsed = parseAuthorWritingRequest('修改第1至3章。不修订第2章。不要跳过检查第1章。')
    expect(parsed.range).toEqual({ kind: 'range', start: 1, count: 3 })
    expect(parsed.exclusions).toEqual(['不修订第2章'])
    expect(parseAuthorWritingExclusion(parsed.exclusions[0])).toEqual({ kind: 'range', start: 2, count: 1 })
    expect(parseAuthorWritingExclusion('不动第2章')).toEqual({ kind: 'range', start: 2, count: 1 })
    expect(parseAuthorWritingExclusion('不修改第1、2、3章')).toEqual({ kind: 'list', positions: [1, 2, 3] })
    expect(parseAuthorWritingExclusion('引用原文：不修改第3章')).toBeNull()
    expect(parseAuthorWritingExclusion('不改第1章和任何正文')).toBeNull()
    expect(parseAuthorWritingExclusion('不改第1章或本章')).toBeNull()
  })
  it.each(['不要再修改第3章', '不能再修订第3章', '请勿修改第3章', '无须修改第3章', '不得再次局部修订第3章',
    'Never again edit chapter 3', "don't again revise chapter 3", 'Do not repeatedly revise chapter 3'])(
    'keeps negation attached through its own adverbs: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: null, hasAction: false, intent: null })
      expect(parsed.evidence.operations.some(operation => operation.kind === 'revise' && operation.polarity === 'negative'
        && operation.reason === 'negated' && !operation.accepted)).toBe(true)
      expect(parseAuthorWritingExclusion(prompt)).toEqual({ kind: 'range', start: 3, count: 1 })
    })
  it.each(['不要再修改第3章，但修订第4章正文', '不能再修订第3章。请修改第4章正文',
    "don't again revise chapter 3 and then revise chapter 4"])(
    'keeps an independently coordinated operation affirmative after a negative predicate: %s', prompt => {
      const parsed = parseAuthorWritingRequest(prompt)
      expect(parsed).toMatchObject({ range: { kind: 'range', start: 4, count: 1 }, intent: 'revise', ambiguous: false })
      expect(parsed.evidence.operations.some(operation => operation.polarity === 'negative' && operation.reason === 'negated')).toBe(true)
    })
  it('retains a genuine negative predicate without an object for frozen same-request conflict handling', () => {
    const parsed = parseAuthorWritingRequest('修订第3章正文。不得修改。')
    expect(parsed.range).toEqual({ kind: 'range', start: 3, count: 1 })
    expect(parsed.exclusions).toEqual(['不得修改'])
    expect(parsed.evidence.operations.find(operation => operation.polarity === 'negative')).toMatchObject({
      kind: 'revise', reason: 'negated', accepted: false, targetIndices: [],
    })
    expect(parseAuthorWritingExclusion('不得修改')).toBeNull()
    expect(parseAuthorWritingRequest('检查是否不应修订第三章').exclusions).toEqual([])
  })
  it.each(['修改第0章', '写一千零一章', '修改前1001章', '修改第1至1001章', '修改第9007199254740992章'])(
    'rejects invalid or over-quota targets without truncation: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, ambiguous: true })
    })
  it('keeps high safe ordinals separate from the bounded quantity budget', () => {
    expect(parseAuthorWritingRequest('修订第1500章').range).toEqual({ kind: 'range', start: 1500, count: 1 })
    expect(parseAuthorWritingRequest('修订第一千零一章').range).toEqual({ kind: 'range', start: 1001, count: 1 })
    expect(parseAuthorWritingRequest('修订第1500卷第2500章').range).toEqual({ kind: 'range', start: 2500, count: 1, volume: 1500 })
    expect(parseAuthorWritingRequest('修订第1500至2499章').range).toEqual({ kind: 'range', start: 1500, count: 1000 })
    expect(parseAuthorWritingRequest('修订第1500至2500章')).toMatchObject({ range: null, ambiguous: true })
    expect(parseAuthorWritingRequest('续写下一章。作为第1500章正式写入。')).toMatchObject({
      range: { kind: 'next', count: 1 }, confirmedNextOrderIndex: 1500, ambiguous: false,
    })
    const list = Array.from({ length: 1001 }, (_, index) => index + 1500).join('、')
    expect(parseAuthorWritingRequest(`修订第${list}章`)).toMatchObject({ range: null, ambiguous: true })
  })
  it('accepts bounded numeric ranges, counts and autonomous serialization', () => {
    expect(parseAuthorWritingRequest('修改第1000章').range).toEqual({ kind: 'range', start: 1000, count: 1 })
    expect(parseAuthorWritingRequest('写三章').range).toEqual({ kind: 'count', count: 3 })
    expect(parseAuthorWritingRequest('修改前两章').range).toEqual({ kind: 'range', start: 1, count: 2 })
    expect(parseAuthorWritingRequest('授权自主创作全书，并修改已有章节及卷章结构。').range).toEqual({ kind: 'unbounded' })
  })
  it('retains exact quote, clause, operation and target UTF-16 source positions', () => {
    const prompt = '请修改第三章《第二章的信》。引用：“写第一章。\n删除第二章！”；😀对当前正文做一次修订。'
    const lexical = lexAuthorWritingRequest(prompt), parsed = parseAuthorWritingRequest(prompt)
    expect(lexical.masked.length).toBe(prompt.length)
    expect(lexical.quoted.map(quote => prompt.slice(quote.start, quote.end))).toEqual(['《第二章的信》', '“写第一章。\n删除第二章！”'])
    expect(lexical.clauses).toHaveLength(3)
    for (const clause of lexical.clauses) expect(clause.text).toBe(prompt.slice(clause.start, clause.end))
    expect(parsed.evidence.operations.filter(operation => operation.accepted).map(operation => prompt.slice(operation.span.start, operation.span.end))).toEqual(['修改', '修订'])
    expect(parsed.range).toEqual({ kind: 'range', start: 3, count: 1 })
  })
  it.each(['"外层\\"修订第3章\\"引文"', "'修订第3章'", '“外层“修订第3章”引文”', "don't edit chapter 3"])(
    'keeps escaped, nested and ASCII quotation data inert: %s', prompt => {
      expect(parseAuthorWritingRequest(prompt)).toMatchObject({ range: null, hasAction: false, intent: null })
    })
  it('rejects operation overflow explicitly without persisting an oversized or partial grant', () => {
    const bounded = parseAuthorWritingRequest('修订第3章。'.repeat(1000))
    expect(bounded).toMatchObject({ range: { kind: 'range', start: 3, count: 1 }, ambiguous: false, hasAction: true })
    expect(bounded.evidence.operations).toHaveLength(1000)
    for (const prompt of ['修订第3章。'.repeat(1001), '作为第4章保存。'.repeat(1001)]) {
      const overflow = parseAuthorWritingRequest(prompt)
      expect(overflow).toMatchObject({ range: null, ambiguous: true, hasAction: false, intent: null, reasons: ['operation_limit'] })
      expect(overflow.evidence.operations).toHaveLength(0)
      expect(parseAuthorWritingExclusion('不修订第3章。'.repeat(1001))).toBeNull()
    }
  })
  it('is deterministic across repeated calls, intervening overflows and different operation orderings', () => {
    const prompts = ['对第3章，修订正文。', '完成第3章的检查并修订正文', '读取前两章。只改第3章', '不修订第2章，写下一章。']
    const expected = prompts.map(parseAuthorWritingRequest)
    parseAuthorWritingRequest('修订第3章。'.repeat(1001))
    for (let repeat = 0; repeat < 10; repeat++) {
      for (const [index, prompt] of [...prompts.entries()].reverse()) expect(parseAuthorWritingRequest(prompt)).toEqual(expected[index])
    }
  })
  it('keeps an unterminated quoted payload inert and handles long non-action prefixes without recursive matching', () => {
    expect(parseAuthorWritingRequest('请阅读：“修改第3章')).toMatchObject({ hasAction: false, range: null })
    expect(parseAuthorWritingRequest('请你'.repeat(2000) + '说明修改第3章')).toMatchObject({ hasAction: false, range: null })
    expect(parseAuthorWritingRequest('当前章节'.repeat(2000) + '中人物修改日期')).toMatchObject({ hasAction: false, range: null })
  })
})
