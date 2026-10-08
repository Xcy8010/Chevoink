import { expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { observeChapterReviewProgress, observeWritingWorkflowMilestone } from '../../api/lib/agent/semantic-progress.js'

it('credits only finite first prerequisites for the current frozen writing target, without using compiler IDs', () => {
  const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'old47', prompt: '写下一章' })
  taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 48, chapterId: null }], titleAndBodyOnly: false, repairAuthorized: false }
  const subject = { userId: 'user', novelId: 'novel', runId: 'run', taskSpec }
  const receipt = { version: 1, userId: 'user', novelId: 'novel', runId: 'run', targetOrderIndex: 48, phase: 'prepare' }
  const seen = new Set<string>()
  expect(observeWritingWorkflowMilestone(seen, 'story_compiler_prepare', receipt, subject)).toBe(true)
  const restored = new Set(seen)
  expect(observeWritingWorkflowMilestone(restored, 'story_compiler_prepare', receipt, subject)).toBe(false)
  expect(observeWritingWorkflowMilestone(restored, 'story_compiler_prepare', { ...receipt, compilationId: 'new-audit-id' }, subject)).toBe(false)
  expect(observeWritingWorkflowMilestone(restored, 'scene_task_build', { ...receipt, phase: 'scenes' }, subject)).toBe(true)
  expect(observeWritingWorkflowMilestone(restored, 'scene_task_build', { ...receipt, phase: 'scenes' }, subject)).toBe(false)
  for (const invalid of [{ ...receipt, targetOrderIndex: 47 }, { ...receipt, runId: 'old-run' }, { ...receipt, userId: 'other' }, { ...receipt, novelId: 'other' }])
    expect(observeWritingWorkflowMilestone(new Set(), 'story_compiler_prepare', invalid, subject)).toBe(false)
  expect(observeWritingWorkflowMilestone(new Set(), 'chapter_bridge_commit', receipt, subject)).toBe(false)
  expect(observeWritingWorkflowMilestone(new Set(), 'story_compiler_prepare', receipt,
    { ...subject, taskSpec: { ...taskSpec, intent: 'review' } })).toBe(false)
})
import { nextStagnantBatch, observeLegacyContentProgress, observeRequiredResult, observeSemanticTransition, observeSemanticReadProgress, persistedContentHash, semanticReadIdentity } from '../../api/lib/agent/semantic-progress.js'

it('does not count the incident full-read then 50/10/20/100-character rereads as new progress', () => {
  const seen = new Set<string>(), contentHash = persistedContentHash('same saved manuscript')
  const read = (start: number, end: number, targetId = 'chapter') => observeSemanticReadProgress(seen, 'chapter_read', `changed wrapper ${start}-${end}`, { targetId, contentHash, start, end })
  expect(read(0, 881)).toBe(true)
  for (const end of [50, 10, 20, 100, 881]) expect(read(0, end)).toBe(false)
  expect(read(0, 50, 'other')).toBe(true)
  expect(observeSemanticReadProgress(new Set(seen), 'chapter_read', 'restored with a new revision label', { targetId: 'chapter', contentHash, start: 20, end: 50 })).toBe(false)
  expect(observeSemanticReadProgress(seen, 'chapter_read', 'new body', { targetId: 'chapter', contentHash: persistedContentHash('changed manuscript'), start: 0, end: 50 })).toBe(true)
})

it('counts genuinely new pages and merges overlapping coverage without counting empty or invalid reads', () => {
  const seen = new Set<string>(), contentHash = persistedContentHash('body')
  const read = (start: number, end: number) => observeSemanticReadProgress(seen, 'chapter_read', 'body', { targetId: 'chapter', contentHash, start, end })
  expect(read(50, 100)).toBe(true)
  expect(read(0, 60)).toBe(true)
  expect(read(100, 150)).toBe(true)
  expect(read(25, 125)).toBe(false)
  expect(seen.size).toBe(1)
  expect(read(150, 150)).toBe(false)
  expect(read(-1, 15)).toBe(false)
  expect(read(0, Number.NaN)).toBe(false)
  expect(observeSemanticReadProgress(seen, 'chapter_read', 'legacy body')).toBe(true)
  expect(observeSemanticReadProgress(seen, 'chapter_read', 'legacy body')).toBe(false)
})

it('keeps progressing beyond old task caps while recognizing content cycles and no-ops', () => {
  const seen = new Set<string>()
  let previous = persistedContentHash('原文'), stagnant = 0
  for (let index = 0; index < 150; index++) {
    const next = persistedContentHash(`正文推进${index}`)
    stagnant = nextStagnantBatch(stagnant, observeSemanticTransition(seen, 'chapter:owned', previous, next))
    expect(stagnant).toBe(0)
    previous = next
  }
  expect(observeSemanticTransition(seen, 'chapter:owned', previous, persistedContentHash('原文'))).toBe(false)
  expect(observeSemanticTransition(seen, 'chapter:owned', previous, previous)).toBe(false)
  expect(observeSemanticTransition(seen, 'chapter:other-authorized', previous, persistedContentHash('原文'))).toBe(true)
})

