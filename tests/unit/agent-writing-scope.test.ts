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
  ])('extracts exact original range: %s', (prompt, expected) => expect(requestedWritingRange(prompt)).toEqual(expected))
  it('uses the full original prompt after the legacy goals truncation boundary', () => {
    expect(requestedWritingRange('背景资料'.repeat(300) + '。请写第十九章')).toEqual({ kind: 'range', start: 19, count: 1 })
    expect(chapterNumber('一百二十三')).toBe(123)
    expect(requestedWritingRange('不要写下一章，只审阅现有正文')).toBeNull()
    expect(requestedWritingRange('不要在当前章之后写下一章。请写下一章')).toEqual({ kind: 'next', count: 1 })
    expect(requestedWritingRange('参考当前章节，写下一章')).toEqual({ kind: 'next', count: 1 })
  })
  it('does not treat writing or checking as permission to repair prose', () => {
    expect(hasOriginalRepairAuthority('写第一章，检查结尾但不要改写')).toBe(false)
    expect(hasOriginalRepairAuthority('审阅这章并列出问题')).toBe(false)
    expect(hasOriginalRepairAuthority('检查并修复当前章节事实错误')).toBe(true)
  })
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
