import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { toOpenAIParameters, toOpenAIToolPresentation, withObjectType, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { getToolByName, getToolsForMode, toOpenAITools } from '../../api/lib/agent/tools/registry.js'
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
import { toolWithNativeView, projectNativeToolViews, hasRetiredNativeArguments, readFrozenModelToolViews, readPreparedModelRequest } from '../../api/lib/agent/runtime-tool-view.js'

vi.mock('zod', async importOriginal => {
  const actual = await importOriginal<typeof import('zod')>()
  return { ...actual, z: { ...actual.z, toJSONSchema: vi.fn(actual.z.toJSONSchema) } }
})

describe('registered built-in parameter cache', () => {
  it('converts a registered base once and deeply isolates every returned nested object and array', () => {
    const tool = getToolByName('novel_import')!
    const expected = toOpenAIToolPresentation(tool).parameters, conversion = vi.mocked(z.toJSONSchema)
    conversion.mockClear()
    try {
      const first = toOpenAITools([tool])[0].function
      expect(conversion).toHaveBeenCalledTimes(1)
      const second = toOpenAITools([tool])[0].function
      expect(conversion).toHaveBeenCalledTimes(1)
      const properties = first.parameters.properties as Record<string, { enum: string[] }>
      const required = first.parameters.required as string[]
      properties.action.enum.push('foreign-action')
      required.push('foreign-field')
      properties.foreign = { enum: ['foreign'] }
      expect(second.parameters).toEqual(expected)
      expect(toOpenAITools([tool])[0].function.parameters).toEqual(expected)
      const renamed = toOpenAITools([{ ...tool, description: 'Current synthetic description' }])[0].function
      expect(renamed.description).toBe('Current synthetic description')
      expect(renamed.strict).toBe(false)
      expect(renamed.parameters.type).toBe('object')
      expect(conversion).toHaveBeenCalledTimes(1)
      expect(first.parameters).not.toBe(second.parameters)
      expect(first.parameters.properties).not.toBe(second.parameters.properties)
    } finally { conversion.mockClear() }
  })
  it('reapplies current scope presentation without leaking initialization guidance or nested mutations', () => {
    const tool = getToolByName('novel_update_meta')!, generic = toOpenAITools([tool])[0].function
    const scope: TaskSpec['scope'] = { novelId: 'synthetic', novelInitializationProtocol: 1, novelInitializationTarget: 'empty' }
    const scoped = toOpenAITools([tool], scope)[0].function
    expect(scoped.description).toContain('完整初始化时一次提供title、summary与tags')
    expect(generic.description).not.toContain('完整初始化时一次提供title、summary与tags')
    expect(scoped.parameters).toEqual(generic.parameters)
    const properties = scoped.parameters.properties as Record<string, { items: Record<string, unknown> }>
    properties.tags.items.minLength = 999
    expect(toOpenAITools([tool])[0].function).toEqual(generic)
    expect(toOpenAITools([tool], scope)[0].function.parameters).toEqual(generic.parameters)
    expect(generic.parameters).not.toBe(scoped.parameters)
  })
  it('converts replaced registered-name parameters on each call while preserving custom strict semantics', () => {
    const registered = getToolByName('novel_import')!, parameters = z.object({ custom: z.string(), optional: z.number().optional() }).strict()
    const custom = { ...registered, parameters, description: 'Replacement schema' }, conversion = vi.mocked(z.toJSONSchema)
    conversion.mockClear()
    try {
      const first = toOpenAITools([custom])[0].function, second = toOpenAITools([custom])[0].function
      expect(conversion).toHaveBeenCalledTimes(2)
      expect(first).toEqual(second)
      expect(first.strict).toBe(false)
      expect(first.description).toBe('Replacement schema')
      expect(first.parameters).toMatchObject({ type: 'object', additionalProperties: false, required: ['custom'] })
      expect(first.parameters.properties).toHaveProperty('optional')
      expect(toOpenAITools([registered])[0].function.parameters).toHaveProperty('properties.action.enum')
    } finally { conversion.mockClear() }
  })
  it('does not reuse a registered schema cache for a custom name sharing that same schema object', () => {
    const registered = getToolByName('novel_import')!, custom = { ...registered, name: 'synthetic_custom_import' }
    toOpenAITools([registered])
    const conversion = vi.mocked(z.toJSONSchema); conversion.mockClear()
    try {
      expect(toOpenAITools([custom])).toEqual(toOpenAITools([custom]))
      expect(conversion).toHaveBeenCalledTimes(2)
    } finally { conversion.mockClear() }
  })
  const dynamicConversion = (route: string, parameters: z.ZodType) => route === 'generic' ? toOpenAIParameters(parameters)
    : route === 'presentation' ? toOpenAIToolPresentation({ name: 'synthetic_dynamic', description: 'Dynamic', parameters }).parameters
    : toOpenAITools([{ ...getToolByName('novel_import')!, name: 'synthetic_dynamic', parameters }])[0].function.parameters
  it.each(['generic', 'presentation', 'unregistered'])('keeps mutable metadata live through the %s path', route => {
    const field = z.string(), parameters = z.object({ value: field }).strict()
    try {
      z.globalRegistry.add(field, { description: 'Before metadata update' })
      const first = dynamicConversion(route, parameters)
      z.globalRegistry.add(field, { description: 'After metadata update' })
      expect(first).toHaveProperty('properties.value.description', 'Before metadata update')
      expect(dynamicConversion(route, parameters)).toHaveProperty('properties.value.description', 'After metadata update')
    } finally { z.globalRegistry.remove(field) }
  })
  it.each(['generic', 'presentation', 'unregistered'])('keeps lazy target metadata live through the %s path', route => {
    const field = z.string(), parameters = z.lazy(() => z.object({ value: field }).strict())
    const conversion = vi.mocked(z.toJSONSchema); conversion.mockClear()
    try {
      z.globalRegistry.add(field, { description: 'Before lazy metadata update' })
      const first = dynamicConversion(route, parameters)
      z.globalRegistry.add(field, { description: 'After lazy metadata update' })
      expect(first).toHaveProperty('properties.value.description', 'Before lazy metadata update')
      expect(dynamicConversion(route, parameters)).toHaveProperty('properties.value.description', 'After lazy metadata update')
      expect(conversion).toHaveBeenCalledTimes(2)
    } finally { z.globalRegistry.remove(field); conversion.mockClear() }
  })
})

it('reads the actual prepared tool definitions in Chat and Responses snapshots', () => {
  const [tool] = toOpenAITools([getToolByName('novel_import')!])
  const model = 'gpt-6.1-terra'
  const chat = { endpoint: 'https://yunshu.chevolink.com/v1/chat/completions', body: { model, stream: true, messages: [], tools: [tool] } }
  const responses = { endpoint: 'https://yunshu.chevolink.com/v1/responses', body: {
    model, stream: true, store: false, input: [], tools: [{ type: tool.type, ...tool.function }],
  } }
  for (const request of [chat, responses]) {
    const snapshot = { input: { request } }
    expect(readPreparedModelRequest(snapshot)).toEqual(request)
    expect(readFrozenModelToolViews(snapshot)).toEqual([tool])
  }
  expect(() => readFrozenModelToolViews({ input: { request: { ...responses, endpoint: 'http://another.example/v1/responses' } } })).toThrow()
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
  it('exposes identity-only new chapter calls and preserves the exact combined historical parser', () => {
    const original = toOpenAIParameters(chapterCreateTool.parameters)
    const old = { type: 'function' as const, function: { name: 'chapter_create', description: '历史创建合同', parameters: original } }
    const next = projectNativeToolViews([old], [chapterCreateTool], { novelId: 'novel' })[0]
    expect(next.function.parameters).not.toHaveProperty('properties.content')
    expect(toOpenAITools([chapterCreateTool])[0].function.parameters).not.toHaveProperty('properties.content')
    expect(next.function.description).toContain('空章节')
    const input = { title: '历史章', content: '旧模型已返回的完整正文。' }
    expect(toolWithNativeView(chapterCreateTool, old).parameters.parse(input)).toMatchObject(input)
    expect(hasRetiredNativeArguments('chapter_create', input)).toBe(false)
    expect(originalToolParameterSchemas(chapterCreateTool, { novelId: 'novel' })).toContainEqual(original)
    expect(old.function.parameters).toHaveProperty('properties.content')
  })
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
  it('keeps historical nested proof data parseable while the current continuity tool accepts source identifiers and the read-only option', () => {
    const legacyCandidate = terminalCandidateSchema.extend({ inheritedProofs: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).optional() })
    const original = toOpenAIParameters(z.object({ terminalState: legacyCandidate.optional()
      .describe('写作交付前要提交的真实章末状态 {exitState,lastUnfinishedAction}；须在本次独立检查前给出。不能从场景计划抄事实，缺失信息保持未知。提交必须与此候选一致；单独审阅既有章省略。') }))
    const hash = runtimeJson(original).hash
    const current = toOpenAITools([continuityValidateTool], { novelId: 'n' })[0].function.parameters
    expect(Object.keys(current.properties as object).sort()).toEqual(['chapterId', 'compilationId', 'focus', 'readOnly'])
    expect(current).not.toHaveProperty('properties.terminalState')
    expect(continuityValidateTool.parameters.safeParse({ chapterId: 'chapter' }).success).toBe(true)
    expect(continuityValidateTool.parameters.parse({ compilationId: 'comp', readOnly: true })).toEqual({ compilationId: 'comp', readOnly: true })
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

  it('projects the built-in import as a plain object and validates each action at execution', () => {
    const tool = getToolByName('novel_import')!
    const scope: TaskSpec['scope'] = { novelId: 'synthetic' }
    const oldParameters = toOpenAIParameters(novelImportArguments)
    const [current] = toOpenAITools([tool], scope)
    expect(current.function.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['prepare', 'status', 'commit'] },
        attachmentUrl: { type: 'string', maxLength: 1024 },
        jobId: { type: 'string', format: 'uuid' },
      },
    })
    expect(current.function.parameters).not.toHaveProperty('oneOf')
    expect(originalToolParameterSchemas(tool, scope)).toEqual([oldParameters, current.function.parameters])

    const old = { ...current, function: { ...current.function, parameters: oldParameters } }
    const custom = { ...old, function: { ...old.function, parameters: { ...oldParameters, description: 'Custom restriction' } } }
    const strict = { ...old, function: { ...old.function, strict: true } }
    expect(projectNativeToolViews([old, custom, strict], [tool], scope)).toEqual([current, custom, strict])
    expect(old.function.parameters).toHaveProperty('oneOf')

    const execution = toolWithNativeView(tool, current).parameters
    const jobId = 'e433ab53-1145-444b-97a3-25cb5146b6fe'
    expect(execution.parse({ action: 'prepare', attachmentUrl: '/synthetic.docx' })).toEqual({ action: 'prepare', attachmentUrl: '/synthetic.docx' })
    for (const action of ['status', 'commit']) {
      expect(execution.parse({ action, jobId })).toEqual({ action, jobId })
      expect(execution.safeParse({ action }).success).toBe(false)
    }
    for (const args of [
      { action: 'prepare' },
      { action: 'prepare', attachmentUrl: '/synthetic.docx', jobId },
      { action: 'commit', jobId, confirmed: true },
    ]) expect(execution.safeParse(args).success).toBe(false)
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
    expect(definition.parameters).toEqual(generic[0].function.parameters)
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
    expect(presentation.parameters).toEqual(toOpenAIParameters(storyCompilerPrepareTool.parameters))
    expect(presentation.parameters.required).not.toContain('volumeDecision')
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
