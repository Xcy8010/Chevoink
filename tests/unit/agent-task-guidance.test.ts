import { expect, it } from 'vitest'
import { taskOperatingGuidance } from '../../api/lib/agent/task-guidance.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

function task(prompt: string) {
  return buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt, authorWritingProtocol: 2 })
}

it('keeps legacy admission guidance unchanged instead of reclassifying a frozen contract', () => {
  expect(taskOperatingGuidance(buildTaskSpec({ runId: 'old', novelId: 'novel', prompt: '你好' }), 'build')).toBeNull()
})

it.each([
  ['你好', '本次是聊天、提问或设定讨论'],
  ['如何写一个人物的犹豫？', '本次是聊天、提问或设定讨论'],
  ['只讨论人物设定，不要改正文。', '本次未授权正文创作'],
])('does not impose chapter work on an informational request: %s', (prompt, expected) => {
  const spec = task(prompt), before = structuredClone(spec), text = taskOperatingGuidance(spec, 'plan')!
  expect(text).toContain(expected)
  expect(text).not.toContain('story_compiler_prepare')
  expect(text).not.toContain('本次是写作或修订')
  expect(spec).toEqual(before)
})

it('provides research evidence requirements without a chapter workflow or implied manuscript permission', () => {
  const spec = task('联网研究《样本》的叙事，不改正文。')
  spec.intent = 'research_analysis'
  const text = taskOperatingGuidance(spec, 'build')!
  expect(text).toContain('简介、目录、预览、乱码或受限页面不是完整正文')
  expect(text).toContain('不顺带改小说')
  expect(text).not.toContain('本次是写作或修订')
})

it('distinguishes local edits from whole chapters while retaining version, receipt, unknown-fee and fact boundaries', () => {
  const spec = task('把第三章开头的一句改得简洁，其他不动。')
  spec.scope.authorEffects!.manuscript = true
  spec.scope.selection = { chapterId: 'chapter', start: 0, end: 12 }
  const text = taskOperatingGuidance(spec, 'build')!
  expect(text).toContain('本次是限定范围修改')
  for (const required of ['不覆盖作者新稿', '不能一律当作未执行', '不能重发未知付费请求', '候选、推测、计划和未完成检查不冒充既成事实']) expect(text).toContain(required)
  expect(text).not.toContain('同一份产物')
})

it('keeps complete chapter review and truthful partial completion without a fixed per-tool retry ritual', () => {
  const spec = task('写下一章。')
  const text = taskOperatingGuidance(spec, 'build')!
  expect(text).toContain('核验当前最终版本')
  expect(text).toContain('缺少必要检查时保留正文并报告未完成')
  expect(text).not.toMatch(/重试 2 次|预算 3 次|只落盘一次/)
})

it.each(['plan', 'review'] as const)('respects %s mode before selecting a manuscript-edit workflow', mode => {
  const spec = task('修改第三章第一段。')
  spec.scope.authorEffects!.manuscript = true
  spec.scope.selection = { chapterId: 'chapter', start: 0, end: 12 }
  const text = taskOperatingGuidance(spec, mode)!
  expect(text).toContain('不执行')
  expect(text).toContain('本轮只完成当前模式允许的分析与规划')
  expect(text).not.toContain('本次是限定范围修改')
  expect(text).not.toContain('本次是写作或修订')
  if (mode === 'review') expect(text).toContain('交付有位置与证据的问题及建议')
})
