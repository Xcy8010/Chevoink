import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

import type { AgentMessagePart, AgentTodoItem } from '../../../../shared/contracts/index.js'
import { prisma } from '../../prisma.js'
import { defineTool } from './types.js'
import { getTaskRunIds } from '../task-lineage.js'

/**
 * 待办清单工具（plan/15 长任务连续性）：
 * - 复杂/多单元任务先建待办再逐项执行，每完成一项立即勾掉，防止中途早停
 * - 完整快照语义：按任务谱系保存；无效收尾忽略、漏带旧项保留，其他任务不覆盖
 * - 循环内核据此拦截"待办未完成就想收尾"的早停（loop.ts）
 */

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])

const todoWriteParameters = z.object({
  changeReason: z.string().min(1).max(200).optional().describe('已有清单确需追加新工作时必填范围变化原因；改写旧项不得新增'),
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(64).optional().describe('首次创建省略 id；更新已有项原样带回回执 id，修改描述也沿用原 id'),
        reason: z.string().min(1).max(200).optional().describe('取消必填原因：重复、超出本任务或作者撤销，不代表完成'),
        content: z.string().min(1).max(100).describe('待办内容，一句话说清要完成什么（如「写第三章正文」）'),
        status: todoStatusSchema.describe('pending=未开始；in_progress=进行中（同一时刻最多 1 项）；completed=已完成；cancelled=取消/不再执行，必须 reason，不算完成'),
      }),
    )
    .max(20)
    .superRefine((items, ctx) => {
      if (items.filter((item) => item.status === 'in_progress').length > 1) {
        ctx.addIssue({ code: 'custom', message: '同一时刻只能有一项待办处于进行中。' })
      }
    })
    .describe('本任务完整清单，保留原项。仅长任务/复杂任务在执行前建至少两项；不要在结尾补造清单。空数组只会忽略，不代表已完成，也不删除旧清单'),
})

/**
 * 待办进度状态机：真实完成后允许批量确认，已完成项不可回退。
 */
export function validateTodoProgression(previous: AgentTodoItem[], next: AgentTodoItem[]): string | null {
  const previousByContent = new Map(previous.map((item) => [item.content, item.status]))

  // 允许一次完成多项待办（pending/进行中 → completed 皆可），避免模型因“一次只能完成一项”
  // 频繁被拒后反复试错重试。仅保留「已完成项不可回退」这一无害纪律线。
  for (const item of next) {
    if (previousByContent.get(item.content) === 'completed' && item.status !== 'completed') {
      return `已完成的待办“${item.content}”不能回退状态；如需返工，请新增一条明确的返工待办。`
    }
  }
  return null
}

/** 不为收尾补造清单；空更新及无变化更新不触碰持久化和 UI。 */
export function withTodoIds(items: AgentTodoItem[]): AgentTodoItem[] {
  const used = new Set<string>()
  return items.map(item => {
    const base = item.id ?? `todo-${createHash('sha256').update(item.content).digest('hex').slice(0, 24)}`
    let id = base
    for (let ordinal = 2; used.has(id); ordinal += 1) id = `${base.slice(0, 55)}-${ordinal}`
    used.add(id)
    return { ...item, id }
  })
}

