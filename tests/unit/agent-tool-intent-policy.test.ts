import { expect, it, vi } from 'vitest'
import { restrictToolsToTask, intersectToolAuthority } from '../../api/lib/agent/tool-authority.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
const tools: AgentTool[] = ['chapter_write', 'chapter_create', 'volume_create', 'plan_save', 'chapter_read'].map(name => ({ name, title: name, description: name, parameters: {} as AgentTool['parameters'], readOnly: name === 'chapter_read', permission: { plan: 'allow', build: 'allow', review: 'allow' }, execute: vi.fn() }))
it.each(['只输出标题和正文，不要写额外说明。', '不要写正文之外的解释。', '只修改正文，不要改正文以外的内容。', '不要写章节，分析这本书。', '不要修改正文，新增空卷。', '不要修改第三章，修改第四章。', '不要写分析报告，修改第三章。', '请解释“不要写章节”这句话。', '不要跳过正文修订。'])('keeps natural-language understanding in the Agent rather than creating a server permission: %s', prompt => {
  const task = buildTaskSpec({ runId: 'run', novelId: 'book', prompt })
  expect(restrictToolsToTask(tools, task, 'build')).toEqual(tools)
  expect(tools.every(tool => vi.mocked(tool.execute).mock.calls.length === 0)).toBe(true)
})
it('still rejects real tool denial and cannot widen an actual parent grant', () => {
  const denied = { ...tools[0], permission: { ...tools[0].permission, build: 'deny' as const } }
  const task = buildTaskSpec({ runId: 'run', novelId: 'book', prompt: '修改正文' })
  expect(restrictToolsToTask([denied], task, 'build')).toEqual([])
  expect(intersectToolAuthority(tools, 'build', new Map([['chapter_write', { permission: 'deny', alwaysConfirm: false, dangerous: false }]]))).toEqual([])
})