it('counts first verified current terminal separately from unchanged body or audit-only stage changes', () => {
  const seen = new Set<string>(), hash = persistedContentHash('完整正文')
  expect(observeSemanticTransition(seen, 'chapter:c', hash, hash)).toBe(false)
  expect(observeRequiredResult(seen, 'terminal:chapter:c', hash)).toBe(true)
  expect(observeRequiredResult(seen, 'terminal:chapter:c', hash)).toBe(false)
  expect(observeRequiredResult(seen, 'terminal:chapter:c', persistedContentHash('最新正文'))).toBe(true)
})

it('fresh workflow reports and read receipt IDs do not count as substantive work', () => {
  for (const action of ['quality_report_get', 'continuity_validate', 'chapter_bridge_get', 'todo_write', 'ask_user', 'task_get', 'task_wait']) {
    expect(semanticReadIdentity(action, '{"id":"new","revision":999,"stage":"check"}')).toBeNull()
  }
  expect(semanticReadIdentity('plan_read', '《大纲》（planId=old，contentHash=abc，正文）：\n计划正文'))
    .toBe(semanticReadIdentity('plan_read', '《大纲》（planId=new，contentHash=abc，正文）：\n计划正文'))
  const header = '网页「https://example.invalid」正文：\nsourceId=正文中原样保留\n来源编号 sourceId='
  expect(semanticReadIdentity('web_read', `${header}old；contentRef=one、revision=1`))
    .toBe(semanticReadIdentity('web_read', `${header}new；contentRef=two、revision=2`))
  expect(semanticReadIdentity('chapter_read', '正文A')).not.toBe(semanticReadIdentity('chapter_read', '正文B'))
})

it('parks repeated failures without counting a healthy child wait as another stagnant batch', () => {
  let count = 0
  for (let index = 0; index < 4; index++) count = nextStagnantBatch(count, false)
  expect(count).toBe(4)
  expect(nextStagnantBatch(count, false, true)).toBe(4)
  expect(nextStagnantBatch(count, true)).toBe(0)
})

it('recreated plan IDs, revision-only report cards and A/B revisions do not refresh legacy progress', () => {
  const seen = new Set<string>()
  const card = (display: Parameters<typeof observeLegacyContentProgress>[1]['display']) => ({
    type: 'tool-call' as const, callId: 'real-tool', toolName: 'plan_save', title: '保存', status: 'success' as const, args: {}, display,
  })
  expect(observeLegacyContentProgress(seen, card({ kind: 'planFile', planId: 'first', title: '计划', content: '内容A' }))).toBe(true)
  expect(observeLegacyContentProgress(seen, card({ kind: 'planFile', planId: 'second', title: '计划', content: '内容A' }))).toBe(false)
  expect(observeLegacyContentProgress(seen, card({ kind: 'planDiff', planId: 'second', title: '计划', before: '内容A', after: '内容B' }))).toBe(true)
  expect(observeLegacyContentProgress(seen, card({ kind: 'planDiff', planId: 'second', title: '计划', before: '内容B', after: '内容A' }))).toBe(false)
})

it('canonical research reads preserve genuine new facts while deduplicating audit IDs and revision-only views', () => {
  const search = (id: string, revision: number, body: string) => `全书检索命中 1 处，索引状态 ready。本次返回结果已保存为 artifactId=${id}，以下包含本次全部返回结果。\n- 卷 / 章 [content@0, chapterId=c, revision=${revision}] …【${body}】…`
  expect(semanticReadIdentity('project_search', search('one', 1, '真正文'))).toBe(semanticReadIdentity('project_search', search('two', 2, '真正文')))
  expect(semanticReadIdentity('project_search', search('one', 1, '真正文'))).not.toBe(semanticReadIdentity('project_search', search('two', 2, '新正文')))
  const dossier = (id: string, version: number, fact: string) => JSON.stringify({ id, version, status: 'ready', updatedAt: 'audit', readerPromise: '原始研究目标', factCards: [{ claim: fact }] })
  expect(semanticReadIdentity('research_dossier_get', dossier('one', 1, '真实事实'))).toBe(semanticReadIdentity('research_dossier_get', dossier('two', 2, '真实事实')))
  expect(semanticReadIdentity('research_dossier_get', dossier('one', 1, '真实事实'))).not.toBe(semanticReadIdentity('research_dossier_get', dossier('two', 2, '新事实')))
})


