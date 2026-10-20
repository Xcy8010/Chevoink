import { describe, expect, it } from 'vitest'
import { freezeLocalEditBoundary, originalLocalEditBoundary, requestedLocalEdit } from '../../api/lib/agent/local-edit-scope.js'
import { currentIssueQuoteRegions, freezeIssueQuoteBoundary, validIssueQuoteBoundary } from '../../api/lib/agent/local-edit-citations.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { frozenWritingRevisionAuthority, requiresCompletedWritingPresentation } from '../../api/lib/agent/writing-scope.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'

const body = '门边的钟照常报时。甲说：“向左走。”乙回答后却向右转。两人停在走廊，没有经过门口。'
const prompt = '请只对第二卷第6章当前已保存正文做一次局部修订，不续写、不新建章节，不修改第1、2、3章。已确认本章有动作方向冲突：甲说“向左走。”，紧接着乙却写“向右转”。请以最小改动让指令与动作一致。其他既定设定“照常报时”保留，不要把这些当错误改掉。'
const writing = { version: 1 as const, kind: 'bounded' as const, titleAndBodyOnly: false, repairAuthorized: true,
  targets: [{ chapterId: 'target', orderIndex: 8, volumeId: 'volume2', positionInVolume: 6 }] }
const chapter = { id: 'target', revision: 4, content: body }
const freeze = (request = prompt, content = body) => freezeLocalEditBoundary(request, writing, [{ ...chapter, content }], 2)!

