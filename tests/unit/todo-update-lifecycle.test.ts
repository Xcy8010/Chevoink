import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentTodoItem } from '../../shared/contracts'
import type { ToolContext } from '../../api/lib/agent/tools/types'
const db = vi.hoisted(() => ({ messages: vi.fn(), artifact: vi.fn(), create: vi.fn(), update: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { agentMessage: { findMany: db.messages }, agentArtifact: { findFirst: db.artifact, create: db.create, update: db.update } } }))
vi.mock('../../api/lib/agent/task-lineage.js', () => ({ getTaskRunIds: async () => ['current-task-run'] }))
import { prepareTodoUpdate, todoWriteTool, withTodoIds, loadSessionTodoItems, cancelTaskTodoItems } from '../../api/lib/agent/tools/todo-tools'
const previous: AgentTodoItem[] = withTodoIds([{ content: '写第一章', status: 'completed' }, { content: '写第二章', status: 'in_progress' }])
const ctx = { sessionId: 's', runId: 'current-task-run' } as ToolContext
beforeEach(() => { vi.resetAllMocks(); db.messages.mockResolvedValue([]); db.artifact.mockResolvedValue(null) })
it('does not create retrospective completion lists or single-step checklists', () => {
  for (const items of [[], [{ content: '已写完第22章', status: 'completed' }], [{ content: '改标题', status: 'pending' }], [{ content: '已写', status: 'completed' }, { content: '已审', status: 'completed' }]] as AgentTodoItem[][]) {
    expect(prepareTodoUpdate([], items)).toEqual({ items: [], changed: false })
  }
})
it('permits a multi-step plan before execution, then real completion of existing items', () => {
  const items: AgentTodoItem[] = [{ content: '一', status: 'in_progress' }, { content: '二', status: 'pending' }]
  expect(prepareTodoUpdate([], items)).toEqual({ items: withTodoIds(items), changed: true })
  expect(prepareTodoUpdate(items, items.map(item => ({ ...item, status: 'completed' })))).toMatchObject({ changed: true, items: [{ status: 'completed' }, { status: 'completed' }] })
})
it('preserves omitted completed and pending work instead of replacing it with a summary', () => {
  expect(prepareTodoUpdate(previous, [{ content: '本轮全部完成', status: 'completed' }])).toMatchObject({ items: previous, changed: false, error: expect.stringContaining('原 id') })
  expect(prepareTodoUpdate(previous, [])).toEqual({ items: previous, changed: false })
  const update = prepareTodoUpdate(previous, [{ content: '写第二章', status: 'completed' }])
  expect(update.items).toEqual([previous[0], { ...previous[1], status: 'completed' }])
  expect(prepareTodoUpdate(previous, [previous[0]]).items).toEqual(previous)
})
it('keeps completed status and skips identical snapshots', () => {
  expect(prepareTodoUpdate(previous, previous).changed).toBe(false)
  expect(prepareTodoUpdate(previous, [{ ...previous[0], status: 'pending' }, previous[1]])).toEqual({ items: previous, changed: false })
})
it('empty and completed-only tool calls neither persist nor emit a replacement todo display', async () => {
  for (const items of [[], [{ content: '写第22章已完成', status: 'completed' }]] as AgentTodoItem[][]) {
    const args = todoWriteTool.parameters.parse({ items })
    const result = await todoWriteTool.execute(ctx, args)
    expect(result.display).toBeUndefined()
    expect(result.summary).toBe('待办清单未变更')
  }
  expect(db.create).not.toHaveBeenCalled()
  expect(db.update).not.toHaveBeenCalled()
  expect(db.artifact.mock.calls[0][0].where.runId).toEqual({ in: ['current-task-run'] })
})
it('does not overwrite an already-completed artifact with a new completed summary', async () => {
  const old = previous.map(item => ({ ...item, status: 'completed' as const }))
  db.artifact.mockResolvedValue({ id: 'old', content: JSON.stringify(old), metadata: { todoList: true } })
  const result = await todoWriteTool.execute(ctx, { items: [{ content: '收尾全部完成', status: 'completed' }] })
  expect(result.outcome).toBe('failed')
  expect(result.display).toEqual({ kind: 'todoList', items: old })
  expect(db.update).not.toHaveBeenCalled()
})

