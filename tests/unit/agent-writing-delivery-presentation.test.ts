import { currentReviewReadinessFixture } from '../helpers/current-review-readiness-fixture.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { createHash } from 'node:crypto'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { probeChapterReviewRevision, readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'

const mocks = vi.hoisted(() => ({ original: vi.fn(), preference: vi.fn(), lease: vi.fn(), state: vi.fn(), save: vi.fn() }))
vi.mock('../../api/lib/agent/original-request.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/original-request.js')>(), readOriginalTaskRequest: mocks.original,
  originalTaskRunIds: async () => ['run'],
}))
vi.mock('../../api/lib/agent/writing-request-context.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/writing-request-context.js')>(), readWritingPresentation: mocks.preference,
}))
vi.mock('../../api/lib/agent/runtime-lease.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/runtime-lease.js')>(), withManuscriptRunLease: mocks.lease,
}))
vi.mock('../../api/lib/agent/runtime-state.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/agent/runtime-state.js')>(), readExecutionStateInTransaction: mocks.state, saveExecutionStateInTransaction: mocks.save,
}))
import { readCompletedWritingDelivery, readSavedWritingPresentation, readRecoveredChapterDelivery, readCompletedWritingPresentation, completedWritingPresentationText,
  shouldUseSavedWritingPresentation, savedChapterPresentationProof, savedChapterPresentationSchema, allowsChapterOnlyCompletion } from '../../api/lib/agent/writing-scope.js'
import { advanceDurableWritingDelivery } from '../../api/lib/agent/runtime-writing-delivery.js'

const subject = { userId: 'author', novelId: 'novel', runId: 'run' }
const token = { ...subject, taskRootId: 'root', owner: 'worker', epoch: 1n }
async function fixture(prompt = '完成第一章，只输出标题与正文。', titleAndBodyOnly = true) {
  const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', chapterId: 'chapter', prompt, mode: 'build' })
  spec.scope.writing = { version: 1, kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly, repairAuthorized: true }
  mocks.original.mockResolvedValue({ prompt, spec, taskId: spec.id, sourceRunId: 'run', parentRunId: null })
  const chapter = { id: 'chapter', title: '第一章 旧罗盘', content: '沈桐眼前浮起价值数字。他压住笑意，决定抓住这个独享的机会。', revision: 1, orderIndex: 1 }
  const bridge = { id: 'bridge', toChapterId: chapter.id, fromChapterId: null, targetRevision: chapter.revision, committedAt: new Date(1) }
  const sceneTasks = [{ id: 'scene', ordinal: 1, status: 'completed', goal: '辨识罗盘价值', turn: '决定抓住机会' }]
  const terminal = { id: 'compiler', runId: subject.runId, chapterId: chapter.id, status: 'completed', stage: 'commit',
    chapter, preparedContext: { terminalContentHash: runtimeJson({ content: chapter.content }).hash }, bridge, sceneTasks,
    validation: { independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: chapter.revision,
      checkRounds: 1, autoRepairRounds: 0, errorCount: 0, warningCount: 0, findings: [] as Array<{ signal: string; severity: string; evidence: string; suggestion: string }>,
      coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks, source: null }) } }
  const quality = { id: 'quality', compilationId: terminal.id, runId: subject.runId, chapterId: chapter.id, chapterRevision: chapter.revision,
    status: 'passed', repairRound: 0, deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') },
    findings: [] as Array<{ id: string; signal: string; severity: string; disposition: string; authorFeedback: null;
      evidenceExcerpt: string; startOffset: number; endOffset: number; explanation: string; suggestion: string }> }
  const db = { $queryRaw: vi.fn(async () => [{ id: 'novel' }]),
    agentRun: { findFirst: vi.fn(async () => ({ id: subject.runId })), findFirstOrThrow: vi.fn(async () => ({ writingBindings: null })) },
    chapter: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(async () => chapter) }, storyCompilation: { findFirst: vi.fn(async () => terminal), findMany: vi.fn(async () => [terminal]) },
    chapterQualityReport: { findFirst: vi.fn(async () => quality), findMany: vi.fn(async () => [quality]) },
    agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => ({ id: 'root', novelId: 'novel' })) },
    agentOperation: { count: vi.fn(async () => 0) }, agentProviderAttempt: { count: vi.fn(async () => 0) },
    agentExecutionOutbox: { create: vi.fn(async () => ({})) } }
  mocks.lease.mockImplementation(async (_token, work) => work(db))
  const state = { frame: { revision: 7, snapshotHash: 'a'.repeat(64), state: { phase: 'idle', messages: [{ role: 'user', content: prompt }] } } }
  mocks.state.mockResolvedValue(state)
  mocks.save.mockImplementation(async (_db, _token, input) => { state.frame = { revision: 8, snapshotHash: 'b'.repeat(64), state: input.snapshot }; return state.frame })
  const refreshContinuity = () => currentReviewReadinessFixture(db as unknown as Prisma.TransactionClient, subject, terminal)
  await refreshContinuity()
  return { db: db as unknown as Prisma.TransactionClient, mocks: db, chapter, terminal, quality, spec, state, refreshContinuity }
}
beforeEach(() => { vi.clearAllMocks(); mocks.preference.mockResolvedValue(null) })

