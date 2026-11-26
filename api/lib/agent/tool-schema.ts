import { chapterReviewWorkflowEnabled } from './chapter-review-rollout.js'
import { sequentialWritingEnabled } from './sequential-writing-rollout.js'
import { z } from 'zod'
import { legacyMemorySaveParameters, legacyMemorySearchParameters, previousMemorySaveParameters } from './memory-tool-parameters.js'
import { storyCharterInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'
import { coordinatedWriterActions, coordinatedWriterParameters } from './coordinated-writing-input.js'
import { novelImportArguments, novelImportModelArguments } from './tools/import-arguments.js'
import { legacyAskUserParameters, previousBatchAskUserParameters, QUESTION_OPTION_LIMIT } from './tools/interact-tools.js'

/** 保证 function parameters 顶层 type 为 object，保留原有参数约束。 */
export function withObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === 'object' ? schema : { ...schema, type: 'object' }
}

/** zod schema → OpenAI function calling 参数定义（zod v4 原生转换 + 顶层 object 保证） */
export function toOpenAIParameters(parameters: z.ZodType): Record<string, unknown> {
  return withObjectType(z.toJSONSchema(parameters, { io: 'input' }) as Record<string, unknown>)
}

const LEGACY_QUALITY_REVIEW_DESCRIPTION = 'Humanity Quality Gate 的 CHECK 步骤。用于评估整章或完整长场景的人类感质量：当作者明确要求判断「有没有 AI 味 / 像不像 AI 写的」「文风是否自然、像真人」「要不要通篇精修润色」，或在整章写完要求深度审阅、或 Story Compiler 进入 CHECK 时，都必须调用本工具，而不是自己只读正文下结论。服务端先运行确定性统计，再启动与 Writer 隔离的 Critic；每条模型意见必须逐字定位正文才能保存。严谨创作可在本任务可写范围内有界自动修订。只看不改或改后只读复核传 readOnly=true。平衡创作与大胆创作只展示报告。标题、元数据、局部错字、单句润色、纯剧情/设定/写作建议等普通问答禁止触发。不得把科幻术语、华丽文风、口语或无悬念结尾按词表误判。'

const importModelParameters = toOpenAIParameters(novelImportModelArguments)
const previousWritingDescriptions: Record<string, string> = {
  chapter_create: "建立只有标题与位置的空章节，取得真实 chapterId；本工具负责章节身份和结构，正文由后续 chapter_write 写入。默认title只写实际章名，不重复章号或书名号；作者明确命名照其要求。作者说“全书第 N 章”时只传 position=N；作者说“第 M 卷第 N 章/卷内第 N 章”时传 volumeOrder=M（或 volumeId）与 positionInVolume=N，两个坐标系不得混用。沿用现有卷时不要传newVolume；新任务需要新卷时先用volume_create取得真实volumeId；newVolume保留旧冻结请求兼容。未指定位置时紧接全书最后一个已有章节。已有目标或恢复时先核对真实身份，复用已绑定章节；已有正文先读后按原请求修改，不重建或覆盖已完成内容。创建成功后使用返回的 chapterId 调用 chapter_write，不能把创建空章说成正文已写完。",
  chapter_write: "用新内容整体覆盖指定章节的正文。标题由独立 title 字段展示，正文默认从叙事开始，并沿用前章排版，不在正文首行重复章号或章名；作者明确要求正文含标题或作品已有此格式时照其要求。需要已存在的 chapterId（新章节请先 chapter_create）。覆盖前建议先 chapter_read 了解现有内容；如只是接着写请用 chapter_append。覆盖前必须确认该章节确实是作者所指：作者按「第N章」指称时，若该排位章节的标题序号对不上（作者删过章导致错位），不要覆盖，改用 chapter_create 传 position 在正确位置插入。",
  chapter_append: "把生成的内容追加到指定章节正文末尾（自动补一个空行分隔），用于续写场景。",
  plan_save: "把创作计划写入作品树「计划」文件夹。规划诉求必须落盘完整目标。长计划按完整小节分次写入，每次建议不超过2000字符且独立调用；首次保存首节，后续mode=append带planId和expectedContentHash追加，直到全部完成。修订已有计划必须传planId就地更新，不另建同名副本；新建时planKind必须明确outline大纲或detail细纲；大纲管主线、阶段、转折、结局，细纲管单章行动、冲突、结果、人物场景、伏笔衔接。细纲用parentPlanId和expectedParentPlanHash绑定已读取大纲，用target绑定真实chapterId或future全书序号；未关联草稿不能用于章节执行。修订typed计划带planHash作为expectedPlanHash；父大纲变化后明确核对并提交expectedParentPlanHash。默认replace替换全文，无planId只在相同类型、父大纲和目标内匹配。查看先plan_read，不重写代替读取。不要把计划全文粘贴在回复里。",
}

