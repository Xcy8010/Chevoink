import { describe, expect, it } from 'vitest'
import { freezeLocalEditBoundary, requestedLocalEdit, originalLocalEditBoundary } from '../../api/lib/agent/local-edit-scope.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

describe('complete original local edit wording', () => {
  it.each(['检查是否需要修改第二段', '看看需不需要润色第二段', '判断修改第二段有没有必要',
    '评估是否需要重写第二段', '评估第二段有没有必要润色', 'Check whether to edit paragraph 2',
    'Assess if paragraph 2 needs polishing', 'Evaluate if we should rewrite paragraph 2'])(
    'cannot grant paragraph mutation for a revision assessment: %s', prompt => expect(requestedLocalEdit(prompt)).toEqual({ kind: 'unknown' }))
  it.each([
    ['请只润色第一章第二段', { kind: 'paragraph', position: 2 }],
    ['修改首段', { kind: 'paragraph', position: 1 }],
    ['修改最后一段', { kind: 'paragraph', position: 'last' }],
    ['Edit the first paragraph of chapter 1', { kind: 'paragraph', position: 1 }],
    ['把“原句”改成“新句”', { kind: 'quote', text: '原句' }],
    ['背景'.repeat(700) + '。将「原句」改为「新句」', { kind: 'quote', text: '原句' }],
    ['背景引文“其他”。把“原句”改成“新句”', { kind: 'quote', text: '原句' }],
    ['修改结尾', { kind: 'unknown' }],
    ['只修改这段，其余保持不变', { kind: 'unknown' }],
    ['润色这一段', { kind: 'unknown' }],
    ['修改第二段以外的内容', { kind: 'unknown' }],
    ['修改第 2 段', { kind: 'paragraph', position: 2 }],
    ['缩写第二段', { kind: 'paragraph', position: 2 }],
    ['扩写第二段', { kind: 'paragraph', position: 2 }],
    ['删掉第二段', { kind: 'paragraph', position: 2 }],
    ['补一句对白', { kind: 'unknown' }],
    ['只修改第二段里的“原短语”', { kind: 'unknown' }],
    ['只修改第二段的前三个字', { kind: 'unknown' }],
    ['修改第二段里的行动方案', { kind: 'unknown' }],
    ['无论如何请修改第二段', { kind: 'paragraph', position: 2 }],
    ['Only modify paragraph 2', { kind: 'paragraph', position: 2 }],
    ['先局部润色，然后重写整章', { kind: 'unknown' }],
    ['先修改首段，然后写整章', { kind: 'unknown' }],
    ['只改第一段结尾', { kind: 'unknown' }],
    ['只润色首段，不要改正文', { kind: 'unknown' }],
    ['整章只改对白', { kind: 'unknown' }],
  ])('extracts server-provable locality: %s', (prompt, expected) => expect(requestedLocalEdit(prompt)).toEqual(expected))
  it.each(['写第一章，开头先写一段雨景', '写第一章，结尾补一句旁白', '重写整章', '修改整章，尤其注意结尾', '重写整章，重点优化开头的节奏',
    'Rewrite the whole chapter, especially polish the first paragraph', '不要局部改写，请重写整章',
    '只检查首段', '如何修改结尾？', '给出第一段修改建议', '参考“只修改结尾”，写完整第一章',
    '他说过“局部改写首段”。请写第一章', '正文中出现“修改首段”的对白，创作下一章'])('does not turn background/readonly/whole writing into locality: %s', prompt => expect(requestedLocalEdit(prompt)).toBeNull())
  it('freezes paragraphs as exact UTF-16 saved lines, preserving CRLF/blank separators', () => {
    const chapter = { id: 'c', revision: 3, content: '前😀段。\r\n\r\n目标行。\r\n末段。' }
    const writing = { version: 1 as const, kind: 'bounded' as const, targets: [{ chapterId: 'c', orderIndex: 1 }], titleAndBodyOnly: false, repairAuthorized: true }
    expect(freezeLocalEditBoundary('润色第二段', writing, [chapter])).toMatchObject({ kind: 'bounded', regions: [{ start: 9, end: 13, prefix: '前😀段。\r\n\r\n', suffix: '\r\n末段。' }] })
    expect(freezeLocalEditBoundary('修改首段', writing, [chapter])).toMatchObject({ regions: [{ start: 0, end: 5 }] })
    expect(freezeLocalEditBoundary('修改末段', writing, [chapter])).toMatchObject({ regions: [{ start: 15, end: 18 }] })
    for (const content of ['重复。重复。', '单段。']) {
      expect(freezeLocalEditBoundary(content.startsWith('重复') ? '修改“重复。”' : '修改首段', writing, [{ ...chapter, content }])).toMatchObject({ kind: 'needs_input', regions: [] })
    }
  })
  it('leaves builder default/old contracts absent and rejects corrupt marker snapshots', () => {
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt: '修改首段' })
    expect(spec.scope.localEditProtocol).toBeUndefined()
    expect(originalLocalEditBoundary(spec)).toBeNull()
    expect(() => originalLocalEditBoundary({ ...spec, scope: { ...spec.scope, localEditProtocol: 2 } })).toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
    expect(() => originalLocalEditBoundary({ ...spec, scope: { ...spec.scope, localEditProtocol: 1,
      localEditBoundary: { version: 1, kind: 'bounded', regions: [] } } })).toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
  })
})
