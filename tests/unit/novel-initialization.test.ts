import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { volumeCreateTool } from '../../api/lib/agent/tools/structure-tools.js'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { novelCreateTool, novelUpdateMetaTool } from '../../api/lib/agent/tools/novel-tools.js'
import { assertNovelMetadataIntent, readNovelInitializationCompletion } from '../../api/lib/agent/novel-initialization.js'
import { buildTaskSpec, isNovelDirectionSetup, renderTaskSpec } from '../../api/lib/agent/task-spec.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { planSaveTool } from '../../api/lib/agent/tools/write-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ original: vi.fn(), runIds: vi.fn(), db: {
  novel: { findFirst: vi.fn(), update: vi.fn() }, chapter: { count: vi.fn() },
  agentMessage: { findMany: vi.fn() }, agentEffectReceipt: { findMany: vi.fn() },
} }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: mocks.db }))
vi.mock('../../api/lib/agent/original-request.js', async original => ({ ...await original<object>(), readOriginalTaskRequest: mocks.original, originalTaskRunIds: mocks.runIds }))
const who = { userId: 'u', novelId: 'n', runId: 'r' }
const directionPrompt = '我想创作一部轻松幻想小说。'
const question = '选定方向后，为当前空作品初始化书名、简介与标签。偏好哪种人物关系？'
const fields = { title: '纸舟旅店', summary: '旅店主人和迷路旅客寻找回家的路。', tags: ['都市'] }
const empty = { title: '新作品', displayTitle: null, summary: '', tagNames: [], chapterCount: 0, wordCount: 0 }
const context = (answer?: string, identity = who): ToolContext => ({ ...who, mode: 'build', signal: new AbortController().signal,
  authorQuestionAnswers: new Map(answer ? [['q', { ...identity, question, answer }]] : []),
} as ToolContext)
const fresh = (prompt: string) => buildTaskSpec({ runId: 'r', novelId: 'n', prompt, mode: 'build', authorWritingProtocol: 2, novelInitializationProtocol: 1 })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.original.mockResolvedValue({ prompt: directionPrompt, spec: fresh(directionPrompt), sourceRunId: 'r', taskId: 'task' })
  mocks.runIds.mockResolvedValue(['r'])
  mocks.db.novel.findFirst.mockResolvedValue(empty)
  mocks.db.chapter.count.mockResolvedValue(0)
  mocks.db.agentMessage.findMany.mockResolvedValue([])
  mocks.db.agentEffectReceipt.findMany.mockResolvedValue([])
})
it('fresh vague book intent asks direction first and exposes only the protected initialization path, without outline or prose writes', () => {
  const spec = fresh(directionPrompt)
  expect(spec.expectedOutputs[0].kind).toBe('text')
  expect(spec.postconditions).toContainEqual(expect.objectContaining({ code: 'NOVEL_METADATA_INITIALIZED' }))
  expect(renderTaskSpec(spec)).toContain('先通过向作者提问工具')
  expect(restrictToolsToTask([novelCreateTool, novelUpdateMetaTool, chapterWriteTool, planSaveTool], spec).map(tool => tool.name)).toEqual(['novel_create', 'novel_update_meta', 'chapter_write', 'plan_save'])
})
it('explicit delegated initialization takes precedence over vague book pacing and never demands another direction question or an outline', () => {
  const prompt = '请从备选中代选一个方向并初始化当前作品的书名、简介和标签。'
  const spec = fresh(prompt)
  expect(isNovelDirectionSetup(prompt)).toBe(false)
  expect(spec.expectedOutputs[0]).toMatchObject({ kind: 'text', description: expect.stringContaining('不重复询问') })
  expect(restrictToolsToTask([novelCreateTool, novelUpdateMetaTool, chapterWriteTool, planSaveTool], spec).map(tool => tool.name)).toEqual(['novel_create', 'novel_update_meta', 'chapter_write', 'plan_save'])
})
it.each(['首部占位', '普通新空作品'])('saves the actual approved title, summary and tags for %s', async kind => {
  if (kind === '首部占位') mocks.db.novel.findFirst.mockResolvedValue({ ...empty, title: '未命名作品', summary: '先创建一部作品，再继续完善简介、章节和封面。' })
  const tool = kind === '首部占位' ? novelCreateTool : novelUpdateMetaTool
  expect((await tool.execute(context('选择第一种方向，同意初始化。'), fields)).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'n' }, data: { title: fields.title, displayTitle: fields.title, summary: fields.summary, tagNames: fields.tags } })
})
it.each(['只讨论', '先别初始化', '都不满意'])('does not save after the real author answer %s', async answer => {
  await expect(novelUpdateMetaTool.execute(context(answer), fields)).rejects.toMatchObject({ code: 'NOVEL_DIRECTION_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})
it.each([{ ...who, runId: 'other-task' }, { ...who, novelId: 'other-work' }])('never reuses another task/work direction observation: %j', async identity => {
  await expect(novelUpdateMetaTool.execute(context('同意初始化', identity), fields)).rejects.toMatchObject({ code: 'NOVEL_DIRECTION_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})
it.each([{ summary: '作者已写简介' }, { tagNames: ['玄幻'] }, { chapterCount: 1, wordCount: 500 }])('requires explicit editing intent for an already edited work: %j', async change => {
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, ...change })
  await expect(novelUpdateMetaTool.execute(context('选第一种，同意初始化'), fields)).rejects.toMatchObject({ code: 'NOVEL_SETUP_AUTHORITY_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})
it('updates current nonempty work atomically when the author explicitly delegates its metadata initialization', async () => {
  mocks.original.mockResolvedValue({ prompt: '由你代选，初始化当前作品的书名、简介、标签。' })
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, chapterCount: 2, wordCount: 3000, summary: '旧简介' })
  expect((await novelUpdateMetaTool.execute(context(), fields)).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledOnce()
})
it.each(['text-only', 'saved', 'different-current-value', 'declined'] as const)('checks actual same-task initialization evidence: %s', async scenario => {
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, ...fields, displayTitle: fields.title, tagNames: fields.tags,
    ...(scenario === 'different-current-value' ? { title: '作者另改的书名' } : {}) })
  if (scenario !== 'text-only') mocks.db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', status: 'success', toolName: scenario === 'declined' ? 'ask_user' : 'novel_update_meta', args: fields,
    ...(scenario === 'declined' ? { display: { kind: 'question', question, answer: '先别初始化，只讨论。' } } : {}) }] }])
  const result = await readNovelInitializationCompletion(mocks.db as unknown as Prisma.TransactionClient, who)
  expect(result.status).toBe(scenario === 'saved' ? 'complete' : scenario === 'declined' ? 'declined' : 'incomplete')
  expect(mocks.db.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { runId: { in: ['r'] }, role: 'assistant' } }))
})
it('does not turn a tag-only request into a full initialization obligation or rewrite old contracts', () => {
  expect(fresh('只更新当前作品标签。').postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED')).toBe(false)
  const legacy = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: directionPrompt })
  expect(legacy.scope.novelInitializationProtocol).toBeUndefined()
  expect(legacy.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED')).toBe(false)
})

