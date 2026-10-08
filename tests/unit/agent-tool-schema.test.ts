import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toOpenAIParameters, withObjectType, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { getToolsForMode, toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { novelImportArguments } from '../../api/lib/agent/tools/import-tools.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { TaskSpec } from '../../shared/contracts/index.js'

// 回归：novel_import 顶层 discriminatedUnion 转换后没有 type，DeepSeek 按 type null 拒绝，
// 导致线上继续任务时报 Invalid schema for function 'novel_import'。
describe('tool schema provider contract', () => {
  it('every published tool keeps top-level object parameters', () => {
    process.env.NOVEL_IMPORT_ENABLED = 'true'
    for (const mode of ['plan', 'build', 'review'] as const) {
      for (const definition of toOpenAITools(getToolsForMode(mode))) {
        expect(definition.function.parameters.type, definition.function.name).toBe('object')
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
