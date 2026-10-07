import { describe, expect, it } from 'vitest'
import { requestedWritingRange, chapterNumber, questionExpandsWritingScope, allowsChapterOnlyCompletion } from '../../api/lib/agent/writing-scope.js'
import { hasOriginalRepairAuthority } from '../../api/lib/agent/original-request.js'

describe('original writing authority', () => {
  it.each([
    ['写第一章，只要标题和正文', { kind: 'first', start: 1, count: 1 }],
    ['写下一章', { kind: 'next', count: 1 }],
    ['在当前这章之后写下一章', { kind: 'next', count: 1, anchor: 'editor' }],
    ['在正在编辑的章节后写下一章', { kind: 'next', count: 1, anchor: 'editor' }],
    ['Write the next chapter after the current chapter', { kind: 'next', count: 1, anchor: 'editor' }],
    ['写第3至5章', { kind: 'range', start: 3, count: 3 }],
    ['先写前两章', { kind: 'range', start: 1, count: 2 }],
    ['写三章', { kind: 'count', count: 3 }],
    ['续写第二卷第三章', { kind: 'range', start: 3, count: 1, volume: 2 }],
    ['前 20 章优化', { kind: 'range', start: 1, count: 20 }],
    ['接着写第 189 章', { kind: 'range', start: 189, count: 1 }],
    ['把189章写完', { kind: 'range', start: 189, count: 1 }],
    ['写第146—188章', { kind: 'range', start: 146, count: 43 }],
    ['第71、72章是空壳的问题帮我解决', { kind: 'list', positions: [71, 72] }],
    ['优化第150、161章', { kind: 'list', positions: [150, 161] }],
    ['修改第七十一、七十二章', { kind: 'list', positions: [71, 72] }],
    ['修复第一百零五章和第一百零七章', { kind: 'list', positions: [105, 107] }],
    ['修改第71,72章', { kind: 'list', positions: [71, 72] }],
    ['修改第71，72章', { kind: 'list', positions: [71, 72] }],
    ['修改第71章， 第72章', { kind: 'list', positions: [71, 72] }],
    ['修改第71 , 72章', { kind: 'list', positions: [71, 72] }],
    ['修改第71章及第72章与第75章', { kind: 'list', positions: [71, 72, 75] }],
    ['修改第71、71、72章', { kind: 'list', positions: [71, 72] }],
    ['你这样吧，开始从第一章改，一直到最后，检查剧情连贯性', { kind: 'existing', start: 1 }],
    ['从第一章检查到最后一章', { kind: 'existing', start: 1 }],
    ['审查优化全书', { kind: 'existing', start: 1 }],
    ['审查优化第二卷', { kind: 'existing', start: 1, volume: 2 }],
    ['修改第二卷第3至5章', { kind: 'range', start: 3, count: 3, volume: 2 }],
    ['修改第二卷第3、5章', { kind: 'list', positions: [3, 5], volume: 2 }],
    ['修改全书中第二卷第三章', { kind: 'range', start: 3, count: 1, volume: 2 }],
    ['修改第71章和72个问题', { kind: 'range', start: 71, count: 1 }],
    ['自主完成全书', { kind: 'unbounded' }],
    ['自动写完全书并检查', { kind: 'unbounded' }],
    ['自动从第一章改到最后', { kind: 'existing', start: 1 }],
    ['分别修改第71、72章', { kind: 'list', positions: [71, 72] }],
  ])('extracts exact original range: %s', (prompt, expected) => expect(requestedWritingRange(prompt)).toEqual(expected))
  it('uses the full original prompt after the legacy goals truncation boundary', () => {
    expect(requestedWritingRange('背景资料'.repeat(300) + '。请写第十九章')).toEqual({ kind: 'range', start: 19, count: 1 })
    expect(chapterNumber('一百二十三')).toBe(123)
    expect(requestedWritingRange('不要写下一章，只审阅现有正文')).toBeNull()
    expect(requestedWritingRange('不要在当前章之后写下一章。请写下一章')).toEqual({ kind: 'next', count: 1 })
    expect(requestedWritingRange('参考当前章节，写下一章')).toEqual({ kind: 'next', count: 1 })
    expect(requestedWritingRange('不要改第71,72章。请改第73章')).toEqual({ kind: 'range', start: 73, count: 1 })
    expect(requestedWritingRange('别修改第71、72章')).toBeNull()
    expect(requestedWritingRange('不要改第71 , 72章修改')).toBeNull()
    expect(requestedWritingRange('不要改第71章，第72章修改')).toBeNull()
    expect(requestedWritingRange('修改第73至71章')).toBeNull()
    expect(requestedWritingRange('写第二卷')).toBeNull()
    expect(requestedWritingRange('从第一章写一直到最后')).toBeNull()
    expect(requestedWritingRange('修改第二卷第一章和第三卷第一章')).toBeNull()
  })
  it('does not treat writing or checking as permission to repair prose', () => {
    expect(hasOriginalRepairAuthority('写第一章，检查结尾但不要改写')).toBe(false)
    expect(hasOriginalRepairAuthority('审阅这章并列出问题')).toBe(false)
    expect(hasOriginalRepairAuthority('检查并修复当前章节事实错误')).toBe(true)
  })
  it.each(['开始从第一章改，一直到最后，检查剧情连贯性', '审查优化第71、72章', '第71、72章是空壳的问题帮我解决', '请改第七十一章', '修复第71章并给出修改报告', '按优化建议直接修复第71章', '分别修改第71、72章'])(
    'recognizes explicit original repair requests: %s', prompt => expect(hasOriginalRepairAuthority(prompt)).toBe(true))
  it.each(['只读检查第71、72章', '别优化第71、72章', '不修改第71章', '如何优化第71章', '下一步应该做什么', '其他的我都听你的', 'read-only review; do not fix prose', '审查第71章，给出优化建议', '提供第71章修改方案', '不要改第71章，第72章修改'])(
    'does not manufacture repair authorization: %s', prompt => expect(hasOriginalRepairAuthority(prompt)).toBe(false))
  it('finishes only the complete original chapter contract, including explicitly requested other artifacts', () => {
    expect(allowsChapterOnlyCompletion('写第一章，只要标题和正文，不要封面')).toBe(true)
    expect(allowsChapterOnlyCompletion('写第一章，只要标题和正文，并生成封面')).toBe(false)
    expect(allowsChapterOnlyCompletion('写第一章，然后检查正文质量')).toBe(false)
    expect(allowsChapterOnlyCompletion('写第一章，顺便写首诗')).toBe(false)
    expect(allowsChapterOnlyCompletion('写第一章，只输出标题正文，另写首诗')).toBe(false)
    expect(allowsChapterOnlyCompletion('下一章需要什么设定？')).toBe(false)
  })
  it('rejects scope expansion hidden inside a model-generated option detail', () => {
    const writing = { version: 1 as const, kind: 'bounded' as const, targets: [{ orderIndex: 1, chapterId: null }], titleAndBodyOnly: true, repairAuthorized: false }
    expect(questionExpandsWritingScope('需要封面吗？', [{ label: '暂时不用', detail: '先继续推进第二章正文，封面后续再补' }], writing, '写第一章，只要标题和正文')).toBe(true)
    expect(questionExpandsWritingScope('需要封面吗？', [{ label: '生成封面' }], writing, '写第一章，不要封面')).toBe(true)
    expect(questionExpandsWritingScope('本章人物选择哪个行动？', [{ label: '留在门外' }, { label: '推门进入' }], writing, '写第一章')).toBe(false)
  })
  it('leaves chapter wording in author questions to the execution guard', () => {
    const writing = { version: 1 as const, kind: 'bounded' as const, targets: [{ orderIndex: 1, chapterId: null }], titleAndBodyOnly: true, repairAuthorized: false }
    expect(questionExpandsWritingScope('可以继续写第二章吗？', [{ label: '继续写第二章' }], writing, '写第一章')).toBe(false)
    expect(questionExpandsWritingScope('需要封面吗？', [{ label: '生成封面' }], writing, '写第一章')).toBe(true)
  })
})
