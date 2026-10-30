import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { toOpenAIParameters, withObjectType, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { getToolsForMode, toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { novelImportArguments } from '../../api/lib/agent/tools/import-tools.js'
import { chapterCreateTool, chapterWriteTool, chapterAppendTool, chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { coordinatedWriterParameters } from '../../api/lib/agent/coordinated-writing-input.js'
import { chapterBridgeCommitTool, continuityValidateTool, storyCompilerPrepareTool, sceneTaskBuildTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { researchReportSaveTool } from '../../api/lib/agent/tools/search-tools.js'
import { researchReportSaveParameters } from '../../api/lib/agent/research-sources.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { TaskSpec } from '../../shared/contracts/index.js'
import { configureAgentTool } from '../../api/lib/agent/tools/configuration-tools.js'
import { agentModelSelectionSchema, modelReasoningEffortSchema } from '../../shared/contracts/agent-model-assignments.js'
import { toolWithNativeView } from '../../api/lib/agent/runtime-tool-view.js'

vi.mock('zod', async importOriginal => {
  const actual = await importOriginal<typeof import('zod')>()
  return { ...actual, z: { ...actual.z, toJSONSchema: vi.fn(actual.z.toJSONSchema) } }
})

it('preserves the exact pre-window agent_configure parameter schema for frozen calls', () => {
  const previous = z.object({ model: agentModelSelectionSchema.optional(), reasoningEffort: modelReasoningEffortSchema.optional(),
    creativeFreedom: z.enum(['stable', 'balanced', 'bold']).optional() }).strict()
    .refine(value => !!value.model || !!value.reasoningEffort || !!value.creativeFreedom)
    .refine(value => !value.model?.reasoningEffort || !value.reasoningEffort || value.model.reasoningEffort === value.reasoningEffort, '不能指定冲突的思考强度。')
  const alternatives = originalToolParameterSchemas(configureAgentTool, { novelId: 'novel' })
  expect(alternatives).toContainEqual(toOpenAIParameters(previous))
  const historical = z.fromJSONSchema(toOpenAIParameters(previous))
  expect(historical.safeParse({ model: { modelTier: 'speed' } }).success).toBe(true)
  expect(historical.safeParse({ sessionId: 'other', expectedRevision: 0, model: { modelTier: 'speed' } }).success).toBe(false)
  const actual = toolWithNativeView(configureAgentTool, { type: 'function', function: { name: 'agent_configure', description: '冻结旧窗口合同', parameters: toOpenAIParameters(previous) } }).parameters
  expect(actual.safeParse({ model: { modelTier: 'speed' } }).success).toBe(true)
  expect(actual.safeParse({ sessionId: 'other', expectedRevision: 0, model: { modelTier: 'speed' } }).success).toBe(false)
})

// 回归：novel_import 顶层 discriminatedUnion 转换后没有 type，DeepSeek 按 type null 拒绝，
// 导致线上继续任务时报 Invalid schema for function 'novel_import'。
describe('tool schema provider contract', () => {
  it.each([chapterWriteTool, chapterAppendTool, chapterEditRangeTool])('publishes ordinary $name parameters even with a historical marker while preserving the exact historical parser', tool => {
    const legacyScope: TaskSpec['scope'] = { novelId: 'novel' }, markedScope: TaskSpec['scope'] = { novelId: 'novel', writingCoordinationProtocol: 1 }
    const legacy = toOpenAIParameters(tool.parameters)
    expect(coordinatedWriterParameters(tool, legacyScope)).toBe(tool.parameters)
    expect(toOpenAITools([tool], legacyScope)[0].function.parameters).toEqual(legacy)
    expect(originalToolParameterSchemas(tool, legacyScope).every(schema => runtimeJson(schema).hash === runtimeJson(legacy).hash)).toBe(true)
    const marked = toOpenAITools([tool], markedScope)[0].function.parameters
    expect(marked).toEqual(legacy)
    expect(marked).not.toHaveProperty('properties.writing')
    const historical = toOpenAIParameters(coordinatedWriterParameters(tool, markedScope))
    expect(historical).toHaveProperty('properties.writing')
    expect(originalToolParameterSchemas(tool, markedScope)).toEqual([legacy, historical])
    const schema = coordinatedWriterParameters(tool, markedScope)
    const body = tool.name === 'chapter_edit_range' ? { oldText: '原文', newText: '新文' } : { content: '新文' }
    expect(schema.safeParse({ chapterId: 'chapter', ...body, writing: { draftComplete: false } }).success).toBe(true)
    expect(schema.safeParse({ chapterId: 'chapter', ...body, writing: { draftComplete: true } }).success).toBe(false)
    expect(schema.safeParse({ chapterId: 'chapter', ...body, writing: { draftComplete: false, skipChecks: true } }).success).toBe(false)
  })
  it('converts each schema only once per alternatives lookup while preserving scoped and legacy hashes', () => {
    const conversion = vi.mocked(z.toJSONSchema)
    try {
      for (const tool of [chapterCreateTool, storyCompilerPrepareTool, chapterBridgeCommitTool, continuityValidateTool, researchReportSaveTool]) {
        const scopes: TaskSpec['scope'][] = [{ novelId: 'n' }, { novelId: 'n', reviewProtocol: 1, writing: { version: 1, kind: 'bounded',
          targets: [{ orderIndex: 3, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false } }]
        for (const scope of scopes) {
          const expected = toOpenAITools([tool], scope)[0].function.parameters
          conversion.mockClear()
          const alternatives = originalToolParameterSchemas(tool, scope)
          expect(conversion).toHaveBeenCalledTimes(1)
          expect(alternatives.map(schema => runtimeJson(schema).hash)).toContain(runtimeJson(expected).hash)
        }
      }
    } finally { conversion.mockClear() }
  })
  it('keeps the pre-optional-title research report schema exactly without rewriting its frozen title field', () => {
    const previous = toOpenAIParameters(researchReportSaveParameters.extend({ title: z.string().trim().min(1).max(160) }))
    expect(originalToolParameterSchemas(researchReportSaveTool, { novelId: 'n' })).toContainEqual(previous)
    expect(previous.required).toEqual(['title', 'expectedRevision', 'section'])
  })
  it('keeps historical nested proof data parseable while current continuity presentation requires only current source identifiers', () => {
    const legacyCandidate = terminalCandidateSchema.extend({ inheritedProofs: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).optional() })
    const original = toOpenAIParameters(z.object({ terminalState: legacyCandidate.optional()
      .describe('写作交付前要提交的真实章末状态 {exitState,lastUnfinishedAction}；须在本次独立检查前给出。不能从场景计划抄事实，缺失信息保持未知。提交必须与此候选一致；单独审阅既有章省略。') }))
    const hash = runtimeJson(original).hash
    const current = toOpenAITools([continuityValidateTool], { novelId: 'n' })[0].function.parameters
    expect(Object.keys(current.properties as object).sort()).toEqual(['chapterId', 'compilationId', 'focus'])
    expect(current).not.toHaveProperty('properties.terminalState')
    expect(continuityValidateTool.parameters.safeParse({ chapterId: 'chapter' }).success).toBe(true)
    expect(continuityValidateTool.parameters.safeParse({ compilationId: 'comp' }).success).toBe(true)
    const parsed = legacyCandidate.parse({ exitState: {}, inheritedProofs: ['a'.repeat(64)] })
    expect(parsed.inheritedProofs).toEqual(['a'.repeat(64)])
    expect(runtimeJson(original).hash).toBe(hash)
  })
  it('publishes a complete compact native scene example accepted without generated state facts', () => {
    const example = sceneTaskBuildTool.description.split('最小原生参数示例：')[1]
    const input = JSON.parse(example)
    expect(Array.isArray(input.tasks)).toBe(true)
    expect(input.tasks).toHaveLength(1)
    expect(input.tasks[0]).not.toHaveProperty('content')
    const parsed = sceneTaskBuildTool.parameters.parse(normalizeToolInput(sceneTaskBuildTool, input))
    expect(parsed.tasks[0].entryState.knowledge).toEqual([])
    expect(parsed.tasks[0].exitState.objects).toEqual([])
    expect(parsed.tasks[0].purpose).toBe(input.tasks[0].purpose)
  })
  it('publishes one actual commit contract without a decision-only phase for both old and new task metadata', () => {
    const current = toOpenAIParameters(chapterBridgeCommitTool.parameters)
    for (const scope of [{ novelId: 'n' }, { novelId: 'n', reviewProtocol: 1 as const }]) {
      expect(toOpenAITools([chapterBridgeCommitTool], scope)[0].function.parameters).toEqual(current)
      expect(current).not.toHaveProperty('properties.decisionOnly')
      expect(current).not.toHaveProperty('properties.terminalState')
      expect(chapterBridgeCommitTool.parameters.safeParse({ compilationId: 'comp' }).success).toBe(true)
      expect(originalToolParameterSchemas(chapterBridgeCommitTool, scope)).toContainEqual(current)
    }
  })
  it('every published tool keeps top-level object parameters', () => {
    process.env.NOVEL_IMPORT_ENABLED = 'true'
    for (const mode of ['plan', 'build', 'review'] as const) {
      for (const definition of toOpenAITools(getToolsForMode(mode))) {
        expect(definition.function.parameters.type, definition.function.name).toBe('object')
        expect(definition.function.strict, definition.function.name).toBe(false)
      }
    }
  })

  it('novel_import union keeps oneOf constraints and gains object type', () => {
    const parameters = toOpenAIParameters(novelImportArguments)
    expect(parameters.type).toBe('object')
    expect(Array.isArray(parameters.oneOf)).toBe(true)
  })

  it('stored snapshots without top-level type are repaired identically to fresh conversion', () => {
    const legacy = z.toJSONSchema(novelImportArguments, { io: 'input' }) as Record<string, unknown>
    expect(legacy.type).toBeUndefined()
    const repaired = withObjectType(legacy)
    expect(repaired).toEqual(toOpenAIParameters(novelImportArguments))
    expect(withObjectType(repaired)).toEqual(repaired)
  })

  const globalScope: TaskSpec['scope'] = { novelId: 'synthetic-novel', writing: { version: 1, kind: 'bounded',
    targets: [{ orderIndex: 7, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false } }

  it('keeps optional object, scalar and array omission through a Responses-compatible gateway', () => {
    const scope: TaskSpec['scope'] = { ...globalScope, writing: { ...globalScope.writing!, tailVolume: {
      version: 1, targetOrderIndex: 7, previousChapterId: 'previous', previousRevision: 3 } } }
    // Synthetic gateway models the documented Responses strict default only;
    // it is not evidence that a particular live gateway uses this converter.
    const gateway = (fn: { strict?: boolean; parameters: Record<string, unknown> }) => fn.strict === false
      ? fn.parameters : { ...fn.parameters, required: Object.keys(fn.parameters.properties as object) }
    const fn = toOpenAITools([chapterCreateTool], scope)[0].function
    const before = structuredClone(fn.parameters)
    expect(gateway({ parameters: fn.parameters }).required).toContain('newVolume')
    expect(gateway(fn).required).toEqual(['title'])
    expect(z.fromJSONSchema(gateway(fn)).safeParse({ title: 'Synthetic next chapter' }).success).toBe(true)
    expect(z.fromJSONSchema(gateway({ parameters: fn.parameters })).safeParse({ title: 'Synthetic next chapter' }).success).toBe(false)
    expect(chapterCreateTool.parameters.safeParse({ title: 'Synthetic next chapter' }).success).toBe(true)
    expect(fn.parameters).toEqual(before)
    // This fix declares the existing protocol; it does not weaken required
    // title, accept null for omission or discard a real requested new volume.
    expect(chapterCreateTool.parameters.safeParse({ content: '' }).success).toBe(false)
    expect(chapterCreateTool.parameters.safeParse({ title: 'Synthetic', newVolume: null }).success).toBe(false)
    const optional = z.object({ title: z.string(), object: z.object({ value: z.string() }).optional(), scalar: z.number().optional(), array: z.array(z.string()).optional() })
    const parameters = toOpenAIParameters(optional)
    expect(z.fromJSONSchema(gateway({ strict: false, parameters })).safeParse({ title: 'fixture' }).success).toBe(true)
  })

  it('shows only title, content and the frozen optional global position for one new chapter', () => {
    const generic = toOpenAITools([chapterCreateTool])
    const definition = toOpenAITools([chapterCreateTool], globalScope)[0].function
    expect(definition.parameters).toMatchObject({ type: 'object', required: ['title'], additionalProperties: false,
      properties: { position: { type: 'integer', enum: [7] } } })
    expect(Object.keys(definition.parameters.properties as object).sort()).toEqual(['content', 'position', 'title'])
    expect(definition.description).toContain('冻结的全书第 7 章')
    expect(definition.description).toContain('只填 title 标题即可')
    expect(definition.description).toContain('不要猜测卷')
    expect(toOpenAITools([chapterCreateTool])).toEqual(generic)
    expect(chapterCreateTool.parameters.safeParse({ title: '合成标题' }).success).toBe(true)
    // Provider presentation never strips actual conflicting model arguments.
    expect(chapterCreateTool.parameters.safeParse({ title: '合成标题', position: 7, volumeOrder: 1, positionInVolume: 2 }).success).toBe(false)
    expect(chapterCreateTool.parameters.parse({ title: '合成标题', volumeOrder: 1, positionInVolume: 2 }))
      .toMatchObject({ volumeOrder: 1, positionInVolume: 2 })
  })

  it.each([
    ['no scope', undefined],
    ['no writing contract', { novelId: 'synthetic-novel' }],
    ['unbounded', { ...globalScope, writing: { ...globalScope.writing!, kind: 'unbounded' as const } }],
    ['needs input', { ...globalScope, writing: { ...globalScope.writing!, kind: 'needs_input' as const } }],
    ['no target', { ...globalScope, writing: { ...globalScope.writing!, targets: [] } }],
    ['multiple targets', { ...globalScope, writing: { ...globalScope.writing!, targets: [{ orderIndex: 7, chapterId: null }, { orderIndex: 8, chapterId: null }] } }],
    ['existing chapter', { ...globalScope, writing: { ...globalScope.writing!, targets: [{ orderIndex: 7, chapterId: 'existing-chapter' }] } }],
    ['explicit volume', { ...globalScope, writing: { ...globalScope.writing!, targets: [{ orderIndex: 7, chapterId: null, volumeId: 'volume' }] } }],
    ['explicit local position', { ...globalScope, writing: { ...globalScope.writing!, targets: [{ orderIndex: 7, chapterId: null, positionInVolume: 2 }] } }],
    ...[0, -1, 1.5, NaN, Infinity].map(orderIndex => [`invalid order ${orderIndex}`, { ...globalScope,
      writing: { ...globalScope.writing!, targets: [{ orderIndex, chapterId: null }] } }] as const),
  ] as const)('keeps the generic schema for %s', (_name, scope) => {
    expect(toOpenAITools([chapterCreateTool], scope)).toEqual(toOpenAITools([chapterCreateTool]))
  })

  it('changes only chapter creation/preparation presentation without mutating shared parameter definitions', () => {
    const tools = getToolsForMode('build')
    const generic = toOpenAITools(tools)
    const originalScope = structuredClone(globalScope)
    const narrowed = toOpenAITools(tools, globalScope)
    const others = (definitions: typeof generic) => definitions.filter(item => !['chapter_create', 'story_compiler_prepare'].includes(item.function.name))
    expect(others(narrowed)).toEqual(others(generic))
    expect(toOpenAITools(tools)).toEqual(generic)
    expect(globalScope).toEqual(originalScope)
  })
  it('prepares frozen new chapter49 without offering previous chapterId and retains exact old tail-volume schema', () => {
    const scope: TaskSpec['scope'] = { novelId: 'n', writing: { ...globalScope.writing!, targets: [{ chapterId: null, orderIndex: 49 }],
      tailVolume: { version: 1, targetOrderIndex: 49, previousChapterId: 'previous48', previousRevision: 6 } } }
    const original = structuredClone(scope)
    const presentation = toOpenAITools([storyCompilerPrepareTool], scope)[0].function
    expect(presentation.parameters.properties).not.toHaveProperty('chapterId')
    expect(presentation.parameters).toMatchObject({ required: ['intentSummary', 'volumeDecision'], additionalProperties: false,
      properties: { targetOrderIndex: { enum: [49] } } })
    expect(presentation.description).toContain('前章只作参考')
    expect(presentation.description).toContain('冻结的全书第 49 章')
    const full = toOpenAIParameters(storyCompilerPrepareTool.parameters)
    const previous = { ...full, required: [...new Set([...(full.required as string[]), 'volumeDecision'])] }
    expect(originalToolParameterSchemas(storyCompilerPrepareTool, scope)).toContainEqual(previous)
    expect(previous.properties).toHaveProperty('chapterId')
    expect(originalToolParameterSchemas(storyCompilerPrepareTool, scope)).not.toContainEqual({ ...presentation.parameters,
      properties: { ...presentation.parameters.properties as object, targetOrderIndex: { type: 'integer', enum: [50] } } })
    expect(scope).toEqual(original)
  })
})


it('adds the terminal response schema only to fresh marked task catalogs without changing existing schemas', async () => {
  const { buildTaskSpec, renderTaskSpec } = await import('../../api/lib/agent/task-spec.js')
  const { restrictToolsToTask } = await import('../../api/lib/agent/tool-authority.js')
  const { taskRespondTool } = await import('../../api/lib/agent/tools/task-response-tool.js')
  const legacy = buildTaskSpec({ runId: 'old-run', novelId: 'novel', prompt: '第一卷要写多少章？', authorWritingProtocol: 2 })
  const fresh = { ...legacy, responseDeliveryProtocol: 1 as const }
  const available = getToolsForMode('build')
  const oldTools = toOpenAITools(restrictToolsToTask(available, legacy), legacy.scope)
  const newTools = toOpenAITools(restrictToolsToTask(available, fresh), fresh.scope)
  expect(oldTools.some(tool => tool.function.name === 'task_respond')).toBe(false)
  expect(newTools.filter(tool => tool.function.name !== 'task_respond')).toEqual(oldTools)
  expect(runtimeJson(newTools).hash).not.toBe(runtimeJson(oldTools).hash)
  const native = newTools.find(tool => tool.function.name === 'task_respond')!
  expect(native.function.parameters).toMatchObject({ type: 'object', required: ['answer'], additionalProperties: false })
  expect(taskRespondTool.parameters.safeParse({ answer: '二十章。', runId: 'foreign' }).success).toBe(false)
  expect(taskRespondTool.parameters.safeParse({ answer: '   ' }).success).toBe(false)
  expect(taskRespondTool.parameters.parse({ answer: '二十章。\n保留原样。' })).toEqual({ answer: '二十章。\n保留原样。' })
  expect(renderTaskSpec(fresh)).toContain('实际交付由你根据完整原始用户请求拆解')
  expect(renderTaskSpec(legacy)).not.toContain('task_respond')
  expect(fresh.scope).toEqual(legacy.scope)
})


it('keeps the terminal response schema main-only even under a marked parent authority', async () => {
  const { getAgentDefinition, getToolsForAgent } = await import('../../api/lib/agent/agents.js')
  const { snapshotToolAuthority, intersectToolAuthority } = await import('../../api/lib/agent/tool-authority.js')
  const main = getToolsForAgent(getAgentDefinition('orchestrator'), 'build', undefined, { taskResponse: true })
  const parent = snapshotToolAuthority(main, 'build')
  expect(parent.has('task_respond')).toBe(true)
  for (const profile of ['research', 'continuity', 'quality', 'lore']) {
    const child = getToolsForAgent(getAgentDefinition(profile), 'review')
    expect(intersectToolAuthority(child, 'review', parent).some(tool => tool.name === 'task_respond')).toBe(false)
    expect(getToolsForAgent(getAgentDefinition(profile), 'review', undefined, { taskResponse: true })
      .some(tool => tool.name === 'task_respond')).toBe(true)
  }
})
