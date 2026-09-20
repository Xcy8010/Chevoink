import { z } from 'zod'
import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { prisma } from '../../prisma.js'
import { saveStoryMemory } from '../story-memory.js'
import { defineTool, type ToolResult } from './types.js'
import { executeDurablePlanSave } from './durable-plan.js'
import { resolveMemorySource } from './memory-source.js'

/**
 * 记忆与计划写工具集。
 * 阶段 P3：章节工具拆至 chapter-tools.ts、作品维度工具拆至 novel-tools.ts，
 * 本文件保留创作记忆沉淀与计划文件夹读写（工具定义逐字不动）。
 */

export const memorySaveTool = defineTool({
  name: 'memory_save',
  title: '沉淀创作记忆',
  description:
    '提交创作记忆候选，作者确认前不参与事实召回。禁止把试写、猜测或待定计划当既成事实；优先提供来源章节、revision和逐字sourceQuote。修订先检索原卡片并传memoryId，不能直接覆盖作者设定。审核完成前不得声称记忆已生效。',
  parameters: z.object({
    memoryType: z
      .enum([
        'novelSummary',
        'worldbuilding',
        'characterCard',
        'chapterSummary',
        'timelineEvent',
        'foreshadowing',
        'stylePreference',
        'continuityRule',
        'volumeSummary',
        'storyArc',
        'sceneState',
        'relationshipState',
        'storyBible',
        'authorProfile',
      ])
      .describe('记忆类型'),
    title: z.string().min(1).max(120).describe('记忆标题（如角色名、章节名、设定名）'),
    content: z.string().min(1).max(4000).describe('记忆内容，事实化、结构化表述，最多4000字符；不同主题分别保存，不截断事实'),
    importance: z.number().int().min(1).max(100).describe('重要性 1-100：核心主角/主线设定 80+，一般设定 50-70'),
    sourceChapterId: z.string().optional().describe('来源章节 ID（章节摘要必填）'),
    revision: z.number().int().positive().optional().describe('读取到的来源章节版本'),
    sourceQuote: z.string().trim().min(1).max(4000).optional().describe('仅用于来源章节的逐字原文，必须同时传真实sourceChapterId。规划/待定设定不是章节证据，不把摘要或计划包装成引用；无章节依据时仅提交待审候选，不传revision/sourceQuote'),
    memoryId: z.string().optional().describe('要修订的既有记忆卡片id；提交关联候选，作者确认前保留旧卡'),
    overwrite: z.boolean().optional().describe('旧客户端兼容参数，不授予自动覆盖或作者确认权限'),
  }),
  coerceArgs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    let source = raw as Record<string, unknown>
    for (const key of ['arguments', 'args', 'params', 'parameters', 'memory'] as const) {
      const wrapped = source[key]
      if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        const candidate = wrapped as Record<string, unknown>
        if ([candidate.content, candidate.text, candidate.body, candidate.summary, candidate.title, candidate.name, candidate.subject].some((value) => value !== undefined)) {
          source = { ...candidate, sourceChapterId: source.sourceChapterId ?? candidate.sourceChapterId }
          break
        }
      }
    }
    const result: Record<string, unknown> = { ...source }
    result.memoryType = result.memoryType ?? result.type ?? result.memory_type
    // Only established equivalent names; unknown types still fail schema validation.
    if (typeof result.memoryType === 'string') {
      const aliases: Record<string, string> = { world_setting: 'worldbuilding', setting: 'worldbuilding', world_building: 'worldbuilding', character_card: 'characterCard', chapter_summary: 'chapterSummary', story_bible: 'storyBible' }
      result.memoryType = aliases[result.memoryType] ?? result.memoryType
    }
    result.title = result.title ?? result.name ?? result.subject
    result.content = result.content ?? result.text ?? result.body ?? result.summary
    result.importance = result.importance ?? result.priority ?? result.weight ?? 70
    result.sourceChapterId = result.sourceChapterId ?? result.chapterId ?? result.source_chapter_id
    if (Array.isArray(result.content)) result.content = result.content.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    else if (result.content && typeof result.content === 'object') result.content = JSON.stringify(result.content)
    else if (typeof result.content === 'number' || typeof result.content === 'boolean') result.content = String(result.content)
    if (typeof result.title === 'number') result.title = String(result.title)
    if (typeof result.title === 'string') result.title = result.title.trim().slice(0, 120)
    // title 漏填兜底：取正文首句作标题，避免整轮工具调用因参数校验失败作废（作者明确要求兜底）
    if (typeof result.title !== 'string' || !result.title.trim()) {
      const content = typeof result.content === 'string' ? result.content.trim() : ''
      if (content) {
        const firstLine = content.split(/\r?\n/)[0].trim()
        const firstSentence = firstLine.split(/[。！？；!?;]/)[0].trim()
        result.title = (firstSentence || firstLine).slice(0, 40)
      }
    }
    if (typeof result.content === 'string') result.content = result.content.trim()
    const importance = Number(result.importance)
    result.importance = Number.isFinite(importance) ? Math.min(100, Math.max(1, Math.round(importance))) : 70
    if (typeof result.sourceChapterId !== 'string' || !result.sourceChapterId.trim()) delete result.sourceChapterId
    return result
  },
  permission: { plan: 'allow', build: 'allow', review: 'allow' },
  readOnly: false,
  async execute(ctx, args) {
    const evidence = await resolveMemorySource(ctx, args)
    const result = await saveStoryMemory({
      userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
      sourceChapterId: args.sourceChapterId ?? null, memoryType: args.memoryType,
      layer: ['novelSummary', 'storyBible', 'authorProfile', 'continuityRule'].includes(args.memoryType) ? 'L3' : ['chapterSummary', 'volumeSummary', 'storyArc', 'sceneState', 'relationshipState'].includes(args.memoryType) ? 'L2' : 'L1',
      title: args.title, content: args.content, importance: args.importance,
      confidence: evidence.confidence, status: 'inferred', agentGenerated: true,
      memoryId: args.memoryId ?? null,
      overwrite: args.overwrite === true,
      evidence,
    }, ctx.transaction)
    return {
      savedMemoryId: result.id,
      output: result.action === 'conflict'
        ? `记忆候选：[${args.memoryType}] ${args.title} 未覆盖旧事实，候选 ${result.id} 等待作者审核，尚未参与事实召回。`
        : `已${result.action === 'created' ? '保存' : '在原卡片上更新'}记忆 [${args.memoryType}] ${args.title}（重要性 ${args.importance}，含来源证据）。`,
      summary: result.action === 'conflict' ? `记忆冲突「${args.title}」` : `沉淀记忆「${args.title}」`,
    }
  },
})

