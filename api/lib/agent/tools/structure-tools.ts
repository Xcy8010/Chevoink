import { z } from 'zod'

import { DataAccessError } from '../../prisma.js'
import {
  createVolumeData,
  deleteVolumeData,
  getStructureReportObservation,
  listVolumesData,
  mergeChaptersData,
  moveChapterData,
  moveVolumeData,
  splitChapterData,
  updateVolumeData,
} from '../../data-access.js'
import { defineTool, type ToolResult } from './types.js'
import { executeDurableRead } from './durable-read.js'
import { executeDurableCreate } from './durable-create.js'
import { getStructureRevisionHash } from '../../data/volume.js'
import { withAgentManuscriptWrite } from '../manuscript-scope.js'

const STRUCTURE_PERMISSION = { plan: 'deny', build: 'allow', review: 'deny' } as const
const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const

function assertProtectedChapterUntouched(ctx: { protectedChapterIds?: ReadonlySet<string> }, ...chapterIds: string[]) {
  const protectedId = chapterIds.find((chapterId) => ctx.protectedChapterIds?.has(chapterId))
  if (protectedId) {
    throw new DataAccessError(
      409,
      'AUTHOR_SCOPE_PROTECTED',
      `作者明确要求前文保持不变，章节 ${protectedId} 属于本轮开始前已有内容，禁止移动、拆分或合并。请只操作本轮新建章节。`,
    )
  }
}

export const volumeListTool = defineTool({
  name: 'volume_list',
  title: '查看卷结构',
  description: '列出当前作品全部卷及每卷章节数、字数。规划或移动章节前先调用。',
  parameters: z.object({}),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx): Promise<ToolResult> {
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      return executeDurableRead(captured, 'volume_list', {}, raw => volumeListTool.parameters.parse(raw),
        tx => volumeListTool.execute({ ...captured, durableRead: undefined, transaction: tx }, {}))
    }
    const volumes = await listVolumesData(ctx.userId, ctx.novelId, ctx.transaction)
    return {
      ...(ctx.transaction ? { observedStructure: { kind: 'structure' as const, id: ctx.novelId, hash: await getStructureRevisionHash(ctx.transaction, ctx.novelId) } } : {}),
      output: volumes.length
        ? volumes.map((item) => `${item.orderIndex}. ${item.title}（${item.chapterCount} 章，${item.wordCount} 字，volumeId=${item.id}）`).join('\n')
        : '当前作品暂无卷。',
      summary: `读取 ${volumes.length} 卷`,
    }
  },
})

export const volumeCreateTool = defineTool({
  name: 'volume_create',
  title: '新建卷',
  description: '为当前作品新建一卷，可指定插入位置。标题与显示序号分离，移动卷不会改写标题。',
  parameters: z.object({
    title: z.string().min(1).max(128),
    summary: z.string().optional(),
    position: z.number().int().positive().optional(),
  }),
  permission: STRUCTURE_PERMISSION,
  readOnly: false,
  async execute(ctx, args): Promise<ToolResult> {
    if (ctx.durableCreate) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableCreate: { ...ctx.durableCreate, lease: { ...ctx.durableCreate.lease }, cursor: { ...ctx.durableCreate.cursor } } }
      const normalize = (raw: unknown) => {
        const parsed = volumeCreateTool.parameters.parse(raw)
        return Object.fromEntries(Object.entries({ ...parsed, title: parsed.title.trim() }).filter(([, value]) => value !== undefined))
      }
      const effective = volumeCreateTool.parameters.parse(normalize(args))
      return executeDurableCreate(captured, effective, normalize, tx => volumeCreateTool.execute({ ...captured, durableCreate: undefined, transaction: tx }, effective), 'volume_create')
    }
    const volume = await withAgentManuscriptWrite(ctx, tx => createVolumeData(ctx.userId, ctx.novelId, args, tx))
    return {
      output: `已创建第 ${volume.orderIndex} 卷《${volume.title}》，volumeId=${volume.id}。`,
      summary: `新建卷《${volume.title}》`,
      observedState: { kind: 'volume', id: volume.id, revision: volume.revision },
    }
  },
})