function previousChapterBody(name: string, schema: Record<string, unknown>) {
  const description = name === 'chapter_write' ? '目标章节 ID；缺省时默认写入最近操作/当前正在编辑的章节'
    : '目标章节 ID；缺省时默认追加到最近操作/当前正在编辑的章节'
  const properties = schema.properties as Record<string, Record<string, unknown>>
  return { ...schema, properties: Object.fromEntries(Object.entries(properties)
    .filter(([key]) => key !== 'targetOrderIndex')
    .map(([key, value]) => [key, key === 'chapterId' ? { ...value, description } : value])) }
}

/** Execution still parses the original full schema and validates scope. */
export function toOpenAIToolPresentation(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, scope?: TaskSpec['scope'], baseParameters?: Record<string, unknown>): { strict: false; description: string; parameters: Record<string, unknown> } {
  if (tool.name === 'quality_analyze' && !chapterReviewWorkflowEnabled({ scope })) {
    tool = { ...tool, description: LEGACY_QUALITY_REVIEW_DESCRIPTION }
  }
  const sequential = sequentialWritingEnabled({ scope })
  if (!sequential && previousWritingDescriptions[tool.name]) tool = { ...tool, description: previousWritingDescriptions[tool.name] }
  // Chat defaults to non-strict; Responses may normalize an omitted strict
  // flag and make optional fields required. Keep our existing omission-based
  // input contract explicit across compatible API gateways.
  const base = baseParameters ?? toOpenAIParameters(tool.parameters)
  const parameters = !sequential && (tool.name === 'chapter_write' || tool.name === 'chapter_append')
    ? previousChapterBody(tool.name, base) : base
  if (tool.name === 'ask_user' && !scope?.agentQuestionProtocol) {
    const legacy = toOpenAIParameters(legacyAskUserParameters)
    const properties = legacy.properties as Record<string, Record<string, unknown>>
    const single = { ...legacy, properties: { ...properties, options: { ...properties.options, maxItems: QUESTION_OPTION_LIMIT,
      description: '提供 2–3 个文字选项，首项为推荐。界面另提供自定义回答。' } } }
    return { strict: false, ...toolPresentation({
      ...tool,
      description: '仅在确实需要作者决定时提问。一次发一道题，使用 question 和 options，提供 2–3 个文字选项。收到回答后继续处理原任务。',
    }, single, scope) }
  }
  return { strict: false, ...toolPresentation(tool, parameters, scope) }
}

