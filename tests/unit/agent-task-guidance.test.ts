import { expect, it } from 'vitest'
import { COMPLETED_WORK_FOLLOWUP_GUIDANCE, SAVED_WORK_CLOSING_GUIDANCE, taskOperatingGuidance } from '../../api/lib/agent/task-guidance.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { enableAgentWritingScope } from '../../api/lib/agent/agent-writing-scope.js'

function task(prompt: string) {
  return buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt, authorWritingProtocol: 2 })
}

it('keeps legacy admission guidance unchanged instead of reclassifying a frozen contract', () => {
  expect(taskOperatingGuidance(buildTaskSpec({ runId: 'old', novelId: 'novel', prompt: '你好' }), 'build')).toBeNull()
})

it.each([
  ['你好', '本次是聊天、提问或设定讨论'],
  ['如何写一个人物的犹豫？', '本次是聊天、提问或设定讨论'],
  ['只讨论人物设定，不要改正文。', '本次未授权作品正文写入'],
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

it('separates direct manuscript replies from workspace writes before an unbound Agent decides the target', () => {
  const spec = enableAgentWritingScope(task('请写一部海岛题材小说的第一章，不要大纲、分析或后续章节。直接输出正文。'))
  const text = taskOperatingGuidance(spec, 'build')!

  expect(text).toContain('直接输出正文且未要求在作品中保存时，在聊天直接给出正文')
  expect(text).toContain('省去执行说明、作品初始化、建章和写入')
  expect(text).toContain('同时要求展示正文时，按指定格式给出保存的版本')
  expect(text).not.toContain('本次未授权作品正文写入')
})

it('ends ordinary writing on verified delivery and keeps author-requested review separate', () => {
  const spec = task('写第四章正文。')
  spec.scope.agentWritingProtocol = 1
  delete spec.scope.agentWritingBinding
  const text = taskOperatingGuidance(spec, 'build')!
  expect(text).toContain('已有保存回执且没有影响交付的具体事实、因果或人物知识问题时，推进剧情的任务按当前规则补记本章，再交付')
  expect(text).toContain('只有建议或未定位的意见时，保留在报告里')
  expect(text).toContain('写入后核对这些改动和受影响的前文')
  expect(text).toContain('作者要求的检查照常完成')
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

it.each(['创建新作品并保存简介标签。', '写下一章。', '只输出标题正文，不要建议。'])('keeps optional stage suggestions separate from completion, questions and execution: %s', prompt => {
  const spec = task(prompt), before = structuredClone(spec), text = taskOperatingGuidance(spec, 'build')!
  for (const required of ['任务真实完成后', '可简短建议或自然询问作者是否需要继续', '普通聊天中的可选邀请', '等作者明确回应后再执行',
    '作者只要结果、只要标题正文或明确不要建议时省略', '未完成、失败或结果未知时据实说明']) expect(COMPLETED_WORK_FOLLOWUP_GUIDANCE).toContain(required)
  expect(text).not.toContain('只有作者要求时才附后续建议')
  expect(spec).toEqual(before)
})

it.each(['把第三章修好并保存。', '详细解释每处修改，完整列出复查意见。', '只输出标题正文，不要总结。'])('keeps concise defaults subordinate to the complete author request: %s', prompt => {
  const spec = task(prompt), before = structuredClone(spec), text = taskOperatingGuidance(spec, 'build')!
  expect(SAVED_WORK_CLOSING_GUIDANCE).toContain('简单改动用短段落即可')
  expect(SAVED_WORK_CLOSING_GUIDANCE).toContain('可用 Markdown 短列表')
  expect(SAVED_WORK_CLOSING_GUIDANCE).toContain('聊天交代值得关注的变化和影响使用的缺项')
  expect(SAVED_WORK_CLOSING_GUIDANCE).toContain('作者明确要求在聊天中交付正文、完整计划或报告、详细解释或具体改动时，按原请求完整提供')
  expect(text).toContain('作者指定仅交付标题正文时直接交付所需内容')
  expect(spec).toEqual(before)
})