export const volumeUpdateTool = defineTool({
  name: 'volume_update',
  title: '修改卷信息',
  description: '修改卷标题或摘要，不改变卷顺序。',
  parameters: z.object({
    volumeId: z.string().min(1),
    title: z.string().min(1).max(128).optional(),
    summary: z.string().nullable().optional(),
    expectedRevision: z.number().int().positive().optional(),
  }),
  permission: STRUCTURE_PERMISSION,
  readOnly: false,
  async execute(ctx, { volumeId, ...input }) {
    const volume = await withAgentManuscriptWrite(ctx, tx => updateVolumeData(ctx.userId, ctx.novelId, volumeId, input, tx))
    return volume
      ? { output: `已更新卷《${volume.title}》。`, summary: `更新卷《${volume.title}》` }
      : { output: '目标卷不存在或不属于当前作品。', outcome: 'failed' as const }
  },
})

export const volumeMoveTool = defineTool({
  name: 'volume_move',
  title: '移动卷',
  description: '把整卷移动到新的全书位置，卷内章节保持原有顺序，全书章节顺序自动重算。',
  parameters: z.object({
    volumeId: z.string().min(1),
    position: z.number().int().positive(),
    expectedRevision: z.number().int().positive().optional(),
  }),
  permission: STRUCTURE_PERMISSION,
  readOnly: false,
  async execute(ctx, { volumeId, ...input }) {
    const volume = await withAgentManuscriptWrite(ctx, tx => moveVolumeData(ctx.userId, ctx.novelId, volumeId, input, tx))
    return volume
      ? { output: `已把《${volume.title}》移动到第 ${volume.orderIndex} 卷，全书章序已同步。`, summary: `移动卷《${volume.title}》` }
      : { output: '目标卷不存在或不属于当前作品。', outcome: 'failed' as const }
  },
})

export const volumeDeleteTool = defineTool({
  name: 'volume_delete',
  title: '删除空卷',
  description: '删除一个空卷。非空卷和作品最后一卷会被服务端拒绝，避免误删正文。',
  parameters: z.object({ volumeId: z.string().min(1) }),
  permission: STRUCTURE_PERMISSION,
  readOnly: false,
  async execute(ctx, args) {
    const deleted = await withAgentManuscriptWrite(ctx, tx => deleteVolumeData(ctx.userId, ctx.novelId, args.volumeId, tx))
    return deleted ? { output: '空卷已删除，卷序已自动压缩。', summary: '删除空卷' } : { output: '目标卷不存在。', outcome: 'failed' as const }
  },
})

const chapterMoveParameters = z.object({
  chapterId: z.string().min(1),
  targetVolumeId: z.string().min(1),
  position: z.number().int().positive(),
  expectedRevision: z.number().int().positive().optional(),
})

function defineChapterMoveTool(name: 'chapter_move' | 'chapter_move_to_volume', title: string) {
  return defineTool({
    name,
    title,
    description: '把章节移动到目标卷的指定卷内位置；同卷调整和跨卷移动都由服务端原子重排，不会产生重号或断号。',
    parameters: chapterMoveParameters,
    permission: STRUCTURE_PERMISSION,
    readOnly: false,
    async execute(ctx, { chapterId, ...input }) {
      assertProtectedChapterUntouched(ctx, chapterId)
      const chapter = await withAgentManuscriptWrite(ctx, tx => moveChapterData(ctx.userId, ctx.novelId, chapterId, input, tx))
      return chapter
        ? {
            output: `已移动《${chapter.title}》：全书第 ${chapter.orderIndex} 章，卷内第 ${chapter.orderInVolume} 章。`,
            summary: `移动章节《${chapter.title}》`,
            observedState: { kind: 'chapter' as const, id: chapter.id, revision: chapter.revision },
            display: { kind: 'chapterRef' as const, chapterId: chapter.id, title: chapter.title, wordCount: chapter.wordCount },
          }
        : { output: '目标章节不存在或不属于当前作品。', outcome: 'failed' as const }
    },
  })
}

export const chapterMoveTool = defineChapterMoveTool('chapter_move', '移动章节')
export const chapterMoveToVolumeTool = defineChapterMoveTool('chapter_move_to_volume', '章节移入卷')

