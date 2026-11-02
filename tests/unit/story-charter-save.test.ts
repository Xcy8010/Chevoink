import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { storyCharterSaveTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { upsertStoryCharter } from '../../api/lib/agent/story-compiler.js'
import { originalToolParameterSchemas } from '../../api/lib/agent/tool-schema.js'
import { normalizeToolInput } from '../../api/lib/agent/tools/input-validation.js'
import { storyCharterInputSchema, storyCharterSaveInputSchema, type TaskSpec } from '../../shared/contracts/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const complete = storyCharterInputSchema.parse({ oneLinePromise: '寻找失落证据', targetAudience: '悬疑读者', targetPlatform: '原平台',
  protagonistDesire: '寻找真相', protagonistFear: '失去亲人', protagonistMisbelief: '证据不会骗人', protagonistNonNegotiable: '不伤害无辜者',
  conflictEngine: '证据互相矛盾', relationshipEngine: '互不信任的同伴', emotionalBaseline: '克制', emotionalRange: '从怀疑到信任',
  genreRules: ['线索可追溯'], abilityCosts: ['暴露身份'], realityBoundaries: ['现实事实须核验'], styleDna: ['短句'], forbiddenZones: ['不滥杀'], antiExamples: ['不堆砌设定'] })
const patch = { oneLinePromise: '失落证据揭开家族秘密', targetAudience: '喜欢人物关系的悬疑读者', relationshipEngine: '同伴重建信任', protagonistMisbelief: '亲人不会说谎' }
const ctx = { userId: 'u', novelId: 'n' } as ToolContext

afterEach(() => vi.restoreAllMocks())
function fixture(exists = true) {
  const original = { ...complete, id: 'charter', userId: 'u', novelId: 'n', revision: 7, createdAt: new Date(0), updatedAt: new Date(0) }
  const owned = vi.spyOn(prisma.novel, 'findFirst').mockResolvedValue({ id: 'n' } as never)
  const read = vi.spyOn(prisma.storyCharter, 'findUnique').mockResolvedValue(exists ? original : null)
  const update = vi.spyOn(prisma.storyCharter, 'update').mockImplementation(async ({ data }) => ({ ...original, ...data, revision: 8 }) as never)
  const create = vi.spyOn(prisma.storyCharter, 'upsert').mockImplementation(async ({ create: data }) => ({ ...data, id: 'charter', revision: 1 }) as never)
  return { original, owned, read, update, create }
}

describe('story charter partial saves', () => {
  it('saves the four supplied fields and preserves omitted strings and lists', async () => {
    const f = fixture()
    const args = storyCharterSaveTool.parameters.parse(normalizeToolInput(storyCharterSaveTool, patch))
    expect(args).toEqual(patch)
    const result = await storyCharterSaveTool.execute(ctx, args)
    expect(result.output).toContain('r8')
    expect(f.update).toHaveBeenCalledWith({ where: { novelId: 'n' }, data: { ...patch, revision: { increment: 1 } } })
    expect(f.create).not.toHaveBeenCalled()
    const saved = await f.update.mock.results[0].value
    expect(saved).toEqual({ ...f.original, ...patch, revision: 8 })
  })

  it('does not materialize creation defaults or revise an unchanged patch', async () => {
    const f = fixture()
    expect(storyCharterSaveInputSchema.parse({})).toEqual({})
    expect(await upsertStoryCharter('u', 'n', { protagonistDesire: complete.protagonistDesire })).toEqual(f.original)
    expect(f.update).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('allows explicit clearing of optional lists and platform without clearing other fields', async () => {
    const f = fixture()
    const args = storyCharterSaveInputSchema.parse({ targetPlatform: '', genreRules: [] })
    await upsertStoryCharter('u', 'n', args)
    expect(f.update).toHaveBeenCalledWith({ where: { novelId: 'n' }, data: { targetPlatform: '', genreRules: [], revision: { increment: 1 } } })
  })

  it('requires complete fields for first creation and performs no write on missing fields', async () => {
    const f = fixture(false)
    await expect(storyCharterSaveTool.execute(ctx, patch)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(f.update).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('retains original creation defaults for a complete first save', async () => {
    const f = fixture(false)
    const { targetPlatform: _platform, genreRules: _genre, abilityCosts: _costs, realityBoundaries: _reality, styleDna: _style, forbiddenZones: _forbidden, antiExamples: _anti, ...required } = complete
    await upsertStoryCharter('u', 'n', required)
    expect(f.create).toHaveBeenCalledWith({ where: { novelId: 'n' }, create: { userId: 'u', novelId: 'n', ...storyCharterInputSchema.parse(required) },
      update: { ...storyCharterInputSchema.parse(required), revision: { increment: 1 } } })
  })

  it('preserves field validation and novel ownership', async () => {
    const f = fixture()
    expect(storyCharterSaveInputSchema.safeParse({ protagonistDesire: '' }).success).toBe(false)
    expect(storyCharterSaveInputSchema.safeParse({ genreRules: 'invalid' }).success).toBe(false)
    f.owned.mockResolvedValue(null)
    await expect(upsertStoryCharter('another-user', 'n', patch)).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
    expect(f.owned).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'n', authorId: 'another-user' } }))
    expect(f.read).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('recognizes the original frozen full schema alongside the new patch schema', () => {
    const schemas = originalToolParameterSchemas(storyCharterSaveTool, {} as TaskSpec['scope'])
    expect(schemas).toContainEqual(z.toJSONSchema(storyCharterInputSchema, { io: 'input' }))
    expect(schemas).toContainEqual(z.toJSONSchema(storyCharterSaveInputSchema, { io: 'input' }))
  })
})