export function prepareTodoUpdate(previous: AgentTodoItem[], requested: AgentTodoItem[], changeReason?: string): { items: AgentTodoItem[]; changed: boolean; error?: string; failureCode?: string } {
  const unchanged = { items: previous, changed: false }
  const reject = (failureCode: string, error: string) => ({ ...unchanged, error, failureCode })
  if (!requested.length) return unchanged
  if (!previous.length && (requested.length < 2 || requested.some(item => item.status === 'completed'))) return reject('TODO_BASELINE_REQUIRED', '本任务没有可更新的清单。不能用单项或已完成项补造待办；不要操作其他任务清单，也不要为了消除提示新增无关工作。')
  const baseline = withTodoIds(previous)
  const byId = new Map(baseline.map(item => [item.id, item]))
  const contentKey = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').replace(/[。.!！]+$/u, '')
  const byContent = new Map(baseline.map(item => [contentKey(item.content), item]))
  const updates = new Map<string, AgentTodoItem>()
  const added: AgentTodoItem[] = []
  for (const requestedItem of requested) {
    // A brand-new list has no server identities to reference. Model-invented
    // IDs are replaced with our stable IDs; foreign IDs on updates still fail.
    const item = baseline.length ? requestedItem : { ...requestedItem, id: undefined }
    if (!item.id && baseline.filter(old => contentKey(old.content) === contentKey(item.content)).length > 1) return reject('TODO_AMBIGUOUS_ID', '存在同名待办，请用各自原 id 指明更新或取消哪一项。')
    const old = item.id ? byId.get(item.id) : byContent.get(contentKey(item.content))
    if (item.id && !old) return reject('TODO_FOREIGN_ID', '待办 id 不属于当前清单；首次创建请省略 id，更新已有项请使用回执中的原 id。')
    if (!old && item.status === 'completed') return baseline.length ? reject('TODO_COMPLETION_TARGET_REQUIRED', '不能用新描述提交已完成项；请沿用原 id 更新既有待办。') : unchanged
    if (!old && baseline.length && !changeReason?.trim()) return reject('TODO_CHANGE_REASON_REQUIRED', '已有清单不能因改写描述而追加新项。更新时带回原 id；确有新增工作须提供 changeReason。')
    if (item.status === 'cancelled' && (!old || !item.reason?.trim())) return reject('TODO_CANCEL_REASON_REQUIRED', '只能取消已有项，并须说明 reason；取消不等于完成。')
    if (!old && added.some(entry => contentKey(entry.content) === contentKey(item.content))) return reject('TODO_DUPLICATE', '同一待办不能在一次更新中重复出现。')
    if (old && contentKey(old.content) !== contentKey(item.content) && baseline.some(entry => entry.id !== old.id && contentKey(entry.content) === contentKey(item.content))) return reject('TODO_DUPLICATE', '改名会与既有待办重复；请保留原项，并按原 id 取消重复项。')
    if (old && (old.status === 'completed' || old.status === 'cancelled') && item.status !== old.status) return reject('TODO_TERMINAL_IMMUTABLE', `待办“${old.content}”已经${old.status === 'completed' ? '完成' : '取消'}，本次状态更新未应用；取消不能改标完成。`)
    const next = old ? { ...old, ...item, id: old.id } : withTodoIds([...baseline, ...added, item]).at(-1)!
    if (updates.has(next.id!)) return reject('TODO_DUPLICATE', '同一待办不能在一次更新中重复出现。')
    updates.set(next.id!, next)
    if (!old) added.push(next)
  }
  // Preserve plan order; editing a title is not adding another task.
  const items = [...baseline.map(item => updates.get(item.id!) ?? item), ...added]
  if (items.length > 20) return reject('TODO_LIMIT', '待办最多 20 项，请按原 id 整理重复项。')
  // 拒绝同批改名/新增制造的新重复；历史同名项仍可按原编号取消。
  for (const item of updates.values()) {
    const old = byId.get(item.id)
    if ((!old || contentKey(old.content) !== contentKey(item.content))
      && items.some(other => other.id !== item.id && contentKey(other.content) === contentKey(item.content))) {
      return reject('TODO_DUPLICATE', '本次更新产生重复待办；请沿用原 id 更新或取消重复项。')
    }
  }
  let activeSeen = false
  const normalized = items.map(item => item.status === 'in_progress'
    ? activeSeen ? { ...item, status: 'pending' as const } : (activeSeen = true, item)
    : item)
  return { items: normalized, changed: JSON.stringify(normalized) !== JSON.stringify(baseline) }
}

/** 待办副本定位条件；调用方传任务谱系 runIds，隔离同会话的其他任务。 */
function todoArtifactWhere(sessionId: string, runIds?: string[]) {
  return {
    artifactType: 'chapterPlan' as const,
    metadata: { path: ['todoList'], equals: true },
    run: { sessionId },
    ...(runIds ? { runId: { in: runIds } } : {}),
  }
}

/**
 * 读取会话当前的待办清单：loop 续跑与 context 注入共用。
 * 按时间比较成功工具快照与持久化副本，避免同批工具或作者结束后读到旧消息。
 * 仅在当前任务谱系内读取；历史无编号清单在读取时补稳定编号。
 */
