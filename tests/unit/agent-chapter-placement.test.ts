import { describe, expect, it } from 'vitest'

import { resolveAgentChapterVolumeId } from '../../api/lib/agent/tools/chapter-placement.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { toOpenAIToolPresentation, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'

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
})
