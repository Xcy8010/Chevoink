import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

vi.mock('../../api/lib/agent/research-dossier.js', () => ({
  buildResearchDossier: vi.fn(), getLatestResearchDossier: vi.fn(),
  getLatestFirstThreePrototype: vi.fn(), buildFirstThreePrototype: vi.fn(),
}))
import { buildResearchDossier, getLatestFirstThreePrototype, buildFirstThreePrototype } from '../../api/lib/agent/research-dossier.js'
import { researchDossierBuildTool, firstThreePrototypeGetTool, firstThreePrototypeBuildTool } from '../../api/lib/agent/tools/research-dossier-tools.js'
import { OPERATION_KNOWLEDGE } from '../../api/lib/agent/knowledge/operation.js'

const ctx = { userId: 'author', novelId: 'novel', runId: 'run', signal: new AbortController().signal } as ToolContext
const dossier = { id: 'dossier', version: 2, searchCount: 1, sources: [{ title: '合成来源' }], expiresAt: '2026-11-05T00:00:00Z',
  readerPromise: '职业细节准确', abandonmentRisks: ['信息误读'], differentiation: ['行动细节'], languageRisks: [] }

beforeEach(() => { vi.resetAllMocks() })

describe('research results retain the current request scope', () => {
  it.each(['new_book', 'factual_risk', 'new_arc', 'author_request'] as const)('reports actual %s research without starting a new planning pipeline', async triggerReason => {
    vi.mocked(buildResearchDossier).mockResolvedValueOnce(dossier as never)
    const args = researchDossierBuildTool.parameters.parse({ triggerReason, triggerSignals: ['本次任务需要核对资料'],
      topic: '合成职业事实', genre: '现实', targetAudience: '成年读者', queries: ['合成研究查询'] })
    const result = await researchDossierBuildTool.execute(ctx, args)
    expect(result.output).toContain('共执行 1 个查询、保存 1 个摘要来源')
    expect(result.output).toContain('按原始请求使用本次资料；研究完成不自动启动其他规划或创作')
    expect(result.output).not.toContain('下一步新书规划应建立')
    expect(result.output).not.toContain('再调用 first_three_prototype_build')
    expect(buildResearchDossier).toHaveBeenCalledOnce()
    expect(buildFirstThreePrototype).not.toHaveBeenCalled()
  })

  it('reports cache reuse without another research or prototype request', async () => {
    vi.mocked(buildResearchDossier).mockResolvedValueOnce({ ...dossier, reused: true } as never)
    const args = researchDossierBuildTool.parameters.parse({ triggerReason: 'new_book', triggerSignals: ['合成新书规划'],
      topic: '合成定位', genre: '科幻', targetAudience: '成年读者', queries: ['合成查询'] })
    const result = await researchDossierBuildTool.execute(ctx, args)
    expect(result.output).toContain('命中 Research Dossier v2 缓存')
    expect(result.output).toContain('档案就绪不要求新增宪章、前三章规划或正文任务')
    expect(buildFirstThreePrototype).not.toHaveBeenCalled()
  })

  it('keeps an absent prototype as absent data rather than a creation obligation', async () => {
    vi.mocked(getLatestFirstThreePrototype).mockResolvedValueOnce(null)
    const result = await firstThreePrototypeGetTool.execute(ctx, {})
    expect(result.output).toContain('当前作品尚无前三章试制')
    expect(result.output).toContain('缺少这份规划不产生创建义务')
    expect(buildResearchDossier).not.toHaveBeenCalled()
    expect(buildFirstThreePrototype).not.toHaveBeenCalled()
  })

  it('delivers a saved blueprint without promising chapter execution or treating candidates as a choice', async () => {
    const directions = [1, 2].map(index => ({ id: `direction-${index}`, title: `方向${index}`, readerPromise: '人物选择', conflictEngine: '行动阻力', differentiation: '视角差异', risk: '信息不足' }))
    const chapterBlueprints = [1, 2, 3].map(orderIndex => ({ orderIndex, title: `第${orderIndex}章`, chapterJob: '明确目标', concreteEvent: '人物找到线索',
      protagonistChoice: '继续核实', cost: '投入时间', newInformation: '来源可疑', exitHook: '等待答复', qualityRisks: [] }))
    vi.mocked(buildFirstThreePrototype).mockResolvedValueOnce({ id: 'prototype', version: 1, genreRisks: ['线索重复'], directions, chapterBlueprints } as never)
    const args = firstThreePrototypeBuildTool.parameters.parse({ dossierId: 'dossier', charterRevision: 1, directions,
      volumeSpine: ['人物发现线索', '人物核实线索', '人物决定追查'], genreRisks: ['线索重复'], chapterBlueprints })
    const result = await firstThreePrototypeBuildTool.execute(ctx, args)
    expect(result.output).toContain('本次保存的是规划蓝图，不是章节正文')
    expect(result.output).toContain('未选择的方向保持候选')
    expect(result.output).toContain('蓝图就绪不自动开启写作或完整长纲任务')
    expect(result.output).not.toContain('再逐章执行 Story Compiler')
  })
})

it('does not describe failed or repeated tools as proof of zero effect or prohibit a second authorized revision', () => {
  expect(OPERATION_KNOWLEDGE).not.toContain('那次调用完全没执行')
  expect(OPERATION_KNOWLEDGE).not.toContain('在一次任务里只落盘一次')
  expect(OPERATION_KNOWLEDGE).toContain('写入后失败可能已有局部成果')
  expect(OPERATION_KNOWLEDGE).toContain('请求结果或费用未知时先核实，禁止直接重发付费请求')
  expect(OPERATION_KNOWLEDGE).toContain('不把重复调用当成幂等或无副作用的证明')
  expect(OPERATION_KNOWLEDGE).toContain('正文在原授权范围内依据当前稿与版本继续修订')
})
