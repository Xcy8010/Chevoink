import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { normalizeToolInput, validateToolInput } from '../../api/lib/agent/tools/input-validation.js'
import { decodeToolArgumentContainers } from '../../api/lib/agent/tools/argument-container-decoding.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { toOpenAIParameters, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

describe('schema-directed container wire decoding', () => {
  const decision = { kind: 'continue', reason: '当前卷主困局尚未收束，继续原目标' }
  it('decodes the actual preparation decision without mutating raw input or the frozen schema', () => {
    const schemas = structuredClone(originalToolParameterSchemas(storyCompilerPrepareTool, { novelId: 'n' }))
    const raw = { targetOrderIndex: 6, intentSummary: '承接前章推进合成故事', volumeDecision: JSON.stringify(decision) }
    const before = JSON.stringify(raw)
    const normalized = normalizeToolInput(storyCompilerPrepareTool, raw)
    expect(normalized).toEqual({ ...raw, volumeDecision: decision })
    expect(validateToolInput(storyCompilerPrepareTool, normalized).success).toBe(true)
    expect(JSON.stringify(raw)).toBe(before)
    expect(normalizeToolInput(storyCompilerPrepareTool, normalized)).toEqual(normalized)
    expect(originalToolParameterSchemas(storyCompilerPrepareTool, { novelId: 'n' })).toEqual(schemas)
  })
  it('keeps every previously accepted canonical input and its normalized identity', () => {
    const values = [decision, { kind: 'new_volume', reason: '原目标已收束，进入新阶段', newVolume: { title: '下一卷', summary: '新的主困局',
      boundary: { previousChapterId: 'source', previousRevision: 2, quote: '这是合成前章的完整收束证据引用。', completedObjective: '完成原目标', nextConflict: '面对新困局' } } }]
    for (const volumeDecision of values) {
      const raw = { targetOrderIndex: 6, intentSummary: '合成目标', volumeDecision }
      expect(decodeToolArgumentContainers(storyCompilerPrepareTool.parameters, raw)).toBe(raw)
      expect(runtimeJson(normalizeToolInput(storyCompilerPrepareTool, raw)).hash).toBe(runtimeJson(raw).hash)
    }
  })
  it('decodes object and array nodes through nullable, optional, tuple and record containers', () => {
    const tool = { parameters: z.object({ tasks: z.array(z.object({ state: z.object({ tags: z.array(z.string()) }).optional() })).nullable(),
      pairs: z.tuple([z.object({ id: z.string() }), z.array(z.number())]), entries: z.record(z.string(), z.object({ names: z.array(z.string()) })) }) }
    const raw = { tasks: JSON.stringify([{ state: JSON.stringify({ tags: '["原状态"]' }) }]), pairs: JSON.stringify([JSON.stringify({ id: 'exact' }), JSON.stringify([1, 2])]),
      entries: { item: JSON.stringify({ names: '["合成对象"]' }) } }
    const normalized = normalizeToolInput(tool, raw)
    expect(normalized).toEqual({ tasks: [{ state: { tags: ['原状态'] } }], pairs: [{ id: 'exact' }, [1, 2]], entries: { item: { names: ['合成对象'] } } })
    expect(validateToolInput(tool, normalized).success).toBe(true)
  })
  it('selects a real discriminator branch without decoding legitimate string values', () => {
    const parameters = z.object({ value: z.discriminatedUnion('kind', [z.object({ kind: z.literal('text'), payload: z.string() }),
      z.object({ kind: z.literal('structured'), payload: z.object({ id: z.string() }) })]) })
    const text = { value: { kind: 'text', payload: '{"id":"still text"}' } }
    expect(decodeToolArgumentContainers(parameters, text)).toBe(text)
    expect(decodeToolArgumentContainers(parameters, { value: { kind: 'structured', payload: '{"id":"real object"}' } }))
      .toEqual({ value: { kind: 'structured', payload: { id: 'real object' } } })
    const missing = { value: { payload: '{"id":"no branch"}' } }
    expect(decodeToolArgumentContainers(parameters, missing)).toEqual(missing)
  })
  it('leaves ambiguous unions, any, unknown, passthrough data, IDs and manuscript text unchanged', () => {
    const tool = { parameters: z.object({ required: z.number(), mixed: z.union([z.string(), z.object({ id: z.string() })]),
      ambiguous: z.union([z.object({ payload: z.string(), a: z.string() }), z.object({ payload: z.object({ id: z.string() }), b: z.string() })]),
      content: z.string(), chapterId: z.string(), anything: z.any(), unknown: z.unknown() }).passthrough() }
    const raw = { mixed: '{"id":"text"}', ambiguous: { payload: '{"id":"ambiguous"}' }, content: '["author prose"]', chapterId: '{"id":"not identity"}',
      anything: '{"id":"unconstrained"}', unknown: '[1]', extra: '{"id":"unknown key"}' }
    expect(normalizeToolInput(tool, raw)).toEqual(raw)
    expect(validateToolInput(tool, raw).success).toBe(false)
  })
  it.each(['{"kind":"continue"', '```json\n{"kind":"continue"}\n```', '{kind:"continue",reason:"原目标未收束"}', 'null', '[1]', JSON.stringify(JSON.stringify(decision))])(
    'does not repair or invent a decision from %s', volumeDecision => {
      const raw = { intentSummary: '合成目标', volumeDecision }
      expect(normalizeToolInput(storyCompilerPrepareTool, raw)).toEqual(raw)
      expect(validateToolInput(storyCompilerPrepareTool, normalizeToolInput(storyCompilerPrepareTool, raw)).success).toBe(false)
    })
  it.each([{ kind: 'continue' }, { kind: 'continue', reason: '有效理由', newVolume: null }, { kind: 'continue', reason: '' },
    { kind: 'new_volume', reason: '真实新阶段' }, { kind: 'guessed', reason: '有效理由' }])('keeps decoded invalid fields for strict validation: %j', value => {
    const raw = { intentSummary: '合成目标', volumeDecision: JSON.stringify(value) }
    expect(normalizeToolInput(storyCompilerPrepareTool, raw)).toEqual({ ...raw, volumeDecision: value })
    expect(validateToolInput(storyCompilerPrepareTool, normalizeToolInput(storyCompilerPrepareTool, raw)).success).toBe(false)
  })
  it('supports intersection constraints without broadening a conflicting string requirement', () => {
    const parameters = z.intersection(z.object({ left: z.object({ id: z.string() }) }), z.object({ right: z.array(z.string()) }))
    expect(decodeToolArgumentContainers(parameters, { left: '{"id":"exact"}', right: '["value"]' })).toEqual({ left: { id: 'exact' }, right: ['value'] })
    const conflict = z.intersection(z.object({ payload: z.string() }), z.object({ payload: z.object({ id: z.string() }) }))
    const raw = { payload: '{"id":"cannot satisfy both"}' }
    expect(decodeToolArgumentContainers(conflict, raw)).toEqual(raw)
  })
  it('leaves opaque values and unsupported schema nodes intact when another field fails', () => {
    const opaque = new Date('2026-10-14T00:00:00Z')
    const parameters = z.object({ missing: z.string(), opaque: z.unknown(), custom: z.custom<string>() })
    const raw = { opaque, custom: '{"id":"custom input"}' }
    expect(decodeToolArgumentContainers(parameters, raw)).toEqual(raw)
    expect((decodeToolArgumentContainers(parameters, raw) as typeof raw).opaque).toBe(opaque)
  })
  it('bounds traversal without treating an undecoded deep container as valid', () => {
    let parameters: z.ZodType = z.object({ id: z.string() }), value: unknown = '{"id":"deep"}'
    for (let i = 0; i < 40; i++) { parameters = z.object({ child: parameters }); value = { child: value } }
    const normalized = decodeToolArgumentContainers(parameters, value)
    expect(parameters.safeParse(normalized).success).toBe(false)
  })
  it('follows only local recursive schema references within the traversal bound', () => {
    const tree: z.ZodType = z.lazy(() => z.object({ id: z.string(), children: z.array(tree).optional() }))
    const raw = { id: 'root', children: JSON.stringify([{ id: 'child', children: JSON.stringify([{ id: 'leaf' }]) }]) }
    const normalized = decodeToolArgumentContainers(tree, raw)
    expect(normalized).toEqual({ id: 'root', children: [{ id: 'child', children: [{ id: 'leaf' }] }] })
    expect(tree.safeParse(normalized).success).toBe(true)
  })
  it('keeps top-level excerpt fencing and previously published schema types', () => {
    const schema = toOpenAIParameters(storyCompilerPrepareTool.parameters)
    expect(() => normalizeToolInput(storyCompilerPrepareTool, JSON.stringify({ _contextCompacted: true, intentSummary: 'excerpt' }))).toThrow('Historical context excerpt')
    expect(toOpenAIParameters(storyCompilerPrepareTool.parameters)).toEqual(schema)
  })
})
