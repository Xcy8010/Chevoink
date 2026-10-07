import { describe, expect, it } from 'vitest'
import { findToolRestriction, restoreToolRestriction, toolFailureInputHash, toolRestrictionSchema } from '../../api/lib/agent/tool-local-failure.js'
import { runCheckpointSchema } from '../../api/lib/agent/checkpoint.js'

describe('input failures preserve usable manuscript authority', () => {
  const args = { chapterId: 'chapter', patches: [{ oldText: '错误原文', newText: '新文' }] }
  const bad = { action: 'chapter_edit_range', target: 'chapter', code: 'CHAPTER_ANCHOR_CONFLICT', reason: '第2处未匹配' }
  it('blocks the same bad input while permitting a corrected anchor or a different authorized writer', () => {
    const item = { ...bad, inputHash: toolFailureInputHash(bad.action, args) }
    expect(findToolRestriction([item], bad.action, args)).toEqual(item)
    expect(findToolRestriction([item], bad.action, { ...args, patches: [{ oldText: '真实原文', newText: '新文' }] })).toBeUndefined()
    expect(findToolRestriction([item], 'chapter_write', { chapterId: 'chapter', content: '正文' })).toBeUndefined()
    expect(toolRestrictionSchema.parse(item)).toEqual(item)
    expect(toolFailureInputHash(bad.action, { chapterId: 'chapter', oldText: undefined })).toBe(toolFailureInputHash(bad.action, { chapterId: 'chapter' }))
  })
  it('converts an obsolete anchor family ban once without erasing its audit or changing any other boundary', () => {
    const converted = restoreToolRestriction(bad)
    expect(converted).toMatchObject(bad)
    expect(restoreToolRestriction(converted)).toEqual(converted)
    expect(findToolRestriction([converted], bad.action, args)).toBeUndefined()
    for (const code of ['AUTHOR_CHAPTER_SCOPE', 'REPAIR_NOT_AUTHORIZED', 'QUALITY_REPORT_INCOMPLETE', 'CONTINUITY_CHECK_LIMIT']) {
      const restriction = { ...bad, code }
      expect(restoreToolRestriction(restriction)).toEqual(restriction)
      expect(findToolRestriction([restriction], bad.action, args)).toEqual(restriction)
    }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 40,
      runStartedAt: 1000, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500, writeProgress: 3,
      writeBaseline: 0, readProgress: 4, readBaseline: 0, stagnantBatches: 4, progressSignatures: [], toolRestrictions: [converted] }
    expect(runCheckpointSchema.parse(checkpoint)).toMatchObject({ tokenBudget: 500, activeExecutionMs: 40, stagnantBatches: 4, toolRestrictions: [converted] })
  })
})
