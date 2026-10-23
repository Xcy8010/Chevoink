import { describe, expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeTaskCapabilities, taskToolRelevance } from '../../api/lib/agent/task-capabilities.js'
import { restrictToolsToTask, snapshotToolAuthority, intersectToolAuthority } from '../../api/lib/agent/tool-authority.js'
import { getToolsForAgent, getAgentDefinition, applySessionToolPolicy } from '../../api/lib/agent/agents.js'
import { getAgentToolManifest, toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'

const names = getAgentToolManifest().map(tool => tool.name)
function task(prompt: string) {
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'target', prompt, authorWritingProtocol: 2,
    researchAdmission: 1, networkAdmission: 1 })
  if (spec.scope.authorEffects?.manuscript) spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'target', orderIndex: 4 }],
    titleAndBodyOnly: false, repairAuthorized: true }
  return spec
}
const freeze = (prompt: string) => freezeTaskCapabilities(task(prompt), { prompt }, names)

describe('fresh task relevance catalog', () => {
  it('narrows one ordinary chapter task while preserving the complete internal writing closure', () => {
    const spec = freeze('修改第四章正文，核对连续性和质量。')
    expect(spec.scope.capabilityCatalog?.kind).toBe('writing')
    const selected = spec.scope.capabilityCatalog!.names
    expect(selected.length).toBeLessThan(names.length)
    for (const name of ['chapter_read', 'chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'story_compiler_prepare',
      'scene_task_build', 'continuity_validate', 'quality_analyze', 'quality_finding_feedback', 'chapter_bridge_commit', 'execution_context_read']) expect(selected).toContain(name)
    expect(selected).not.toContain('cover_generate')
    expect(selected).not.toContain('skill_publish')
    expect(taskSpecSchema.safeParse(spec).success).toBe(true)
  })
  it.each(['修改第四章正文，然后导出', '修改第四章正文并生成封面', '修改第四章正文，然后创建一个技能',
    '修改第四章正文，调整模型', '修改第四章正文并保存计划', '修改第四章正文，检查账单', '修改第四章正文，“未闭合引用',
    '修改第四章正文，先联网搜索潜艇结构并核对来源', '修改第四章正文，先读取 https://author.example/chapter/4 的公开资料',
    'Revise chapter 4, first browse the web and fetch the source'])(
    'keeps extension/mixed/unknown requests intact: %s', prompt => {
      expect(freeze(prompt).scope.capabilityCatalog).toMatchObject({ kind: 'full', names: [...names, 'execution_context_read'] })
    })
  it('retains pins, attachments and local editing without reinterpreting their contracts', () => {
    const prompt = '修改第四章正文。', original = task(prompt)
    for (const extension of [{ attachments: [{ id: 'attachment', kind: 'file' as const, name: 'reference', url: '/private/file', size: 4 }] },
      { pinnedSkillIds: ['original-skill'] }, { pinnedSubagentId: 'original-agent' }, { selection: { text: '原文', start: 0, end: 2 } }]) {
      expect(freezeTaskCapabilities(original, { prompt, ...extension }, names).scope.capabilityCatalog?.kind).toBe('full')
    }
    expect(original.scope.capabilityCatalog).toBeUndefined()
  })
  it.each([{ prompt: '研究《合成作品》，不要联网', kind: 'full' },
    { prompt: '上网搜索《合成作品》，研究叙事技巧，只搜索不要读取正文', kind: 'research' }])(
    'preserves research network/read denials after relevance selection: $prompt', ({ prompt, kind }) => {
      const spec = freeze(prompt), available = getToolsForAgent(getAgentDefinition('orchestrator'), 'build')
      const selected = restrictToolsToTask(available, spec)
      if (spec.networkAccess === 'denied') expect(selected.some(tool => ['web_search', 'web_read'].includes(tool.name))).toBe(false)
      if (spec.researchReadAccess === 'denied') expect(selected.some(tool => tool.name === 'web_read')).toBe(false)
      expect(spec.scope.capabilityCatalog?.kind).toBe(kind)
    })
  it('freezes stable names once and keeps schema/authority aligned under a stricter session policy', () => {
    const prompt = '修改第四章正文。', spec = freeze(prompt)
    expect(freezeTaskCapabilities(spec, { prompt: '后来模型想导出' }, [...names, 'later_capability'])).toBe(spec)
    const available = getToolsForAgent(getAgentDefinition('orchestrator'), 'build')
    const tools = applySessionToolPolicy(restrictToolsToTask(available, spec), 'build', { contentWrite: 'deny' }, 'full_access')
    const authority = snapshotToolAuthority(tools, 'build')
    expect(toOpenAITools(tools, spec.scope).map(tool => tool.function.name)).toEqual([...authority.keys()])
    expect(authority.has('chapter_write')).toBe(false)
    expect(intersectToolAuthority(available, 'build', authority).map(tool => tool.name)).toEqual(tools.map(tool => tool.name))
  })
  it('preserves unknown extensions at admission, but never adds a later registry name to saved runs', () => {
    const prompt = '修改第四章正文。'
    const spec = freezeTaskCapabilities(task(prompt), { prompt }, [...names, 'new_extension'])
    expect(taskToolRelevance('new_extension')).toBe('extension')
    expect(spec.scope.capabilityCatalog!.names).toContain('new_extension')
    expect(spec.scope.capabilityCatalog!.names).not.toContain('later_extension')
    expect(freezeTaskCapabilities(spec, { prompt }, [...names, 'later_extension'])).toBe(spec)
  })
  it('does not retrofit legacy contracts or accept another request hash', () => {
    const old = buildTaskSpec({ runId: 'old', novelId: 'novel', prompt: '修改第四章' })
    expect(freezeTaskCapabilities(old, { prompt: '修改第四章' }, names)).toBe(old)
    expect(() => freezeTaskCapabilities(task('修改第四章'), { prompt: '导出作品' }, names)).toThrow('Original request')
    const spec = freeze('修改第四章')
    expect(taskSpecSchema.safeParse({ ...spec, scope: { ...spec.scope, capabilityCatalog: { ...spec.scope.capabilityCatalog!, requestHash: 'a'.repeat(64) } } }).success).toBe(false)
  })
})
