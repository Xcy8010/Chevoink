import { describe, expect, it } from 'vitest'

import { resolveAgentChapterVolumeId } from '../../api/lib/agent/tools/chapter-placement.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { toOpenAIToolPresentation, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'

describe('Agent 新章卷归属', () => {
  it.each([['chapter_create', chapterCreateTool, 'newVolume'], ['story_compiler_prepare', storyCompilerPrepareTool, 'volumeDecision']] as const)('retains the original %s full frozen schema without adding permissions', (_name, tool, key) => {
    const alternatives = originalToolParameterSchemas(tool, { novelId: 'n' })
    expect(alternatives[0].properties).toHaveProperty(key)
    expect(alternatives.at(-1)!.properties).not.toHaveProperty(key)
    const current = alternatives[0].properties as Record<string, unknown>
    expect(alternatives.at(-1)).toEqual({ ...alternatives[0], properties: Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)) })
  })
  it('exposes a new-volume proposal only for the new server-frozen capability', () => {
    const writing = { version: 1 as const, kind: 'bounded' as const, targets: [{ orderIndex: 2, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
    const old = toOpenAIToolPresentation(chapterCreateTool, { novelId: 'n', writing })
    expect(old.parameters.properties).not.toHaveProperty('newVolume')
    const fresh = toOpenAIToolPresentation(chapterCreateTool, { novelId: 'n', writing: { ...writing, tailVolume: { version: 1, targetOrderIndex: 2, previousChapterId: 'c1', previousRevision: 1 } } })
    expect(fresh.parameters.properties).toHaveProperty('newVolume')
    expect(fresh.description).toContain('不能按章数切卷')
    const prepare = toOpenAIToolPresentation(storyCompilerPrepareTool, { novelId: 'n', writing: { ...writing, tailVolume: { version: 1, targetOrderIndex: 2, previousChapterId: 'c1', previousRevision: 1 } } })
    expect(prepare.parameters.required).toContain('volumeDecision')
    expect(toOpenAIToolPresentation(storyCompilerPrepareTool, { novelId: 'n', writing }).parameters.required).not.toContain('volumeDecision')
  })
  it('后方存在空卷时仍追加到最后一个已有章节所在卷', () => {
    expect(resolveAgentChapterVolumeId({ lastExistingVolumeId: 'volume-1' })).toBe('volume-1')
  })

  it('显式卷和全书插入点拥有更高优先级', () => {
    expect(resolveAgentChapterVolumeId({ requestedVolumeId: 'volume-4', globalTargetVolumeId: 'volume-2', lastExistingVolumeId: 'volume-1' })).toBe('volume-4')
    expect(resolveAgentChapterVolumeId({ globalTargetVolumeId: 'volume-2', lastExistingVolumeId: 'volume-1' })).toBe('volume-2')
  })

  it('第 M 卷第 N 章必须使用卷内坐标，禁止和全书位置混用', () => {
    expect(chapterCreateTool.parameters.safeParse({ title: '霜甲', volumeOrder: 2, positionInVolume: 8 }).success).toBe(true)
    expect(chapterCreateTool.parameters.safeParse({ title: '霜甲', positionInVolume: 8 }).success).toBe(false)
    expect(chapterCreateTool.parameters.safeParse({ title: '霜甲', position: 15, volumeOrder: 2, positionInVolume: 8 }).success).toBe(false)
  })
  it('normalizes only explicit top-level decimal coordinates without changing IDs, content or boundary revisions', () => {
    const raw = { title: '风眼', volumeOrder: '2', positionInVolume: '33', volumeId: '2', content: '原文 33', newVolume: { boundary: { previousRevision: '6' } } }
    expect(normalizeToolInput(chapterCreateTool, raw)).toEqual({ ...raw, volumeOrder: 2, positionInVolume: 33 })
    expect(raw.volumeOrder).toBe('2')
    expect(chapterCreateTool.parameters.parse(normalizeToolInput(chapterCreateTool, { title: '风眼', volumeOrder: '2', positionInVolume: '33' })))
      .toMatchObject({ volumeOrder: 2, positionInVolume: 33 })
    expect(chapterCreateTool.parameters.parse(normalizeToolInput(chapterCreateTool, { title: '风眼', position: '49' }))).toMatchObject({ position: 49 })
  })
  it.each(['0', '-1', '1.5', '+2', ' 2 ', '02', '2e0', '第2卷', '2147483648', '9007199254740991'])('does not guess unsafe or non-literal coordinate %s', value => {
    const normalized = normalizeToolInput(chapterCreateTool, { title: '风眼', volumeOrder: value, positionInVolume: 33 })
    expect(normalized).toMatchObject({ volumeOrder: value })
    expect(chapterCreateTool.parameters.safeParse(normalized).success).toBe(false)
  })
  it('numeric repair preserves an actual new-volume versus existing-volume conflict', () => {
    const args = normalizeToolInput(chapterCreateTool, { title: '风眼', volumeOrder: '2', positionInVolume: '33',
      newVolume: { title: '第二卷 雪压边墙', summary: '现有卷不等于新尾卷', boundary: { previousChapterId: 'p48', previousRevision: 6,
        quote: '两面的火头都在等他先动。天亮了。', completedObjective: '本章状态已记录', nextConflict: '继续解决尚未收束的原困局' } } })
    const parsed = chapterCreateTool.parameters.safeParse(args)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ['newVolume'], message: '新尾卷不能与固定卷或卷内位置混用' }))
    expect(args).toHaveProperty('newVolume')
  })
})