export const planSaveTool = defineTool({
  name: 'plan_save',
  title: '写入计划',
  description:
    '把创作计划写入作品树「计划」文件夹。规划诉求必须落盘完整目标。长计划按完整小节分次写入，每次建议不超过2000字符且独立调用；首次保存首节，后续mode=append带planId和expectedContentHash追加，直到全部完成。修订已有计划必须传planId就地更新，不另建同名副本；默认replace替换全文，不传planId时同名自动更新。查看先plan_read，不重写代替读取。不要把计划全文粘贴在回复里。',
  parameters: z.object({
    title: z.string().min(2).max(60).describe('计划标题，如"第六章规划"'),
    content: z.string().min(1).describe('Markdown正文。长计划分完整小节写入，每次建议不超过2000字符且只调用一次plan_save；首次保存首节，后续mode=append追加，不能缩短原目标或把首节说成全文完成。禁止占位文本'),
    mode: z.enum(['replace', 'append']).optional().describe('默认replace替换全文；长计划用append逐节追加，每次等待回执再写下一节'),
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('append必填，使用最近plan_save或plan_read返回的contentHash，防重复追加与覆盖并发修改'),
    planId: z
      .string()
      .optional()
      .describe('要修订的既有计划 id（工具返回或上下文提供）。修订已有计划时必传；新建计划时不传'),
  }),
  // 校验前兜底修复：plan_save 是「参数校验失败」小概率事故的高发工具（长上下文下模型偶发
  // planId:null、标题超长/非字符串、参数嵌套一层、别名键），修好再进 zod，避免整次写入作废
  coerceArgs(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw
    }

    let obj = raw as Record<string, unknown>

    const asRecord = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      return value as Record<string, unknown>
    }
    const parseRecord = (value: unknown): Record<string, unknown> | null => {
      const direct = asRecord(value)
      if (direct) return direct
      if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
      try { return asRecord(JSON.parse(value)) } catch { return null }
    }

    // 模型偶发把参数包在 arguments/args/params 键里（把 function calling 内部结构当成参数），
    // 或该键值为字符串化 JSON：优先解包一层，避免「参数校验失败」把整次写入作废
    const unwrapWrapped = (record: unknown): Record<string, unknown> | null => {
      const candidate = parseRecord(record)
      return candidate && (candidate.title !== undefined || candidate.content !== undefined || candidate.text !== undefined || candidate.markdown !== undefined)
        ? candidate
        : null
    }
    for (const wrapKey of ['arguments', 'args', 'params', 'parameters', 'parameter', 'input', 'payload', 'tool_input', 'plan'] as const) {
      const wrapped = obj[wrapKey]
      const direct = unwrapWrapped(wrapped)
      if (direct) {
        obj = { ...direct, planId: obj.planId ?? direct.planId, mode: obj.mode ?? direct.mode, expectedContentHash: obj.expectedContentHash ?? direct.expectedContentHash }
        break
      }
    }

    // 某些兼容层把参数编码成 [{name, value}]，或把 content 再包成 {value/text}。
    const parameterList = Array.isArray(obj.parameters) ? obj.parameters : Array.isArray(obj.params) ? obj.params : null
    if (parameterList) {
      const flattened: Record<string, unknown> = {}
      for (const item of parameterList) {
        const entry = asRecord(item)
        const name = typeof entry?.name === 'string' ? entry.name : typeof entry?.key === 'string' ? entry.key : ''
        if (name) flattened[name] = entry?.value ?? entry?.content ?? entry?.text
      }
      if (flattened.title !== undefined || flattened.content !== undefined) obj = { ...obj, ...flattened }
    }

    // 模型偶发把参数嵌套一层（如 {"plan": {...}}）：根层缺 title/content 时展平
    if (obj.title === undefined && obj.content === undefined) {
      const nested = Object.values(obj).find(
        (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
      ) as Record<string, unknown> | undefined
      if (nested && (nested.title !== undefined || nested.content !== undefined)) {
        obj = { ...nested, planId: obj.planId ?? nested.planId, mode: obj.mode ?? nested.mode, expectedContentHash: obj.expectedContentHash ?? nested.expectedContentHash }
      }
    }

    const result: Record<string, unknown> = { ...obj }

    // 别名键兜底
    if (result.title === undefined) {
      result.title = result.name ?? result.planTitle
    }
    if (result.content === undefined) {
      result.content = result.text ?? result.markdown ?? result.body
    }
    if (result.content === 'undefined' || result.content === 'null') delete result.content
    const nestedContent = asRecord(result.content)
    if (nestedContent) {
      result.content = nestedContent.value ?? nestedContent.text ?? nestedContent.markdown ?? nestedContent.body
    }

    // 最后一层保守恢复：根对象里若只有一段明显的长文本，把它视为计划正文；ID、标题与说明不参与。
    if (result.content === undefined) {
      const candidates = Object.entries(result)
        .filter(([key, value]) => !['title', 'name', 'planTitle', 'planId', 'id', 'reason', 'summary', 'mode', 'expectedContentHash'].includes(key) && typeof value === 'string')
        .map(([, value]) => value as string)
        .filter((value) => value.trim().length >= 20)
        .sort((left, right) => right.length - left.length)
      if (candidates[0]) result.content = candidates[0]
    }

    // planId 空值（null 已在 loop 层剔除，这里再防空串）一律视为新建
    if (typeof result.planId !== 'string' || result.planId.trim().length === 0) {
      delete result.planId
    } else {
      result.planId = result.planId.trim()
    }

    // content 段落数组拼成全文
    if (Array.isArray(result.content)) {
      result.content = result.content
        .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
        .join('\n')
    } else if (typeof result.content === 'number' || typeof result.content === 'boolean') {
      result.content = String(result.content)
    }

    // title 非字符串/超长/过短兜底：数字转串、超长截断、缺失或过短从正文首个标题行派生
    if (typeof result.title === 'number') {
      result.title = String(result.title)
    }
    if (typeof result.title === 'string') {
      result.title = result.title.trim().slice(0, 60)
    }
    if (typeof result.title !== 'string' || result.title.length < 2) {
      const heading =
        typeof result.content === 'string' ? /^#{1,6}\s*(.+)$/m.exec(result.content)?.[1]?.trim() : undefined
      result.title = (heading && heading.length >= 2 ? heading : '创作计划').slice(0, 60)
    }

    return result
  },
  permission: { plan: 'allow', build: 'allow', review: 'deny' },
  readOnly: false,
  async execute(ctx, args): Promise<ToolResult> {
    if (ctx.durablePlan) {
      const capturedCtx = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), protectedChapterIds: new Set(ctx.protectedChapterIds) }
      const capturedArgs = { ...args }
      return executeDurablePlanSave(capturedCtx, capturedArgs,
        raw => Object.fromEntries(Object.entries(planSaveTool.parameters.parse(planSaveTool.coerceArgs!(raw))).filter(([, value]) => value !== undefined)),
        tx => planSaveTool.execute({ ...capturedCtx, durablePlan: undefined, transaction: tx }, capturedArgs))
    }
    const db = ctx.transaction ?? prisma
    const title = args.title.trim()
    ctx.signal.throwIfAborted()
    if (args.mode === 'append' && (!args.planId || !args.expectedContentHash)) return {
      outcome: 'failed', summary: '追加计划需要已保存的目标版本',
      output: '先用 plan_read 读取已保存计划，再带 planId、contentHash（作为expectedContentHash）及mode=append追加完整小节。未执行任何写入。',
    }

    // 优先 planId 精确定位；不传时按同作品同标题兜底去重，防止模型忘传 planId 导致重复落盘
    const existing = args.planId
      ? await db.agentArtifact.findFirst({
          where: {
            id: args.planId,
            artifactType: 'chapterPlan',
            run: { userId: ctx.userId, novelId: ctx.novelId },
          },
        })
      : await db.agentArtifact.findFirst({
          where: {
            artifactType: 'chapterPlan',
            title,
            metadata: { path: ['savedAsPlan'], equals: true },
            run: { userId: ctx.userId, novelId: ctx.novelId },
          },
          orderBy: { updatedAt: 'desc' },
        })

    if (args.planId && !existing) {
      return {
        output: `未找到 planId=${args.planId} 对应的计划，本次未执行任何写入。请核对 planId，或不传 planId 重试（同名计划会自动就地更新）。`,
        summary: '计划更新失败：planId 不存在',
        outcome: 'failed',
      }
    }

    // 防误清空护栏：模型偶发把占位文本当正文传入（如 "placeholder"），或把长计划覆盖成几句话，
    // 这里直接拦截不落库，并要求携带完整正文重试，避免既有计划被意外摧毁
    const appending = args.mode === 'append'
    if (existing && args.expectedContentHash && createHash('sha256').update(existing.content).digest('hex') !== args.expectedContentHash) return {
      outcome: 'failed', summary: '计划版本已变化，未重复写入', output: '先用 plan_read 核对当前正文及contentHash；确认本小节是否已保存，仅追加尚未保存的小节，不原样重试旧版本。',
    }
    const content = appending && existing ? `${existing.content}\n\n${args.content}` : args.content
    const contentHash = createHash('sha256').update(content).digest('hex')
    const nextContent = args.content.trim()
    const looksPlaceholder = /^(placeholder|todo|tbd|n\/a|待补充|待填充|待完善|占位|暂无|略)[\s.。…]*$/i.test(nextContent)
    const beforeLength = existing?.content.trim().length ?? 0
    const shrunkTooMuch =
      !appending && Boolean(existing) && beforeLength >= 200 && nextContent.length < Math.min(80, Math.ceil(beforeLength * 0.1))
    if (looksPlaceholder || shrunkTooMuch) {
      return {
        output: existing
          ? `已拦截本次计划更新：传入内容疑似占位或不完整（${nextContent.length} 字，原计划 ${beforeLength} 字），计划《${existing.title}》保持原样未被修改。${appending ? '追加必须传入一个完整小节，不能传占位文本；保留mode=append和expectedContentHash，不重发整份长计划。' : '替换必须传入完整正文；长计划新增内容应使用mode=append逐小节追加。'}请带上planId=${existing.id}重新调用；如确需删除计划请改用plan_delete。`
          : `已拦截本次计划写入：传入内容疑似占位文本（「${nextContent.slice(0, 20)}」），未创建任何计划。请携带完整的计划正文（Markdown 全文）重新调用 plan_save。`,
        summary: '计划写入已拦截：疑似占位/不完整内容',
        outcome: 'failed',
      }
    }

    if (existing) {
      const beforeTitle = existing.title
      const before = existing.content
      const metadata = {
        ...((existing.metadata as Record<string, unknown> | null) ?? {}),
        savedAsPlan: true,
      }
      ctx.signal.throwIfAborted()
      if (appending || args.expectedContentHash) {
        const saved = await db.agentArtifact.updateMany({
          where: { id: existing.id, content: existing.content, title: existing.title, updatedAt: existing.updatedAt },
          data: { title: appending ? existing.title : title, content, metadata: metadata as Prisma.InputJsonValue },
        })
        if (saved.count !== 1) return { outcome: 'failed', summary: '计划版本已变化，未追加', output: '并发修改已发生，未写入。请plan_read核对正文和contentHash后再继续，不能重复追加已保存小节。' }
        return { summary: `${appending ? '追加' : '更新'}计划《${appending ? existing.title : title}》 · ${args.content.length} 字`,
          output: `${appending ? '已追加一个完整小节' : '已按核对版本更新计划'}，planId=${existing.id}，contentHash=${contentHash}，累计${content.length}字。继续追加剩余小节直到原计划完整，不重复已保存内容。`,
          display: { kind: 'planDiff', artifactId: existing.id, title: appending ? existing.title : title, beforeTitle: existing.title, before: existing.content, after: content } }
      }
      const updated = await db.agentArtifact.update({
        where: { id: existing.id },
        data: { title, content: args.content, metadata: metadata as Prisma.InputJsonValue },
      })

      return {
        output: `已就地更新既有计划《${beforeTitle}》（planId=${updated.id}，contentHash=${contentHash}，${args.content.length} 字），没有新建副本。如长计划尚未完整，继续mode=append追加剩余小节；只有完成原目标后才向作者汇报完成。`,
        summary: `更新计划《${title}》 · ${args.content.length} 字`,
        display: {
          kind: 'planDiff',
          artifactId: updated.id,
          title,
          beforeTitle,
          before,
          after: args.content,
        },
      }
    }

    const artifact = await db.agentArtifact.create({
      data: {
        runId: ctx.runId,
        artifactType: 'chapterPlan',
        title,
        content: args.content,
        metadata: { savedAsPlan: true },
      },
    })

    return {
      output: `已把《${title}》写入计划文件夹（planId=${artifact.id}，contentHash=${contentHash}，${args.content.length} 字）。如长计划尚未完整，继续mode=append追加剩余小节；只有完成原目标后才向作者汇报完成。后续修订带planId就地更新，不新建副本。`,
      summary: `写入计划《${title}》 · ${args.content.length} 字`,
      display: { kind: 'planFile', artifactId: artifact.id, title, content: args.content },
    }
  },
})