it('freezes vague existing-work discussion without initialization writes or a save obligation', () => {
  const spec = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: directionPrompt, mode: 'plan', authorWritingProtocol: 2,
    novelInitializationProtocol: 1, novelInitializationTarget: 'existing' })
  expect(spec.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED')).toBe(false)
  expect(spec.expectedOutputs[0].description).toContain('保留当前作品')
  expect(renderTaskSpec(spec)).toContain('不以缺少保存记录反复尝试')
  expect(restrictToolsToTask([novelCreateTool, novelUpdateMetaTool], spec)).toEqual([novelCreateTool, novelUpdateMetaTool])
  const explicit = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '初始化当前作品的书名、简介、标签。',
    novelInitializationProtocol: 1, novelInitializationTarget: 'existing' })
  expect(explicit.postconditions).toContainEqual(expect.objectContaining({ code: 'NOVEL_METADATA_INITIALIZED' }))
})
it.each(['novel_create', 'novel_update_meta', 'volume_create'])('old planning contracts never gain %s execution from registry permission updates', async name => {
  const old = buildTaskSpec({ runId: 'r', novelId: 'n', prompt: '初始化当前作品的书名简介标签并创建第二卷。', mode: 'plan', authorWritingProtocol: 2 })
  mocks.original.mockResolvedValue({ prompt: old.goals[0], spec: old })
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, title: '未命名作品', summary: '先创建一部作品，再继续完善简介、章节和封面。' })
  const tool = name === 'novel_create' ? novelCreateTool : name === 'novel_update_meta' ? novelUpdateMetaTool : volumeCreateTool
  expect(restrictToolsToTask([tool], old)).toEqual([tool])
  expect(restrictToolsToTask([tool], old, 'plan')).toEqual(tool.permission.plan === 'deny' ? [] : [tool])
  if (name === 'volume_create') {
    expect(tool.permission.plan).toBe('allow')
    return // Ordinary volume creation has its own transactional fixture.
  }
  await expect(tool.execute({ ...context(), mode: 'plan' }, fields)).rejects.toMatchObject({ code: name === 'volume_create' ? 'AUTHOR_CHAPTER_SCOPE' : 'NOVEL_SETUP_AUTHORITY_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})
it.each(['saved', 'tampered', 'declined'] as const)('uses scoped native receipt proof for initialization: %s', async scenario => {
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, ...fields, displayTitle: fields.title, tagNames: fields.tags })
  const input = runtimeJson({ input: { args: fields } }), result = runtimeJson({ toolResult: scenario === 'declined'
    ? { display: { kind: 'question', question, answer: '先别初始化' } } : { output: '已保存' } })
  mocks.db.agentEffectReceipt.findMany.mockResolvedValue([{ result: result.value, resultHash: scenario === 'tampered' ? 'bad' : result.hash,
    operation: { action: scenario === 'declined' ? 'ask_user' : 'novel_update_meta', inputSnapshot: input.value, inputHash: input.hash } }])
  const promise = readNovelInitializationCompletion(mocks.db as unknown as Prisma.TransactionClient, who)
  if (scenario === 'tampered') await expect(promise).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  else expect((await promise).status).toBe(scenario === 'saved' ? 'complete' : 'declined')
  expect(mocks.db.agentEffectReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ operation: expect.objectContaining({
    originRunId: { in: ['r'] }, taskRoot: { userId: 'u', novelId: 'n' }, status: 'succeeded' }) }) }))
})
it('fresh planning initialization admits an actual same-task answer and saves the current empty work', async () => {
  const spec = fresh(directionPrompt)
  mocks.original.mockResolvedValue({ prompt: directionPrompt, spec })
  expect((await novelUpdateMetaTool.execute({ ...context('选第一种，同意初始化'), mode: 'plan' }, fields)).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledOnce()
})

it('legacy process recovery reuses only the original task successful question answer, without asking again', async () => {
  mocks.db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', toolName: 'ask_user', status: 'success',
    display: { kind: 'question', question, answer: '选第一种，同意初始化' } }] }])
  expect((await novelUpdateMetaTool.execute(context(), fields)).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledOnce()
  expect(mocks.db.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
    runId: { in: ['r'] }, role: 'assistant', run: { userId: 'u', novelId: 'n' } } }))
})
it.each(['other-task', 'other-work', 'assistant-prose', 'failed-call'] as const)('legacy recovery does not treat %s as a real current-task author answer', async scenario => {
  if (scenario === 'assistant-prose') mocks.db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'text', text: '作者已同意初始化。' }] }])
  if (scenario === 'failed-call') mocks.db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', toolName: 'ask_user', status: 'error',
    display: { kind: 'question', question, answer: '同意初始化' } }] }])
  // Foreign rows are absent from the authenticated same-task query, even if
  // another task/work had a positive question result.
  await expect(novelUpdateMetaTool.execute(context(), fields)).rejects.toMatchObject({ code: 'NOVEL_DIRECTION_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
  expect(mocks.db.agentMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
    runId: { in: ['r'] }, role: 'assistant', run: { userId: 'u', novelId: 'n' } } }))
})

