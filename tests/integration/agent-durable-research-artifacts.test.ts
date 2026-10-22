import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../api/lib/prisma.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { saveResearchReportSection } from '../../api/lib/agent/research-sources.js'
import * as reducer from '../../api/lib/agent/runtime-reducer.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { platformNovelReadTool, platformNovelSearchTool } from '../../api/lib/agent/tools/platform-tools.js'
import { researchReportReadTool, researchReportSaveTool } from '../../api/lib/agent/tools/search-tools.js'
import { planExitTool } from '../../api/lib/agent/tools/write-tools.js'
import { characterVoiceSaveTool, experienceAnchorSaveTool, qualityFindingFeedbackTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { styleProfileExtractTool } from '../../api/lib/agent/tools/craft-library-tools.js'
import { firstThreePrototypeBuildTool } from '../../api/lib/agent/tools/research-dossier-tools.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

async function start(f: Parameters<Parameters<typeof fixture>[0]>[0], tools: AgentTool[], calls: Array<{ id: string; name: string; arguments: string }>, mode: 'build' | 'plan' = 'build') {
  const lease = await claim(f)
  await initializeExecutionState(lease, { configuration: { version: 1, mode, agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'balanced',
    model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } })),
    toolAuthority: tools.map(tool => ({ name: tool.name, permission: tool.permission[mode], alwaysConfirm: Boolean(tool.alwaysConfirm), dangerous: Boolean(tool.dangerous) })),
    protectedChapterIds: [], pinnedSkillVersions: [] }, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
    phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: 'Original synthetic task' }, { role: 'assistant', content: null, toolCalls: calls }], successfulToolSignatures: [] } })
  return lease
}
const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) })
const signal = () => new AbortController().signal

