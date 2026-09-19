import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTaskSpec, narrowLegacyConversationTask, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { intersectToolAuthority, restrictToolsToTask, snapshotToolAuthority } from '../../api/lib/agent/tool-authority.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'

const spec = (prompt: string) => buildTaskSpec({ runId: 'r', novelId: 'n', prompt })
const tool = (name: string, readOnly = false): AgentTool => ({
  name, readOnly, title: name, description: '', parameters: z.object({}),
  permission: { plan: 'allow', build: 'allow', review: 'allow' }, execute: vi.fn(),
})

describe('task-scoped creative pacing', () => {
  it.each(['帮我写一本玄幻类型的小说', '帮我写玄幻小说', '写本修仙小说', '我想写悬疑小说', '调研市场后创作一部悬疑小说', '请写一本长篇小说，先大纲再确认', 'Write a fantasy novel'])('freezes a broad request as proposal only: %s', prompt => {
    const task = taskSpecSchema.parse(spec(prompt))
    expect(task.writingPacing).toBe('proposal_only')
    expect(task.intent).toBe('plan')
    expect(task.expectedOutputs[0].description).toContain('本轮不写章节正文')
    expect(renderTaskSpec(task)).toContain('作者下一条明确写作指令')
  })

  it.each(['写一本悬疑小说，先写第一章', '写一本仙侠小说，你自主逐章写完', '写一本小说，我授权你创作全书', '写一本科幻小说，不用问我直接写完整本'])('honors explicit prose authorization: %s', prompt => {
    expect(spec(prompt).writingPacing).toBe('explicit_writing')
  })

  it.each(['按照已经确认的大纲续写第六章', '修改第三章', '你好，帮我写下一章', '续写本作品', '续写这本小说', '改写这部小说的第三章', '帮我写玄幻小说的第六章'])('does not block bounded existing workflows: %s', prompt => {
    expect(restrictToolsToTask([tool('chapter_write')], spec(prompt))).toHaveLength(1)
  })

  it('a proposal cannot spawn writing or mutate prose, even after serialization or a mode switch', () => {
    const tools = ['plan_save', 'todo_write', 'ask_user', 'chapter_create', 'chapter_write', 'chapter_append', 'changeset_apply', 'task_create', 'subagent_spawn', 'memory_save'].map(name => tool(name))
    tools.push(tool('chapter_read', true))
    const resumed = taskSpecSchema.parse(JSON.parse(JSON.stringify(spec('帮我写一本科幻小说'))))
    const allowed = restrictToolsToTask(tools, resumed)
    expect(allowed.map(item => item.name)).toEqual(['plan_save', 'todo_write', 'ask_user', 'chapter_read'])
    const ceiling = snapshotToolAuthority(allowed, 'plan')
    expect(intersectToolAuthority(tools, 'build', ceiling).map(item => item.name)).toEqual(allowed.map(item => item.name))
    expect(tools.every(item => !vi.mocked(item.execute).mock.calls.length)).toBe(true)
  })

  it.each(['你好', 'Hello!', '你是谁？', '如何写好第一章？', '如何写一本玄幻小说？', '我想了解如何写一本玄幻小说', '我想学习怎么写本修仙小说', '请问玄幻小说有哪些类型？'])('ordinary conversation never grants prose writes: %s', prompt => {
    const task = spec(prompt)
    expect(task.writingPacing).toBe('conversation_only')
    expect(restrictToolsToTask([tool('chapter_read', true), tool('ask_user'), tool('chapter_write'), tool('plan_save')], task).map(item => item.name))
      .toEqual(['chapter_read', 'ask_user'])
    expect(renderTaskSpec(task)).toContain('不继续其他窗口')
  })

  it('repairs a legacy greeting using the original request without replacing identity or history', () => {
    const task = spec('你好')
    delete task.writingPacing
    const narrowed = narrowLegacyConversationTask(task, '你好')
    expect(narrowed).toMatchObject({ id: task.id, goals: task.goals, scope: task.scope, writingPacing: 'conversation_only' })
    expect(narrowLegacyConversationTask(task, '继续')).toBe(task)
    expect(narrowLegacyConversationTask(narrowed, '写下一章')).toBe(narrowed)
  })

  it('does not treat a forbidden chapter request as prose authorization', () => {
    expect(spec('写一本仙侠小说，不要写第一章').writingPacing).toBe('proposal_only')
    expect(spec('写一本仙侠小说，等我确认后再写第一章').writingPacing).toBe('proposal_only')
  })
})