it.each(['什么是作品初始化？', '帮我解释作品初始化的含义。', '无需初始化，只解释当前作品设置。', '请解释“初始化当前作品”这句话。', '把“初始化当前作品”这段话给我看看。'])('does not impose a metadata save postcondition for explanation, refusal or quoted data: %s', prompt => {
  const task = fresh(prompt)
  expect(task.postconditions.some(item => item.code === 'NOVEL_METADATA_INITIALIZED')).toBe(false)
  expect(task.expectedOutputs[0].description).not.toContain('更新当前作品')
  expect(restrictToolsToTask([novelUpdateMetaTool], task, 'plan')).toEqual([novelUpdateMetaTool])
})
it.each(['可以帮我初始化当前作品吗？', '请问可以帮我初始化当前作品吗？'])('keeps polite interrogative action requests authorized: %s', prompt => {
  expect(fresh(prompt).postconditions).toContainEqual(expect.objectContaining({ code: 'NOVEL_METADATA_INITIALIZED' }))
})
it.each(['不用初始化，先给几个方向', '不需要初始化', '无需初始化'])('uses the same explicit decline interpretation for write and completion: %s', async answer => {
  await expect(novelUpdateMetaTool.execute(context(answer), fields)).rejects.toMatchObject({ code: 'NOVEL_DIRECTION_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
  mocks.db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', status: 'success', toolName: 'ask_user', args: {},
    display: { kind: 'question', question, answer } }] }])
  expect((await readNovelInitializationCompletion(mocks.db as unknown as Prisma.TransactionClient, who)).status).toBe('declined')
})
it('rejects partial initialization without effects, then the real metadata tool saves all three fields atomically', async () => {
  mocks.original.mockResolvedValue({ prompt: directionPrompt, spec: fresh(directionPrompt) })
  const ctx = context('选第一种，同意初始化')
  await expect(novelUpdateMetaTool.execute(ctx, { summary: fields.summary })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
  expect((await novelUpdateMetaTool.execute(ctx, fields)).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'n' }, data: { title: fields.title, displayTitle: fields.title, summary: fields.summary, tagNames: fields.tags } })
})
it('retains a real partial metadata update for an author request to edit synopsis only on an existing edited work', async () => {
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, title: '作者原题', summary: '作者原简介', tagNames: ['玄幻'], chapterCount: 2, wordCount: 1200 })
  const prompt = '只更新当前作品简介。'
  mocks.original.mockResolvedValue({ prompt, spec: fresh(prompt) })
  expect((await novelUpdateMetaTool.execute(context(), { summary: fields.summary })).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'n' }, data: { summary: fields.summary, tagNames: undefined } })
})