it('delivers the authenticated frozen current chapter without requiring a second numbered legacy range', async () => {
  const prompt = '完整重写当前章节，只输出标题和正文。', f = await fixture(prompt)
  expect(allowsChapterOnlyCompletion(prompt)).toBe(false)
  expect(f.spec.scope.writing).toMatchObject({ kind: 'bounded', targets: [{ chapterId: 'chapter', orderIndex: 1 }], titleAndBodyOnly: true })
  expect(f.terminal).toMatchObject({ status: 'completed', stage: 'commit', bridge: { toChapterId: 'chapter', targetRevision: 1 } })
  expect(await readCompletedWritingDelivery(f.db, subject)).toMatchObject({ chapters: [{ id: 'chapter', revision: 1 }], presentationKind: 'auto' })
  expect(f.mocks.storyCompilation.findFirst).toHaveBeenCalled()
  expect(await advanceDurableWritingDelivery(token as never)).toMatchObject({ revision: 8 })
  expect(mocks.save).toHaveBeenCalledOnce()
  expect(f.chapter.revision).toBe(1)
})

it.each(['ordinary-presentation', 'extra-report', 'extra-artifact', 'empty-targets', 'wrong-target', 'bad-bridge', 'pending-provider'] as const)(
  'frozen current chapter does not bypass %s', async invalid => {
    const prompt = invalid === 'ordinary-presentation' ? '完整重写当前章节' : invalid === 'extra-report'
      ? '完整重写当前章节，只输出标题和正文；另外提供分析报告。' : invalid === 'extra-artifact'
        ? '完整重写当前章节，只输出标题和正文；顺便写首诗。' : '完整重写当前章节，只输出标题和正文。'
    const f = await fixture(prompt, invalid !== 'ordinary-presentation')
    if (invalid === 'empty-targets') f.spec.scope.writing!.targets = []
    if (invalid === 'wrong-target') f.mocks.chapter.findFirst.mockResolvedValue(null as never)
    if (invalid === 'bad-bridge') f.terminal.bridge.targetRevision = 2
    if (invalid === 'pending-provider') f.mocks.agentProviderAttempt.count.mockResolvedValue(1)
    expect(await advanceDurableWritingDelivery(token as never)).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(f.mocks.agentExecutionOutbox.create).not.toHaveBeenCalled()
  })

it.each(['修改第一章，另外写报告。', '修改第一章，并生成大纲。', '写第一章，顺便写首诗。', '写第一章，然后检查正文质量。'])(
  'does not finish additional original deliverables through local chapter recovery: %s', async prompt => {
    const f = await fixture(prompt, false)
    expect(await readCompletedWritingPresentation(f.db, subject)).not.toBeNull()
    expect(await readRecoveredChapterDelivery(f.db, subject)).toBeNull()
  })

it('captures the recovery kind so final persistence rechecks the original chapter-only request boundary', async () => {
  const f = await fixture('修改第一章。', false)
  expect(await readRecoveredChapterDelivery(f.db, subject)).toMatchObject({ presentationKind: 'recovered_chapter_only', chapters: [{ id: f.chapter.id }] })
})