function toolPresentation(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, parameters: Record<string, unknown>, scope?: TaskSpec['scope']): { description: string; parameters: Record<string, unknown> } {
  if (tool.name === 'novel_import' && tool.parameters === novelImportArguments) {
    return { description: tool.description, parameters: structuredClone(importModelParameters) }
  }
  // New model calls create identity/structure only. The execution schema keeps
  // content for already-frozen legacy requests; never rewrite their snapshots.
  if (tool.name === 'chapter_create') {
    const properties = parameters.properties as Record<string, unknown>
    return { description: tool.description, parameters: { ...parameters,
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'content')),
      required: (parameters.required as string[] ?? []).filter(key => key !== 'content') } }
  }
  if (tool.name === 'novel_update_meta' && scope?.novelInitializationProtocol && scope.novelInitializationTarget === 'empty') {
    return { description: `${tool.description} 完整初始化时一次提供title、summary与tags；缺字段不会保存任何内容。单项修改任务仍可只传所需字段。`, parameters }
  }
  if (tool.name === 'ask_user') {
    const required = [...new Set([...(parameters.required as string[] ?? []), ...(scope?.novelDirectionRequired ? ['purpose'] : [])])]
    const properties = parameters.properties as Record<string, Record<string, unknown>> | undefined
    if (properties?.questions) {
      const question = properties.questions.items as { properties?: Record<string, Record<string, unknown>> } | undefined
      const currentOptions = properties.options?.items as { properties?: Record<string, unknown> } | undefined
      const presented = currentOptions?.properties?.coverAssetId && question?.properties?.options ? { ...properties,
        options: { ...properties.options, maxItems: QUESTION_OPTION_LIMIT }, questions: { ...properties.questions,
          items: { ...question, properties: { ...question.properties, options: { ...question.properties.options, maxItems: QUESTION_OPTION_LIMIT } } } },
      } : properties
      return { description: tool.description, parameters: { ...parameters, properties: presented,
        required: required.filter(field => field !== 'question' && field !== 'options'),
        anyOf: [{ required: ['question', 'options'] }, { required: ['questions'] }] } }
    }
    if (scope?.novelDirectionRequired) return { description: tool.description, parameters: { ...parameters, required } }
  }
  return { description: tool.description, parameters }
}

/** Exact alternatives for immutable legacy or server-frozen presentations.
 * Callers must supply scope from the verified original task, never model input. */
