import { z } from 'zod'

import { assertAgentManuscriptCurrent } from '../manuscript-scope.js'
import { assertWritingTarget } from '../writing-scope.js'
import {
  applyChangeSetData,
  getStructureReportData,
  previewBulkReplaceData,
  rollbackChangeSetData,
  searchProjectData,
} from '../../data-access.js'
import type { ChangeSet } from '../../../../shared/contracts/index.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { defineTool } from './types.js'

const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const
const PREVIEW_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const
const APPLY_PERMISSION = { plan: 'deny', build: 'ask', review: 'deny' } as const

function clip(value: string | null, max = 180) {
  if (!value) return ''
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function changeSetDisplay(changeSet: ChangeSet) {
  return {
    kind: 'changeSet' as const,
    changeSetId: changeSet.id,
    status: changeSet.status,
    patchCount: changeSet.patches.length,
    selectedCount: changeSet.patches.filter((patch) => patch.selected).length,
    patches: changeSet.patches.slice(0, 50).map((patch) => ({
      id: patch.id,
      chapterId: patch.targetId,
      field: patch.field,
      beforePreview: clip(patch.before),
      afterPreview: clip(patch.after),
      selected: patch.selected,
    })),
  }
}

export const projectSearchTool = defineTool({
  name: 'project_search',
  title: '全书检索',
  description: '一次检索整部作品的章节标题、摘要和正文，返回卷章位置、字符偏移、上下文与来源 revision。全局改名禁止逐章读取，必须先用本工具确认命中集。',
  parameters: z.object({
    query: z.string().min(1).max(256),
    mode: z.enum(['exact', 'regex', 'fuzzy']).default('exact'),
    fields: z.array(z.enum(['title', 'summary', 'content'])).min(1).default(['title', 'summary', 'content']),
    caseSensitive: z.boolean().default(true),
    volumeIds: z.array(z.string().min(1)).optional(),
    chapterIds: z.array(z.string().min(1)).optional(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const result = await searchProjectData(ctx.userId, ctx.novelId, args, ctx.transaction)
    const artifact = result.matches.length > 20
      ? await (ctx.transaction ?? prisma).agentArtifact.create({
          data: {
            runId: ctx.runId,
            artifactType: 'searchResult',
            title: `全书检索：${args.query}`.slice(0, 160),
            summary: `${result.total} 处命中，索引 ${result.indexState}`,
            content: JSON.stringify(result),
            metadata: { query: args.query, mode: args.mode },
          },
        })
      : null
    const visibleMatches = artifact && !ctx.transaction ? result.matches.slice(0, 20) : result.matches
    const lines = visibleMatches.map((match) =>
      `- ${match.volumeTitle} / ${match.chapterTitle} [${match.field}@${match.offset}, chapterId=${match.chapterId}, revision=${match.revision}] …${match.contextBefore}【${match.match}】${match.contextAfter}…`,
    )
    return {
      output: `全书检索命中 ${result.total} 处${result.truncated ? `（查询仅返回前 ${result.matches.length} 处）` : ''}，索引状态 ${result.indexState}。${artifact ? `本次返回结果已保存为 artifactId=${artifact.id}，${ctx.transaction ? '以下包含本次全部返回结果' : `上下文仅保留前 ${visibleMatches.length} 处`}。` : ''}\n${lines.join('\n') || '无匹配。'}`,
      summary: `全书检索“${args.query}” · ${result.total} 处`,
    }
  },
})

export const entityResolveTool = defineTool({
  name: 'entity_resolve',
  title: '解析实体影响',
  description: '按名称检索全书并按章节、字段统计出现位置，辅助判断人物/地点/物品同名歧义；不自动认定实体身份。',
  parameters: z.object({ name: z.string().min(1).max(128) }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const result = await searchProjectData(ctx.userId, ctx.novelId, {
      query: args.name,
      mode: 'exact',
      fields: ['title', 'summary', 'content'],
      caseSensitive: true,
      limit: 500,
    }, ctx.transaction)
    const grouped = new Map<string, number>()
    for (const match of result.matches) grouped.set(match.chapterTitle, (grouped.get(match.chapterTitle) ?? 0) + 1)
    return {
      output: `名称“${args.name}”共命中 ${result.total} 处，分布：${[...grouped].map(([title, count]) => `${title} ${count}处`).join('；') || '无'}。这只是词法证据；若存在同名或旧名语境，应在预览中排除。`,
      summary: `解析“${args.name}” · ${result.total} 处`,
    }
  },
})

export const impactAnalyzeTool = defineTool({
  name: 'impact_analyze',
  title: '分析全书影响',
  description: '统计某文本会影响的卷、章、标题、摘要和正文范围，为变更预览提供影响摘要。',
  parameters: z.object({ query: z.string().min(1).max(256) }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const result = await searchProjectData(ctx.userId, ctx.novelId, {
      query: args.query,
      mode: 'exact',
      fields: ['title', 'summary', 'content'],
      caseSensitive: true,
      limit: 1000,
    }, ctx.transaction)
    const chapters = new Set(result.matches.map((match) => match.chapterId))
    const volumes = new Set(result.matches.map((match) => match.volumeId))
    const fields = new Set(result.matches.map((match) => match.field))
    return {
      output: `影响范围：${volumes.size} 卷、${chapters.size} 章、${result.total} 处；字段：${[...fields].join('、') || '无'}；索引状态：${result.indexState}。`,
      summary: `影响分析 · ${chapters.size} 章 ${result.total} 处`,
    }
  },
})

function definePreviewTool(name: 'bulk_replace_preview' | 'entity_rename_preview', title: string, entityMode: boolean) {
  return defineTool({
    name,
    title,
    description: entityMode
      ? '生成实体改名 ChangeSet 预览。可保留引号中的历史旧名；只创建补丁，不写正文。必须把 changeSetId 交给 changeset_apply。'
      : '生成全书精确替换 ChangeSet 预览；只创建补丁，不写正文。返回逐字段前后预览、排除数和 changeSetId。',
    parameters: z.object({
      query: z.string().min(1).max(256),
      replacement: z.string().max(256),
      fields: z.array(z.enum(['title', 'summary', 'content'])).min(1).default(['content']),
      caseSensitive: z.boolean().default(true),
      preserveQuotedText: z.boolean().default(entityMode),
      excludeChapterIds: z.array(z.string().min(1)).default([]),
      reason: z.string().min(1).max(500).default(entityMode ? '实体改名' : '全书批量替换'),
    }),
    permission: PREVIEW_PERMISSION,
    readOnly: true,
    async execute(ctx, args) {
      let changeSet: ChangeSet
      try {
        changeSet = await previewBulkReplaceData(ctx.userId, ctx.novelId, args)
      } catch (error) {
        if (error instanceof DataAccessError && ['NO_SEARCH_MATCH', 'NO_CHANGE'].includes(error.code)) {
          const detail = error.code === 'NO_CHANGE' ? '替换前后相同，无需扫描。' : '已按指定字段、排除章节及引文保护条件核对。'
          return { summary: '预览完成 · 无需变更', output: `${error.message} ${detail}未创建变更集、未写入正文。无需调用 changeset_apply；不要重复相同预览。若与预期不符，请先用 project_search 核对范围。` }
        }
        throw error
      }
      return {
        output: `已生成 ChangeSet ${changeSet.id}：${changeSet.patches.length} 个字段补丁，尚未写入正文。请检查预览与警告；确认后调用 changeset_apply(changeSetId=${changeSet.id})。`,
        summary: `生成变更预览 · ${changeSet.patches.length} 项`,
        display: changeSetDisplay(changeSet),
      }
    },
  })
}

export const bulkReplacePreviewTool = definePreviewTool('bulk_replace_preview', '生成全书替换预览', false)
export const entityRenamePreviewTool = definePreviewTool('entity_rename_preview', '生成实体改名预览', true)

export const changeSetApplyTool = defineTool({
  name: 'changeset_apply',
  title: '应用全书变更集',
  description: '校验所有目标 revision 与内容哈希后，在一个数据库事务中应用选中补丁；任一冲突则整批不写入。该工具始终要求作者确认。',
  parameters: z.object({
    changeSetId: z.string().min(1),
    selectedPatchIds: z.array(z.string().min(1)).optional(),
  }),
  permission: APPLY_PERMISSION,
  readOnly: false,
  dangerous: true,
  alwaysConfirm: true,
  async execute(ctx, { changeSetId, selectedPatchIds }) {
    const changeSet = await applyChangeSetData(ctx.userId, changeSetId, { selectedPatchIds }, async (tx, novelId, ids) => {
      if (novelId !== ctx.novelId) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '变更集不属于当前授权作品。')
      await assertAgentManuscriptCurrent(tx, ctx)
      for (const chapterId of ids) await assertWritingTarget(tx, ctx, { chapterId })
    })
    if (!changeSet) return { output: '变更集不存在或不属于当前作者。' }
    return {
      output: `ChangeSet ${changeSet.id} 已原子应用，${changeSet.patches.filter((patch) => patch.selected).length} 个补丁全部通过版本与哈希校验。可用 changeset_rollback 整体回滚。`,
      summary: `已应用变更集 · ${changeSet.patches.filter((patch) => patch.selected).length} 项`,
      display: changeSetDisplay(changeSet),
    }
  },
})

export const changeSetRollbackTool = defineTool({
  name: 'changeset_rollback',
  title: '整体回滚变更集',
  description: '在确认所有目标自应用后未再被编辑的前提下，整体恢复 ChangeSet 的应用前内容；任一冲突则不回滚任何章节。该工具始终要求作者确认。',
  parameters: z.object({ changeSetId: z.string().min(1) }),
  permission: APPLY_PERMISSION,
  readOnly: false,
  dangerous: true,
  alwaysConfirm: true,
  async execute(ctx, args) {
    const changeSet = await rollbackChangeSetData(ctx.userId, args.changeSetId, async (tx, novelId, ids) => {
      if (novelId !== ctx.novelId) throw new DataAccessError(409, 'AUTHOR_CHAPTER_SCOPE', '变更集不属于当前授权作品。')
      await assertAgentManuscriptCurrent(tx, ctx)
      for (const chapterId of ids) await assertWritingTarget(tx, ctx, { chapterId })
    })
    if (!changeSet) return { output: '变更集不存在或不属于当前作者。' }
    return {
      output: `ChangeSet ${changeSet.id} 已整体回滚，所有目标章节恢复到应用前内容。`,
      summary: '已整体回滚变更集',
      display: changeSetDisplay(changeSet),
    }
  },
})

export const structureValidateTool = defineTool({
  name: 'structure_validate',
  title: '验证卷章结构',
  description: '验证全书卷序、卷内章序和全书阅读顺序；跨章变更完成后用于后置校验。',
  parameters: z.object({}),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx) {
    const report = await getStructureReportData(ctx.userId, ctx.novelId, ctx.transaction)
    return {
      output: report.valid ? `结构验证通过：${report.volumeCount} 卷 ${report.chapterCount} 章。` : report.issues.map((issue) => issue.message).join('\n'),
      summary: report.valid ? '结构验证通过' : `结构验证发现 ${report.issues.length} 项异常`,
    }
  },
})