export const planRenameTool = defineTool({
  name: 'plan_rename',
  title: '重命名计划',
  description:
    '就地重命名「计划」文件夹里的一份既有计划（只改标题，不动正文）。作者要求改计划名字时必须用本工具，禁止用 plan_save 另存一份新计划。',
  parameters: z.object({
    planId: z.string().min(1).describe('要重命名的计划 id（plan_save 返回或上下文提供）'),
    title: z.string().min(2).max(60).describe('新的计划标题'),
  }),
  permission: { plan: 'allow', build: 'allow', review: 'deny' },
  readOnly: false,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    const existing = await db.agentArtifact.findFirst({
      where: {
        id: args.planId,
        artifactType: 'chapterPlan',
        run: { userId: ctx.userId, novelId: ctx.novelId },
      },
    })

    if (!existing) {
      return {
        output: `未找到 planId=${args.planId} 对应的计划，未执行重命名。请核对 planId。`,
        summary: '计划重命名失败：planId 不存在',
        outcome: 'failed' as const,
      }
    }

    const beforeTitle = existing.title
    const title = args.title.trim()
    await db.agentArtifact.update({
      where: { id: existing.id },
      data: { title },
    })

    return {
      output: `已把计划《${beforeTitle}》重命名为《${title}》（planId=${existing.id}），没有新建副本。回复正文只允许一句话确认。`,
      summary: `重命名计划《${beforeTitle}》→《${title}》`,
      display: { kind: 'planRename', artifactId: existing.id, beforeTitle, title },
    }
  },
})

