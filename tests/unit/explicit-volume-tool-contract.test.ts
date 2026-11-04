import { expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { freezeTaskCapabilities } from '../../api/lib/agent/task-capabilities.js'
import { toOpenAIToolPresentation, originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { volumeCreateTool, volumeMoveTool, volumeListTool } from '../../api/lib/agent/tools/structure-tools.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'

const fresh = (prompt: string) => buildTaskSpec({ runId: 'r', novelId: 'n', prompt, mode: 'build', authorWritingProtocol: 2 })
it('exposes the existing create tool for explicit volume creation and keeps a directory explanation read-only', () => {
  const created = fresh('创建第二卷并命名为远行。'), explained = fresh('解释当前卷目录的布局。')
  expect(created.scope.authorEffects?.structure).toBe(true)
  expect(restrictToolsToTask([volumeListTool, volumeCreateTool], created).map(tool => tool.name)).toContain('volume_create')
  expect(restrictToolsToTask([volumeListTool, volumeCreateTool], explained).map(tool => tool.name)).not.toContain('volume_create')
})
it('retains only the explicit tail-volume capability for a bounded chapter, without granting volume move', () => {
  const spec = fresh('写下一章。')
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 2, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false,
    tailVolume: { version: 1, creationProtocol: 2, targetOrderIndex: 2, previousChapterId: 'p', previousRevision: 3 } }
  const input = { prompt: '写下一章。' }
  const catalog = freezeTaskCapabilities(spec, input, ['volume_create', 'volume_move', 'chapter_create'])
  expect(catalog.scope.capabilityCatalog?.names).toContain('volume_create')
  expect(restrictToolsToTask([volumeCreateTool, volumeMoveTool, chapterCreateTool], catalog).map(tool => tool.name)).toEqual(['volume_create', 'chapter_create'])
  const chapter = toOpenAIToolPresentation(chapterCreateTool, catalog.scope)
  expect(chapter.parameters.properties).toHaveProperty('volumeId')
  expect(chapter.parameters.properties).not.toHaveProperty('newVolume')
  const volume = toOpenAIToolPresentation(volumeCreateTool, catalog.scope)
  expect(volume.parameters.required).toEqual(['title', 'summary', 'boundary', 'targetOrderIndex'])
  expect(volume.parameters.properties).not.toHaveProperty('position')
})
it('preserves old frozen implicit-newVolume presentation and the original volume-create parameter shape', () => {
  const spec = fresh('写下一章。')
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 2, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false,
    tailVolume: { version: 1, targetOrderIndex: 2, previousChapterId: 'p', previousRevision: 3 } }
  expect(toOpenAIToolPresentation(chapterCreateTool, spec.scope).parameters.properties).toHaveProperty('newVolume')
  expect(originalToolParameterSchemas(volumeCreateTool, spec.scope)).toContainEqual(expect.objectContaining({ properties: {
    title: expect.any(Object), summary: expect.any(Object), position: expect.any(Object),
  } }))
  expect(restrictToolsToTask([volumeCreateTool], spec)).toEqual([])
})

it('only fresh explicit directory creation receives planning authority, without chapter or move grants', () => {
  const old = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '创建第二卷。', mode: 'plan', authorWritingProtocol: 2 })
  const fresh = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '创建第二卷。', mode: 'plan', authorWritingProtocol: 2, volumeCreationProtocol: 1 })
  expect(restrictToolsToTask([volumeCreateTool], old)[0].permission.plan).toBe('deny')
  expect(restrictToolsToTask([volumeCreateTool], fresh)[0].permission.plan).toBe('allow')
  expect(restrictToolsToTask([chapterCreateTool], fresh)).toEqual([])
  expect(volumeMoveTool.permission.plan).toBe('deny')
})
