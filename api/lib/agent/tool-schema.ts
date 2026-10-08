import { z } from 'zod'
import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'

/** 保证 function parameters 顶层 type 为 object。
 * 供应商（DeepSeek/OpenAI）要求函数参数顶层 type 必须是 object：顶层联合（oneOf/anyOf，
 * 如 novel_import 的 discriminatedUnion）转换后没有 type，会被供应商按 type null 拒绝，
 * 联合约束仍保留在 oneOf/anyOf 中，语义不变。 */
export function withObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === 'object' ? schema : { ...schema, type: 'object' }
}

/** zod schema → OpenAI function calling 参数定义（zod v4 原生转换 + 顶层 object 保证） */
export function toOpenAIParameters(parameters: z.ZodType): Record<string, unknown> {
  return withObjectType(z.toJSONSchema(parameters, { io: 'input' }) as Record<string, unknown>)
}

/** Only a deterministic server-frozen global slot gets simpler presentation.
 * Execution still parses the original full schema and validates scope. */
export function toOpenAIToolPresentation(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, scope?: TaskSpec['scope']): { description: string; parameters: Record<string, unknown> } {
  const parameters = toOpenAIParameters(tool.parameters)
  const writing = scope?.writing
  const target = writing?.kind === 'bounded' && writing.targets.length === 1 ? writing.targets[0] : undefined
  const globalNewChapter = target?.chapterId === null && Number.isSafeInteger(target.orderIndex) && target.orderIndex > 0
    && target.volumeId === undefined && target.positionInVolume === undefined ? target.orderIndex : undefined
  if (tool.name === 'story_compiler_prepare') {
    const properties = parameters.properties as Record<string, unknown>
    const required = [...new Set([...(parameters.required as string[] ?? []), ...(writing?.tailVolume ? ['volumeDecision'] : [])])]
    return {
      description: `${tool.description}${globalNewChapter !== undefined ? ` 本任务目标为冻结的全书第 ${globalNewChapter} 章，前章只作参考，禁止把前章chapterId填作目标。只填intentSummary，targetOrderIndex可省略；若填必须为${globalNewChapter}，服务端会沿本任务定位新章或已创建的绑定章节。` : ''}${writing?.tailVolume ? ' 本任务必须显式填写volumeDecision：当前卷尚未收束时填continue与理由；真实收束且进入新阶段才填new_volume与证据。现有卷不是newVolume，章数不决定切卷。' : ''}`,
      parameters: globalNewChapter === undefined ? { ...parameters, required } : { type: 'object', properties: {
        intentSummary: properties.intentSummary, volumeDecision: properties.volumeDecision,
        targetOrderIndex: { ...(properties.targetOrderIndex as Record<string, unknown>), enum: [globalNewChapter] },
      }, required, additionalProperties: false },
    }
  }
  if (tool.name !== 'chapter_create' || globalNewChapter === undefined) return { description: tool.description, parameters }
  const properties = parameters.properties as Record<string, unknown>
  return {
    description: `在当前作品创建本任务冻结的全书第 ${globalNewChapter} 章。服务器按原任务合同定位，只填 title 标题即可，content 正文可选。默认title只写实际章名，不重复章号或书名号；作者明确命名照其要求。若传 position，只能为 ${globalNewChapter}；不要猜测卷 ID、卷序号或卷内位置。${writing?.tailVolume ? '每次续写先在PREPARE审视卷目标；continue决定创建时省略newVolume和所有卷坐标，服务端沿用当前卷。真实收束且已保存new_volume决定时，只传同一newVolume创建尾卷与此章；不得把现有卷填写为newVolume。缺证据留当前卷，不能按章数切卷。' : ''}创建成功后复用返回的 chapterId 写正文，不要重复建章。`,
    parameters: { type: 'object', properties: { title: properties.title, content: properties.content,
      ...(writing?.tailVolume ? { newVolume: properties.newVolume } : {}),
      position: { ...(properties.position as Record<string, unknown>), enum: [globalNewChapter] } }, required: ['title'], additionalProperties: false },
  }
}

/** Exact alternatives for immutable legacy or server-frozen presentations.
 * Callers must supply scope from the verified original task, never model input. */
export function originalToolParameterSchemas(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, scope: TaskSpec['scope']): Record<string, unknown>[] {
  const current = toOpenAIParameters(tool.parameters)
  const additive = tool.name === 'chapter_create' ? 'newVolume' : tool.name === 'story_compiler_prepare' ? 'volumeDecision' : null
  const legacy = additive && current.properties && typeof current.properties === 'object'
    ? { ...current, properties: Object.fromEntries(Object.entries(current.properties).filter(([key]) => key !== additive)) } : null
  const previousPrepare = tool.name === 'story_compiler_prepare' && scope.writing?.tailVolume
    ? { ...current, required: [...new Set([...(current.required as string[] ?? []), 'volumeDecision'])] } : null
  return [current, toOpenAIToolPresentation(tool, scope).parameters, ...(legacy ? [legacy] : []), ...(previousPrepare ? [previousPrepare] : [])]
}
