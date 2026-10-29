import { describe, expect, it } from 'vitest'
import { findToolRestriction, restoreToolRestriction, toolFailureInputHash, toolRestrictionSchema } from '../../api/lib/agent/tool-local-failure.js'
import { runCheckpointSchema } from '../../api/lib/agent/checkpoint.js'

describe('input failures preserve usable manuscript authority', () => {
  const args = { chapterId: 'chapter', patches: [{ oldText: '错误原文', newText: '新文' }] }
  const bad = { action: 'chapter_edit_range', target: 'chapter', code: 'CHAPTER_ANCHOR_CONFLICT', reason: '第2处未匹配' }
  it('preserves the old exact bad-input audit while permitting current validation for every authorized writer', () => {
    const item = { ...bad, inputHash: toolFailureInputHash(bad.action, args) }
    expect(findToolRestriction([item], bad.action, args)).toBeUndefined()
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
      expect(findToolRestriction([restriction], bad.action, args)).toEqual(code === 'AUTHOR_CHAPTER_SCOPE' ? restriction : undefined)
    }
    const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'system_default', activeExecutionMs: 40,
      runStartedAt: 1000, resumeCount: 0, compactionCount: 0, maxTurns: 1, tokenBudget: 500, writeProgress: 3,
      writeBaseline: 0, readProgress: 4, readBaseline: 0, stagnantBatches: 4, progressSignatures: [], toolRestrictions: [converted] }
    expect(runCheckpointSchema.parse(checkpoint)).toMatchObject({ tokenBudget: 500, activeExecutionMs: 40, stagnantBatches: 4, toolRestrictions: [converted] })
  })
})


describe('server revision-scoped quality failures', () => {
  const restriction = { action: 'quality_analyze', target: 'comp', code: 'QUALITY_REPORT_INCOMPLETE', reason: 'r3格式失败',
    reviewInput: { chapterId: 'chapter', revision: 3 } }
  it('preserves the old report failure without treating its chapter or revision as current execution authority', () => {
    const saved = toolRestrictionSchema.parse(restriction)
    expect(findToolRestriction([saved], 'quality_analyze', { compilationId: 'comp' }, 'chapter', { chapterId: 'chapter', revision: 3 })).toBeUndefined()
    expect(findToolRestriction([saved], 'quality_analyze', { compilationId: 'comp' }, 'chapter', { chapterId: 'chapter', revision: 4 })).toBeUndefined()
    expect(findToolRestriction([saved], 'quality_analyze', { compilationId: 'comp' }, 'chapter')).toBeUndefined()
    expect(findToolRestriction([saved], 'quality_analyze', { compilationId: 'comp' }, 'chapter', { chapterId: 'foreign', revision: 4 })).toBeUndefined()
    expect(saved).toEqual(restriction)
    const legacy = { action: saved.action, target: saved.target, code: saved.code, reason: saved.reason }
    expect(findToolRestriction([legacy], 'quality_analyze', { compilationId: 'comp' }, 'chapter', { chapterId: 'chapter', revision: 4 })).toBeUndefined()
  })
})


describe('actual authority and historical structural failure records', () => {
  it.each(['AUTHOR_CHAPTER_SCOPE', 'RUNTIME_EFFECT_NOT_AUTHORIZED', 'STRUCTURE_RETRY_LIMIT'])('preserves %s without reviving a retired retry-count ban', code => {
    const item = { action: 'chapter_create', target: 'chapter', code, reason: '结构操作连续失败，隔离原目标' }
    expect(toolRestrictionSchema.parse(item)).toEqual(item)
    expect(findToolRestriction([item], item.action, { chapterId: 'chapter' })).toEqual(code === 'STRUCTURE_RETRY_LIMIT' ? undefined : item)
    expect(findToolRestriction([item], item.action, { chapterId: 'another' })).toBeUndefined()
  })
  it.each(['web_search', 'web_read'])('preserves the existing %s argument failure behavior', action => {
    const args = { url: 'https://fixture.invalid' }
    const item = { action, target: null, code: 'INVALID_ARGUMENTS', reason: '连续三次参数无效，该工具未完成；继续其他可执行工作。', inputHash: toolFailureInputHash(action, args) }
    expect(findToolRestriction([item], action, args)).toEqual(item)
  })
})