it('renames by stable ID without growing or reordering the plan', () => {
  const updated = prepareTodoUpdate(previous, [{ ...previous[1], content: '第二章写作及核验', status: 'completed' }])
  expect(updated.items).toEqual([previous[0], { ...previous[1], content: '第二章写作及核验', status: 'completed' }])
  expect(updated.items).toHaveLength(2)
})
it('rejects description-only additions and foreign IDs, allows justified new work', () => {
  expect(prepareTodoUpdate(previous, [{ content: '重述第二章工作', status: 'pending' }]).error).toContain('原 id')
  expect(prepareTodoUpdate(previous, [{ id: 'other-task', content: '一', status: 'pending' }]).error).toContain('不属于')
  const next = prepareTodoUpdate(previous, [{ content: '新增插图', status: 'pending' }], '作者追加插图')
  expect(next.items).toHaveLength(3)
  expect(next.items.slice(0, 2)).toEqual(previous)
})
it('cancels duplicate work explicitly without calling it completed or reactivating it', () => {
  expect(prepareTodoUpdate(previous, [{ ...previous[1], status: 'cancelled' }]).error).toContain('reason')
  const next = prepareTodoUpdate(previous, [{ ...previous[1], status: 'cancelled', reason: '重复工作，原项已保留' }]).items
  expect(next[1]).toMatchObject({ status: 'cancelled', reason: '重复工作，原项已保留' })
  expect(prepareTodoUpdate(next, [{ ...next[1], status: 'completed' }]).items[1].status).toBe('cancelled')
})
it('does not silently accept duplicate IDs in a snapshot', () => {
  expect(prepareTodoUpdate(previous, [previous[1], previous[1]]).error).toContain('重复')
})
it('reads the newer task artifact while message persistence lags behind', async () => {
  db.messages.mockResolvedValue([{ createdAt: new Date(100), parts: [{ type: 'tool-call', toolName: 'todo_write', status: 'success', display: { kind: 'todoList', items: previous } }] }])
  const current = previous.map(item => ({ ...item, status: 'completed' }))
  db.artifact.mockResolvedValue({ content: JSON.stringify(current), updatedAt: new Date(200) })
  expect(await loadSessionTodoItems('s', ['r'])).toEqual(current)
  db.artifact.mockResolvedValue({ content: JSON.stringify(current), updatedAt: new Date(50) })
  expect(await loadSessionTodoItems('s', ['r'])).toEqual(previous)
})
it('author closure preserves completed work and records cancellation for remaining items', async () => {
  db.artifact.mockResolvedValue({ id: 'a', content: JSON.stringify(previous) })
  const items = await cancelTaskTodoItems('s', ['r'], '作者要求结束')
  expect(items).toEqual([previous[0], { ...previous[1], status: 'cancelled', reason: '作者要求结束' }])
  expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a' }, data: expect.objectContaining({ content: JSON.stringify(items) }) }))
})

it('assigns distinct stable IDs to historical same-title rows and requires explicit identity', () => {
  const legacy: AgentTodoItem[] = [{ content: '重复旧项', status: 'pending' }, { content: '重复旧项', status: 'pending' }]
  const identified = withTodoIds(legacy)
  expect(new Set(identified.map(item => item.id)).size).toBe(2)
  expect(withTodoIds(identified)).toEqual(identified)
  expect(prepareTodoUpdate(legacy, [{ content: '重复旧项', status: 'completed' }]).error).toContain('同名')
  const next = prepareTodoUpdate(identified, [{ ...identified[1], status: 'cancelled', reason: '与第一项重复' }]).items
  expect(next[0]).toEqual(identified[0])
  expect(next[1]).toMatchObject({ id: identified[1].id, status: 'cancelled' })
})
it('rejects duplicate content on initial creation instead of manufacturing duplicate IDs', () => {
  expect(prepareTodoUpdate([], [{ content: '重复', status: 'pending' }, { content: '重复', status: 'pending' }]).error).toContain('重复')
})

it('does not reuse a renamed item ID when its old title is added as new work', () => {
  const initial = withTodoIds([{ content: '旧标题', status: 'pending' as const }, { content: '另一项', status: 'pending' as const }])
  const renamed = prepareTodoUpdate(initial, [{ ...initial[0], content: '新标题' }]).items
  const next = prepareTodoUpdate(renamed, [{ content: '旧标题', status: 'pending' }], '作者明确增加独立事项').items
  expect(next).toHaveLength(3)
  expect(new Set(next.map(item => item.id)).size).toBe(3)
  expect(next[0].id).toBe(initial[0].id)
})

it('reports the same active denominator as the UI and separately reports cancellations', async () => {
  db.artifact.mockResolvedValue({ id: 'old', content: JSON.stringify(previous) })
  const result = await todoWriteTool.execute(ctx, { items: [{ ...previous[1], status: 'cancelled', reason: '作者撤销' }] })
  expect(result.summary).toContain('1/1')
  expect(result.summary).toContain('1 项已取消')
  expect(result.display).toMatchObject({ kind: 'todoList', items: [{ status: 'completed' }, { status: 'cancelled' }] })
})
