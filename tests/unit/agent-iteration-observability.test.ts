import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { allTools } from '../../api/lib/agent/tools/registry'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('Agent 创作可观测与容错', () => {
  it('容错记忆工具的包装参数、别名和缺省重要度', () => {
    const tool = allTools.find((item) => item.name === 'memory_save')
    const coerced = tool?.coerceArgs?.({ memory: {
      type: 'storyArc', name: '主线阶段', body: ['主角进入军营', '发现名单异常'], priority: '88',
    } })
    expect(tool?.parameters.safeParse(coerced).success).toBe(true)
    expect(coerced).toMatchObject({ memoryType: 'storyArc', title: '主线阶段', importance: 88 })
  })

  it('容错计划工具的数组参数、深层正文与字符串化包装', () => {
    const tool = allTools.find((item) => item.name === 'plan_save')
    const fromParameterList = tool?.coerceArgs?.({ parameters: [
      { name: 'title', value: '第三卷计划' },
      { name: 'content', value: { value: '# 第三卷\n推进主线并完成阶段收束。' } },
      { name: 'planId', value: null },
    ] })
    expect(tool?.parameters.safeParse(fromParameterList).success).toBe(true)
    expect(fromParameterList).toMatchObject({ title: '第三卷计划', content: '# 第三卷\n推进主线并完成阶段收束。' })

    const wrapped = tool?.coerceArgs?.({ tool_input: JSON.stringify({ name: '全书大纲', markdown: '# 全书大纲\n第一阶段进入军营。' }) })
    expect(tool?.parameters.safeParse(wrapped).success).toBe(true)
    expect(wrapped).toMatchObject({ title: '全书大纲', content: '# 全书大纲\n第一阶段进入军营。' })
  })

  it('关系网仅在空置或受限刷新时使用 low AI，并支持全小说实体', () => {
    const source = read('api/lib/agent/story-memory.ts')
    expect(source).toContain("reasoningEffort: 'low'")
    expect(source).toContain('MEMORY_GRAPH_REFRESH_COOLDOWN_MS')
    expect(source).toContain("z.enum(['character', 'location', 'scene', 'organization', 'item', 'event', 'concept'])")
    expect(source).toContain('if (!force && existingEntityCount > 0)')
    expect(source).toContain("从正文中自动识别")
  })

  it('最终正文和工具长文都走流式事件，写入期锁定编辑器', () => {
    const loop = read('api/lib/agent/loop.ts')
    const workspace = read('src/features/studio/StudioWorkspace.tsx')
    const viewer = read('src/features/studio/components/StudioChapterViewer.tsx')
    const stream = read('src/features/studio/agent/useAgentStream.ts')
    expect(loop).toContain("type: 'text.delta'")
    expect(loop).toContain("type: 'text.final'")
    expect(stream).toContain("'text.final'")
    expect(loop).toContain('extractStreamingToolDraft(toolName, rawArgs)')
    expect(workspace).toContain('liveToolDrafts')
    expect(viewer).toContain('Agent 写入中 · 暂停编辑')
    expect(viewer).toContain('const readOnly = retained || writeLocked')
    expect(viewer).toContain('readOnly={readOnly}')
  })

  it('Work 追踪会自动打开作品树及章节查看器', () => {
    const workspace = read('src/features/studio/StudioWorkspace.tsx')
    expect(workspace).toContain("setWorkInspectorTab('work')")
    expect(workspace).toContain('setWorkRightOpen(true)')
    expect(workspace).toContain("setWorkViewer('chapter')")
  })

  it('Token 后台同时提供用户排行、作品/任务用量和工具调用数', () => {
    const data = read('api/lib/data/admin.ts')
    const page = read('src/features/admin/pages/AdminTokenManagementPage.tsx')
    expect(data).toContain('getAdminTokenManagementData')
    expect(data).toContain("trackedToolResultWhere('web_search'")
    expect(data).toContain("trackedToolResultWhere('cover_generate'")
    expect(page).toContain('用量排行')
    expect(page).toContain('高消耗动作')
    expect(page).toContain('/creation-records')
  })
})