describe('fresh issue quotations bound to separate local islands', () => {
  it('recognizes a target-first local operation and preserves its separate author issue anchors', () => {
    expect(requestedLocalEdit(prompt, 2)).toEqual({ kind: 'unknown' })
    const boundary = freeze()
    expect(boundary).toMatchObject({ version: 2, kind: 'bounded', regions: [
      { chapterId: 'target', text: '向左走。', source: { kind: 'author_issue_quote' } },
      { chapterId: 'target', text: '向右转', source: { kind: 'author_issue_quote' } },
    ] })
    if (boundary.version !== 2) throw Error('expected citation boundary')
    expect(validIssueQuoteBoundary(boundary)).toBe(true)
    expect(boundary.regions.every(region => region.prefix + region.text + region.suffix === body)).toBe(true)
    expect(boundary.regions.map(region => prompt.slice(region.source.quoteStart + 1, region.source.quoteEnd - 1))).toEqual(['向左走。', '向右转'])
    expect(boundary.regions.some(region => region.text.includes('照常报时'))).toBe(false)
  })
  it.each([
    prompt.replace('向右转', '不存在的引文'),
    prompt.replace('本章有动作方向冲突', '前章有动作方向冲突'),
    prompt.replace('已确认本章有动作方向冲突', '假设本章有动作方向冲突'),
    prompt.replace('已确认本章有动作方向冲突', '本章是否有动作方向冲突'),
    prompt.replace('已确认本章有动作方向冲突', '本章没有动作方向冲突'),
    prompt + '“向左走。”保持不变。',
    prompt + '禁止修订“向左走。”。',
    prompt + '不调整“向左走。”。',
    prompt + '“向左走。”，保持不变。',
    prompt + '勿再润色“向左走。”。',
  ])('does not infer an unproven or protected editable island', request => {
    expect(freeze(request)).toMatchObject({ kind: 'needs_input', regions: [] })
  })
  it('rejects repeated source text and a whole-body citation', () => {
    expect(freeze(prompt, body + '向右转')).toMatchObject({ kind: 'needs_input' })
    expect(freezeIssueQuoteBoundary('请局部修订第六章。已确认本章有问题：“整段原文”。', writing,
      [{ ...chapter, content: '整段原文' }])).toMatchObject({ kind: 'needs_input' })
  })
  it('tracks changed lengths in each island while preserving the exact gap and outer body', () => {
    const boundary = freeze()
    if (boundary.version !== 2) throw Error('expected citation boundary')
    const after = body.replace('向左走。', '请向右走。').replace('向右转', '往右侧走')
    const spans = currentIssueQuoteRegions(boundary, 'target', 5, after)!
    expect(spans.map(span => after.slice(span.start, span.end))).toEqual(['请向右走。', '往右侧走'])
    expect(currentIssueQuoteRegions(boundary, 'other', 5, after)).toBeNull()
    expect(currentIssueQuoteRegions(boundary, 'target', 3, body)).toBeNull()
    expect(currentIssueQuoteRegions(boundary, 'target', 4, after)).toBeNull()
    expect(currentIssueQuoteRegions(boundary, 'target', 5, after.replace('乙回答后却', '乙突然'))).toBeNull()
    expect(currentIssueQuoteRegions(boundary, 'target', 5, after + '新的一章')).toBeNull()
  })
  it('rejects ambiguous gaps and cumulative expansion relative to the initial quote', () => {
    const boundary = freeze()
    if (boundary.version !== 2) throw Error('expected citation boundary')
    const gap = body.slice(boundary.regions[0].end, boundary.regions[1].start)
    expect(currentIssueQuoteRegions(boundary, 'target', 5, body.replace('向左走。', `向左${gap}走。`))).toBeNull()
    expect(currentIssueQuoteRegions(boundary, 'target', 5, body.replace('向右转', '新'.repeat(1000)))).toBeNull()
    const corrupt = structuredClone(boundary)
    corrupt.regions[1].revision++
    expect(validIssueQuoteBoundary(corrupt)).toBe(false)
    corrupt.regions[1].revision--
    corrupt.regions[1].source.requestHash = 'a'.repeat(64)
    expect(validIssueQuoteBoundary(corrupt)).toBe(false)
  })
  it('preserves version1 and exact paragraph/quote locators in the fresh classifier', () => {
    expect(requestedLocalEdit('修订第二段', 2)).toEqual({ kind: 'paragraph', position: 2 })
    expect(requestedLocalEdit('修订“原短句”', 2)).toEqual({ kind: 'quote', text: '原短句' })
    expect(freezeLocalEditBoundary('修订第二段', writing, [{ ...chapter, content: '第一段\n第二段\n第三段' }], 2)).toMatchObject({ version: 1, kind: 'bounded' })
    expect(requestedLocalEdit('修订第二段')).toBeNull()
    expect(requestedLocalEdit('检查是否需要修改第二段', 2)).toBeNull()
    expect(requestedLocalEdit('评估第二段有没有必要润色', 2)).toBeNull()
    expect(buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '检查是否需要修改第二段', authorWritingProtocol: 2 }).intent).toBe('review')
  })
  it('uses the frozen intent and resolved chapter identity after a volume-qualified admission', () => {
    const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, authorWritingProtocol: 2, localEditProtocol: 1 })
    spec.scope.writingTargetProtocol = 2
    spec.scope.writing = writing
    spec.scope.localEditBoundary = freeze()
    spec.scope.writingInterpretation = { version: 2, scopeHash: '0'.repeat(64), requestHash: spec.scope.localEditBoundary.version === 2
      ? spec.scope.localEditBoundary.regions[0].source.requestHash : '0'.repeat(64), intent: 'revise', reasons: [], revisionDenied: false, creationDenied: false,
      operations: [{ start: 1, end: 3, kind: 'revise', polarity: 'affirmative' }], excludedChapterIds: ['prior1','prior2','prior3'] }
    spec.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(spec.scope)
    expect(originalLocalEditBoundary(spec)).toEqual(spec.scope.localEditBoundary)
    expect(frozenWritingRevisionAuthority(spec, 'target')).toBe(true)
    expect(frozenWritingRevisionAuthority(spec, 'prior1')).toBe(false)
    expect(frozenWritingRevisionAuthority(spec, 'other')).toBe(false)
    for (const field of ['writing', 'localEditBoundary', 'writingInterpretation'] as const) {
      const corrupt = structuredClone(spec)
      delete corrupt.scope[field]
      expect(() => frozenWritingRevisionAuthority(corrupt, 'target')).toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
    }
    spec.goals = ['截断摘要不含写作指令']
    expect(requiresCompletedWritingPresentation(spec)).toBe(true)
    spec.scope.writingInterpretation.operations = [{ start: 1, end: 3, kind: 'review', polarity: 'affirmative' }]
    spec.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(spec.scope)
    expect(frozenWritingRevisionAuthority(spec, 'target')).toBe(false)
    delete spec.scope.writingTargetProtocol
    expect(frozenWritingRevisionAuthority(spec, 'target')).toBeUndefined()
  })
})