it('does not partially initialize when some tags are outside the author-facing tag library', async () => {
  mocks.original.mockResolvedValue({ prompt: directionPrompt, spec: fresh(directionPrompt) })
  expect((await novelUpdateMetaTool.execute(context('同意初始化'), { ...fields, tags: ['都市', 'not-a-site-tag'] })).outcome).toBe('failed')
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})

it.each([
  '作品初始化是什么意思？', '初始化后会发生什么？', '初始化当前作品之后会发生什么？',
  '如果初始化当前作品，需要做什么？', '初始化后会不会修改书名和简介？',
  '请说明初始化当前作品的条件。', '当我说“帮我初始化当前作品”时是什么意思？',
  '只讨论“初始化当前作品”，不执行。', '不用初始化当前作品。',
])('requires positive initialization action grammar for spec and actual metadata authority: %s', async prompt => {
  const spec = fresh(prompt)
  expect(spec.postconditions.some(condition => condition.code === 'NOVEL_METADATA_INITIALIZED')).toBe(false)
  expect(restrictToolsToTask([novelUpdateMetaTool], spec, 'plan')).toEqual([novelUpdateMetaTool])
  mocks.original.mockResolvedValue({ prompt, spec })
  await expect(assertNovelMetadataIntent(mocks.db as unknown as Prisma.TransactionClient, context(), { ...empty, summary: '作者已有简介' })).rejects.toMatchObject({ code: 'NOVEL_SETUP_AUTHORITY_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})
it.each([
  '可以帮我初始化当前作品吗？', '请问可以帮我初始化当前作品吗？', '请初始化当前作品。',
  '直接初始化当前作品。', '开始初始化当前作品。', '把当前作品初始化。',
  '帮我把当前作品的元信息初始化好吗？', '初始化当前作品的书名、简介、标签。',
  '请从备选中代选一个方向并初始化当前作品的书名、简介和标签。', '选一个并初始化当前作品。',
])('keeps genuine soft/delegated initialization action for spec and actual metadata authority: %s', async prompt => {
  const spec = fresh(prompt)
  expect(spec.postconditions).toContainEqual(expect.objectContaining({ code: 'NOVEL_METADATA_INITIALIZED' }))
  expect(restrictToolsToTask([novelUpdateMetaTool], spec, 'plan').map(tool => tool.name)).toContain('novel_update_meta')
  mocks.original.mockResolvedValue({ prompt, spec })
  await expect(assertNovelMetadataIntent(mocks.db as unknown as Prisma.TransactionClient, context(), { ...empty, summary: '作者已有简介' })).resolves.toBe(true)
})

it('keeps the frozen legacy build metadata grant without retrofitting fresh initialization semantics', async () => {
  const prompt = '修改本章', spec = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt })
  mocks.original.mockResolvedValue({ prompt, spec })
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, summary: '原简介', chapterCount: 1, wordCount: 1200 })
  expect((await novelUpdateMetaTool.execute(context(), { summary: fields.summary })).outcome).not.toBe('failed')
  expect(mocks.db.novel.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'n' }, data: { summary: fields.summary, tagNames: undefined } })
})
it('fresh chapter work cannot use its grant to overwrite existing metadata without author intent', async () => {
  const prompt = '修改本章', spec = fresh(prompt)
  mocks.original.mockResolvedValue({ prompt, spec })
  mocks.db.novel.findFirst.mockResolvedValue({ ...empty, summary: '原简介', tagNames: ['玄幻'], chapterCount: 1, wordCount: 1200 })
  await expect(novelUpdateMetaTool.execute(context(), { summary: fields.summary })).rejects.toMatchObject({ code: 'NOVEL_SETUP_AUTHORITY_REQUIRED' })
  expect(mocks.db.novel.update).not.toHaveBeenCalled()
})
