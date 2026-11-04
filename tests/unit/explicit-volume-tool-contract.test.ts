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

it.each(['新建一个空卷', '给当前作品新增一卷', '帮我加一个新卷', '增加第二卷', '添加第二卷', '帮我加上第二卷'])('exposes actual volume creation for a standalone empty-volume request: %s', prompt => {
  const task = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, mode: 'build', authorWritingProtocol: 2, volumeCreationProtocol: 1 })
  expect(task.intent).toBe('structure')
  expect(task.scope.authorEffects).toMatchObject({ manuscript: false, structure: true })
  const catalog = freezeTaskCapabilities(task, { prompt }, ['volume_create', 'chapter_create'])
  expect(restrictToolsToTask([volumeCreateTool, chapterCreateTool], catalog, 'build').map(tool => tool.name)).toEqual(['volume_create'])
})
it.each(['不要帮我加一个新卷', '解释为什么没有第二卷', '只读检查卷目录，不要增加第二卷', '解释“帮我加一个新卷”的含义'])('does not turn refusal or discussion into empty-volume creation: %s', prompt => {
  const task = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, mode: 'build', authorWritingProtocol: 2, volumeCreationProtocol: 1 })
  expect(restrictToolsToTask([volumeCreateTool, chapterCreateTool], task, 'build')).toEqual([])
})

it.each(['给第二卷增加摘要', '帮我添加第二卷的摘要'])('does not mistake an existing volume metadata edit for empty-volume creation: %s', prompt => {
  const task = buildTaskSpec({ runId: 'r', novelId: 'n', prompt, authorWritingProtocol: 2, volumeCreationProtocol: 1 })
  expect(task.scope.authorEffects?.manuscript).toBe(false)
  expect(restrictToolsToTask([volumeCreateTool], task, 'build')).toEqual([])
})