describe('current committed manuscript wrap-up', () => {
  async function current() {
    const f = await fixture('只修改第三章，第一二章不要改；完成后简要总结。', false)
    f.chapter.revision = 6
    f.chapter.orderIndex = 3
    f.chapter.title = '第三章 河岸'
    f.spec.scope.writing!.targets[0].orderIndex = 3
    f.chapter.content = '北岸闸门只开了半尺。阿岚把手停在铁链上，等守闸人的回答。'
    f.terminal.bridge.targetRevision = 6
    f.terminal.preparedContext.terminalContentHash = runtimeJson({ content: f.chapter.content }).hash
    f.terminal.validation.checkedRevision = 6
    f.terminal.validation.coverage = compilerContinuityCoverage({ chapter: f.chapter, bridge: f.terminal.bridge, sceneTasks: f.terminal.sceneTasks, source: null })
    f.quality.chapterRevision = 6
    f.quality.deterministicMetrics.contentHash = createHash('sha256').update(f.chapter.content).digest('hex')
    await f.refreshContinuity()
    const delivery = await readCompletedWritingPresentation(f.db, subject)
    expect(delivery).not.toBeNull()
    return { f, delivery: delivery! }
  }
  it.each([['「', '」'], ['“', '”'], ['‘', '’'], ['『', '』'], ['`', '`'], ['"', '"'], ["'", "'"]])('omits stale manuscript quotation %s without erasing supported commentary', async (open, close) => {
    const { delivery } = await current()
    const text = completedWritingPresentationText(delivery,
      `第3章已提交r6。闸门表述已改为${open}北岸闸门开了整整一尺${close}。\n\n人物的选择仍落在等待回答上。`)
    expect(text).not.toContain('整整一尺')
    expect(text).toContain('人物的选择仍落在等待回答上。')
    expect(text).not.toContain('章节终态已提交')
    expect(text).not.toContain('（r6）')
    expect(completedWritingPresentationText(delivery, text)).toBe(text)
  })
  it('keeps current excerpts and quoted style labels while rejecting an obsolete revision claim', async () => {
    const { delivery } = await current()
    const text = completedWritingPresentationText(delivery, '当前稿是r5。正文保留「北岸闸门只开了半尺」。风格标签为“收束与留白”。')
    expect(text).not.toContain('r5')
    expect(text).toContain('正文保留「北岸闸门只开了半尺」。')
    expect(text).toContain('风格标签为“收束与留白”。')
  })
  it.each(['「旧钥匙打开了门」', '“旧钥匙\n打开了门”', "'旧钥匙\n打开了门'", '本章写道：“旧钥匙打开了门”。', '原文是：“旧钥匙\n打开了门”。', '第3章却写“旧钥匙打开了门”。', '「灯」', '“留白”'])('rejects unsupported literal text without an attribution-prefix loophole: %s', async candidate => {
    const { delivery } = await current()
    const text = completedWritingPresentationText(delivery, `${candidate}\n\n等待回答的处理仍然克制。`)
    expect(text).not.toContain('旧钥匙')
    expect(text).not.toContain('「灯」')
    expect(text).not.toContain('“留白”')
    expect(text).toContain('等待回答的处理仍然克制。')
  })
  it('preserves only a grammatical style label, never a short-word manuscript exemption', async () => {
    const { delivery } = await current()
    const text = completedWritingPresentationText(delivery, '风格标签为“留白”。正文里保留“留白”。风格标签为“旧钥匙打开了门”。\n\n人物的停顿仍然自然。')
    expect(text).toContain('风格标签为“留白”。')
    expect(text).not.toContain('正文里保留')
    expect(text).not.toContain('旧钥匙')
    expect(text).toContain('人物的停顿仍然自然。')
  })
  it.each(['saved_only', 'full_text'] as const)('replaces a model-declared manuscript block with the saved presentation: %s', async mode => {
    const { delivery } = await current()
    delivery.presentation = { mode, sourceRunId: 'author', sourceMessageId: 'message' }
    delivery.text = mode === 'full_text' ? `${delivery.chapters[0].title}\n\n${delivery.chapters[0].content}` : '已保存。'
    const text = completedWritingPresentationText(delivery, '保留人物等待的审美总结。\n\n以下是修改后的正文：\n旧钥匙打开了门。\n\n旧稿第二段也不应流出。\n\n修改总结：\n停顿让选择更清楚。')
    expect(text).not.toContain('旧钥匙')
    expect(text).not.toContain('旧稿第二段')
    expect(text).toContain('保留人物等待的审美总结。')
    expect(text).toContain('停顿让选择更清楚。')
    if (mode === 'full_text') expect(text).toContain(delivery.chapters[0].content)
    else expect(text).not.toContain(delivery.chapters[0].content)
  })
  it('accepts exact cross-line text and true identifiers, but rejects a quote attributed to another chapter', async () => {
    const { delivery } = await current()
    delivery.chapters[0].content = '北岸闸门只开了半尺。\n阿岚等守闸人的回答。'
    const accepted = completedWritingPresentationText(delivery, '第3章保留“只开了半尺。\n阿岚等守闸人”。章节ID为`chapter`。')
    expect(accepted).toContain('“只开了半尺。\n阿岚等守闸人”')
    expect(accepted).not.toContain('章节ID')
    const rejected = completedWritingPresentationText(delivery, '第1章却写“只开了半尺”。\n\n审美总结保留。')
    expect(rejected).not.toContain('第1章却写')
    expect(rejected).toContain('审美总结保留。')
  })
  it('binds each chapter revision and quotation separately rather than requiring all revisions to be equal', async () => {
    const { delivery } = await current()
    const third = delivery.chapters[0]
    delivery.chapters = [{ ...third, id: 'chapter-one', title: '第一章 山径', orderIndex: 1, revision: 4, content: '山径只剩一串湿脚印。',
      completion: { ...third.completion, compilationId: 'compiler-one', qualityReportId: 'quality-one' } }, third]
    const supported = completedWritingPresentationText(delivery, '第1章r4，正文保留「山径只剩一串湿脚印」。第3章r6，正文保留「北岸闸门只开了半尺」。')
    expect(supported).toContain('正文保留「山径只剩一串湿脚印」。')
    expect(supported).toContain('正文保留「北岸闸门只开了半尺」。')
    expect(supported).not.toMatch(/\br[46]\b/)
    const wrong = completedWritingPresentationText(delivery, '第1章r6。第3章r4。第1章却写「北岸闸门只开了半尺」。\n\n多章的未引用总结仍保留。')
    expect(wrong).not.toContain('第1章r6')
    expect(wrong).not.toContain('第3章r4')
    expect(wrong).not.toContain('第1章却写')
    expect(wrong).toContain('多章的未引用总结仍保留。')
    expect(completedWritingPresentationText(delivery, '《第一章 山径》r4，当前版本已保存。')).not.toContain('r4')
    for (const wrongAttribution of ['第1章的原句如下：\n“北岸闸门只开了半尺”', '第1章写道，“北岸闸门只开了半尺”']) {
      const text = completedWritingPresentationText(delivery, `${wrongAttribution}\n\n未引用总结保留。`)
      expect(text).not.toContain('“北岸闸门只开了半尺”')
      expect(text).toContain('未引用总结保留。')
    }
    expect(completedWritingPresentationText(delivery, '第1章的原句如下：\n“山径只剩一串湿脚印”')).toContain('“山径只剩一串湿脚印”')
  })
  it('does not repeat a whole chapter quotation or delete ordinary summary text by a short-body substring', async () => {
    const { delivery } = await current()
    const body = delivery.chapters[0].content
    expect(completedWritingPresentationText(delivery, `“${body}”\n\n保留停顿的总结。`)).not.toContain(body)
    delivery.chapters[0].content = '门'
    expect(completedWritingPresentationText(delivery, '门外的悬念让人物停顿更自然。')).toContain('门外的悬念让人物停顿更自然。')
  })
  it('removes correct-version and terminal metadata clauses while preserving literary r6 text and exact saved delivery', async () => {
    const { delivery } = await current()
    const text = completedWritingPresentationText(delivery, '第3章已提交r6。章节终态已提交。当前稿是r6。\n\n人物在r6房间等待回答，停顿更克制。')
    expect(text).toBe('人物在r6房间等待回答，停顿更克制。')
    delivery.titleAndBodyOnly = true
    delivery.text = `标题r6\n\n${delivery.chapters[0].content}\n章节终态已提交。\n\n\`r6\``
    expect(completedWritingPresentationText(delivery, '章节终态已提交。')).toBe(delivery.text)
  })
  it.each([['（', '，', '）'], ['(', ',', ')'], ['（', '；', '）']])('keeps a complete saved opening with a parenthetical revision and count: %s%s%s', async (open, separator, close) => {
    const { delivery } = await current()
    const recap = '阿岚停在半开的闸门前，等待守闸人的回答。'
    const text = completedWritingPresentationText(delivery, `已保存《第三章 河岸》${open}r6${separator}3541 字${close}。${recap}`)
    expect(text).toBe(`已保存《第三章 河岸》${open}3541 字${close}。${recap}`)
    expect(completedWritingPresentationText(delivery, text)).toBe(text)
    expect(text).not.toMatch(/^3541/u)
  })
  it('does not erase a revision-like word in the actual title while cleaning its saved receipt', async () => {
    const { delivery } = await current()
    delivery.chapters[0].title = 'r6 房间'
    const text = completedWritingPresentationText(delivery, '已保存《r6 房间》（r6，3541 字）。人物仍在门外等待。')
    expect(text).toBe('已保存《r6 房间》（3541 字）。人物仍在门外等待。')
    expect(completedWritingPresentationText(delivery, text)).toBe(text)
  })

  it('removes a whole terminal receipt without leaving a count fragment or joining adjacent sentences', async () => {
    const { delivery } = await current()
    const text = completedWritingPresentationText(delivery,
      '阿岚仍在等待回答，章节终态已提交（r6，3541 字）。守闸人的沉默留下悬念。')
    expect(text).toBe('阿岚仍在等待回答。守闸人的沉默留下悬念。')
    expect(completedWritingPresentationText(delivery, text)).toBe(text)
  })
  it('keeps nested parenthetical plot details and literal commas in verified quotations', async () => {
    const { delivery } = await current()
    delivery.chapters[0].content += '屏幕提示：已保存（r6，3541 字）。'
    const text = '人物的停顿（包括等待（半尺，未动）的过程）仍然克制。正文保留“已保存（r6，3541 字）”。'
    expect(completedWritingPresentationText(delivery, text)).toBe(text)
  })

  it('preserves verified manuscript block quotes and paragraph boundaries, but removes metadata-only quoted versions', async () => {
    const { delivery } = await current()
    delivery.chapters[0].content += '\n屏幕显示：章节终态已提交。'
    const quote = '> 章节终态已提交。\n\n保留屏幕上的提示。\n\n人物的犹豫仍然清楚。'
    expect(completedWritingPresentationText(delivery, quote)).toBe(quote)
    expect(completedWritingPresentationText(delivery, '第3章已提交`r6`。\n\n人物的犹豫仍然清楚。')).toBe('人物的犹豫仍然清楚。')
    expect(completedWritingPresentationText(delivery, '当前稿是“r6”。\n\n人物的犹豫仍然清楚。')).toBe('人物的犹豫仍然清楚。')
  })
  it('respects no-repeat and explicit full-text display without inventing passed checks', async () => {
    const { delivery } = await current()
    delivery.presentation = { mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'author-message' }
    expect(completedWritingPresentationText(delivery, delivery.chapters[0].content)).not.toContain(delivery.chapters[0].content)
    delivery.chapters[0].completion.quality = 'stale'
    expect(completedWritingPresentationText(delivery, '连续性与人类感检查均已通过。')).not.toContain('均已通过')
    delivery.presentation.mode = 'full_text'
    delivery.text = `${delivery.chapters[0].title}\n\n${delivery.chapters[0].content}`
    expect(completedWritingPresentationText(delivery, '保留人物的停顿。')).toContain(delivery.chapters[0].content)
  })
  it('binds the exact latest report and commit state even when the saved body is unchanged', async () => {
    const { f, delivery } = await current()
    f.quality.id = 'replacement-report'
    const next = await readCompletedWritingPresentation(f.db, subject)
    expect(next?.chapters[0].contentHash).toBe(delivery.chapters[0].contentHash)
    expect(next?.chapters[0].completion.qualityReportId).toBe('replacement-report')
    expect(next?.chapters[0].completion.reviewHash).not.toBe(delivery.chapters[0].completion.reviewHash)
  })
})

