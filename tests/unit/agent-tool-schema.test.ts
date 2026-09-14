import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toOpenAIParameters, withObjectType } from '../../api/lib/agent/tool-schema.js'
import { getToolsForMode, toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { novelImportArguments } from '../../api/lib/agent/tools/import-tools.js'

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
})