export function originalToolParameterSchemas(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, scope: TaskSpec['scope']): Record<string, unknown>[] {
  const hasChapterPosition = tool.name === 'chapter_write' || tool.name === 'chapter_append'
  if (scope.writingCoordinationProtocol && coordinatedWriterActions.some(name => name === tool.name)) {
    const original = [toOpenAIParameters(tool.parameters), toOpenAIParameters(coordinatedWriterParameters(tool, scope))]
    return hasChapterPosition ? [...original, ...original.map(schema => previousChapterBody(tool.name, schema))] : original
  }
  const current = toOpenAIParameters(tool.parameters)
  if (hasChapterPosition) return [current, previousChapterBody(tool.name, current)]
  if (tool.name === 'memory_search') return [current, toOpenAIParameters(legacyMemorySearchParameters)]
  if (tool.name === 'memory_save') {
    const legacy = toOpenAIParameters(legacyMemorySaveParameters)
    const properties = legacy.properties as Record<string, Record<string, unknown>>
    // Previously prepared operations retain their exact published descriptions.
    return [current, toOpenAIParameters(previousMemorySaveParameters), legacy, { ...legacy, properties: {
      ...properties,
      sourceChapterId: { ...properties.sourceChapterId, description: '来源章节 ID（章节摘要必填）' },
      sourceQuote: { ...properties.sourceQuote, description: '仅用于来源章节的逐字原文，必须同时传真实sourceChapterId。规划/待定设定不是章节证据，不把摘要或计划包装成引用；无章节依据时仅提交待审候选，不传revision/sourceQuote' },
      memoryId: { ...properties.memoryId, description: '要修订的既有记忆卡片id；提交关联候选，作者确认前保留旧卡' },
      overwrite: { ...properties.overwrite, description: '旧客户端兼容参数，不授予自动覆盖或作者确认权限' },
    } }]
  }
  if (tool.name === 'story_charter_save') return [current, toOpenAIParameters(storyCharterInputSchema)]
  if (tool.name === 'ask_user') {
    const legacy = toOpenAIParameters(legacyAskUserParameters)
    const previousBatch = toOpenAIParameters(previousBatchAskUserParameters)
    const legacyProperties = legacy.properties as Record<string, unknown>
    return [current, toolPresentation(tool, current, scope).parameters, toOpenAIToolPresentation(tool, scope, current).parameters,
      previousBatch, toolPresentation(tool, previousBatch, scope).parameters,
      legacy, toolPresentation(tool, legacy, scope).parameters,
      { ...legacy, properties: Object.fromEntries(Object.entries(legacyProperties).filter(([key]) => key !== 'purpose')) }]
  }
  const additive = tool.name === 'chapter_create' ? 'newVolume' : tool.name === 'story_compiler_prepare' ? 'volumeDecision' : tool.name === 'chapter_bridge_commit' ? 'decisionOnly' : null
  const legacy = additive && current.properties && typeof current.properties === 'object'
    ? { ...current, properties: Object.fromEntries(Object.entries(current.properties).filter(([key]) => key !== additive)) } : null
  const previousPrepare = tool.name === 'story_compiler_prepare' && scope.writing?.tailVolume
    ? { ...current, required: [...new Set([...(current.required as string[] ?? []), 'volumeDecision'])] } : null
  const properties = current.properties as Record<string, Record<string, unknown>> | undefined
  const previousConfiguration = tool.name === 'agent_configure' && properties?.sessionId && properties?.expectedRevision
    ? { ...current, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'sessionId' && key !== 'expectedRevision')) } : null
  const terminalState = properties?.terminalState
  const previousTerminal = tool.name === 'continuity_validate' && terminalState?.properties
    ? { ...current, properties: { ...properties, terminalState: { ...terminalState,
      properties: Object.fromEntries(Object.entries(terminalState.properties).filter(([key]) => key !== 'inheritedProofs')) } } } : null
  const withoutTopLevelProofs = (schema: Record<string, unknown>) => ({ ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>).filter(([key]) => key !== 'inheritedProofs')) })
  const previousProofSelection = tool.name === 'continuity_validate' && properties?.inheritedProofs
    ? [withoutTopLevelProofs(current), ...(previousTerminal ? [withoutTopLevelProofs(previousTerminal)] : [])] : []
  const previousResearch = tool.name === 'research_report_save' && properties?.title
    ? { ...current, properties: { ...properties, title: Object.fromEntries(Object.entries(properties.title).filter(([key]) => key !== 'description')) },
      required: Object.keys(properties).filter(key => key === 'title' || (current.required as string[] ?? []).includes(key)) } : null
  const previousPatch = tool.name === 'continuity_validate' && properties?.terminalPatch
    ? { ...current, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'terminalPatch')) } : null
  const oldTerminal = previousTerminal && previousPatch ? { ...previousTerminal,
    properties: Object.fromEntries(Object.entries(previousTerminal.properties).filter(([key]) => key !== 'terminalPatch')) } : null
  const previousVolumeCreate = tool.name === 'volume_create' ? { ...current, properties: Object.fromEntries(Object.entries(current.properties as Record<string, unknown>).filter(([key]) => key !== 'boundary' && key !== 'targetOrderIndex')) } : null
  const previousNovelMetadata = tool.name === 'novel_update_meta' ? { ...current, properties: Object.fromEntries(Object.entries(current.properties as Record<string, unknown>).filter(([key]) => key !== 'title')) } : null
  return [current, toolPresentation(tool, current, scope).parameters, ...(previousNovelMetadata ? [previousNovelMetadata] : []), ...(previousVolumeCreate ? [previousVolumeCreate] : []), ...(previousConfiguration ? [previousConfiguration] : []), ...(legacy ? [legacy] : []), ...(previousPrepare ? [previousPrepare] : []),
    ...(previousPatch ? [previousPatch, withoutTopLevelProofs(previousPatch), ...(oldTerminal ? [oldTerminal, withoutTopLevelProofs(oldTerminal)] : [])] : []),
    ...(previousProofSelection.length ? previousProofSelection : previousTerminal ? [previousTerminal] : []), ...(previousResearch ? [previousResearch] : [])]
}