export const planDeleteTool = defineTool({
  name: 'plan_delete',
  title: '删除计划',
  description:
    '把一份既有计划从「计划」文件夹移除（不影响对话记录）。仅在作者明确要求删除/移除某份计划时调用。',
  parameters: z.object({
    planId: z.string().min(1).describe('要删除的计划 id'),
  }),
  permission: { plan: 'allow', build: 'ask', review: 'deny' },
  readOnly: false,
  async execute(ctx, args) {
    const db = ctx.transaction ?? prisma
    const existing = await db.agentArtifact.findFirst({
      where: {
        id: args.planId,
        artifactType: 'chapterPlan',
        run: { userId: ctx.userId, novelId: ctx.novelId },
      },
    })

    if (!existing) {
      return {
        output: `未找到 planId=${args.planId} 对应的计划，未执行删除。请核对 planId。`,
        summary: '计划删除失败：planId 不存在',
        outcome: 'failed' as const,
      }
    }

    const metadata = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
      savedAsPlan: false,
    }
    await db.agentArtifact.update({
      where: { id: existing.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    })

    return {
      output: `已把计划《${existing.title}》从计划文件夹移除（planId=${existing.id}）。回复正文只允许一句话确认。`,
      summary: `删除计划《${existing.title}》`,
      display: { kind: 'planDelete', artifactId: existing.id, title: existing.title },
    }
  },
})

export const planExitTool = defineTool({
  name: 'plan_exit',
  title: '提交计划',
  description:
    'Plan 模式专用：完成分析后调用此工具提交结构化计划并请求切换到 Build 执行。summary 是一句话总结，steps 是按执行顺序排列的步骤。',
  parameters: z.object({
    summary: z.string().min(1).max(300).describe('计划的一句话总结'),
    steps: z
      .array(
        z.object({
          title: z.string().min(1).max(120).describe('步骤标题'),
          detail: z.string().max(600).optional().describe('步骤说明'),
        }),
      )
      .min(1)
      .max(12)
      .describe('执行步骤列表'),
  }),
  permission: { plan: 'allow', build: 'deny', review: 'deny' },
  readOnly: true,
  async execute(_ctx, args) {
    return {
      output: '计划已提交给用户确认。请停止输出更多内容，等待用户决定是否执行。',
      summary: `提交计划 · ${args.steps.length} 步`,
      display: { kind: 'plan', summary: args.summary, steps: args.steps },
    }
  },
})