export const chapterSplitTool = defineTool({
  name: 'chapter_split',
  title: '拆分章节',
  description: '按字符位置把一章拆成相邻两章，后半部分成为新章，卷内序与全书序自动校正。拆分前必须先读取章节确认位置。',
  parameters: z.object({
    chapterId: z.string().min(1),
    splitOffset: z.number().int().positive(),
    newChapterTitle: z.string().min(1).max(120),
    expectedRevision: z.number().int().positive().optional(),
  }),
  permission: STRUCTURE_PERMISSION,
  readOnly: false,
  async execute(ctx, { chapterId, ...input }) {
    assertProtectedChapterUntouched(ctx, chapterId)
    const result = await withAgentManuscriptWrite(ctx, tx => splitChapterData(ctx.userId, ctx.novelId, chapterId, input, tx))
    return result
      ? { output: `已将《${result.first.title}》拆分，并创建相邻章节《${result.second.title}》（chapterId=${result.second.id}）。`, summary: `拆分《${result.first.title}》`, affectedChapterIds: [result.first.id, result.second.id] }
      : { output: '目标章节不存在或不属于当前作品。', outcome: 'failed' as const }
  },
})

export const chapterMergeTool = defineTool({
  name: 'chapter_merge',
  title: '合并章节',
  description: '把来源章节正文合并到目标章节末尾并删除来源章节，随后原子压缩结构。执行前必须读取两章并确认方向。',
  parameters: z.object({
    targetChapterId: z.string().min(1),
    sourceChapterId: z.string().min(1),
    separator: z.string().max(16).default('\n\n'),
    expectedTargetRevision: z.number().int().positive().optional(),
    expectedSourceRevision: z.number().int().positive().optional(),
  }),
  permission: STRUCTURE_PERMISSION,
  readOnly: false,
  async execute(ctx, { targetChapterId, ...input }) {
    assertProtectedChapterUntouched(ctx, targetChapterId, input.sourceChapterId)
    const chapter = await withAgentManuscriptWrite(ctx, tx => mergeChaptersData(ctx.userId, ctx.novelId, targetChapterId, input, tx))
    return chapter
      ? {
          output: `章节已合并到《${chapter.title}》，来源章节已删除，当前正文 ${chapter.wordCount} 字。`,
          summary: `合并到《${chapter.title}》`,
          affectedChapterIds: [chapter.id],
          observedState: { kind: 'chapter' as const, id: chapter.id, revision: chapter.revision },
          display: { kind: 'chapterRef' as const, chapterId: chapter.id, title: chapter.title, wordCount: chapter.wordCount },
        }
      : { output: '目标或来源章节不存在。', outcome: 'failed' as const }
  },
})

export const structureOutlineTool = defineTool({
  name: 'structure_outline',
  title: '校验作品结构',
  description: '检查卷序、卷内章序、全书章序是否连续且一致。结构操作完成后必须调用。',
  parameters: z.object({}),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx): Promise<ToolResult> {
    if (ctx.durableRead) {
      const captured = { ...ctx, toolAuthority: new Map(ctx.toolAuthority), durableRead: { ...ctx.durableRead, lease: { ...ctx.durableRead.lease }, cursor: { ...ctx.durableRead.cursor } } }
      return executeDurableRead(captured, 'structure_outline', {}, raw => structureOutlineTool.parameters.parse(raw),
        tx => structureOutlineTool.execute({ ...captured, durableRead: undefined, transaction: tx }, {}))
    }
    const { report, stateHash } = await getStructureReportObservation(ctx.userId, ctx.novelId, ctx.transaction)
    return {
      ...(ctx.transaction ? { observedStructure: { kind: 'structure' as const, id: ctx.novelId, hash: await getStructureRevisionHash(ctx.transaction, ctx.novelId) } } : {}),
      validationEvidence: { code: 'STRUCTURE_VALIDATED', passed: report.valid, novelId: ctx.novelId, stateHash, issues: report.issues.map(issue => issue.code) },
      output: report.valid
        ? `结构校验通过：${report.volumeCount} 卷、${report.chapterCount} 章，卷序与章序连续。`
        : `结构校验未通过：\n${report.issues.map((issue) => `- ${issue.message}`).join('\n')}`,
      summary: report.valid ? '结构校验通过' : `发现 ${report.issues.length} 个结构问题`,
    }
  },
})
