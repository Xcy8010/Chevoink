import { expect, it } from 'vitest'
import { classifyContinuityFindingAuthority } from '../../api/lib/agent/continuity-finding-authority.js'
import { COMPILER_CONTINUITY_PROTOCOL } from '../../api/lib/agent/compiler-continuity-contract.js'
import { continuityCriticSystem } from '../../api/lib/agent/tools/story-compiler-tools.js'
const finding = { signal: 'body' as const, severity: 'error' as const,
  evidence: 'Scene Task 草案代价写着晕厥，但正文只是扶住桌沿。', suggestion: '调整场景任务目标以匹配正文。' }
it('classifies explicit generated plan calibration without spending a manuscript factual repair', () => {
  expect(classifyContinuityFindingAuthority(finding)).toMatchObject({ severity: 'warning' })
  expect(COMPILER_CONTINUITY_PROTOCOL).toBe(4)
  expect(continuityCriticSystem).toContain('不能单凭计划偏离报 error')
  expect(continuityCriticSystem).toContain('不得把作者硬要求降级')
})
it.each(['作者明确要求发生晕厥', '前章原文明示他已晕厥', '已确认设定该伤势必然昏迷', '已保存正文的同一时刻互斥状态'])('does not accept an unbound critic authority label: %s', evidence => {
  expect(classifyContinuityFindingAuthority({ ...finding, evidence: `${finding.evidence}；${evidence}` }).severity).toBe('warning')
})
it('does not elevate an unrelated author must-clause or mistake generated plans for saved facts', () => {
  expect(classifyContinuityFindingAuthority(finding, '必须用中文。').severity).toBe('warning')
  const savedConflict = { ...finding, evidence: 'Scene Task 草案与前章原文「门已锁上」及本章「门从未锁过」不一致。' }
  expect(classifyContinuityFindingAuthority(savedConflict, '必须用中文。', { previous: '门已锁上。', current: '门从未锁过。' }).severity).toBe('error')
  expect(classifyContinuityFindingAuthority(savedConflict, '必须用中文。', { previous: '门已锁上。', current: '另一个场景。' }).severity).toBe('warning')
})
it('does not demote unrelated/ambiguous factual findings or already classified warnings', () => {
  expect(classifyContinuityFindingAuthority(finding, '本章必须发生晕厥，随后才救醒。').severity).toBe('error')
  expect(classifyContinuityFindingAuthority({ ...finding, evidence: '同一人物在同一时刻醒着与昏迷。' }).severity).toBe('error')
  expect(classifyContinuityFindingAuthority({ ...finding, suggestion: '核对前后互斥状态并修正文。' }).severity).toBe('error')
  expect(classifyContinuityFindingAuthority({ ...finding, severity: 'warning' }).severity).toBe('warning')
})