describe.runIf(available)('durable research and plan artifacts', () => {
  it('recovers a committed research section before reduction, then preserves the exact report revision', () => fixture(async f => {
    expect(f.spec.intent).toBe('research_analysis')
    const input = { reportId: 'main', expectedRevision: 0, section: { id: 'scope', order: 0, content: 'Only verified observations are analyzed.', citations: [] } }
    const network = vi.fn(() => { throw Error('Unexpected network') }); vi.stubGlobal('fetch', network)
    const updated = { ...input, expectedRevision: 1, section: { ...input.section, content: 'The same original report continues after resume.' } }
    let lease = await start(f, [researchReportSaveTool, researchReportReadTool], [call('save', 'research_report_save', input), call('read', 'research_report_read', {}),
      call('continued-save', 'research_report_save', updated),
      call('conflict', 'research_report_save', { ...input, section: { ...input.section, content: 'Stale overwrite attempt' } })])
    const interrupted = vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('Worker ended after commit'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended after commit')
    interrupted.mockRestore()
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'researchReport' } })).toBe(1)
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    const read = await executeDurableToolStep(lease, signal())
    expect(read).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining(input.section.content) } })
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'report-resumed-worker')
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { semanticTransition: { beforeHash: expect.any(String), afterHash: expect.any(String) } } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed', summary: '研究报告未保存' } })
    const artifact = await prisma.agentArtifact.findFirstOrThrow({ where: { runId: f.runId, artifactType: 'researchReport' } })
    expect(artifact).toMatchObject({ content: updated.section.content, metadata: { revision: 2 } })
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '原文' })
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    expect(network).not.toHaveBeenCalled()
  }, undefined, '分析这本小说'))

  it('does not normalize away changed frozen requirements when saving a research report', () => fixture(async f => {
    await claim(f)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { taskSpec: JSON.parse(JSON.stringify({ ...f.spec,
      expectedOutputs: f.spec.expectedOutputs.map(item => ({ ...item, description: 'Changed frozen requirements' })) })) } })
    await expect(prisma.$transaction(tx => saveResearchReportSection(f, { reportId: 'main', expectedRevision: 0,
      section: { id: 'scope', order: 0, content: 'Unapproved altered task.', citations: [] } }, tx))).rejects.toMatchObject({ code: 'RESEARCH_REPORT_NOT_AUTHORIZED' })
    expect(await prisma.agentArtifact.count({ where: { runId: f.runId, artifactType: 'researchReport' } })).toBe(0)
  }, undefined, '分析这本小说'))

  it('persists the exact plan display without granting Build or manuscript authority', () => fixture(async f => {
    const args = { summary: 'A synthetic plan', steps: [{ title: 'Discuss the premise' }, { title: 'Choose a viewpoint', detail: 'Wait for the author.' }] }
    const lease = await start(f, [planExitTool], [call('plan', 'plan_exit', args)], 'plan')
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { display: { kind: 'plan', ...args } } })
    const operation = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: f.rootId, action: 'plan_exit' }, include: { effectReceipt: true } })
    expect(operation.effectReceipt?.result).toMatchObject({ toolResult: { display: { kind: 'plan', ...args } } })
    expect((await loadExecutionState(f.userId, f.runId)).configuration.mode).toBe('plan')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content: '原文' })
  }, undefined, '拟定一个写作计划'))

  it('retains the platform search allowance across pause/resume and permits only receipt reuse after exhaustion', () => fixture(async f => {
    const calls = Array.from({ length: 6 }, (_, index) => call(`search-${index}`, 'platform_novel_search', { query: `synthetic-absent-${index}` }))
    calls.push(call('reuse', 'platform_novel_search', { query: 'synthetic-absent-0' }))
    let lease = await start(f, [platformNovelSearchTool], calls)
    for (let index = 0; index < 2; index++) expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { platformBudget: { charged: true } } })
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'resumed-worker')
    for (let index = 2; index < 5; index++) expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { platformBudget: { charged: true } } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: '站内搜索预算已用尽', platformBudget: { charged: false } } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining('已保存'), platformBudget: { charged: false } } })
    expect(await prisma.agentOperation.count({ where: { taskRootId: f.rootId, action: 'platform_novel_search', status: 'succeeded' } })).toBe(7)
  }))

  it('keeps other authors draft content private through the transaction adapter', () => fixture(async other => {
    await prisma.novel.update({ where: { id: other.novelId }, data: { status: 'published', visibility: 'public' } })
    await prisma.chapter.update({ where: { id: other.chapterId }, data: { status: 'published', visibility: 'public', content: 'PRIVATE_DRAFT_CONTENT', publishedRevision: 1,
      publishedTitle: 'Published title', publishedContent: 'PUBLIC_SNAPSHOT_CONTENT', publishedWordCount: 23 } })
    await fixture(async f => {
      const lease = await start(f, [platformNovelReadTool], [call('read', 'platform_novel_read', { novelId: other.novelId, chapterId: other.chapterId })])
      const result = await executeDurableToolStep(lease, signal())
      expect(result).toMatchObject({ kind: 'tool', result: { output: expect.stringContaining('PUBLIC_SNAPSHOT_CONTENT'), platformBudget: { charged: true } } })
      expect(JSON.stringify(result)).not.toContain('PRIVATE_DRAFT_CONTENT')
    })
  }))

  it('commits voice and anchor evidence with their receipts and rejects stale chapter evidence', () => fixture(async f => {
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: 8, content: 'One. Two. Three.' } })
    const voice = { characterName: 'Mara', vocabularyLevel: 'Plain', sentenceLength: { short: 4, long: 20 }, pressureResponse: 'Requests details', confirmed: true,
      voiceSamples: ['One.', 'Two.', 'Three.'].map(text => ({ text, sourceChapterId: f.chapterId, sourceRevision: 8 })) }
    const anchor = { characterName: 'Mara', title: 'The first count', triggerEvent: 'A count', concreteDetail: 'One.', habitualResponse: 'Counts', emotionalMeaning: 'Careful attention',
      sourceType: 'chapter', sourceChapterId: f.chapterId, sourceRevision: 8 }
    const lease = await start(f, [characterVoiceSaveTool, experienceAnchorSaveTool], [call('voice', 'character_voice_save', voice),
      call('voice-stale', 'character_voice_save', { ...voice, voiceSamples: voice.voiceSamples.map(sample => ({ ...sample, sourceRevision: 7 })) }),
      call('anchor', 'experience_anchor_save', anchor), call('anchor-stale', 'experience_anchor_save', { ...anchor, sourceRevision: 7 })])
    const interrupted = vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('Worker ended after voice commit'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended after voice commit')
    interrupted.mockRestore()
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: expect.stringContaining('保存经历锚点') } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect(await prisma.characterVoiceProfile.findFirstOrThrow({ where: { novelId: f.novelId } })).toMatchObject({ revision: 1, status: 'confirmed' })
    expect(await prisma.experienceAnchor.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ revision: 8, content: 'One. Two. Three.' })
  }))

  it('keeps author-input anchor identity on the original root after resume', () => fixture(async f => {
    const anchor = { characterName: 'Mara', title: 'A stated memory', triggerEvent: 'A bell', concreteDetail: 'A copper bell', habitualResponse: 'Waits', emotionalMeaning: 'Home',
      sourceType: 'author_input', authorConfirmed: true }
    let lease = await start(f, [experienceAnchorSaveTool], [call('anchor', 'experience_anchor_save', anchor), call('anchor-again', 'experience_anchor_save', anchor)])
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool' })
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: f.runId, type: 'run.paused' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    lease = await claim({ userId: f.userId, runId: resumed.run.id }, 'anchor-resumed-worker')
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool' })
    expect(await prisma.experienceAnchor.findMany({ where: { novelId: f.novelId } })).toMatchObject([{ sourceId: f.rootId, title: anchor.title }])
    expect(await prisma.experienceAnchor.count({ where: { novelId: f.novelId } })).toBe(1)
  }))

  it.each([false, true])('requires the exact Style DNA approval (approved=%s) before storing private samples', approved => fixture(async f => {
    const content = 'The archive door opens. Mara reads the date and checks the seal. '.repeat(60)
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content } })
    const lease = await start(f, [styleProfileExtractTool], [call('style', 'style_profile_extract', { title: 'Owned sample', chapterIds: [f.chapterId], authorConfirmed: true })])
    const waiting = await executeDurableToolStep(lease, signal())
    if (waiting.kind !== 'waiting_approval') throw Error('Expected an exact approval request')
    expect(await prisma.styleProfile.count({ where: { novelId: f.novelId } })).toBe(0)
    await resolveDurableApproval({ userId: f.userId, runId: f.runId, requestId: waiting.approvalId, callId: 'style', approved, alwaysAllow: false })
    const result = await executeDurableToolStep(lease, signal())
    expect(result).toMatchObject({ kind: 'tool', result: approved ? { summary: expect.stringContaining('Style DNA') } : { outcome: 'failed' } })
    expect(await prisma.styleProfile.count({ where: { novelId: f.novelId } })).toBe(approved ? 1 : 0)
    expect(await prisma.corpusSource.count({ where: { novelId: f.novelId, scope: 'novel', sourceClass: 'author_private' } })).toBe(approved ? 1 : 0)
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content })
  }))

  it('limits quality feedback to the original novel even when the user owns another novel', () => fixture(async f => {
    const other = await prisma.novel.create({ data: { authorId: f.userId, title: 'Other owned novel', summary: '', slug: randomUUID() } })
    const volume = await prisma.volume.create({ data: { novelId: other.id, title: 'Other volume', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: other.id, volumeId: volume.id, orderInVolume: 1, title: 'Other chapter', content: 'Other text', orderIndex: 1 } })
    const finding = async (novelId: string, chapterId: string) => {
      const report = await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId, chapterId, chapterRevision: 1, deterministicMetrics: {},
        findings: { create: { userId: f.userId, novelId, signal: 'emotion_grounding', source: 'critic', severity: 'advisory', startOffset: 0, endOffset: 1,
          evidenceExcerpt: 'A', evidenceHash: 'a'.repeat(64), explanation: 'Synthetic opinion', suggestion: 'Consider a detail' } } }, include: { findings: true } })
      return report.findings[0]
    }
    const foreign = await finding(other.id, chapter.id), owned = await finding(f.novelId, f.chapterId)
    const lease = await start(f, [qualityFindingFeedbackTool], [call('wrong-novel', 'quality_finding_feedback', { findingId: foreign.id, accepted: true }),
      call('current-novel', 'quality_finding_feedback', { findingId: owned.id, accepted: true })])
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { outcome: 'failed' } })
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'tool', result: { summary: '记录质量反馈' } })
    expect(await prisma.qualityFinding.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ authorFeedback: null })
    expect(await prisma.qualityFinding.findUniqueOrThrow({ where: { id: owned.id } })).toMatchObject({ authorFeedback: 'accepted' })
  }))

  it('recovers a committed prototype without creating another version or charging a model', () => fixture(async f => {
    const text = 'Synthetic premise'
    await prisma.storyCharter.create({ data: { userId: f.userId, novelId: f.novelId, oneLinePromise: text, targetAudience: text, protagonistDesire: text,
      protagonistFear: text, protagonistMisbelief: text, protagonistNonNegotiable: text, conflictEngine: text, relationshipEngine: text,
      genreRules: [], abilityCosts: [], realityBoundaries: [], emotionalBaseline: text, emotionalRange: text, styleDna: {}, forbiddenZones: [], antiExamples: [] } })
    const dossier = await prisma.researchDossier.create({ data: { userId: f.userId, novelId: f.novelId, version: 1, status: 'ready', triggerReason: 'new_book', triggerSignals: [],
      topic: text, genre: text, targetAudience: text, readerPromise: text, abandonmentRisks: [], marketPatterns: [], differentiation: [], factCards: [], languageRisks: [],
      recommendations: [], rejectedIdeas: [], queryPlan: [], sources: [], sourceHash: 'a'.repeat(64), cacheKey: 'b'.repeat(64), expiresAt: new Date(Date.now() + 3600000) } })
    const input = { dossierId: dossier.id, genreRisks: ['A generic beginning'],
      directions: ['a', 'b'].map(id => ({ id, title: `Direction ${id}`, readerPromise: text, conflictEngine: text, differentiation: text, risk: text })),
      volumeSpine: ['Discover', 'Investigate', 'Decide'], chapterBlueprints: [1, 2, 3].map(orderIndex => ({ orderIndex, title: `Chapter ${orderIndex}`,
        chapterJob: text, concreteEvent: text, protagonistChoice: text, cost: text, newInformation: text, exitHook: text, qualityRisks: [] })) }
    const network = vi.fn(() => { throw Error('Unexpected provider request') }); vi.stubGlobal('fetch', network)
    const lease = await start(f, [firstThreePrototypeBuildTool], [call('prototype', 'first_three_prototype_build', input)])
    const interrupted = vi.spyOn(reducer, 'reduceExecutionReceipt').mockRejectedValueOnce(Error('Worker ended after prototype commit'))
    await expect(executeDurableToolStep(lease, signal())).rejects.toThrow('Worker ended after prototype commit')
    interrupted.mockRestore()
    expect(await executeDurableToolStep(lease, signal())).toMatchObject({ kind: 'recovered' })
    expect(await prisma.firstThreePrototype.findMany({ where: { novelId: f.novelId } })).toMatchObject([{ version: 1, dossierId: dossier.id }])
    expect(await prisma.firstThreePrototype.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    expect(network).not.toHaveBeenCalled()
  }))
})