export async function loadSessionTodoItems(sessionId: string, runIds?: string[], db: Prisma.TransactionClient = prisma): Promise<AgentTodoItem[]> {
  const recent = await db.agentMessage.findMany({
    where: { sessionId, role: 'assistant', ...(runIds ? { runId: { in: runIds } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { parts: true, createdAt: true },
  })

  const artifact = await db.agentArtifact.findFirst({
    where: todoArtifactWhere(sessionId, runIds), orderBy: { updatedAt: 'desc' },
    select: { content: true, updatedAt: true },
  })
  for (const record of recent) {
    if (artifact?.updatedAt && record.createdAt && artifact.updatedAt > record.createdAt) break
    const parts = record.parts as unknown as AgentMessagePart[]
    if (!Array.isArray(parts)) {
      continue
    }
    // 同一条消息内可能有多次 todo_write，倒序取最后一次成功的
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index]
      if (
        part.type === 'tool-call' &&
        part.toolName === 'todo_write' &&
        part.status === 'success' &&
        part.display?.kind === 'todoList'
      ) {
        return withTodoIds(part.display.items)
      }
    }
  }

  if (!artifact) {
    return []
  }
  try {
    const parsed = JSON.parse(artifact.content) as AgentTodoItem[]
    return Array.isArray(parsed)
      ? withTodoIds(parsed.filter(
          (item): item is AgentTodoItem =>
            Boolean(item && typeof item.content === 'string') &&
            ['pending', 'in_progress', 'completed', 'cancelled'].includes((item as AgentTodoItem).status),
        ))
      : []
  } catch {
    return []
  }
}

/** 渲染待办清单文本：回填给模型/注入上下文用 */
export function renderTodoItems(items: AgentTodoItem[]): string {
  return withTodoIds(items)
    .map((item, index) => {
      const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[进行中]' : item.status === 'cancelled' ? '[已取消]' : '[ ]'
      return `${index + 1}. ${item.id ? `[id=${item.id}] ` : ''}${mark} ${item.content}${item.reason ? `（${item.reason}）` : ''}`
    })
    .join('\n')
}

export const todoWriteTool = defineTool({
  name: 'todo_write',
  title: '更新待办清单',
  description:
    '按原 id 更新状态或修改说明，禁止改描述新增重复项。开工前一次列出已知步骤并按序执行，每项开工先设 in_progress，真实完成后立即设 completed；确有范围变化才带 changeReason 新增。重复项或不再执行项沿用原 id 设 cancelled 并填 reason，不得假标 completed。仅用于长任务、复杂任务（如连写多章、跨章批量整改、多项独立交付步骤）：开工前建立至少两项真实待办，再逐项推进。简单问答、单处修改、简单单步操作不需要清单。首次创建不能包含 completed；禁止在收尾时补写完成清单或用一条总结覆盖旧清单。已真实交付的既有项可批量标记 completed，已完成项不回退、原项不遗漏。有未完成项就继续执行，无法完成时说明阻塞，不得假勾选。空数组不会清空旧清单；进度未变化不要重复调用。',
  parameters: todoWriteParameters,
  coerceArgs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    let source = raw as Record<string, unknown>
    for (const key of ['arguments', 'args', 'params', 'parameters'] as const) {
      const wrapped = source[key]
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        const candidate = wrapped as Record<string, unknown>
        if ([candidate.items, candidate.todos, candidate.tasks, candidate.todoList].some(Array.isArray)) {
          source = candidate
          break
        }
      }
    }
    const rawItems = source.items ?? source.todos ?? source.tasks ?? source.todoList
    if (!Array.isArray(rawItems)) return source
    let inProgressSeen = false
    const items = rawItems
      .map((value) => {
        if (typeof value === 'string') return { content: value.trim().slice(0, 100), status: 'pending' as const }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        const item = value as Record<string, unknown>
        const contentValue = item.content ?? item.title ?? item.task ?? item.text
        if (typeof contentValue !== 'string' || !contentValue.trim()) return null
        const rawStatus = String(item.status ?? item.state ?? 'pending').toLowerCase()
        let status: AgentTodoItem['status'] = ['cancelled', 'canceled'].includes(rawStatus) ? 'cancelled' : ['completed', 'done', 'complete', 'finished'].includes(rawStatus)
          ? 'completed'
          : ['in_progress', 'in-progress', 'doing', 'active', 'running'].includes(rawStatus)
            ? 'in_progress'
            : 'pending'
        if (status === 'in_progress') {
          if (inProgressSeen) status = 'pending'
          inProgressSeen = true
        }
        return { ...(typeof item.id === 'string' ? { id: item.id.trim() } : {}), ...(typeof item.reason === 'string' ? { reason: item.reason.trim() } : {}), content: contentValue.trim().slice(0, 100), status }
      })
      .filter((item): item is AgentTodoItem => item !== null)
      .slice(0, 20)
    return { items, ...(typeof source.changeReason === 'string' ? { changeReason: source.changeReason.trim() } : {}) }
  },
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  readOnly: true,
  async execute(ctx, args) {
    const runIds = await getTaskRunIds(ctx.sessionId, ctx.runId)
    // 任务谱系内 upsert：续跑/刷新恢复本任务清单，不覆盖其他任务副本。
    const existing = await prisma.agentArtifact.findFirst({
      where: todoArtifactWhere(ctx.sessionId, runIds),
      orderBy: { updatedAt: 'desc' },
      select: { id: true, content: true, metadata: true },
    })
    const metadata = existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown>
      : {}
    // 待办前态以「注入模型的同一真相源」为准（loadSessionTodoItems 优先取消息里最后一次成功
    // 的 todo_write 清单），跨 run / 续跑也能拿到真实前态；避免 artifact 副本停在旧任务导致
    // previous 退化为空，从而把本应已完成的旧项误判为本轮“一次完成多项”而被拒。
    const previous = await loadSessionTodoItems(ctx.sessionId, runIds)
    const { items, changed, error, failureCode } = prepareTodoUpdate(previous, args.items, args.changeReason)
    if (error) return { outcome: 'failed', failureCode, summary: '待办更新未接受', output: `${error}\n本任务实际清单：\n${renderTodoItems(previous)}`, display: { kind: 'todoList', items: previous } }
    if (!changed) return {
      output: `待办清单未变更，未清空或覆盖原清单。仅在长任务/复杂任务开工前建立至少两项未完成工作，或更新既有项真实进度；不要为收尾补造 completed 项，也不要重试无变化的清单。${previous.length ? `\n本任务原清单仍为：\n${renderTodoItems(previous)}` : '\n本任务没有清单；如已完成请直接交付，否则继续实际工作。'}`,
      summary: '待办清单未变更',
    }

    const completed = items.filter((item) => item.status === 'completed').length
    const cancelled = items.filter(item => item.status === 'cancelled').length
    const progress = `${completed}/${items.length - cancelled}${cancelled ? `，${cancelled} 项已取消` : ''}`
    const content = JSON.stringify(items)
    if (existing) {
      await prisma.agentArtifact.update({
        where: { id: existing.id },
        data: { content, summary: `待办 ${progress}`, metadata: { ...metadata, todoList: true, todoRunId: ctx.runId } },
      })
    } else {
      await prisma.agentArtifact.create({
        data: {
          runId: ctx.runId,
          artifactType: 'chapterPlan',
          title: '任务待办清单',
          summary: `待办 ${progress}`,
          content,
          metadata: { todoList: true, todoRunId: ctx.runId },
        },
      })
    }

    const remaining = items.filter(item => item.status === 'pending' || item.status === 'in_progress').length
    return {
      output:
        remaining > 0
          ? `待办清单已更新（${progress} 已完成）：\n${renderTodoItems(items)}\n还有 ${remaining} 项未完成，请立即继续执行下一条未完成的待办，不要停下来询问作者。`
          : `待办清单已处理（${completed} 项完成，${items.length - completed} 项取消）：\n${renderTodoItems(items)}\n请核对每项都已真实交付，然后用简短正文向作者收尾。`,
      summary: `待办 ${progress} 已完成`,
      display: { kind: 'todoList', items },
    }
  },
})

/** Called only after a trusted author answer ends this task. No work is marked done. */
export async function cancelTaskTodoItems(sessionId: string, runIds: string[], reason: string): Promise<AgentTodoItem[]> {
  if (!runIds.length) return []
  const previous = await loadSessionTodoItems(sessionId, runIds)
  const items = withTodoIds(previous).map(item => item.status === 'pending' || item.status === 'in_progress'
    ? { ...item, status: 'cancelled' as const, reason } : item)
  if (!items.length) return items
  const existing = await prisma.agentArtifact.findFirst({ where: todoArtifactWhere(sessionId, runIds), orderBy: { updatedAt: 'desc' }, select: { id: true } })
  const data = { content: JSON.stringify(items), summary: '作者已结束任务', metadata: { todoList: true, authorEnded: true } }
  if (existing) await prisma.agentArtifact.update({ where: { id: existing.id }, data })
  else await prisma.agentArtifact.create({ data: { ...data, runId: runIds.at(-1)!, artifactType: 'chapterPlan', title: '任务待办清单' } })
  return items
}
