import { describe, expect, it } from 'vitest'
import { composeChapterEdit } from '../../api/lib/agent/tools/chapter-patches.js'
import { chapterEditArguments } from '../../api/lib/agent/tools/chapter-arguments.js'

describe('one immutable chapter patch batch', () => {
  it('rejects all seven edits when only the third anchor changes punctuation, then accepts the corrected exact batch', () => {
    const fragments = ['甲门锁着。', '乙灯亮着。', '「请稍等。」', '丙窗关着。', '丁箱封着。', '戊轮停着。', '己阀闭着。']
    const original = fragments.join('\n\n')
    const patches = fragments.map((oldText, index) => ({ oldText, newText: `修订${index + 1}。` }))
    patches[2].oldText = '「请稍等」。'
    expect(() => composeChapterEdit(original, { patches })).toThrow(expect.objectContaining({ code: 'CHAPTER_ANCHOR_CONFLICT', message: expect.stringMatching(/第\s*3\s*处/u) }))
    expect(original).toBe(fragments.join('\n\n'))
    patches[2].oldText = fragments[2]
    expect(composeChapterEdit(original, { patches }).after).toBe(patches.map(item => item.newText).join('\n\n'))
  })
  const before = '甲门锁着。乙灯亮着。丙箱关着。'
  it('resolves all offsets before variable length composition and retains untouched text', () => {
    const result = composeChapterEdit(before, { patches: [{ oldText: '甲门锁着', newText: '甲门已经打开' }, { oldText: '乙灯亮着', newText: '乙灯熄了' }] })
    expect(result.after).toBe('甲门已经打开。乙灯熄了。丙箱关着。')
    expect(result.ranges).toEqual([{ start: 2, end: 4, newText: '已经打开' }, { start: 7, end: 9, newText: '熄了' }])
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
  it('locates a unique missing paragraph break while preserving all other characters and untouched prose', () => {
    const body = '天未亮。纸条有缺角。\r\n\r\n堡内老卫站着。老段被押。'
    const args = { patches: [{ oldText: '天未亮', newText: '天大亮后' },
      { oldText: '纸条有缺角。堡内老卫站着。', newText: '纸条仍有缺角。\n\n堡内老卫坐下。' },
      { oldText: '老段被押', newText: '老段仍被押' }] }
    expect(composeChapterEdit(body, args).after).toBe('天大亮后。纸条仍有缺角。\n\n堡内老卫坐下。老段仍被押。')
    expect(() => composeChapterEdit(body, args, 1)).toThrow(expect.objectContaining({ code: 'CHAPTER_ANCHOR_CONFLICT', message: expect.stringContaining('第 2 处') }))
  })
  it.each(['甲。\n乙。甲。\r\n乙。', '甲 。\n乙。', '甲。\n丙。'])('never guesses ambiguous, space or ordinary character differences in %s', body => {
    expect(() => composeChapterEdit(body, { oldText: '甲。乙。', newText: '改文' })).toThrow(expect.objectContaining({ code: 'CHAPTER_ANCHOR_CONFLICT' }))
  })
  it('keeps normalized ranges subject to atomic overlap and rejects whitespace-only anchors', () => {
    expect(() => composeChapterEdit('甲。\n\n乙。', { patches: [{ oldText: '甲。乙。', newText: '一' }, { oldText: '乙。', newText: '二' }] })).toThrow()
    expect(() => composeChapterEdit('甲。', { oldText: '\n\n', newText: '空白定位' })).toThrow()
  })
  it.each(['“向左走。”', '甲说：“向左走。”乙仍留在门前。'])(
    'separates a unique copied anchor from its actual changed effect: %s', oldText => {
      const body = '前段。甲说：“向左走。”乙仍留在门前。后段。'
      const result = composeChapterEdit(body, { oldText, newText: oldText.replace('左', '右') })
      expect(result.after).toBe(body.replace('左', '右'))
      expect(result.ranges).toEqual([{ start: body.indexOf('左'), end: body.indexOf('左') + 1, newText: '右' }])
    })
  it.each([
    ['原句', '原句补充', 2, 2, '补充'],
    ['原句', '请读原句', 0, 0, '请读'],
    ['原句', '原', 1, 2, ''],
    ['原😀句', '原😃句', 2, 3, '\ude03'],
  ] as const)('preserves composition for insertion, deletion and UTF-16 changes: %s → %s', (oldText, newText, start, end, text) => {
    const body = `前。${oldText}。后。`, offset = body.indexOf(oldText)
    const result = composeChapterEdit(body, { oldText, newText })
    expect(result.after).toBe(`前。${newText}。后。`)
    expect(result.ranges).toEqual([{ start: offset + start, end: offset + end, newText: text }])
    const range = result.ranges[0]
    expect(body.slice(0, range.start) + range.newText + body.slice(range.end)).toBe(result.after)
  })
  it('retains no-op target authentication and validates overlap before trimming context', () => {
    expect(composeChapterEdit(before, { oldText: '甲门锁着', newText: '甲门锁着' }).ranges)
      .toEqual([{ start: 0, end: 4, newText: '甲门锁着' }])
    expect(() => composeChapterEdit(before, { patches: [
      { oldText: '甲门锁着', newText: '甲门开了' }, { oldText: '门锁着。乙灯', newText: '门锁着。乙灯' },
    ] })).toThrow(expect.objectContaining({ code: 'CHAPTER_ANCHOR_CONFLICT' }))
  })
  it.each([
    ['YB', '前AXYB后', { start: 2, end: 2, newText: 'XY' }],
    ['Z', '前AXZ后', { start: 2, end: 3, newText: 'XZ' }],
  ] as const)('coalesces adjacent anchors with same-address net effects: B → %s', (newText, after, range) => {
    const body = '前AB后'
    const result = composeChapterEdit(body, { patches: [{ oldText: 'A', newText: 'AX' }, { oldText: 'B', newText }] })
    expect(result).toEqual({ after, ranges: [range] })
    let composed = body
    for (const effect of [...result.ranges].sort((a, b) => b.start - a.start)) composed = composed.slice(0, effect.start) + effect.newText + composed.slice(effect.end)
    expect(composed).toBe(result.after)
  })
})
