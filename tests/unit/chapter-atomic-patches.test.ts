import { describe, expect, it } from 'vitest'
import { composeChapterEdit } from '../../api/lib/agent/tools/chapter-patches.js'
import { chapterEditArguments } from '../../api/lib/agent/tools/chapter-arguments.js'

describe('one immutable chapter patch batch', () => {
  const before = '甲门锁着。乙灯亮着。丙箱关着。'
  it('resolves all offsets before variable length composition and retains untouched text', () => {
    const result = composeChapterEdit(before, { patches: [{ oldText: '甲门锁着', newText: '甲门已经打开' }, { oldText: '乙灯亮着', newText: '乙灯熄了' }] })
    expect(result.after).toBe('甲门已经打开。乙灯熄了。丙箱关着。')
    expect(result.ranges).toEqual([{ start: 0, end: 4, newText: '甲门已经打开' }, { start: 5, end: 9, newText: '乙灯熄了' }])
    expect(before).toBe('甲门锁着。乙灯亮着。丙箱关着。')
  })
  it.each([
    [{ oldText: '甲门锁着', newText: '甲门开了' }, { oldText: '不存在', newText: '错误' }],
    [{ oldText: '甲门锁着', newText: '甲门开了' }, { oldText: '门锁着。乙灯', newText: '重叠' }],
    [{ oldText: '甲门锁着', newText: '甲门开了' }, { oldText: '甲门锁着', newText: '重复' }],
    [{ oldText: '', newText: '空锚点' }], [],
    Array.from({ length: 9 }, () => ({ oldText: '甲门锁着', newText: '超限' })),
  ].map(patches => ({ patches })))('rejects the entire invalid batch %j', ({ patches }) => {
    expect(() => composeChapterEdit(before, { patches })).toThrow(expect.objectContaining({ code: 'CHAPTER_ANCHOR_CONFLICT' }))
    expect(before).toBe('甲门锁着。乙灯亮着。丙箱关着。')
  })
  it('rejects overlapping repeated anchors, and mixed legacy parameters even outside schema admission', () => {
    expect(() => composeChapterEdit('aaaa', { patches: [{ oldText: 'aa', newText: 'x' }] })).toThrow()
    expect(() => composeChapterEdit(before, { patches: [{ oldText: '甲门锁着', newText: '开了' }], newText: '混用' })).toThrow()
    expect(() => composeChapterEdit(before, { start: 0, end: 100, newText: '越界' })).toThrow()
  })
  it('admits one legacy range or a bounded batch, never both, and recognizes a true no-op', () => {
    expect(chapterEditArguments.safeParse({ oldText: '甲门锁着', newText: '' }).success).toBe(true)
    expect(chapterEditArguments.safeParse({ patches: [{ oldText: '甲门锁着', newText: '甲门锁着' }] }).success).toBe(true)
    expect(chapterEditArguments.safeParse({ patches: [{ oldText: '甲门锁着', newText: '' }], start: 0, end: 4, newText: '' }).success).toBe(false)
    expect(composeChapterEdit(before, { patches: [{ oldText: '甲门锁着', newText: '甲门锁着' }] }).after).toBe(before)
  })
})
