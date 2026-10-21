import { describe, expect, it } from 'vitest'
import { parseAuthorWritingRequest, resolveAuthorWritingRequest, type AuthorWritingDirectory } from '../../api/lib/agent/author-writing-request.js'
import { freezeLocalEditBoundary, requestedLocalEdit } from '../../api/lib/agent/local-edit-scope.js'
import { directoryContinuationPrompt } from '../support/writing-target-prompt.js'

const directory = (split = false): AuthorWritingDirectory => ({ volumes: [{ id: 'v1', orderIndex: 1 }, { id: 'v2', orderIndex: 2 }],
  chapters: [1, 2, 3, 4].map(orderIndex => ({ id: `c${orderIndex}`, orderIndex,
    volumeId: split && orderIndex > 2 ? 'v2' : 'v1', orderInVolume: split && orderIndex > 2 ? orderIndex - 2 : orderIndex })) })

describe('fresh directory-backed chapter address identity', () => {
  it('resolves a compound continuation without changing its operation classifications or denials', () => {
    const lexical = parseAuthorWritingRequest(directoryContinuationPrompt)
    expect(lexical.reasons).toEqual(['conflicting_targets'])
    const resolved = resolveAuthorWritingRequest(directoryContinuationPrompt, directory())
    expect(resolved).toMatchObject({ ambiguous: false, range: { kind: 'range', start: 5, count: 1, volume: 1 }, intent: 'write' })
    expect(resolved.evidence.operations).toEqual(lexical.evidence.operations)
    expect(resolved.exclusions).toEqual(lexical.exclusions)
    expect(resolved.conditionalLocalRepair).toBeUndefined()
    expect(requestedLocalEdit(directoryContinuationPrompt, 2, resolved)).toBeNull()
  })
  it.each([
    ['续写第一卷第5章。仅写第5章。', false, 1, 5],
    ['仅写第5章。续写第一卷第5章。', false, 1, 5],
    ['续写第一卷第5章即第5章。', false, 1, 5],
    ['续写第二卷第3章。仅写第5章。', true, 2, 3],
    ['修订第二卷第1章。仅修订第3章。', true, 2, 1],
  ] as const)('proves existing IDs or a single new tail slot, retaining the qualified fence: %s', (prompt, split, volume, start) => {
    expect(resolveAuthorWritingRequest(prompt, directory(split))).toMatchObject({ ambiguous: false, range: { kind: 'range', start, count: 1, volume } })
  })
  it.each([
    ['续写第一卷第5章。仅写第5章。', true], // first volume ends at2; book tail belongs to volume2
    ['修订第二卷第1章。仅修订第1章。', true],
    ['续写第三卷第5章。仅写第5章。', false],
    ['续写第一卷第7章。仅写第7章。', false], // no proved future slot
    ['续写第一卷第5章即全书第5章。', false], // legacy whole-book object remains unresolved; do not erase it
  ] as const)('retains genuine conflict or missing evidence: %s', (prompt, split) => {
    expect(resolveAuthorWritingRequest(prompt, directory(split))).toMatchObject({ ambiguous: true, range: null })
  })
  it('does not invent the next slot from an incomplete or duplicate directory', () => {
    for (const chapters of [directory().chapters.filter(chapter => chapter.orderIndex !== 2), [...directory().chapters, directory().chapters[0]]]) {
      expect(resolveAuthorWritingRequest('写第一卷第5章。仅写第5章。', { ...directory(), chapters })).toMatchObject({ ambiguous: true, range: null })
    }
  })
  it('passes one resolved interpretation to the actual local-boundary consumer', () => {
    const prompt = '修订第二卷第1章。仅修订第3章。只修订“合成短句”。'
    const parsed = resolveAuthorWritingRequest(prompt, directory(true))
    const boundary = freezeLocalEditBoundary(prompt, { version: 1, kind: 'bounded', targets: [{ orderIndex: 3, chapterId: 'c3' }],
      titleAndBodyOnly: false, repairAuthorized: true }, [{ id: 'c3', revision: 1, content: '开头。合成短句。结尾。' }], 2, parsed)
    expect(boundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: 'c3', start: 3, end: 7 }] })
  })
  it.each(['只读检查第一卷第4章。不修改第4章。', '检查第一卷第4章是否需要修改。', '读取：“修订第一卷第4章”。'])('cannot create mutation authority from address evidence: %s', prompt => {
    const lexical = parseAuthorWritingRequest(prompt), resolved = resolveAuthorWritingRequest(prompt, directory())
    expect(resolved.evidence.operations).toEqual(lexical.evidence.operations)
    expect(resolved.evidence.operations.some(operation => operation.accepted && ['write', 'revise'].includes(operation.kind))).toBe(false)
  })
})
