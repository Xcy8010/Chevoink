import { describe, expect, it } from 'vitest'

import { AGENT_TOOL_GOVERNANCE } from '../../api/lib/agent/tools/governance.js'
import { allTools, getAgentToolManifest } from '../../api/lib/agent/tools/registry.js'
import { agentToolResourceKey } from '../../api/lib/agent/tools/contract.js'
import { getAgentToolPresentation, registeredAgentToolPresentationNames } from '../../shared/agent-tool-presentation.js'

describe('Agent 工具治理清单', () => {
  it('actual registry generates complete author, authority, effect and recovery contracts', () => {
    const manifest = getAgentToolManifest()
    expect(manifest).toHaveLength(allTools.length)
    expect(new Set(manifest.map(tool => tool.name)).size).toBe(allTools.length)
    expect(new Set(registeredAgentToolPresentationNames())).toEqual(new Set(allTools.map(tool => tool.name)))
    for (const [index, entry] of manifest.entries()) {
      expect(entry.permission).toEqual(allTools[index].permission)
      expect(entry.contract.author.label).toMatch(/^[\u4e00-\u9fff]+$/)
      expect(entry.contract.preconditions).toContain('frozen_tool_authority')
      expect(entry.contract.postconditions.length).toBeGreaterThan(0)
      expect(entry.contract.recovery === 'repeat_authorized_read' || entry.contract.recovery === 'committed_receipt_only').toBe(true)
    }
    expect(getAgentToolPresentation('future_unknown_tool')).toEqual({ label: '推进创作', phase: 'other' })
  })

  it('paid reads, preview/trace operations and writers cannot be classified as replayable queries', () => {
    const entries = getAgentToolManifest()
    for (const name of ['view_image', 'read_file', 'novel_export', 'bulk_replace_preview', 'craft_search',
      'quality_analyze', 'chapter_write', 'changeset_apply', 'task_spawn']) {
      expect(entries.find(tool => tool.name === name)?.contract).toMatchObject({
        recovery: 'committed_receipt_only', concurrency: 'serialize_scope',
      })
    }
    const read = entries.find(tool => tool.name === 'chapter_read')!
    expect(read.contract).toMatchObject({ recovery: 'repeat_authorized_read', concurrency: 'independent_read' })
    const scope = { userId: 'owner', novelId: 'novel', sessionId: 'session' }
    expect(agentToolResourceKey(read.contract, scope)).not.toEqual(agentToolResourceKey(read.contract, { ...scope, userId: 'other' }))
    expect(agentToolResourceKey(read.contract, scope)).not.toEqual(agentToolResourceKey(read.contract, { ...scope, novelId: 'other' }))
    const write = entries.find(tool => tool.name === 'chapter_write')!
    expect(agentToolResourceKey(write.contract, scope)).toEqual(agentToolResourceKey(read.contract, scope))
    expect(write.contract.preconditions).toContain('current_chapter_observation_and_revision')
  })
  it('注册表内每个工具都有分类、风险和后置条件', () => {
    for (const tool of allTools) {
      const governance = AGENT_TOOL_GOVERNANCE[tool.name as keyof typeof AGENT_TOOL_GOVERNANCE]
      expect(governance, `${tool.name} 未登记治理信息`).toBeDefined()
      expect(governance.postconditions.length, `${tool.name} 未登记后置条件`).toBeGreaterThan(0)
    }
  })

  it('治理清单不存在未注册的幽灵工具', () => {
    const registeredNames = new Set(allTools.map((tool) => tool.name))
    for (const name of Object.keys(AGENT_TOOL_GOVERNANCE)) {
      expect(registeredNames.has(name), `${name} 已登记但未注册`).toBe(true)
    }
  })

  it('dangerous 工具必须归类为高风险', () => {
    for (const tool of allTools.filter((item) => item.dangerous)) {
      expect(AGENT_TOOL_GOVERNANCE[tool.name as keyof typeof AGENT_TOOL_GOVERNANCE].category).toBe('high_risk')
    }
  })

  it('跨文档应用与回滚即使全局自动批准开启也必须逐次确认', () => {
    for (const name of ['changeset_apply', 'changeset_rollback']) {
      const tool = allTools.find((item) => item.name === name)
      expect(tool?.alwaysConfirm).toBe(true)
      expect(tool?.dangerous).toBe(true)
      expect(tool?.permission.build).toBe('ask')
    }
  })

  it('会话原文工具只读且明确禁止每轮例行扫描', () => {
    const search = allTools.find((item) => item.name === 'session_history_search')
    const read = allTools.find((item) => item.name === 'session_message_read')

    expect(search?.readOnly).toBe(true)
    expect(read?.readOnly).toBe(true)
    expect(search?.description).toContain('普通写作、续写、改稿与已有上下文足够时禁止调用')
    expect(read?.description).toContain('禁止为了“以防万一”批量读取整段会话')
  })
})
