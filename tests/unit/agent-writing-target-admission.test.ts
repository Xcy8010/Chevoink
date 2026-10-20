import { chapterRevisionPrompt, nextChapterContinuationPrompt } from '../support/writing-target-prompt.js'
import { describe, expect, it } from 'vitest'
import { parseWritingTargets, requestedWritingRange } from '../../api/lib/agent/writing-target-admission.js'
import { legacyWritingRange } from '../../api/lib/agent/writing-target-range.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { chapterRevisionAuthorityText, prohibitsNewDraftRevision } from '../../api/lib/agent/writing-scope.js'

describe('fresh action-bound chapter targets', () => {
  it.each([
    '续写下一章，只写这一章。',
    '写下一章。仅续写该章。',
    '写下一章。只完成本章正文。',
  ])('keeps a same-chapter restriction from becoming another counted grant: %s', prompt => {
    expect(parseWritingTargets(prompt)).toMatchObject({ range: { kind: 'next', count: 1 }, ambiguous: false })
  })
  it.each(['作为第4章正式写入', '作为第四章保存', '作为全书第4章落稿'])(
    'retains an appositive ordinal for admission snapshot verification: %s', confirmation => {
      expect(parseWritingTargets(`续写下一章，${confirmation}。只写这一章。`)).toMatchObject({
        range: { kind: 'next', count: 1 }, confirmedNextOrderIndex: 4, ambiguous: false,
      })
    })
  it('retains the complete synthetic continuation contract and prior-chapter exclusions', () => {
    expect(parseWritingTargets(nextChapterContinuationPrompt)).toMatchObject({ range: { kind: 'next', count: 1 },
      confirmedNextOrderIndex: 4, ambiguous: false, exclusions: ['不修改已经保存的第1、2、3章'] })
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: nextChapterContinuationPrompt }).intent).toBe('write')
    expect(parseWritingTargets('修改第4章。只写这一章。')).toMatchObject({ range: { kind: 'range', start: 4, count: 1 }, ambiguous: false })
    expect(parseWritingTargets('只写这一章')).toMatchObject({ range: null, ambiguous: false, hasAction: true })
    expect(legacyWritingRange('续写下一章，只写这一章')).toEqual({ kind: 'next', count: 1 })
  })
  it.each(['不批量修改前文', '不要统一替换所有章节', '不全局改名'])(
    'does not turn denied global work into the continuation intent: %s', denied => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: `续写下一章。${denied}。完成连续性检查。` }).intent).toBe('write')
    })
  it.each(['全书统一修改人名', '批量替换所有章节的称呼', '全局改名'])(
    'retains affirmative global transformation intent: %s', prompt => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).intent).toBe('global_transform')
    })
  it.each(['对所有章节，修改主角姓名。', '全书统一，把主角姓名修改为李明。'])(
    'preserves adjacent affirmative global scope/action and its changeset gate: %s', prompt => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt })).toMatchObject({ intent: 'global_transform',
        expectedOutputs: [{ kind: 'changeset' }], postconditions: [{ code: 'CHANGESET_VERIFIED' }] })
    })
  it.each([
    '续写下一章，只写这一章，不修改第1、2、3章。',
    '续写下一章，作为第四章保存。仅写该章，不修改已经保存的第1、2、3章。',
    '全书，不要统一修改，续写下一章。',
  ])('does not derive revision/global transformation from a denied effect: %s', prompt => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).intent).toBe('write')
  })
  it.each(['\n', '。', '；'])(
    'keeps a reading scope across a hard boundary out of the later mutation: %s', boundary => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: `先通读全书${boundary}仅修改第3章。` }))
        .toMatchObject({ intent: 'revise', expectedOutputs: [{ kind: 'text' }], postconditions: [] })
    })
  it.each([
    '写第4章。续写下一章。只写这一章。',
    '写第4至5章。只写这一章。',
    '写三章。仅写该章。',
    '写第3章。作为第4章正式写入。',
    '续写下一章。作为第4章正式写入。作为第5章保存。',
    '续写下一章。作为第2卷第4章正式写入。',
    '续写下一章。作为第4章和第5章正式写入。',
  ])('rejects independent, conflicting or unsupported placement constraints: %s', prompt => {
    expect(parseWritingTargets(prompt)).toMatchObject({ range: null, ambiguous: true })
  })
  it.each([
    '请读取这句：“续写下一章，只写这一章，作为第4章正式写入”。',
    '不要续写下一章，不要作为第4章正式写入。',
    '请阅读：作为第4章正式写入。',
  ])('never promotes quoted, reading or denied apposition into writing: %s', prompt => {
    expect(parseWritingTargets(prompt)).toMatchObject({ range: null, hasAction: false })
  })
  it.each([
    '仅修改第3章。请先读取前两章。不修改第1、2章。',
    '仅修改第3章。请先读取前两章。',
    '请先读取第1章。仅修改第3章。',
    '仅修改第3章。请先读取第1章。',
    '仅修改第3章，第1章提到一扇窗。',
    '仅修改第3章。先阅读前两章作为参考。',
    '仅修改第3章并核对第1章。',
    '修改第3章时参考第1章。',
    '修改第3章以呼应第1章。',
    '读取第1章后修改第3章。',
    '仅修改第3章。第1章却写“请修改第二章”。',
    '只修订第三章《第一章的信》。前两章已经写完。',
    '仅修正第三章的正文。不要跳过检查第1章。',
    '请修改：第三章。',
    chapterRevisionPrompt,
  ])('freezes only the explicitly revised chapter: %s', prompt => {
    expect(requestedWritingRange(prompt)).toEqual({ kind: 'range', start: 3, count: 1 })
  })
  it.each([
    '读取前两章',
    '参考第1章。第3章却写“修改第2章”。',
    '前两章已经写完。',
    '给出修改第3章的建议',
    '第1章提到如何修改第3章',
    '不要修改第1章，第2章修改',
    '“修改第1章”。读取第3章。',
    '第1章主角尝试修改日期。',
    '请阅读这句：修改当前章节。',
    '请读取这句文字：修改第3章。',
    '引用原文：修改第3章。',
    '请阅读提示：修改首段。',
  ])('does not convert context into a mutation range: %s', prompt => expect(requestedWritingRange(prompt)).toBeNull())
  it('retains separate effects, explicit exclusions, and ambiguous volume boundaries', () => {
    expect(requestedWritingRange('修改第3章。修正第5章。读取第一章。')).toEqual({ kind: 'list', positions: [3, 5] })
    expect(parseWritingTargets('修改第1至3章。不要修改第2章。不要跳过检查第1章。').exclusions).toEqual(['不要修改第2章'])
    expect(parseWritingTargets('修改第二卷第三章。修改第三卷第一章。')).toMatchObject({ range: null, ambiguous: true })
    expect(parseWritingTargets('修改第5至3章。')).toMatchObject({ range: null, ambiguous: true })
    expect(parseWritingTargets('修改第3章为第1章铺垫。')).toMatchObject({ range: null, ambiguous: true })
    expect(parseWritingTargets('修改第1至3章。不修订第2章。').exclusions).toEqual(['不修订第2章'])
    expect(parseWritingTargets('修改第1至3章。不动第2章。').exclusions).toEqual(['不动第2章'])
    expect(requestedWritingRange('只修订当前章节。读取前两章。')).toBeNull()
    expect(parseWritingTargets('只修订当前章节。读取前两章。')).toMatchObject({ hasAction: true, ambiguous: false })
    expect(parseWritingTargets('请阅读这句：修改当前章节。')).toMatchObject({ hasAction: false })
    expect(parseWritingTargets('请阅读提示：修改首段。')).toMatchObject({ hasAction: false })
  })
  it.each(['检查并修复第二段', '修改首段', '将“测试原文”替换为“新的文字”', '第二段修改', '只改那句话'])(
    'retains explicit local actions without using their locator as authority: %s',
    prompt => expect(parseWritingTargets(prompt)).toMatchObject({ hasAction: true, ambiguous: false }))
  it('keeps the historical lexical interpretation available without rewriting old contracts', () => {
    const prompt = '仅修改第3章。请先读取前两章。不修改第1、2章。'
    expect(legacyWritingRange(prompt)).toEqual({ kind: 'range', start: 1, count: 2 })
    expect(requestedWritingRange(prompt)).toEqual({ kind: 'range', start: 3, count: 1 })
  })
  it.each(['仅修订第3章并检查连续性', '仅修正第三章正文，检查后提交', '继续完成第3章，现明确授权本章正文修订与检查'])(
    'classifies explicit prose revision consistently: %s', prompt => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).intent).toBe('revise')
    })
  it('keeps next-chapter writing with subordinate necessary repair as writing', () => {
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '写下一章，按必要性修订复检' }).intent).toBe('write')
  })
  it.each(['写下一章，不修订前两章', '写下一章，不修正第2章', '写下一章并检查，不修正第2章'])(
    'does not classify forbidden revision as the requested effect: %s', prompt => {
      expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt }).intent).toBe('write')
    })
  it('keeps long non-action prefixes bounded without ambiguous repeated-token matching', () => {
    expect(parseWritingTargets('请你'.repeat(2000) + '说明修改第3章')).toMatchObject({ range: null, hasAction: false })
    expect(parseWritingTargets('当前章节'.repeat(2000) + '中人物修改日期')).toMatchObject({ range: null, hasAction: false })
  })
  it('applies numbered exclusions only to their frozen chapter at the revision guard', () => {
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: chapterRevisionPrompt })
    spec.scope.writingTargetProtocol = 1
    spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 3, chapterId: 'third' }],
      repairAuthorized: true, titleAndBodyOnly: false }
    expect(prohibitsNewDraftRevision(chapterRevisionPrompt)).toBe(true)
    expect(prohibitsNewDraftRevision(chapterRevisionAuthorityText(chapterRevisionPrompt, spec, 'third'))).toBe(false)
    for (const prompt of ['不改第3章', '不改正文', '不改第1章和任何正文', '不改第1章或本章', '不改第二卷第一章']) {
      expect(chapterRevisionAuthorityText(prompt, spec, 'third')).toBe(prompt)
      expect(prohibitsNewDraftRevision(chapterRevisionAuthorityText(prompt, spec, 'third'))).toBe(true)
    }
    // This helper must not reinterpret the historical relative-word classifier.
    const relative = '不改第1章或当前章'
    expect(chapterRevisionAuthorityText(relative, spec, 'third')).toBe(relative)
    expect(prohibitsNewDraftRevision(chapterRevisionAuthorityText(relative, spec, 'third'))).toBe(prohibitsNewDraftRevision(relative))
    expect(chapterRevisionAuthorityText('不改第1章', spec, 'unbound')).toBe('不改第1章')
    delete spec.scope.writingTargetProtocol
    expect(chapterRevisionAuthorityText(chapterRevisionPrompt, spec, 'third')).toBe(chapterRevisionPrompt)
  })
})
