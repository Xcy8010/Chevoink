import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { buildTaskSpec, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { readVolumeCreateIntent, isElidedVolumeAddition } from '../../api/lib/agent/volume-create-intent.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { applySessionToolPolicy } from '../../api/lib/agent/agents.js'
import { freezeTaskCapabilities } from '../../api/lib/agent/task-capabilities.js'
import { volumeCreateTool, volumeMoveTool, volumeUpdateTool, volumeListTool } from '../../api/lib/agent/tools/structure-tools.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import { toOpenAIToolPresentation } from '../../api/lib/agent/tool-schema.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({ original: vi.fn(), fence: vi.fn(), structure: vi.fn(), create: vi.fn(), db: {
  agentRun: { findFirst: vi.fn() }, agentMessage: { findMany: vi.fn(), findFirst: vi.fn() }, volume: { findMany: vi.fn() }, $transaction: vi.fn(),
} }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: mocks.db }))
vi.mock('../../api/lib/agent/original-request.js', async original => ({ ...await original<object>(), readOriginalTaskRequest: mocks.original }))
vi.mock('../../api/lib/agent/manuscript-scope.js', async original => ({ ...await original<object>(), assertAgentManuscriptCurrent: mocks.fence }))
vi.mock('../../api/lib/agent/writing-scope.js', async original => ({ ...await original<object>(), assertWritingStructureAuthority: mocks.structure }))
vi.mock('../../api/lib/data/volume.js', async original => ({ ...await original<object>(), createVolumeData: mocks.create }))
vi.mock('../../api/lib/agent/semantic-progress.js', async original => ({ ...await original<object>(), readSemanticStructureHash: vi.fn(async () => runtimeJson(volumes).hash) }))
const subject = { userId: 'u', novelId: 'n', sessionId: 'session', runId: 'new-run', prompt: '你帮我加' }
const ctx = { ...subject, callId: 'create', mode: 'build', signal: new AbortController().signal } as unknown as ToolContext
const proposal = '请在目录里新增三个空卷，卷名是《第二卷 渡桥》《第三卷 灯塔》《第四卷 归港》。摘要可以在创建时填写，之后还可以把细纲挂到实际章上并核对卷序。'
const source = { id: 'proposal-message', parts: [{ type: 'text', text: proposal }] }
let volumes: Array<{ id: string; title: string; orderIndex: number; revision: number }>
beforeEach(() => {
  vi.resetAllMocks()
  volumes = [{ id: 'v1', title: '第一卷 起航', orderIndex: 1, revision: 1 }]
  mocks.db.agentRun.findFirst.mockImplementation(async ({ where }) => typeof where.id === 'string' ? { sessionId: 'session' } : { id: 'prior-run', status: 'completed' })
  mocks.db.agentMessage.findMany.mockResolvedValue([source]); mocks.db.agentMessage.findFirst.mockResolvedValue(source)
  mocks.db.volume.findMany.mockImplementation(async () => volumes)
  mocks.db.$transaction.mockImplementation(async work => work(mocks.db))
  mocks.create.mockImplementation(async (_user, _novel, input) => { const volume = { id: `v${volumes.length + 1}`, title: input.title, orderIndex: volumes.length + 1, revision: 1 }; volumes.push(volume); return volume })
})
async function admitted() {
  const intent = await readVolumeCreateIntent(mocks.db as unknown as Prisma.TransactionClient, subject)
  const task = buildTaskSpec({ ...subject, mode: 'build', authorWritingProtocol: 2, volumeCreationProtocol: 1, volumeCreateIntent: intent })
  mocks.original.mockResolvedValue({ prompt: subject.prompt, sourceRunId: subject.runId, taskId: 'task', parentRunId: null, spec: task })
  return task
}
it('admits a new run in an old session as create-only, while the original request and old run remain untouched', async () => {
  const task = await admitted()
  expect(task.goals).toEqual(['你帮我加'])
  expect(task.scope.authorEffects).toMatchObject({ manuscript: false, structure: false, artifact: false })
  expect(task.scope.volumeCreateIntent?.targets).toEqual([{ orderIndex: 2, title: '渡桥' }, { orderIndex: 3, title: '灯塔' }, { orderIndex: 4, title: '归港' }])
  expect(mocks.db.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u', novelId: 'n', sessionId: 'session', id: { not: 'new-run' } }) }))
  const tools = [volumeCreateTool, volumeListTool, volumeUpdateTool, volumeMoveTool, chapterCreateTool, askUserTool]
  const catalog = freezeTaskCapabilities(task, { prompt: subject.prompt }, tools.map(tool => tool.name))
  expect(restrictToolsToTask(tools, catalog, 'build').map(tool => tool.name)).toEqual(['volume_create', 'volume_list', 'ask_user'])
  expect(restrictToolsToTask(tools, catalog, 'plan').map(tool => tool.name)).toContain('volume_create')
  expect(toOpenAIToolPresentation(volumeCreateTool, catalog.scope).parameters.properties).toMatchObject({ title: { enum: ['渡桥', '灯塔', '归港'] } })
  expect(toOpenAIToolPresentation(volumeCreateTool, catalog.scope).parameters.properties).not.toHaveProperty('position')
  expect(renderTaskSpec(task)).toContain('不授予通用结构权限')
})
it('the real tool adds the three named empty volumes in order and repeated requests reuse the same objects', async () => {
  await admitted()
  const first = await volumeCreateTool.execute(ctx, { title: '渡桥' })
  const replay = await volumeCreateTool.execute(ctx, { title: '第二卷 渡桥' })
  expect(replay.observedState?.id).toBe(first.observedState?.id)
  expect(replay.output).toContain('已存在，复用')
  await volumeCreateTool.execute(ctx, { title: '灯塔' }); await volumeCreateTool.execute(ctx, { title: '归港' })
  expect(volumes.map(volume => [volume.id, volume.orderIndex])).toEqual([['v1', 1], ['v2', 2], ['v3', 3], ['v4', 4]])
  expect(mocks.create).toHaveBeenCalledTimes(3)
  expect(mocks.structure).not.toHaveBeenCalled()
  expect(mocks.fence).toHaveBeenCalledTimes(4)
})
it.each(['unknown-title', 'insert', 'skip-order', 'occupied-order', 'edited-source', 'foreign-source', 'changed-request', 'child'] as const)('the real create tool rejects %s without creating a volume', async scenario => {
  const task = await admitted()
  if (scenario === 'occupied-order') volumes.push({ id: 'someone-elses', title: '其他卷', orderIndex: 2, revision: 1 })
  if (scenario === 'edited-source') mocks.db.agentMessage.findFirst.mockResolvedValue({ ...source, parts: [{ type: 'text', text: proposal + ' 改变了来源' }] })
  if (scenario === 'foreign-source') mocks.db.agentMessage.findFirst.mockResolvedValue(null)
  if (scenario === 'changed-request' || scenario === 'child') mocks.original.mockResolvedValue({ prompt: scenario === 'changed-request' ? '只讨论' : subject.prompt, sourceRunId: subject.runId, spec: task, parentRunId: scenario === 'child' ? 'parent' : null })
  await expect(volumeCreateTool.execute(ctx, { title: scenario === 'unknown-title' ? '无关新卷' : scenario === 'skip-order' ? '灯塔' : '渡桥', ...(scenario === 'insert' ? { position: 1 } : {}) })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).not.toHaveBeenCalled()
})
it.each(['只讨论', '你觉得能加吗？', '可以加吗？', '不要帮我加', '重新试一下', '继续', '帮我加一个新卷'])('never borrows conversation authority for %s', async prompt => {
  expect(await readVolumeCreateIntent(mocks.db as unknown as Prisma.TransactionClient, { ...subject, prompt })).toBeUndefined()
  expect(mocks.db.agentRun.findFirst).not.toHaveBeenCalled()
})
it.each(['no-prior-run', 'no-concrete-names', 'two-add-objects', 'quoted-story', 'unrelated-latest-message', 'changed-directory'] as const)('keeps ambiguous %s read-only with an actual question tool available', async scenario => {
  if (scenario === 'no-prior-run') mocks.db.agentRun.findFirst.mockResolvedValue(null)
  if (scenario === 'no-concrete-names') mocks.db.agentMessage.findMany.mockResolvedValue([{ id: 'm', parts: [{ type: 'text', text: '可以在目录里新增几个空卷，之后再起名。' }] }])
  if (scenario === 'two-add-objects') mocks.db.agentMessage.findMany.mockResolvedValue([{ ...source, parts: [{ type: 'text', text: proposal + '也可以添加一个人物。' }] }])
  if (scenario === 'quoted-story') mocks.db.agentMessage.findMany.mockResolvedValue([{ ...source, parts: [{ type: 'text', text: `故事里有人说：“${proposal}”` }] }])
  if (scenario === 'unrelated-latest-message') mocks.db.agentMessage.findMany.mockResolvedValue([{ id: 'later', parts: [{ type: 'text', text: '我们先讨论角色关系。' }] }, source])
  if (scenario === 'changed-directory') volumes.push({ id: 'other', title: '另一卷', orderIndex: 2, revision: 1 })
  const task = await admitted()
  expect(task.scope.volumeCreateIntent).toBeUndefined()
  expect(restrictToolsToTask([volumeCreateTool, volumeUpdateTool, chapterCreateTool, askUserTool], task, 'build')).toEqual([askUserTool])
  expect(askUserTool.permission.build).toBe('allow')
  expect(renderTaskSpec(task)).toContain('向作者提问工具澄清')
  expect(mocks.create).not.toHaveBeenCalled()
})
it('does not treat a suggestion as action without the new human confirmation', () => {
  expect(isElidedVolumeAddition(proposal)).toBe(false)
})

it('read-only session policy and explicit cancellation cannot create even a confirmed empty volume', async () => {
  const task = await admitted()
  const allowed = restrictToolsToTask([volumeCreateTool, askUserTool], task, 'build')
  expect(applySessionToolPolicy(allowed, 'build', {}, 'read_only').map(tool => tool.name)).toEqual(['ask_user'])
  await expect(volumeCreateTool.execute({ ...ctx, sandboxMode: 'read_only' }, { title: '渡桥' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  const controller = new AbortController(); controller.abort()
  await expect(volumeCreateTool.execute({ ...ctx, signal: controller.signal }, { title: '渡桥' })).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.create).not.toHaveBeenCalled()
})

it.each(['structure', 'metadata'] as const)('the actual general %s mutation guard rejects the create-only scope', async effect => {
  await admitted()
  const { assertWritingStructureAuthority } = await vi.importActual<typeof import('../../api/lib/agent/writing-scope.js')>('../../api/lib/agent/writing-scope.js')
  await expect(assertWritingStructureAuthority(mocks.db as unknown as Prisma.TransactionClient, ctx, effect)).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
  expect(mocks.create).not.toHaveBeenCalled()
})

it.each(['failed', 'running', 'paused', 'awaiting_approval'] as const)('does not skip a newer %s run to resurrect an older completed volume suggestion', async status => {
  mocks.db.agentRun.findFirst.mockResolvedValue({ id: 'newer-unrelated-run', status })
  expect(await readVolumeCreateIntent(mocks.db as unknown as Prisma.TransactionClient, subject)).toBeUndefined()
  expect(mocks.db.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.not.objectContaining({ status: 'completed' }) }))
  expect(mocks.db.agentMessage.findMany).not.toHaveBeenCalled()
})
