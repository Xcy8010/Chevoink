import { z } from 'zod'
import { storyCharterInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import type { TaskSpec } from '../../../shared/contracts/index.js'
import type { AgentTool } from './tools/types.js'
import { coordinatedWriterActions, coordinatedWriterParameters } from './coordinated-writing-input.js'
import { novelImportArguments, novelImportModelArguments } from './tools/import-arguments.js'

/** 保证 function parameters 顶层 type 为 object，保留原有参数约束。 */
export function withObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === 'object' ? schema : { ...schema, type: 'object' }
}

/** zod schema → OpenAI function calling 参数定义（zod v4 原生转换 + 顶层 object 保证） */
export function toOpenAIParameters(parameters: z.ZodType): Record<string, unknown> {
  return withObjectType(z.toJSONSchema(parameters, { io: 'input' }) as Record<string, unknown>)
}

const importModelParameters = toOpenAIParameters(novelImportModelArguments)

/** Execution still parses the original full schema and validates scope. */
export function toOpenAIToolPresentation(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, scope?: TaskSpec['scope'], baseParameters?: Record<string, unknown>): { strict: false; description: string; parameters: Record<string, unknown> } {
  // Chat defaults to non-strict; Responses may normalize an omitted strict
  // flag and make optional fields required. Keep our existing omission-based
  // input contract explicit across compatible API gateways.
  return { strict: false, ...toolPresentation(tool, baseParameters ?? toOpenAIParameters(tool.parameters), scope) }
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
  if (tool.name === 'ask_user' && scope?.novelDirectionRequired) {
    return { description: tool.description, parameters: { ...parameters,
      required: [...new Set([...(parameters.required as string[] ?? []), 'purpose'])] } }
  }
  return { description: tool.description, parameters }
}

/** Exact alternatives for immutable legacy or server-frozen presentations.
 * Callers must supply scope from the verified original task, never model input. */
export function originalToolParameterSchemas(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>, scope: TaskSpec['scope']): Record<string, unknown>[] {
  if (scope.writingCoordinationProtocol && coordinatedWriterActions.some(name => name === tool.name)) {
    return [toOpenAIParameters(tool.parameters), toOpenAIParameters(coordinatedWriterParameters(tool, scope))]
  }
  const current = toOpenAIParameters(tool.parameters)
  if (tool.name === 'story_charter_save') return [current, toOpenAIParameters(storyCharterInputSchema)]
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
  const previousQuestion = tool.name === 'ask_user' && properties?.purpose ? { ...current, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'purpose')) } : null
  return [current, toolPresentation(tool, current, scope).parameters, ...(previousQuestion ? [previousQuestion] : []), ...(previousNovelMetadata ? [previousNovelMetadata] : []), ...(previousVolumeCreate ? [previousVolumeCreate] : []), ...(previousConfiguration ? [previousConfiguration] : []), ...(legacy ? [legacy] : []), ...(previousPrepare ? [previousPrepare] : []),
    ...(previousPatch ? [previousPatch, withoutTopLevelProofs(previousPatch), ...(oldTerminal ? [oldTerminal, withoutTopLevelProofs(oldTerminal)] : [])] : []),
    ...(previousProofSelection.length ? previousProofSelection : previousTerminal ? [previousTerminal] : []), ...(previousResearch ? [previousResearch] : [])]
}