it('does not treat empty lookup advice, null charters or audit-only retrieval traces as progress', () => {
  const empty: Record<string, string> = {
    research_dossier_get: '当前作品尚无研究档案。只在明确需要时建立。', first_three_prototype_get: '当前作品尚无前三章试制。',
    style_profile_get: '当前作品尚无已确认的作者 Style DNA。', memory_review_list: '记忆审核箱为空。',
    character_voice_get: '没有匹配的 Voice DNA。', experience_anchor_get: '没有确认经历锚点；不得编造。',
    directive_list: '当前作品没有 active 指令。', story_charter_get: JSON.stringify({ charter: null, readerPromises: [] }),
    retrieval_trace_read: '检索查询：{"scene":"实际查询"}\n选择结果：[]\n记录时间：审计时间',
  }
  for (const [action, output] of Object.entries(empty)) expect(semanticReadIdentity(action, output), action).toBeNull()
  expect(semanticReadIdentity('structure_validate', '真实目录：卷一，章节位置1')).not.toBeNull()
  const output = '全书检索命中 1 处。本次返回结果已保存为 artifactId=one，全部结果。\n- 卷 / 章 [content@0, chapterId=c, revision=1] 正文 [content@1, chapterId=c, revision=999]'
  expect(semanticReadIdentity('project_search', output)).not.toBe(semanticReadIdentity('project_search', output.replace('revision=999', 'revision=998')))
})


it('summary locating revisions and report receipt revisions cannot manufacture fresh material', () => {
  const summary = (revision: number, body: string) => `全书检索命中 1 处。\n- 卷 / 章 [summary@0, chapterId=c, revision=${revision}] ${body}`
  expect(semanticReadIdentity('project_search', summary(1, '原摘要 revision=999'))).toBe(semanticReadIdentity('project_search', summary(2, '原摘要 revision=999')))
  expect(semanticReadIdentity('project_search', summary(1, '原摘要 revision=999'))).not.toBe(semanticReadIdentity('project_search', summary(2, '原摘要 revision=998')))
  const report = (artifactId: string, revision: number, content: string) => JSON.stringify({ reportId: 'main', artifactId, revision,
    sections: [{ id: 'intro', order: 0 }], content, offset: 0, totalChars: content.length, nextOffset: null })
  expect(semanticReadIdentity('research_report_read', report('old', 1, '正文 revision=1'))).toBe(semanticReadIdentity('research_report_read', report('new', 9, '正文 revision=1')))
  expect(semanticReadIdentity('research_report_read', report('old', 1, '正文 revision=1'))).not.toBe(semanticReadIdentity('research_report_read', report('new', 9, '新正文 revision=1')))
})


it('credits current required review phases once per original task and body, not repeated reports or revisions', () => {
  const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt: '写下一章' })
  const subject = { userId: 'user', novelId: 'novel', expectedOriginalTaskId: taskSpec.id, taskSpec }
  const evidence = { taskId: taskSpec.id, userId: 'user', novelId: 'novel', chapterId: 'chapter', orderIndex: 50,
    contentHash: 'a'.repeat(64), phases: ['quality'] as Array<'quality' | 'decision'> }
  const seen = new Set<string>()
  expect(observeChapterReviewProgress(seen, evidence, subject)).toBe(true)
  expect(observeChapterReviewProgress(new Set(seen), evidence, subject)).toBe(false)
  expect(observeChapterReviewProgress(seen, { ...evidence, phases: ['quality', 'decision'] }, subject)).toBe(true)
  expect(observeChapterReviewProgress(seen, { ...evidence, phases: ['decision'] }, subject)).toBe(false)
  expect(observeChapterReviewProgress(seen, { ...evidence, contentHash: 'b'.repeat(64) }, subject)).toBe(true)
  expect(observeChapterReviewProgress(seen, evidence, subject)).toBe(false)
  for (const invalid of [undefined, { ...evidence, phases: [] }, { ...evidence, userId: 'other' },
    { ...evidence, novelId: 'other' }, { ...evidence, taskId: 'other' }, { ...evidence, chapterId: 'other' }, { ...evidence, contentHash: 'invalid' }])
    expect(observeChapterReviewProgress(new Set(), invalid, subject)).toBe(false)
})

it('does not let a legacy editor chapter bypass a bounded writing target', () => {
  const taskSpec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'old', prompt: '写下一章' })
  taskSpec.scope.writing = { version: 1, kind: 'bounded', targets: [{ orderIndex: 50, chapterId: 'new' }], titleAndBodyOnly: false, repairAuthorized: false }
  const subject = { userId: 'user', novelId: 'novel', taskSpec, expectedOriginalTaskId: taskSpec.id }
  const evidence = { taskId: taskSpec.id, userId: 'user', novelId: 'novel', chapterId: 'old', orderIndex: 49,
    contentHash: 'a'.repeat(64), phases: ['quality'] as const }
  expect(observeChapterReviewProgress(new Set(), { ...evidence, phases: [...evidence.phases] }, subject)).toBe(false)
})