describe('saved artifact display withdrawal', () => {
  it('uses a truthful short fallback only after current completion and never appends implementation receipts', async () => {
    const f = await fixture('完成第一章，简要说明结果。', false)
    const delivery = await readCompletedWritingPresentation(f.db, subject)
    expect(delivery).not.toBeNull()
    expect(completedWritingPresentationText(delivery!, '')).toBe('已完成《第一章 旧罗盘》。')
    expect(completedWritingPresentationText(delivery!, '人物的决定让机会变得具体。')).toBe('人物的决定让机会变得具体。')
    expect(f.chapter.content).toBe('沈桐眼前浮起价值数字。他压住笑意，决定抓住这个独享的机会。')
  })
  it('keeps a natural wrap-up with a title and short excerpt under a no-repeat preference', async () => {
    const f = await fixture('重写第一章，突出捡漏爽文。', false)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    const delivery = await readSavedWritingPresentation(f.db, subject)
    expect(delivery).not.toBeNull()
    expect(shouldUseSavedWritingPresentation(delivery, '第一章「旧罗盘」已完成。\n\n开头保留“沈桐眼前浮起价值数字”，突出独享机会的兴奋感，收尾留下询价的悬念。')).toBe(false)
    expect(shouldUseSavedWritingPresentation(delivery, delivery!.text)).toBe(false)
    expect(shouldUseSavedWritingPresentation(delivery, `${f.chapter.title}\n\n${f.chapter.content}`)).toBe(true)
    expect(shouldUseSavedWritingPresentation(delivery, '  ')).toBe(true)
    expect(shouldUseSavedWritingPresentation(null, f.chapter.content)).toBe(false)
  })
  it('short rewrite can serialize an already successful completion without obtaining auto-completion eligibility', async () => {
    const f = await fixture('重写第一章，突出捡漏爽文。', false)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    const delivery = await readSavedWritingPresentation(f.db, subject)
    expect(delivery).toMatchObject({ text: '已保存《第一章 旧罗盘》。', presentationKind: 'completed_saved_only', titleAndBodyOnly: false })
    const proof = savedChapterPresentationProof(subject, delivery!)
    expect(proof).toMatchObject({ targetRunId: 'run', sourceRunId: 'author-correction', sourceMessageId: 'message', chapters: [{ id: 'chapter', revision: 1 }] })
    expect(JSON.stringify(proof)).not.toContain(f.chapter.content)
    expect(savedChapterPresentationSchema.safeParse({ ...proof, text: f.chapter.content }).success).toBe(false)
    mocks.preference.mockResolvedValue({ mode: 'full_text', sourceRunId: 'author-opt-in', sourceMessageId: 'message2' })
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
  })
  it('legacy delivery serializes a short saved confirmation while retaining the immutable original contract and chapter', async () => {
    const f = await fixture()
    const originalSpec = structuredClone(f.spec)
    expect((await readCompletedWritingDelivery(f.db, subject))?.text).toContain(f.chapter.content)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    const delivery = await readCompletedWritingDelivery(f.db, subject)
    expect(delivery).toMatchObject({ text: '已保存《第一章 旧罗盘》。', titleAndBodyOnly: true, chapters: [{ id: 'chapter', revision: 1 }] })
    expect(delivery?.text).not.toContain(f.chapter.content)
    expect(f.spec).toEqual(originalSpec)
    mocks.preference.mockResolvedValue({ mode: 'full_text', sourceRunId: 'author-opt-in', sourceMessageId: 'message2' })
    expect((await readCompletedWritingDelivery(f.db, subject))?.text).toContain(f.chapter.content)
  })
  it('durable delivery appends one server confirmation with CAS and no provider operation', async () => {
    const f = await fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author-correction', sourceMessageId: 'message' })
    expect(await advanceDurableWritingDelivery(token as never)).toMatchObject({ revision: 8 })
    expect(mocks.save).toHaveBeenCalledWith(f.mocks, token, expect.objectContaining({ expectedRevision: 7, expectedHash: 'a'.repeat(64),
      snapshot: expect.objectContaining({ messages: expect.arrayContaining([{ role: 'assistant', content: '已保存《第一章 旧罗盘》。' }]) }) }))
    expect(f.mocks.agentExecutionOutbox.create).toHaveBeenCalledOnce()
    expect(await advanceDurableWritingDelivery(token as never)).toBeNull()
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(f.chapter.revision).toBe(1)
  })
  it.each(['operation', 'provider', 'phase'] as const)('does not bypass a pending/unknown %s fence', async pending => {
    const f = await fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    if (pending === 'operation') f.mocks.agentOperation.count.mockResolvedValue(1)
    if (pending === 'provider') f.mocks.agentProviderAttempt.count.mockResolvedValue(1)
    if (pending === 'phase') f.state.frame.state.phase = 'awaiting_operation'
    expect(await advanceDurableWritingDelivery(token as never)).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each(['完成第一章，只输出标题与正文；另外生成封面。', '完成第一章，只输出标题与正文；并检查章节质量。', '重写第一章。'])('does not expand auto-completion eligibility: %s', async prompt => {
    const f = await fixture(prompt, prompt !== '重写第一章。')
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
  })
  it.each(['重写第一章；另外给我一首诗。', '重写第一章；并提供分析报告。'])('does not erase extra requested chat artifacts: %s', async prompt => {
    const f = await fixture(prompt, false)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
  })
  it.each(['stale-content', 'invalid-terminal'] as const)('still rejects %s after withdrawal', async invalid => {
    const f = await fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    if (invalid === 'stale-content') f.chapter.content = '作者新正文。'
    else f.terminal.status = 'active'
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
  })
  it.each(['missing', 'failed'] as const)('current continuity cannot replace %s independent quality after withdrawal', async quality => {
    const f = await fixture()
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    if (quality === 'missing') f.mocks.chapterQualityReport.findFirst.mockResolvedValue(null as never)
    else { f.quality.status = 'failed'; f.quality.deterministicMetrics.independentCheck = 'unavailable' }
    expect(await readChapterReviewReadiness(f.db, subject)).toMatchObject({ ready: false, continuity: 'complete', quality: quality === 'missing' ? 'missing' : 'incomplete' })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
  })
  it('completed automatic revision does not certify unhandled factual errors and quality advice', async () => {
    const f = await fixture(), chapter = structuredClone(f.chapter)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    f.terminal.validation.errorCount = 1
    f.terminal.validation.findings = [{ signal: 'object', severity: 'error', evidence: '罗盘同一状态仍需作者确认', suggestion: '交作者确认' }]
    await currentReviewReadinessFixture(f.db, subject, f.terminal, snapshot => [{ signal: 'object', severity: 'error', explanation: '罗盘同一状态仍冲突', suggestion: '交作者确认', evidence: [{ sourceId: snapshot.sources[0].table.entries[0].id }] }])
    f.quality.status = 'needs_repair'
    f.quality.findings = [{ id: 'retained', signal: 'object', severity: 'error', disposition: 'pending', authorFeedback: null,
      evidenceExcerpt: '价值数字', startOffset: f.chapter.content.indexOf('价值数字'), endOffset: f.chapter.content.indexOf('价值数字') + 4,
      explanation: '罗盘数字与同一物件状态仍冲突', suggestion: '核对当前物件事实' }]
    expect(await readChapterReviewReadiness(f.db, subject)).toMatchObject({ ready: true, continuity: 'complete', continuityErrorCount: 1, quality: 'complete', qualityErrorCount: 1 })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    expect(f.chapter).toEqual(chapter)
    expect(f.terminal.validation.errorCount).toBe(1)
    expect(f.quality.status).toBe('needs_repair')
    expect(f.quality.findings[0].disposition).toBe('pending')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('current factual errors still block saved presentation while original revision authority keeps the correction channel open', async () => {
    const f = await fixture('重写第一章，只输出标题与正文。'), chapter = structuredClone(f.chapter)
    mocks.preference.mockResolvedValue({ mode: 'saved_only', sourceRunId: 'author', sourceMessageId: 'message' })
    f.terminal.validation.errorCount = 1
    f.terminal.validation.findings = [{ signal: 'object', severity: 'error', evidence: '罗盘同一状态仍冲突', suggestion: '合并确认事实修订' }]
    await currentReviewReadinessFixture(f.db, subject, f.terminal, snapshot => [{ signal: 'object', severity: 'error', explanation: '罗盘同一状态仍冲突', suggestion: '合并确认事实修订', evidence: [{ sourceId: snapshot.sources[0].table.entries[0].id }] }])
    expect(await readChapterReviewReadiness(f.db, subject)).toMatchObject({ ready: true, continuity: 'complete', continuityErrorCount: 1 })
    expect(await probeChapterReviewRevision(f.db, subject, f.chapter)).toEqual({ open: true })
    expect(await readCompletedWritingDelivery(f.db, subject)).toBeNull()
    expect(await readSavedWritingPresentation(f.db, subject)).toBeNull()
    expect(f.chapter).toEqual(chapter)
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
