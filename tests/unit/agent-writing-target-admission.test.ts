import { chapterRevisionPrompt } from '../support/writing-target-prompt.js'
import { describe, expect, it } from 'vitest'
import { parseWritingTargets, requestedWritingRange } from '../../api/lib/agent/writing-target-admission.js'
import { legacyWritingRange } from '../../api/lib/agent/writing-target-range.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { chapterRevisionAuthorityText, prohibitsNewDraftRevision } from '../../api/lib/agent/writing-scope.js'

describe('fresh action-bound chapter targets', () => {
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
